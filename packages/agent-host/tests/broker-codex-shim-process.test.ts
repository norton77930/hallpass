import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CODEX_SHIM_COMMAND, CODEX_SHIM_ENV, CODEX_SHIM_EXIT_BOUND_MS } from "../src/broker/codex-strict.js";

// Each case starts cmd.exe, the shim, cmd.exe again and the fake CLI: slow under the parallel run.
vi.setConfig({ testTimeout: 30_000 });

/**
 * 019 SC-135 / SC-136 - the Codex app-server shim as the adapter runs it: `"<CODEX_PATH>" app-server`
 * through a shell, with `CODEX_PATH` the command file and the paths in the environment. A fake
 * `codex.cmd` stands in for the CLI: it reports its pid, arguments and any shim variable that leaked
 * into its environment, echoes each line it receives, exits with `exit:<n>`, and reports end of input.
 *
 * Runs the built `dist/codex-app-server-shim.js` (build first, as broker-job.test.ts).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_ENTRY = resolve(HERE, "..", "dist", "codex-app-server-shim.js");
const JOB_MODULE = pathToFileURL(resolve(HERE, "..", "dist", "broker", "job.js")).href;

const FAKE_CLI = `
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
out({ fake: "started", pid: process.pid, argv: process.argv.slice(2),
  leaked: Object.keys(process.env).filter((name) => /^(HALLPASS_CODEX_|CODEX_PATH$)/i.test(name)) });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const exit = /^exit:(\\d+)$/.exec(line);
    if (exit) process.exit(Number(exit[1]));
    out({ fake: "got", line });
  }
});
process.stdin.on("end", () => { out({ fake: "eof", rest: buffer }); if (!process.env.FAKE_IGNORE_EOF) process.exit(0); });
if (process.env.FAKE_IGNORE_EOF) setInterval(() => {}, 1000);
`;

let root = "";
let shimCommand = "";
/** The same command file under a profile-like folder with a space and non-ASCII letters. */
let shimCommandUnicode = "";
let fakeCli = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hallpass-codex-shim-"));
  // A space, dots and non-ASCII letters: the dev checkout has a space, a profile may have the rest.
  const cliDir = join(root, "npm v1.2 \u6e2c\u8a66");
  await mkdir(cliDir);
  await writeFile(join(cliDir, "fake-codex.mjs"), FAKE_CLI);
  fakeCli = join(cliDir, "codex.cmd");
  await writeFile(fakeCli, '@echo off\r\n"%FAKE_NODE%" "%~dp0fake-codex.mjs" %*\r\n');
  shimCommand = join(root, "app-server-shim.cmd");
  await writeFile(shimCommand, CODEX_SHIM_COMMAND);
  // As under a %LOCALAPPDATA% whose user name has a space and non-ASCII letters.
  const unicodeData = join(root, "Users", "\u738b \u5c0f\u660e", "AppData", "Local", "hallpass", "agents", "codex");
  await mkdir(unicodeData, { recursive: true });
  shimCommandUnicode = join(unicodeData, "app-server-shim.cmd");
  await writeFile(shimCommandUnicode, CODEX_SHIM_COMMAND);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const shimEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  // The adapter's own variable naming the command file; the real CLI must not see it.
  CODEX_PATH: shimCommand,
  [CODEX_SHIM_ENV.node]: process.execPath,
  [CODEX_SHIM_ENV.shim]: SHIM_ENTRY,
  [CODEX_SHIM_ENV.cli]: fakeCli,
  FAKE_NODE: process.execPath,
  ...extra,
});

type FakeLine = { fake: string; pid?: number; argv?: string[]; leaked?: string[]; line?: string; rest?: string };

/** The adapter's own way of starting `CODEX_PATH` (codex-acp 1.13.1 `startCodexConnection`). */
function startLikeAdapter(
  command = shimCommand,
  extraEnv: Record<string, string> = {},
): { child: ChildProcessWithoutNullStreams; lines: FakeLine[]; exit: Promise<number | null> } {
  const child = spawn(`"${command}" app-server`, { shell: true, env: shimEnv({ CODEX_PATH: command, ...extraEnv }), windowsHide: true });
  const lines: FakeLine[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      lines.push(JSON.parse(buffer.slice(0, at)) as FakeLine);
      buffer = buffer.slice(at + 1);
    }
  });
  const exit = new Promise<number | null>((done) => child.once("exit", done));
  return { child, lines, exit };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

const strictTurn = JSON.stringify({
  id: 10,
  method: "turn/start",
  params: {
    threadId: "t",
    input: [{ type: "text", text: "write x.txt", text_elements: [] }],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  },
});
const agentTurn = JSON.stringify({
  id: 11,
  method: "turn/start",
  params: { threadId: "t", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } },
});
const threadStart = JSON.stringify({ id: 9, method: "thread/start", params: { cwd: "C:\\x \u6e2c", sandbox: "workspace-write" } });

