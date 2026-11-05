import { chmodSync, mkdirSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";

/**
 * The owner-only modes of everything under the host data directory (security review 2026-11-05 S2).
 *
 * The directory holds the relay's loopback token (`browsers/<id>.json`, `bridge.json`), the owner's
 * agent id (`agent-id`, which to the worker *is* the pairing), the upload roots and the relay log.
 * On Windows `%LOCALAPPDATA%` carries a per-user ACL and on macOS `~/Library` is 0700, so the files
 * were private by where they lived. Linux has no such floor: `~/.local/share` is created with the
 * umask, 0755 on several distributions, and a file written with the default mode is 0644 - readable
 * by every other account on the machine. Another local user who reads the token and the agent id
 * can greet the relay as the owner's already-paired agent, and no card stands in the way
 * (`relay-mux.ts` checks token equality; `pairing-controller.ts` admits a paired id).
 *
 * So the directory is created 0700 and every file 0600, on every platform (Windows ignores the
 * mode bits, which is the right thing there). An *existing* directory is repaired to 0700 too, because
 * `mkdir` with a mode sets it only on creation and an installation from before this rule has the
 * umask's mode; the directory's own bits are what keep another account out of every file inside,
 * so repairing the one directory is enough for the files already written.
 */
export const HOST_DIRECTORY_MODE = 0o700;
export const HOST_FILE_MODE = 0o600;

/** Creates the host data directory (or one below it) owner-only, and repairs an existing one's mode. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: HOST_DIRECTORY_MODE });
  if (process.platform === "win32") return;
  // Recursive `mkdir` creates missing parents with the same mode; the parents it did not create are the
  // owner's own (`~/.local/share`) and are left alone. Only the directory named is repaired.
  await chmod(path, HOST_DIRECTORY_MODE).catch(() => undefined);
}

/** The synchronous twin, for the two processes that set up their log before anything else runs. */
export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: HOST_DIRECTORY_MODE });
  if (process.platform === "win32") return;
  try {
    chmodSync(path, HOST_DIRECTORY_MODE);
  } catch {
    // A directory this process cannot chmod is one it did not create; its mode is not this process's to fix.
  }
}
