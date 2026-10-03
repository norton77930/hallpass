import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where every file the host owns lives, derived once.
 *
 * Four different processes look for these files - the installer writes two of them, Chrome reads
 * the manifest through the registry, and since R-111 the relay Chrome spawns is the single writer
 * of `bridge.json` while every MCP server reads it to find the relay to dial - and none of them can
 * ask another where they are. A single derivation from the environment is what keeps the four in
 * agreement; a second hand-written path is how a server ends up dialling a file no relay wrote.
 *
 * The environment is a parameter rather than a read of `process.env` so the derivation is a pure
 * function under test: the directory this resolves to on the developer's machine is not something a
 * unit test may depend on.
 */
export type HostEnvironment = { LOCALAPPDATA?: string | undefined };

/** The per-user data directory. `%LOCALAPPDATA%` on Windows; the same place by hand if it is unset. */
export function hostDataDirectory(env: HostEnvironment = process.env): string {
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "hallpass");
}

/** Chrome's native-messaging host manifest, named after the host so the registry value is obvious. */
export function hostManifestPath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "com.hallpass.host.json");
}

/** The `.cmd` shim Chrome actually spawns - Windows cannot spawn a `.js` file (R-101). */
export function launcherPath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "native-host.cmd");
}

/**
 * Where the MCP server publishes the loopback endpoint the relay connects back to.
 *
 * It is a file rather than a fixed port because the server takes an ephemeral port: a fixed port
 * would collide between two agent sessions and would be guessable by any other local process.
 */
export function bridgeFilePath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "bridge.json");
}

/**
 * Which browser run the relay in `bridge.json` belongs to (two browsers, 2026-10-02).
 *
 * Beside the record rather than inside it: servers parse the record strictly, so only relays read
 * this file, to tell their own browser's previous relay from another browser's.
 */
export function bridgeOwnerFilePath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "bridge-owner.json");
}

/**
 * Where each browser's relay writes its own record, `<browserId>.json` (018 R-266).
 *
 * A directory rather than one more file beside `bridge.json`, because there is one writer per
 * browser now and N browsers: each relay owns exactly its own file, and a server lists the folder
 * to see every connected browser. `bridge.json` stays where it is for servers older than 018 (R-277).
 */
export function browsersDirectory(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "browsers");
}

/**
 * Where the browser each agent chose last is remembered, `<agentId>.json` (018 R-271, D-018-11).
 *
 * One file per agent so that a later key cannot lose another agent's update; the agent id is the
 * per-Windows-user id `agentIdFilePath` holds, so every agent of one user shares the choice.
 */
export function browserChoicesDirectory(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "choices");
}

/**
 * The stable identity of *this machine's* agent installation.
 *
 * The owner pairs an agent once and expects the next session not to ask again (SC-020), so the id
 * has to outlive the process. It is created once and never rewritten; a new id would read to the
 * worker as a new agent and would ask the owner to pair again.
 */
export function agentIdFilePath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "agent-id");
}

/**
 * Whether a name is one of Windows' reserved device names (018 T507 m4).
 *
 * `NUL.json`, `COM1.json` and their kin name the device, not a file in the folder - whatever the
 * case, and whatever extension follows. An id that becomes a file name (an agent id in `choices/`, a
 * browser id in `browsers/`) is refused as one, rather than read from or written to a device.
 */
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export function isWindowsDeviceName(name: string): boolean {
  return WINDOWS_DEVICE_NAME.test(name);
}
