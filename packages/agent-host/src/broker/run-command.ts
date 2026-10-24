import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

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

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 024 R-377: ended because `signal` was aborted. */
  aborted?: true;
  /**
   * 024 R-377: `signal` was aborted but the tree could not be ended, and it had not closed after
   * `ABORT_WAIT_MS` - so the command may still be running; never `aborted` then.
   */
  killFailed?: true;
};

/** 024 R-377: how long a cancelled command's tree is waited for after the kill, at most. */
export const ABORT_WAIT_MS = 5_000;

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process tree after this long (default 30 s). */
  timeoutMs?: number;
  /** Each chunk as it arrives, for progress. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * 024 R-377: aborted, the whole process tree is ended (taskkill /T /F) and the run answers
   * `aborted` once it has closed - or after `ABORT_WAIT_MS` if it does not.
   */
  signal?: AbortSignal;
  /** How the tree is ended on abort or timeout (default `killTreeAsync`); tests stand in for taskkill. */
  killTree?: (pid: number | undefined) => Promise<boolean>;
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

/**
 * `taskkill` by its full path: a browser started with a broken PATH starts the broker with it too,
 * and a bare name is looked for in the working folder first (as `USER_ENVIRONMENT_NAMES_QUERY`).
 */
export const TASKKILL = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

/** What `killTreeAsync` needs of the machine; tests stand in for it. */
export type KillPorts = {
  spawn: (file: string, args: readonly string[]) => { once(event: "error" | "close", listener: () => void): unknown };
  /** Ends one process (not its tree): the fallback when taskkill cannot start. */
  kill: (pid: number) => void;
};

const defaultKillPorts: KillPorts = {
  spawn: (file, args) => spawn(file, [...args], { stdio: "ignore", windowsHide: true }),
  kill: (pid) => process.kill(pid),
};

/**
 * `killTree` without holding the broker's event loop while taskkill runs (a second or more on a busy
 * machine): resolves once taskkill has ended the tree. 024 R-374 / R-377: a bounded check and a cancel
 * must not stall everything else the broker is doing meanwhile. When taskkill cannot be started, the
 * process itself is ended (its own children may then outlive it). `false` only when neither worked:
 * the process may still be running.
 */
export function killTreeAsync(pid: number | undefined, ports: KillPorts = defaultKillPorts): Promise<boolean> {
  if (!pid) return Promise.resolve(true);
  if (process.platform !== "win32") {
    killTree(pid);
    return Promise.resolve(true);
  }
  const killOne = (): boolean => {
    try {
      ports.kill(pid);
      return true;
    } catch (error) {
      // Already gone is what the kill was for.
      return (error as { code?: unknown }).code === "ESRCH";
    }
  };
  return new Promise<boolean>((done) => {
    let killer: ReturnType<KillPorts["spawn"]>;
    try {
      killer = ports.spawn(TASKKILL, ["/pid", String(pid), "/T", "/F"]);
    } catch {
      done(killOne());
      return;
    }
    killer.once("error", () => done(killOne()));
    killer.once("close", () => done(true));
  });
}

export function runCommand(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun, rejectRun) => {
    const { signal } = options;
    if (signal?.aborted === true) {
      resolveRun({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
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
    let aborted = false;
    let settled = false;
    let abortWait: NodeJS.Timeout | undefined;
    const endTree = options.killTree ?? ((pid: number | undefined) => killTreeAsync(pid));
    /** The tree's kill under way: the run answers once it is done, so nothing of the tree is left running. */
    let killing: Promise<boolean> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killing = endTree(child.pid);
    }, options.timeoutMs ?? 30_000);
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (abortWait !== undefined) clearTimeout(abortWait);
      signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (aborted || settled) return;
      aborted = true;
      const kill = endTree(child.pid);
      killing = kill;
      abortWait = setTimeout(() => {
        // Not closed yet: `aborted` only when the kill went through; a failed one may leave it running.
        void kill.then((killed) => {
          if (settle()) resolveRun({ code: null, stdout, stderr, timedOut, ...(killed ? { aborted: true as const } : { killFailed: true as const }) });
        });
      }, ABORT_WAIT_MS);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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
      if (settle()) rejectRun(error);
    });
    child.once("close", (code) => {
      void (killing ?? Promise.resolve(true)).then(() => {
        if (settle()) resolveRun({ code, stdout, stderr, timedOut, ...(aborted ? { aborted: true as const } : {}) });
      });
    });
  });
}
