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
 * The stable identity of *this machine's* agent installation.
 *
 * The owner pairs an agent once and expects the next session not to ask again (SC-020), so the id
 * has to outlive the process. It is created once and never rewritten; a new id would read to the
 * worker as a new agent and would ask the owner to pair again.
 */
export function agentIdFilePath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "agent-id");
}
