import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { AGENT_HOST_NAME } from "./manifest.js";

/**
 * 028 (issue #1, FR-434): the host's registration on macOS and Linux. There is no registry: Chrome and
 * its kin look for `<host name>.json` in a fixed per-user folder of their own, and start the manifest's
 * `path` directly. One folder per browser, as `windows.ts` has one registry root per browser.
 *
 * A browser whose own per-user folder does not exist is not installed (or never started), so nothing is
 * created for it: the output says it was skipped, rather than leaving folders of browsers the owner
 * does not have.
 */

export type PosixPlatform = "darwin" | "linux";
export type PosixEnvironment = { HOME?: string | undefined; XDG_CONFIG_HOME?: string | undefined };

/** Each browser's own per-user folder, below Application Support (macOS) or the config folder (Linux). */
const BROWSERS: ReadonlyArray<{ browser: string; darwin: readonly string[]; linux: readonly string[] }> = [
  { browser: "Chrome", darwin: ["Google", "Chrome"], linux: ["google-chrome"] },
  { browser: "Chromium", darwin: ["Chromium"], linux: ["chromium"] },
  { browser: "Edge", darwin: ["Microsoft Edge"], linux: ["microsoft-edge"] },
  { browser: "Brave", darwin: ["BraveSoftware", "Brave-Browser"], linux: ["BraveSoftware", "Brave-Browser"] },
];

export type NativeMessagingFolder = { browser: string; profile: string; folder: string };

export function nativeMessagingFolders(platform: PosixPlatform, env: PosixEnvironment): NativeMessagingFolder[] {
  const home = env.HOME ?? "";
  const base =
    platform === "darwin"
      ? posix.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
        ? env.XDG_CONFIG_HOME
        : posix.join(home, ".config");
  return BROWSERS.map((entry) => {
    const profile = posix.join(base, ...entry[platform]);
    return { browser: entry.browser, profile, folder: posix.join(profile, "NativeMessagingHosts") };
  });
}

export type PosixOutcome = {
  browser: string;
  folder: string;
  outcome: "written" | "skipped" | "failed" | "removed" | "absent";
  reason?: string;
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const manifestIn = (folder: string): string => posix.join(folder, `${AGENT_HOST_NAME}.json`);

/** FR-434: the manifest in each installed browser's folder; idempotent (the file is rewritten). */
export async function registerPosix(folders: readonly NativeMessagingFolder[], manifestJson: string): Promise<PosixOutcome[]> {
  const outcomes: PosixOutcome[] = [];
  for (const { browser, profile, folder } of folders) {
    if (!(await exists(profile))) {
      outcomes.push({ browser, folder, outcome: "skipped" });
      continue;
    }
    try {
      await mkdir(folder, { recursive: true });
      await writeFile(manifestIn(folder), manifestJson, "utf8");
      outcomes.push({ browser, folder, outcome: "written" });
    } catch (error) {
      outcomes.push({ browser, folder, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** The uninstall's part: each manifest goes; the browsers' own folders stay. */
export async function unregisterPosix(folders: readonly NativeMessagingFolder[]): Promise<PosixOutcome[]> {
  const outcomes: PosixOutcome[] = [];
  for (const { browser, folder } of folders) {
    const file = manifestIn(folder);
    if (!(await exists(file))) {
      outcomes.push({ browser, folder, outcome: "absent" });
      continue;
    }
    await rm(file, { force: true });
    outcomes.push({ browser, folder, outcome: "removed" });
  }
  return outcomes;
}
