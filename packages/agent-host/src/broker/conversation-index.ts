import {
  CONVERSATION_MAX_FOLDERS,
  type ConversationEntry,
  type ConversationFolderEntry,
} from "@hallpass/contracts";

/**
 * The broker's conversation index and the owner's folder list (019 R-319, data-model), as seams.
 *
 * The broker uses the file-backed versions since S7 (T560 `index-store.ts`, T562 `folders.ts`):
 * `conversations.json` / `folders.json` under the host data folder, re-read before every write,
 * temp + rename, 50 entries / 30 days pruning - behind these interfaces, which are async for that
 * reason. The in-memory factories below stay for tests.
 */

export interface ConversationIndex {
  list(): Promise<ConversationEntry[]>;
  get(conversationId: string): Promise<ConversationEntry | undefined>;
  /** Insert or replace by `conversationId`. */
  put(entry: ConversationEntry): Promise<void>;
  remove(conversationId: string): Promise<void>;
}

export function memoryConversationIndex(initial: ConversationEntry[] = []): ConversationIndex {
  const entries = new Map(initial.map((entry) => [entry.conversationId, structuredClone(entry)]));
  return {
    list: async () => [...entries.values()].map((entry) => structuredClone(entry)),
    get: async (conversationId) => {
      const entry = entries.get(conversationId);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    put: async (entry) => {
      entries.set(entry.conversationId, structuredClone(entry));
    },
    remove: async (conversationId) => {
      entries.delete(conversationId);
    },
  };
}

export interface FolderList {
  list(): Promise<ConversationFolderEntry[]>;
  /** Whether `path` is one of the owner's folders (case-insensitive, as Windows paths are). */
  has(path: string): Promise<boolean>;
  add(path: string, addedAt: string): Promise<void>;
  /** `false` when the path was not in the list. */
  remove(path: string): Promise<boolean>;
}

const sameFolder = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function memoryFolderList(initial: ConversationFolderEntry[] = []): FolderList {
  let folders = initial.map((folder) => ({ ...folder }));
  return {
    list: async () => folders.map((folder) => ({ ...folder })),
    has: async (path) => folders.some((folder) => sameFolder(folder.path, path)),
    add: async (path, addedAt) => {
      if (folders.some((folder) => sameFolder(folder.path, path))) return;
      folders = [...folders, { path, addedAt }].slice(-CONVERSATION_MAX_FOLDERS);
    },
    remove: async (path) => {
      const before = folders.length;
      folders = folders.filter((folder) => !sameFolder(folder.path, path));
      return folders.length !== before;
    },
  };
}
