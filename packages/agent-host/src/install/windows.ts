import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_HOST_NAME } from "./manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Where Chrome looks for a native-messaging host manifest on Windows.
 *
 * Two keys, not one: branded Chrome reads the `Google\Chrome` root and Chromium builds - including
 * the bundled Chromium every packaged test runs against - read the `Chromium` root. Registering
 * only the first makes the host work for the owner and silently not exist for the test gates, which
 * is the worst of the two failures because it looks like a bridge bug rather than a missing
 * registration.
 *
 * `HKCU`, never `HKLM`: a per-user registration needs no elevation (R-101).
 */
export const NATIVE_MESSAGING_ROOTS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts",
] as const;

export const NATIVE_MESSAGING_REGISTRY_KEYS = [
  `${NATIVE_MESSAGING_ROOTS[0]}\\${AGENT_HOST_NAME}`,
  `${NATIVE_MESSAGING_ROOTS[1]}\\${AGENT_HOST_NAME}`,
] as const;

/** `reg query` of a root alone lists its subkeys, one per line, as full key paths. */
export function registryListArguments(root: string): string[] {
  return ["query", root];
}

/**
 * The subkey names under `root` from a `reg query <root>` listing; other lines are ignored.
 *
 * `reg.exe` prints every key with its hive spelled out (`HKEY_CURRENT_USER\...`) even when it was
 * asked with the short alias (`HKCU\...`), so both spellings of the root are accepted.
 */
export function parseRegistrySubkeys(root: string, output: string): string[] {
  const long = root.replace(/^HKCU(?=\\)/i, "HKEY_CURRENT_USER");
  const prefixes = [`${root}\\`.toLowerCase(), `${long}\\`.toLowerCase()];
  const names: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const prefix = prefixes.find((candidate) => line.toLowerCase().startsWith(candidate));
    if (prefix) names.push(line.slice(prefix.length));
  }
  return names;
}

/**
 * A native-messaging registration left behind by an earlier version of this host (009/FR-126).
 *
 * The rule is a property, not a remembered name: a manifest that allows *exactly* our extension's
 * origin and nothing else can only have been written by us, and one whose name is not the name we
 * register today is from a version that used another. Naming the old host here would put a legacy
 * identifier into the shipped installer, which the identity test forbids; the rule needs none.
 */
export function isLegacyRegistration(
  manifest: { name?: unknown; allowed_origins?: unknown },
  ourOrigins: readonly string[],
  currentName: string,
): boolean {
  if (typeof manifest.name !== "string" || manifest.name === currentName) return false;
  if (!Array.isArray(manifest.allowed_origins)) return false;
  const origins = manifest.allowed_origins.filter((origin): origin is string => typeof origin === "string");
  return (
    origins.length === manifest.allowed_origins.length &&
    origins.length === ourOrigins.length &&
    ourOrigins.every((origin) => origins.includes(origin))
  );
}

/**
 * `reg add` for one key. The manifest path is the key's *default* value (`/ve`), which is what
 * Chrome reads; `/f` makes a re-install overwrite rather than prompt, so installing twice is the
 * same as installing once.
 *
 * Arguments are built as an array and handed to `execFile`, never concatenated into a shell string:
 * the manifest path contains backslashes and may contain spaces, and a shell would be a second
 * parser between this list and `reg.exe`.
 */
export function registryAddArguments(key: string, manifestPath: string): string[] {
  return ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

/** `reg delete` for one key. `/f` so removing a key that is already gone is not an interactive prompt. */
export function registryDeleteArguments(key: string): string[] {
  return ["delete", key, "/f"];
}

/** `reg query` for one key, used by `status` to report what is actually registered. */
export function registryQueryArguments(key: string): string[] {
  return ["query", key, "/ve"];
}

export async function runReg(args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await execFileAsync("reg.exe", args, { windowsHide: true });
    return { ok: true, output: stdout };
  } catch (error) {
    // `reg.exe` exits non-zero for "no such key", which is a normal answer for `delete` and
    // `query`; the caller decides whether that is a failure, so the message travels rather than
    // an exception.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: message };
  }
}
