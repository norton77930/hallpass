import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { conversationEnvNameSchema } from "@hallpass/contracts";
import { runCommand } from "./run-command.js";

/**
 * 023 R-369 (D-023-6, FR-369, FR-370): whether the variable Hermes reads its key from was set in the
 * owner's user settings after the browser started - so the browser, and every agent it starts, never
 * received it, and the fix is to quit the browser completely and open it again.
 *
 * Names only. Hermes' `config.yaml` gives the variable's name (its `model:` block's `key_env`, else
 * `api_key_env`); Hermes' own `.env` gives the names it defines itself (the text before `=`; a key
 * kept there reaches Hermes whatever the browser had); the user's environment settings give their
 * names through a query that prints names and nothing else. The environment the agent ran with is
 * asked only whether it has the name. No value is kept, compared, returned, logged or put in an
 * error: the files' text is parsed where it is read and dropped, and only a name leaves this module.
 *
 * Everything that touches the machine goes through `UserEnvironmentPorts`, so tests decide what the
 * machine holds.
 */

export type UserEnvironmentPorts = {
  /** A file's text; rejects when it cannot be read (not there, no access). */
  readText(path: string): Promise<string>;
  /**
   * Runs the names-only query to the end. May reject when it cannot be started. Aborted by `signal`
   * (024 R-374: a superseded readiness retry), it ends at once.
   */
  run(file: string, args: readonly string[], options?: { signal?: AbortSignal }): Promise<{ code: number | null; stdout: string }>;
};

/**
 * The value names under `HKCU\Environment` - the signed-in user's variables - one per line. Never
 * `reg query`, which prints every value with its name. Windows PowerShell by its full path: a browser
 * started with a broken PATH starts the broker with it too, and a bare name is looked for in the
 * working folder first (R-369).
 */
export const USER_ENVIRONMENT_NAMES_QUERY = {
  file: win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  args: ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item 'HKCU:\\Environment').GetValueNames()"],
} as const;

/** How long the query may take; the start or turn whose failure asked it waits for it. */
const QUERY_TIMEOUT_MS = 10_000;

export const defaultUserEnvironmentPorts: UserEnvironmentPorts = {
  readText: (path) => readFile(path, "utf8"),
  run: async (file, args, options) => {
    const { code, stdout } = await runCommand(file, args, {
      timeoutMs: QUERY_TIMEOUT_MS,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return { code, stdout };
  },
};

const isName = (text: string): boolean => conversationEnvNameSchema.safeParse(text).success;

/** Windows variable names do not depend on case. */
const sameName = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

type Env = Readonly<Record<string, string | undefined>>;

/** Hermes' home: `HERMES_HOME`, otherwise `%LOCALAPPDATA%\hermes` (R-369); unknown without either. */
export function hermesHome(env: Env): string | undefined {
  const set = env.HERMES_HOME?.trim();
  if (set) return set;
  return env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "hermes") : undefined;
}

/** A YAML scalar as written: the inside of quotes, else the text before a ` #` comment. */
function scalar(raw: string): string {
  const quoted = /^(["'])(.*?)\1/u.exec(raw);
  return quoted ? quoted[2]! : raw.replace(/\s+#.*$/u, "").trim();
}

/**
 * The variable named by the `model:` block's own `key_env`, else its `api_key_env` - lines read one by
 * one, no YAML library. Only the block's direct keys count; a value that is not a variable name is
 * nothing (it could be a key pasted in the wrong place).
 */
export function hermesKeyEnvName(config: string): string | undefined {
  const lines = config.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^model[ \t]*:[ \t]*(?:#.*)?$/u.test(line));
  if (start < 0) return undefined;
  const found = new Map<string, string>();
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
    const lead = /^[ \t]*/u.exec(line)![0].length;
    if (lead === 0) break;
    indent ??= lead;
    if (lead !== indent) continue;
    const key = /^[ \t]*(key_env|api_key_env)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (key === null || found.has(key[1]!)) continue;
    const name = scalar(key[2]!);
    if (isName(name)) found.set(key[1]!, name);
  }
  return found.get("key_env") ?? found.get("api_key_env");
}

/** The names a `.env` defines: each line's text before its first `=` (an `export ` prefix dropped). */
export function dotEnvNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const name = trimmed.slice(0, equals).replace(/^export\s+/u, "").trim();
    if (isName(name)) names.push(name);
  }
  return names;
}

/** The names of the user's environment settings; none when the query fails or `signal` ends it. */
export async function userEnvironmentNames(ports: UserEnvironmentPorts, signal?: AbortSignal): Promise<string[]> {
  try {
    const { file, args } = USER_ENVIRONMENT_NAMES_QUERY;
    const { code, stdout } = await (signal === undefined ? ports.run(file, args) : ports.run(file, args, { signal }));
    if (code !== 0) return [];
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(isName);
  } catch {
    return [];
  }
}

/**
 * The name of Hermes' key variable when it is in the user's settings but not in `env` (what the agent
 * ran with) and not defined in Hermes' own `.env`; otherwise nothing. The query runs only once there
 * is a name to look for.
 */
export async function keyNameOnlyInUserSettings(env: Env, ports: UserEnvironmentPorts): Promise<string | undefined> {
  const home = hermesHome(env);
  if (home === undefined) return undefined;
  const config = await ports.readText(win32.join(home, "config.yaml")).catch(() => undefined);
  const name = config === undefined ? undefined : hermesKeyEnvName(config);
  if (name === undefined) return undefined;
  if (Object.keys(env).some((key) => sameName(key, name) && env[key] !== undefined)) return undefined;
  const dotEnv = await ports.readText(win32.join(home, ".env")).catch(() => "");
  if (dotEnvNames(dotEnv).some((defined) => sameName(defined, name))) return undefined;
  const userNames = await userEnvironmentNames(ports);
  return userNames.some((user) => sameName(user, name)) ? name : undefined;
}