describe.runIf(process.platform === "win32")("Codex app-server shim, run the way the adapter runs it", () => {
  it("relays both ways, rewrites the strict turn/start, and passes everything else byte for byte", async () => {
    const { child, lines, exit } = startLikeAdapter();
    await until(() => lines.some((line) => line.fake === "started"), "the fake CLI to start");
    const started = lines.find((line) => line.fake === "started")!;
    expect(started.argv).toEqual(["app-server"]);
    expect(started.leaked).toEqual([]);

    for (const line of [threadStart, strictTurn, agentTurn, "not json {", '{"id":1,"result":{}}']) child.stdin.write(`${line}\n`);
    child.stdin.end();
    await until(() => lines.some((line) => line.fake === "eof"), "the fake CLI to see the end of input");
    expect(await exit).toBe(0);

    const got = lines.filter((line) => line.fake === "got").map((line) => line.line!);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe(threadStart);
    expect(JSON.parse(got[1]!)).toEqual({
      ...JSON.parse(strictTurn),
      params: { ...JSON.parse(strictTurn).params, sandboxPolicy: { type: "readOnly", networkAccess: false } },
    });
    expect(got.slice(2)).toEqual([agentTurn, "not json {", '{"id":1,"result":{}}']);
    expect(lines.find((line) => line.fake === "eof")!.rest).toBe("");
  });

  it("runs from a command file under a path with a space and non-ASCII letters", async () => {
    const { child, lines, exit } = startLikeAdapter(shimCommandUnicode);
    await until(() => lines.some((line) => line.fake === "started"), "the fake CLI to start");
    const started = lines.find((line) => line.fake === "started")!;
    expect(started.argv).toEqual(["app-server"]);
    expect(started.leaked).toEqual([]);

    child.stdin.write(`${strictTurn}\n`);
    child.stdin.end();
    await until(() => lines.some((line) => line.fake === "eof"), "the fake CLI to see the end of input");
    expect(await exit).toBe(0);
    const got = lines.filter((line) => line.fake === "got").map((line) => JSON.parse(line.line!) as { params: { sandboxPolicy: unknown } });
    expect(got.map((message) => message.params.sandboxPolicy)).toEqual([{ type: "readOnly", networkAccess: false }]);
  });

  it("ends a CLI that outlives the end of its input after a bound", async () => {
    const { child, lines, exit } = startLikeAdapter(shimCommand, { FAKE_IGNORE_EOF: "1" });
    await until(() => lines.some((line) => line.fake === "started"), "the fake CLI to start");
    const pid = lines.find((line) => line.fake === "started")!.pid!;
    child.stdin.end();
    await until(() => lines.some((line) => line.fake === "eof"), "the fake CLI to see the end of input");
    const ended = Date.now();
    await exit;
    expect(Date.now() - ended).toBeLessThan(CODEX_SHIM_EXIT_BOUND_MS + 5_000);
    await until(() => !isAlive(pid), "the fake CLI to be gone", 5_000);
  });

  it("exits with the CLI's exit code", async () => {
    const { child, lines, exit } = startLikeAdapter();
    await until(() => lines.some((line) => line.fake === "started"), "the fake CLI to start");
    child.stdin.write("exit:7\n");
    expect(await exit).toBe(7);
  });

  it("keeps the real CLI in the broker's kill-on-close job (SC-136)", async () => {
    // As broker-job.test.ts: a holder process joins the job, never the test runner.
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { createKillOnCloseJob } from ${JSON.stringify(JOB_MODULE)};`,
      `const job = createKillOnCloseJob();`,
      `const child = spawn(${JSON.stringify(`"${shimCommand}" app-server`)}, { shell: true, windowsHide: true });`,
      `let text = "";`,
      `child.stdout.setEncoding("utf8");`,
      `const pid = await new Promise((done) => child.stdout.on("data", (chunk) => {`,
      `  text += chunk;`,
      `  const at = text.indexOf("\\n");`,
      `  if (at !== -1) done(JSON.parse(text.slice(0, at)).pid);`,
      `}));`,
      `const report = { cli: job.contains(pid) };`,
      `child.stdin.end();`,
      `await new Promise((done) => child.once("exit", done));`,
      `process.stdout.write(JSON.stringify(report));`,
    ].join("\n");
    const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { env: shimEnv(), windowsHide: true });
    let out = "";
    let err = "";
    holder.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    holder.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const code = await new Promise<number | null>((done) => holder.once("exit", done));

    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ cli: true });
  });
});
