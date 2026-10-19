import { readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { CONVERSATION_MAX_ENTRIES, conversationEntrySchema, type ConversationEntry } from "@hallpass/contracts";
import { writeHostFileAtomically } from "../bridge-link.js";
import type { ConversationIndex } from "./conversation-index.js";

/**
 * The conversation index as a host file (019 T560; R-319, FR-304, data-model "Conversation index"):
 * `<data>\conversations.json` = `{ "version": 1, "entries": ConversationEntry[] }`.
 *
 * - One writer per write, the broker; every change re-reads the file first and writes temp + rename
 *   (`writeHostFileAtomically`), so the brokers of two browsers (018) keep each other's entries.
 * - Every write keeps at most 50 entries, the most recently used, and drops those unused for 30 days
 *   (D-019-6). Reads apply the same rule, so the list never shows what the next write would drop.
 * - A file that does not parse - not JSON, an unknown field, another version - is kept aside as
 *   `conversations.json.bad-<time>` and the index starts empty; that is logged and reported through
 *   `onNotice` ("conversation list could not be read"), never silent; `notice()` keeps the code for
 *   the overview (T563).
 * - It stores no content: the entry is all there is (D-019-6).
 */

export const INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function conversationIndexPath(dataDir: string): string {
  return join(dataDir, "conversations.json");
}

const indexFileSchema = z.strictObject({ version: z.literal(1), entries: z.array(conversationEntrySchema) });

export type IndexNotice = { code: "index-unreadable"; keptAs: string; text: string };
/** T563: the code the overview carries (contracts `CONVERSATION_LIST_NOTICES`); never `keptAs` or text. */
export type ConversationListNotice = IndexNotice["code"];

/**
 * The file-backed index, plus its list notice (T563): `index-unreadable` from the read that kept a
 * corrupt file aside until a later write succeeds - the new list has then been started, and a write
 * whose own re-read found the file does not count, so the notice is never raised and gone at once.
 */
export type FileConversationIndex = ConversationIndex & { notice(): ConversationListNotice | undefined };

export type FileConversationIndexOptions = {
  path: string;
  now?: () => number;
  onNotice?: (notice: IndexNotice) => void;
  log?: (code: string, detail?: string) => void;
};

/** D-019-6: newest 50 by last use, nothing older than 30 days. */
export function pruneEntries(entries: readonly ConversationEntry[], now: number): ConversationEntry[] {
  return entries
    .filter((entry) => !(now - Date.parse(entry.lastUsedAt) > INDEX_MAX_AGE_MS))
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
    .slice(0, CONVERSATION_MAX_ENTRIES);
}

export type HostJsonRead<T> = { kind: "ok"; value: T } | { kind: "absent" } | { kind: "kept-aside"; keptAs: string };

/**
 * Reads a small host JSON file against a closed schema. Absent is `absent`; anything that does not
 * parse is renamed to `<file>.bad-<time>` (kept for the owner, never deleted) and reported as such.
 * Shared by the index and the folder list (T560, T562).
 */
export async function readHostJsonFile<T>(path: string, schema: z.ZodType<T>, now: number): Promise<HostJsonRead<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let parsed: z.ZodSafeParseResult<T> | undefined;
  try {
    parsed = schema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success) return { kind: "ok", value: parsed.data };
  const keptAs = `${basename(path)}.bad-${new Date(now).toISOString().replace(/[:.]/gu, "-")}`;
  try {
    await rename(path, join(path, "..", keptAs));
  } catch (error) {
    // Another broker kept it aside first: the file is gone either way.
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return { kind: "kept-aside", keptAs };
}

export function fileConversationIndex(options: FileConversationIndexOptions): FileConversationIndex {
  const { path } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  /** This broker's changes, one at a time; the file's re-read covers the other brokers. */
  let queue: Promise<unknown> = Promise.resolve();
  let notice: ConversationListNotice | undefined;

  const read = async (): Promise<ConversationEntry[]> => {
    const result = await readHostJsonFile(path, indexFileSchema, now());
    switch (result.kind) {
      case "ok":
        return pruneEntries(result.value.entries, now());
      case "absent":
        return [];
      case "kept-aside":
        log("broker.index-unreadable", result.keptAs);
        notice = "index-unreadable";
        options.onNotice?.({
          code: "index-unreadable",
          keptAs: result.keptAs,
          text: `The conversation list could not be read; it was kept as ${result.keptAs} and a new list was started.`,
        });
        return [];
    }
  };

  const change = (apply: (entries: ConversationEntry[]) => ConversationEntry[]): Promise<void> => {
    const run = async () => {
      const raisedBefore = notice !== undefined;
      const entries = pruneEntries(apply(await read()), now());
      await writeHostFileAtomically(path, { version: 1, entries });
      if (raisedBefore) notice = undefined;
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    notice: () => notice,
    list: () => read(),
    get: async (conversationId) => (await read()).find((entry) => entry.conversationId === conversationId),
    put: (entry) =>
      change((entries) => [...entries.filter((item) => item.conversationId !== entry.conversationId), structuredClone(entry)]),
    // FR-304: the entry and nothing else - not the scratch folder, not the agent's own record.
    remove: (conversationId) => change((entries) => entries.filter((item) => item.conversationId !== conversationId)),
  };
}
