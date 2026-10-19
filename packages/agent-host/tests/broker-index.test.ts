import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "@hallpass/contracts";
import { fileConversationIndex, INDEX_MAX_AGE_MS, type IndexNotice } from "../src/broker/index-store.js";
import { makeTempDir, poolHarness, removeDir } from "./conversation-harness.js";

/**
 * 019/T559 - the conversation index as a host file (R-319, FR-304, data-model "Conversation index"):
 * `<data>\conversations.json`, written temp + rename, at most 50 entries and nothing unused for 30
 * days after every write, re-read before every write so two brokers (two browsers, 018) do not lose
 * each other's entries, a corrupt file kept aside with a notice, `resumable: false` once the agent
 * refused a load, and `remove` deleting the entry and nothing else.
 */

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await makeTempDir("hallpass-index-");
  path = join(dir, "data", "conversations.json");
});

afterEach(async () => {
  await removeDir(dir);
});

function entry(n: number, lastUsedAt = new Date(NOW - n * 60_000).toISOString()): ConversationEntry {
  const conversationId = `conv-${String(n).padStart(16, "0")}`;
  return {
    conversationId,
    agent: "claude-code",
    agentSessionId: `session-${n}`,
    title: `Conversation ${n}`,
    folder: { kind: "scratch" },
    mode: "strict",
    createdAt: lastUsedAt,
    lastUsedAt,
    resumable: true,
  };
}

const onDisk = async () => JSON.parse(await readFile(path, "utf8")) as { version: number; entries: ConversationEntry[] };
const ids = (entries: ConversationEntry[]) => entries.map((item) => item.conversationId);

describe("T559 conversations.json", () => {
  it("is written atomically: temp + rename replaces the file, no temp is left behind", async () => {
    const index = fileConversationIndex({ path, now: () => NOW });
    await index.put(entry(1));
    const first = await stat(path, { bigint: true });
    await index.put(entry(2));
    const second = await stat(path, { bigint: true });

    // A rename puts a new file in place; an in-place write would keep the file's identity.
    expect(second.ino).not.toBe(first.ino);
    expect(await readdir(join(dir, "data"))).toEqual(["conversations.json"]);
    expect(await onDisk()).toEqual({ version: 1, entries: expect.any(Array) });
    expect(ids((await onDisk()).entries).sort()).toEqual(ids([entry(1), entry(2)]).sort());
  });

  it("keeps at most 50 entries, the most recently used, on every write", async () => {
    const index = fileConversationIndex({ path, now: () => NOW });
    for (let n = 1; n <= 51; n++) await index.put(entry(n));
    const stored = (await onDisk()).entries;
    expect(stored).toHaveLength(50);
    // entry(51) is the least recently used.
    expect(ids(stored)).not.toContain(entry(51).conversationId);
    expect(await index.list()).toHaveLength(50);
  }, 60_000); // 51 sequential temp + rename writes: seconds alone, longer under the full parallel run

  it("drops entries unused for 30 days on the next write", async () => {
    const stale = entry(1, new Date(NOW - INDEX_MAX_AGE_MS - 1).toISOString());
    const recent = entry(2, new Date(NOW - 29 * DAY).toISOString());
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, entries: [stale, recent] }));

    const index = fileConversationIndex({ path, now: () => NOW });
    await index.put(entry(3));
    expect(ids((await onDisk()).entries).sort()).toEqual([recent.conversationId, entry(3).conversationId].sort());
  });

  it("re-reads before every write, so two brokers keep each other's entries", async () => {
    const a = fileConversationIndex({ path, now: () => NOW });
    const b = fileConversationIndex({ path, now: () => NOW });
    await a.put(entry(1));
    await b.put(entry(2));
    await a.put({ ...entry(1), title: "Renamed by A" });
    await a.remove(entry(3).conversationId);

    expect(ids(await b.list()).sort()).toEqual([entry(1).conversationId, entry(2).conversationId].sort());
    expect((await b.get(entry(1).conversationId))?.title).toBe("Renamed by A");
  });

  it.each([
    ["not JSON", "{ oops"],
    ["an unknown field", JSON.stringify({ version: 1, entries: [{ ...entry(1), extra: true }] })],
    ["another version", JSON.stringify({ version: 2, entries: [] })],
  ])("a corrupt file (%s) is kept aside as .bad-<time>, with a notice, and the list starts empty", async (_label, content) => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(path, content);
    const notices: IndexNotice[] = [];
    const index = fileConversationIndex({ path, now: () => NOW, onNotice: (notice) => notices.push(notice) });

    expect(await index.list()).toEqual([]);
    const files = await readdir(join(dir, "data"));
    const bad = files.filter((name) => name.startsWith("conversations.json.bad-"));
    expect(bad).toHaveLength(1);
    expect(files).not.toContain("conversations.json");
    expect(await readFile(join(dir, "data", bad[0]!), "utf8")).toBe(content);
    expect(notices).toEqual([{ code: "index-unreadable", keptAs: bad[0], text: expect.stringMatching(/could not be read/u) }]);

    await index.put(entry(2));
    expect(ids((await onDisk()).entries)).toEqual([entry(2).conversationId]);
  });

  it("T563: the list notice is a code, kept until a later write succeeds - not the write that found the file", async () => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(path, "{ not json");
    const index = fileConversationIndex({ path, now: () => NOW });
    expect(index.notice()).toBeUndefined();

    // Found by a read (the overview's): it stays across reads.
    await index.list();
    expect(index.notice()).toBe("index-unreadable");
    await index.list();
    expect(index.notice()).toBe("index-unreadable");
    // The next write that succeeds started the new list: the notice has said what it had to.
    await index.put(entry(1));
    expect(index.notice()).toBeUndefined();

    // Found by a write's own re-read: that write does not clear it, the one after does.
    await writeFile(path, "{ not json");
    await index.put(entry(2));
    expect(index.notice()).toBe("index-unreadable");
    await index.put(entry(3));
    expect(index.notice()).toBeUndefined();
  });
});

describe("T559 the index under the pool", () => {
  it("marks an entry resumable: false once the agent refused to load it", async () => {
    const index = fileConversationIndex({ path });
    const gone = { ...entry(1, new Date().toISOString()), agentSessionId: "fake-claude-unknown" };
    await index.put(gone);
    await mkdir(join(dir, "data", "scratch", gone.conversationId), { recursive: true });
    const h = await poolHarness({ dir, index, store: false });
    try {
      const opened = await h.pool.open(gone.conversationId);
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.code).toBe("cannot-resume");
      expect((await onDisk()).entries.find((item) => item.conversationId === gone.conversationId)?.resumable).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("remove deletes only that entry: the other entries and the scratch folder stay", async () => {
    const index = fileConversationIndex({ path });
    const h = await poolHarness({ dir, index });
    try {
      const removed = await h.start("claude-code");
      const kept = await h.start("codex");
      const scratch = join(dir, "data", "scratch", removed);
      expect((await stat(scratch)).isDirectory()).toBe(true);

      expect((await h.pool.remove(removed)).ok).toBe(true);
      expect(ids((await onDisk()).entries)).toEqual([kept]);
      expect((await stat(scratch)).isDirectory()).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
