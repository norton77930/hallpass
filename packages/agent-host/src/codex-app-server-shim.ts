import { spawn } from "node:child_process";
import {
  CODEX_SHIM_EXIT_BOUND_MS,
  createLineRewriter,
  realCliSpawn,
  rewriteStrictTurnStart,
  shimChildEnvironment,
} from "./broker/codex-strict.js";
import { killTree } from "./broker/run-command.js";

/**
 * `node codex-app-server-shim.js <real codex CLI> app-server ...` - what the Codex adapter's
 * `CODEX_PATH` command file runs (019 D-019-12, R-317, SC-135; the rule and its reasons are in
 * `broker/codex-strict.ts`).
 *
 * Starts the real CLI with the same arguments. The CLI's stdout and stderr are this process's own
 * (inherited, so the server -> adapter direction is untouched); the adapter -> server direction is
 * read line by line and the adapter's `read-only` `turn/start` gets a read-only sandbox. The exit
 * code and a terminating signal are the CLI's. Nothing breaks away from the broker's job: the CLI
 * is an ordinary child, as this process is of the adapter's shell. Once the adapter closes the input,
 * the CLI has `CODEX_SHIM_EXIT_BOUND_MS` to leave before its process tree is ended.
 */

const [cli = "", ...args] = process.argv.slice(2);

let launch: ReturnType<typeof realCliSpawn>;
try {
  launch = realCliSpawn(cli, args, process.env.ComSpec ?? "cmd.exe");
} catch (error) {
  process.stderr.write(`hallpass codex shim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const child = spawn(launch.command, launch.args, {
  env: shimChildEnvironment(process.env),
  stdio: ["pipe", "inherit", "inherit"],
  windowsHide: true,
  windowsVerbatimArguments: launch.verbatim,
});

child.once("error", (error) => {
  process.stderr.write(`hallpass codex shim: could not start the Codex CLI: ${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

// The CLI gone mid-write is its exit's story, told above.
child.stdin.on("error", () => undefined);

const rewriter = createLineRewriter(rewriteStrictTurnStart);
const forward = (bytes: Buffer): void => {
  if (bytes.length === 0) return;
  if (!child.stdin.write(bytes)) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
};
process.stdin.on("data", (chunk: Buffer) => forward(rewriter.push(chunk)));
process.stdin.once("end", () => {
  forward(rewriter.flush());
  child.stdin.end();
  setTimeout(() => killTree(child.pid), CODEX_SHIM_EXIT_BOUND_MS).unref();
});
