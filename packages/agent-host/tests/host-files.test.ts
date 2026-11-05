import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHostFileAtomically } from "../src/bridge-link.js";
import { ensurePrivateDirectory } from "../src/host-files.js";
import { bridgeFilePath, hostDataDirectory } from "../src/host-paths.js";
import { createUploadConfigStore } from "../src/upload-config-store.js";

/**
 * Security review 2026-11-05 S2 — the host data directory and every file in it are the owner's alone.
 *
 * The relay token and the owner's agent id live here, and together they are the whole admission to
 * the owner's browser. On Linux nothing above this directory keeps another account out, so the
 * directory must do it itself: 0700, and the files 0600. Mode bits mean nothing on Windows, so
 * the assertions run elsewhere; the calls are the same there and are exercised by every other test.
 */
const posix = process.platform !== "win32";

/** The group and other bits: the ones that let another account in. */
const OTHERS = 0o077;

describe("host data files are owner-only", () => {
  let root = "";
  let env: { LOCALAPPDATA: string };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hallpass-host-files-"));
    env = { LOCALAPPDATA: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(posix)("creates the data directory 0700 and a record 0600 (bridge.json)", async () => {
    await writeHostFileAtomically(bridgeFilePath(env), { port: 1, token: "t".repeat(64), relayPid: 1, startedAt: "x", protocol: 2 });

    const directory = await stat(hostDataDirectory(env));
    expect(directory.mode & OTHERS).toBe(0);
    const record = await stat(bridgeFilePath(env));
    expect(record.mode & OTHERS).toBe(0);
  });

  it.runIf(posix)("repairs an existing world-readable data directory to 0700", async () => {
    // An installation from before the rule: the umask's 0755.
    await mkdir(hostDataDirectory(env), { recursive: true });
    await chmod(hostDataDirectory(env), 0o755);

    await ensurePrivateDirectory(hostDataDirectory(env));

    expect((await stat(hostDataDirectory(env))).mode & OTHERS).toBe(0);
  });

  it.runIf(posix)("writes the upload roots list 0600", async () => {
    const store = createUploadConfigStore(env);
    const folder = join(root, "uploads");
    await mkdir(folder);

    const change = await store.add([folder]);

    expect(change.written).toBe(true);
    expect((await stat(store.path())).mode & OTHERS).toBe(0);
    expect((await stat(hostDataDirectory(env))).mode & OTHERS).toBe(0);
  });
});
