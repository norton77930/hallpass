import { spawn, spawnSync } from "node:child_process";

/**
 * Run a command to completion and collect what it printed (019/T531, T533: `--version` of the
 * owner's CLI, `npm ci`). The only thing here that is not obvious is `.cmd`.
 *
 * `codex.cmd` and `npm.cmd` are batch files, and since Node 20.12 `spawn` refuses a batch file
 * without a shell (EINVAL, the CVE-2024-27980 fix). So a `.cmd` / `.bat` goes through
 * `cmd.exe /d /s /c "<file> <args>"` with verbatim arguments - and because that line is parsed by
 * cmd.exe, a file or argument containing a quote, a percent sign or a line break is refused rather
 * than escaped: every caller passes fixed flags and a path it found itself, so a refusal is a bug
 * or a hostile path, never a case worth supporting.
 */

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process tree after this long (default 30 s). */
  timeoutMs?: number;
  /** Each chunk as it arrives, for progress. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
};

/** How much of each stream is kept: the end, which is where errors are. */
const KEEP_CHARS = 64 * 1024;

const isBatch = (file: string) => /\.(cmd|bat)$/i.test(file);
const UNSAFE_FOR_CMD = /["%\r\n\0]/;

const keepTail = (current: string, chunk: string) => {
  const next = current + chunk;
  return next.length > KEEP_CHARS ? next.slice(next.length - KEEP_CHARS) : next;
};

/** End a process and everything it started (taskkill /T on Windows). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function runCommand(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun, rejectRun) => {
    let command = file;
    let argv = [...args];
    let verbatim = false;
    if (isBatch(file)) {
      if ([file, ...args].some((part) => UNSAFE_FOR_CMD.test(part))) {
        rejectRun(new Error("refusing to pass a quote, percent sign or line break to cmd.exe"));
        return;
      }
      const quote = (part: string) => (/[\s&|<>^()]/.test(part) ? `"${part}"` : part);
      command = process.env.ComSpec ?? "cmd.exe";
      argv = ["/d", "/s", "/c", `"${[file, ...args].map(quote).join(" ")}"`];
      verbatim = true;
    }
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = keepTail(stdout, chunk);
      options.onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = keepTail(stderr, chunk);
      options.onOutput?.("stderr", chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}
