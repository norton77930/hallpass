import { readFile } from "node:fs/promises";
import { win32 } from "node:path";

/**
 * What the broker needs to know of the owner's own Codex settings (019 R-322, T566): whether they
 * hold an MCP server named `hallpass`, and which of its own keys it sets.
 *
 * Codex deep-merges the panel's session entry over the owner's entry of the same name, and the
 * adapter hands Codex only `command`, `args` and `env` of a session entry. An owner entry that a
 * command entry cannot be merged over - a `url` (HTTP transport) or one switched off - makes the
 * panel take its own name instead (`browser-token.ts`).
 *
 * The file is only read, and nothing of it leaves this module but key names: never a value, never
 * a log line. It is a deliberately small TOML reader for this one question - table headers, dotted
 * keys and one-line inline tables - not a TOML parser; anything it cannot follow (an entry nested in
 * `mcp_servers = { ... }`, a table spread over lines) is not an entry. It reads the user-level file
 * only: a project's own `.codex/config.toml` layer is not looked at.
 */

/** `%CODEX_HOME%\config.toml`, else `%USERPROFILE%\.codex\config.toml` - where Codex itself reads it. */
export function codexConfigPath(env: { CODEX_HOME?: string | undefined; USERPROFILE?: string | undefined }): string | undefined {
  if (env.CODEX_HOME) return win32.join(env.CODEX_HOME, "config.toml");
  if (env.USERPROFILE) return win32.join(env.USERPROFILE, ".codex", "config.toml");
  return undefined;
}

export type OwnerHallpassEntry = {
  /** The entry's own top-level keys (`url`, `command`, `env`, ...). */
  keys: ReadonlySet<string>;
  /** `enabled`, when the entry says it as a plain boolean. */
  enabled?: boolean;
};

const ENTRY_PATH = ["mcp_servers", "hallpass"] as const;

/** Keys of the HTTP transport: a command entry merged over any of them is no longer a command entry. */
const HTTP_KEYS = new Set(["url", "bearer_token", "bearer_token_env_var", "http_headers", "env_http_headers"]);

/** Whether a session entry named `hallpass` cannot replace this owner entry by a deep merge. */
export function cannotMergeOver(entry: OwnerHallpassEntry | undefined): boolean {
  if (entry === undefined) return false;
  return entry.enabled === false || [...entry.keys].some((key) => HTTP_KEYS.has(key));
}

/** The text before an unquoted `#`. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

/** A dotted key (`a . "b" . c`) as its parts, or undefined when it is not one. */
function keyPath(text: string): string[] | undefined {
  const parts: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]!);
    if (match[4] === "") return parts;
  }
  return parts.length > 0 && pattern.lastIndex >= text.length ? parts : undefined;
}

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((part, index) => path[index] === part);

/** The top-level keys of a one-line inline table `{ a = 1, b.c = "x" }` and its plain `enabled`. */
function inlineTable(value: string, entry: { keys: Set<string>; enabled?: boolean }): void {
  const body = /^\{(.*)\}$/su.exec(value.trim())?.[1];
  if (body === undefined) return;
  // Strings first, so a comma or `=` inside one does not split anything.
  const plain = body.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/gu, '""');
  let depth = 0;
  let start = 0;
  const pairs: string[] = [];
  for (let index = 0; index <= plain.length; index++) {
    const char = plain[index];
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if ((char === "," && depth === 0) || index === plain.length) {
      pairs.push(plain.slice(start, index));
      start = index + 1;
    }
  }
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const key = keyPath(pair.slice(0, at))?.[0];
    if (key === undefined) continue;
    entry.keys.add(key);
    if (key === "enabled") {
      const flag = pair.slice(at + 1).trim();
      if (flag === "true" || flag === "false") entry.enabled = flag === "true";
    }
  }
}

/** The owner's `[mcp_servers.hallpass]`, in whichever of TOML's ways it is written; undefined when absent. */
export function findOwnerHallpass(toml: string): OwnerHallpassEntry | undefined {
  const entry: { keys: Set<string>; enabled?: boolean } = { keys: new Set() };
  let found = false;
  let table: string[] = [];
  for (const raw of toml.split(/\r?\n/u)) {
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;
    const header = /^\[(\[)?(.*?)\]?\]$/u.exec(line);
    if (header !== null && !line.includes("=")) {
      // An array of tables is never the entry; its keys go nowhere.
      table = header[1] === undefined ? (keyPath(header[2]!) ?? []) : ["[[array]]"];
      if (startsWith(table, ENTRY_PATH)) {
        found = true;
        if (table.length > ENTRY_PATH.length) entry.keys.add(table[ENTRY_PATH.length]!);
      }
      continue;
    }
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = keyPath(line.slice(0, at));
    if (key === undefined) continue;
    const path = [...table, ...key];
    const value = line.slice(at + 1).trim();
    if (path.length === ENTRY_PATH.length && startsWith(path, ENTRY_PATH)) {
      found = true;
      inlineTable(value, entry);
    } else if (path.length > ENTRY_PATH.length && startsWith(path, ENTRY_PATH)) {
      found = true;
      const own = path[ENTRY_PATH.length]!;
      entry.keys.add(own);
      if (own === "enabled" && path.length === ENTRY_PATH.length + 1 && (value === "true" || value === "false")) {
        entry.enabled = value === "true";
      }
    }
  }
  return found ? { keys: entry.keys, ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) } : undefined;
}

/** Reads the owner's Codex config at `path`; a missing or unreadable file holds no entry. */
export async function readOwnerHallpass(
  path: string | undefined,
  readText: (path: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<OwnerHallpassEntry | undefined> {
  if (path === undefined) return undefined;
  try {
    return findOwnerHallpass(await readText(path));
  } catch {
    return undefined;
  }
}
