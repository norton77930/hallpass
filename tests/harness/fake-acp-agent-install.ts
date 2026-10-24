import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 024 T741 (R-376, R-377, R-378): a stand-in for an agent's `npm ci` that takes its time, for broker
 * tests of install progress, cancel and interruption. It writes `files` files of `bytesPerFile` bytes
 * into `target`, evenly over `seconds`, and then the done marker; the tree grows steadily, so a
 * size-sampling progress estimate has something to read. Killed part way, it leaves the files written
 * so far and no marker - what a cancelled or interrupted download leaves behind.
 *
 * 024 T791, the lockfile mode (`fakeLockfileInstall`, `--lockfile`): what the broker's
 * `HALLPASS_BROKER_TEST_INSTALL` runs in place of `npm ci`, in the install tree the broker prepared.
 * It reads that tree's `package-lock.json` and writes each `node_modules/...` entry's `package.json`
 * (its name and locked version) evenly over `seconds`, then the done marker - so the broker's own
 * estimate (package folders against the lockfile), its check of the pinned package and its pointer
 * all see what a real `npm ci` would leave, only slower or faster.
 *
 * In-process: `await fakeSlowInstall({ target, files, seconds, signal })` (rejects when aborted),
 * `await fakeLockfileInstall({ dir, seconds, signal })`.
 * As a process (imports only `node:` modules, so it runs under `--experimental-strip-types`):
 *
 *     node --experimental-strip-types tests/harness/fake-acp-agent-install.ts <target> <seconds> [files] [bytesPerFile]
 *     node --experimental-strip-types tests/harness/fake-acp-agent-install.ts --lockfile [seconds]     (in the tree)
 *
 * In the lockfile mode without `seconds`: `FAKE_INSTALL_SECONDS` from the `FAKE_ACP_SWITCH_FILE` JSON
 * (read at start, as `fake-acp-agent-switch.ts` reads it), else from the environment, else 20.
 */

export const FAKE_INSTALL_DONE_MARKER = ".fake-install-done";

export type FakeSlowInstallOptions = {
  target: string;
  /** Default 10. */
  files?: number;
  /** Default 5. */
  seconds?: number;
  /** Default 64 KiB. */
  bytesPerFile?: number;
  signal?: AbortSignal;
};

const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((done, fail) => {
    if (signal?.aborted) return fail(new Error("fake install aborted"));
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        fail(new Error("fake install aborted"));
      },
      { once: true },
    );
  });

export async function fakeSlowInstall(options: FakeSlowInstallOptions): Promise<void> {
  const files = options.files ?? 10;
  const seconds = options.seconds ?? 5;
  const bytes = options.bytesPerFile ?? 64 * 1024;
  const step = (seconds * 1000) / files;
  mkdirSync(options.target, { recursive: true });
  for (let index = 1; index <= files; index += 1) {
    await pause(step, options.signal);
    writeFileSync(join(options.target, `file-${index}.bin`), Buffer.alloc(bytes, index % 256));
  }
  writeFileSync(join(options.target, FAKE_INSTALL_DONE_MARKER), "");
}

export type FakeLockfileInstallOptions = {
  /** The install tree: holds `package-lock.json`, gets `node_modules`. */
  dir: string;
  /** Default 20. */
  seconds?: number;
  signal?: AbortSignal;
};

/** Every `node_modules/...` entry of the lockfile, with the name and version its `package.json` gets. */
export function lockfilePackages(lockText: string): { key: string; name: string; version: string }[] {
  const packages = (JSON.parse(lockText) as { packages?: Record<string, { name?: unknown; version?: unknown }> }).packages ?? {};
  return Object.entries(packages)
    .filter(([key]) => key.startsWith("node_modules/"))
    .map(([key, entry]) => ({
      key,
      name: typeof entry.name === "string" ? entry.name : key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length),
      version: typeof entry.version === "string" ? entry.version : "0.0.0",
    }));
}

/** Writes the lockfile's package folders into `dir` over `seconds`; resolves with how many it wrote. */
export async function fakeLockfileInstall(options: FakeLockfileInstallOptions): Promise<number> {
  const entries = lockfilePackages(readFileSync(join(options.dir, "package-lock.json"), "utf8"));
  const step = ((options.seconds ?? 20) * 1000) / Math.max(entries.length, 1);
  for (const entry of entries) {
    await pause(step, options.signal);
    const folder = join(options.dir, ...entry.key.split("/"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: entry.name, version: entry.version })}\n`);
  }
  writeFileSync(join(options.dir, FAKE_INSTALL_DONE_MARKER), "");
  return entries.length;
}

/** `FAKE_INSTALL_SECONDS` of the switch file, else of the environment. */
export function lockfileSeconds(env: Record<string, string | undefined>): number | undefined {
  let value = env.FAKE_INSTALL_SECONDS;
  if (env.FAKE_ACP_SWITCH_FILE) {
    try {
      const overrides = JSON.parse(readFileSync(env.FAKE_ACP_SWITCH_FILE, "utf8")) as Record<string, unknown> | null;
      const switched = overrides?.FAKE_INSTALL_SECONDS;
      if (typeof switched === "string") value = switched;
    } catch {
      // No switch file, or not one: the environment decides.
    }
  }
  const seconds = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--lockfile") {
    const given = rest[0] === undefined ? Number.NaN : Number(rest[0]);
    const seconds = Number.isFinite(given) ? given : lockfileSeconds(process.env);
    fakeLockfileInstall({ dir: process.cwd(), ...(seconds === undefined ? {} : { seconds }) }).then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`fake install failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  } else {
    const [target, seconds, files, bytesPerFile] = process.argv.slice(2);
    if (!target) {
      process.stderr.write("usage: fake-acp-agent-install.ts <target> <seconds> [files] [bytesPerFile] | --lockfile [seconds]\n");
      process.exit(2);
    }
    fakeSlowInstall({
      target,
      ...(seconds === undefined ? {} : { seconds: Number(seconds) }),
      ...(files === undefined ? {} : { files: Number(files) }),
      ...(bytesPerFile === undefined ? {} : { bytesPerFile: Number(bytesPerFile) }),
    }).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
}
