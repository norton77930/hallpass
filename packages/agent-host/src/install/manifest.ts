import { fileURLToPath } from "node:url";

/**
 * The two files Chrome needs in order to spawn this host: its manifest and the launcher the
 * manifest points at. Both are produced as values here, so the installer's only job is to write
 * them and the tests can assert their content without touching the machine.
 */

/**
 * Chrome's host-name rule is lowercase alphanumerics, dots and underscores; a dash would make
 * `connectNative` fail with a name the worker cannot distinguish from a missing installation.
 */
export const AGENT_HOST_NAME = "com.hallpass.host";

/**
 * What the owner sees beside the host in Chrome's native-messaging registration.
 *
 * It names the relay's job as 004/R-111 left it: Chrome spawns this host, and the host is the
 * side that *listens* and publishes the loopback record every agent session dials. Before 004 the
 * agent listened and the host dialled, which is why the description says which way round it is.
 */
export const AGENT_HOST_DESCRIPTION =
  "Local agent bridge relay for Hallpass: publishes the loopback record that agent sessions dial";

/**
 * The only extension allowed to spawn this host.
 *
 * This is the test-build extension id from `apps/extension/src/build-config.ts`
 * (`TEST_BUILD_EXTENSION_ID`, pinned by `TEST_BUILD_PUBLIC_KEY`). It is written out rather than
 * imported because `@hallpass/test-kit` is a dev dependency and this package is what the *installed*
 * host runs from; a production identity gets its own entry when there is one to add.
 *
 * Chrome's origin check is the outer gate on the whole bridge: without it any extension on the
 * machine could spawn the host and reach the agent's link.
 */
export const AGENT_HOST_ALLOWED_ORIGINS = [
  "chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/",
] as const;

export type NativeHostManifest = {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
};

/** The manifest for a launcher at `launcherPath`; the path must be absolute (Chrome will not resolve it). */
export function createNativeHostManifest(launcherPath: string): NativeHostManifest {
  return {
    name: AGENT_HOST_NAME,
    description: AGENT_HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: [...AGENT_HOST_ALLOWED_ORIGINS],
  };
}

/**
 * The `.cmd` shim, with the entry path resolved at install time.
 *
 * `%*` forwards the arguments Chrome appends (the calling extension's origin and, on Windows, the
 * parent window handle). They are not read here, but a host that swallowed them would be lying to
 * anything that later wants them, and Chrome's own examples pass them through.
 */
export function createLauncherScript(hostEntryPath: string): string {
  return ["@echo off", `node "${hostEntryPath}" %*`, ""].join("\r\n");
}

/**
 * Where the relay's entry point is, relative to the installer module itself (007/T201).
 *
 * Two layouts exist. In the repository the installer is `dist/install/cli.js` and the relay is one
 * directory up; in the QA package both are bundled flat into `host/`, so the relay is a sibling.
 * The sibling wins when it exists because that is the only layout in which it can exist at all.
 * The working directory is never consulted: Chrome spawns the launcher with no useful cwd.
 */
export function resolveRelayEntryPath(moduleUrl: string, exists: (path: string) => boolean): string {
  const sibling = fileURLToPath(new URL("./native-host.js", moduleUrl));
  if (exists(sibling)) {
    return sibling;
  }
  return fileURLToPath(new URL("../native-host.js", moduleUrl));
}
