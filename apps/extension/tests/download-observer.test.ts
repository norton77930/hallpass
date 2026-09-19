import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  AGENT_DOWNLOADS_KEY,
  createDownloadObserver,
  type DownloadObserverDeps,
} from "../src/service-worker/download-observer.js";
import type { DownloadDelta, DownloadSnapshot } from "../src/chrome-adapters/downloads.js";

/**
 * 005/T179 — the browser's downloads, observed and attributed (US2, FR-076, FR-077, FR-080).
 *
 * The record has no tab id, so the one rule is liveness: a download created while a session holds
 * a tab is written to that session's ring, to every such session when there are several (and says
 * so), and to nobody when nobody holds one. A change updates every ring that carries the id. The
 * ring is bounded, newest first, in session storage, serialised through one write chain, and a
 * session's end discards it. And the adapter can only *listen*: the last test reads the source.
 */

type Listener<T> = (event: T) => void;

function harness(overrides: Partial<DownloadObserverDeps> = {}) {
  const store: Record<string, unknown> = {};
  const created: Array<Listener<DownloadSnapshot>> = [];
  const changed: Array<Listener<DownloadDelta>> = [];
  let holders: string[] = [];
  let now = 1_000;
  const storage = {
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
  };
  const observer = createDownloadObserver({
    onCreated: (listener) => void created.push(listener),
    onChanged: (listener) => void changed.push(listener),
    holders: async () => holders,
    storage,
    now: () => now,
    ...overrides,
  });
  observer.start();
  return {
    observer,
    store,
    storage,
    setHolders: (next: string[]) => void (holders = next),
    tick: (ms: number) => void (now += ms),
    now: () => now,
    async create(item: Partial<DownloadSnapshot> & { id: number }) {
      const snapshot: DownloadSnapshot = {
        url: "https://example.test/report.csv",
        filename: "",
        state: "in_progress",
        startedAt: new Date(now).toISOString(),
        bytesReceived: 0,
        totalBytes: -1,
        danger: false,
        ...item,
      };
      for (const listener of created) listener(snapshot);
      await observer.settled();
    },
    async change(delta: DownloadDelta) {
      for (const listener of changed) listener(delta);
      await observer.settled();
    },
  };
}

describe("T179 download observer", () => {
  it("writes a created download to the one session holding a tab, as its own", async () => {
    const h = harness();
    h.setHolders(["session-a"]);

    await h.create({ id: 1 });

    await expect(h.observer.list("session-a")).resolves.toEqual([
      {
        id: 1,
        filename: "",
        url: "https://example.test/report.csv",
        state: "in_progress",
        startedAt: new Date(h.now()).toISOString(),
        bytesReceived: 0,
        totalBytes: -1,
        danger: false,
        attribution: "session",
      },
    ]);
    // Where it lives: session storage, under one key, per session, with the wait's watermark
    // (0: no `download-complete` wait has been answered yet).
    expect(h.store[AGENT_DOWNLOADS_KEY]).toMatchObject({ "session-a": { waitWatermark: 0 } });
  });

  it("tells every session holding a tab, marked shared, and nobody when nobody holds one (FR-077)", async () => {
    const h = harness();
    h.setHolders(["session-a", "session-b"]);
    await h.create({ id: 1 });
    h.setHolders([]);
    await h.create({ id: 2 });

    const a = await h.observer.list("session-a");
    const b = await h.observer.list("session-b");
    expect(a.map((record) => [record.id, record.attribution])).toEqual([[1, "shared"]]);
    expect(b.map((record) => [record.id, record.attribution])).toEqual([[1, "shared"]]);
    // Nobody held a tab when 2 began: it is the owner's, and no ring ever carries it.
    expect(JSON.stringify(h.store)).not.toContain('"id":2');
  });

  it("updates the name, state, bytes and end time on every ring that carries the id", async () => {
    const h = harness();
    h.setHolders(["session-a", "session-b"]);
    await h.create({ id: 1 });
    h.setHolders(["session-a"]);
    await h.create({ id: 2 });

    h.tick(500);
    await h.change({ id: 1, filename: "C:\\Users\\owner\\Downloads\\report.csv", totalBytes: 2048 });
    await h.change({ id: 1, state: "complete", bytesReceived: 2048, endedAt: new Date(h.now()).toISOString() });
    // A change about a download nobody was told of is not an event for anyone.
    await h.change({ id: 9, state: "complete" });

    const expected = {
      id: 1,
      filename: "C:\\Users\\owner\\Downloads\\report.csv",
      state: "complete",
      bytesReceived: 2048,
      totalBytes: 2048,
      endedAt: new Date(h.now()).toISOString(),
    };
    const a = await h.observer.list("session-a");
    expect(a.map((record) => record.id)).toEqual([2, 1]);
    expect(a[1]).toMatchObject(expected);
    expect((await h.observer.list("session-b"))[0]).toMatchObject(expected);
  });

  it("stamps an end time on a terminal change that arrived without one, so a cancellation still answers a wait (review 2026-09-13)", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    await h.create({ id: 4 });
    h.tick(700);
    // The browser reports the cancellation in a delta that carries no end time; the record must not
    // stay un-ended, or `downloads_context` would say canceled while `wait` ran to its bound.
    await h.change({ id: 4, state: "canceled" });

    const [record] = await h.observer.list("session-a");
    expect(record).toMatchObject({ id: 4, state: "canceled", endedAt: new Date(h.now()).toISOString() });
    expect(await h.observer.takeCompletion("session-a")).toEqual({
      id: 4,
      filename: record!.filename,
      url: record!.url,
      state: "canceled",
    });
  });

  it("says a complete download received every byte, when the change record carried no count (T187 B19)", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    await h.create({ id: 5 });
    // The browser's change record carries the total but never the received count, so the probe's
    // finished zip read `bytesReceived: 0, totalBytes: 351` - a complete download is a whole one.
    await h.change({ id: 5, totalBytes: 351 });
    await h.change({ id: 5, state: "complete" });

    const [record] = await h.observer.list("session-a");
    expect(record).toMatchObject({ id: 5, state: "complete", bytesReceived: 351, totalBytes: 351 });
  });

  it("keeps the newest twenty, newest first", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    for (let id = 1; id <= 23; id += 1) await h.create({ id });

    const ids = (await h.observer.list("session-a")).map((record) => record.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(23);
    expect(ids[19]).toBe(4);
  });

  it("discards a session's ring with the session, and only that session's (FR-080)", async () => {
    const h = harness();
    h.setHolders(["session-a", "session-b"]);
    await h.create({ id: 1 });

    await h.observer.discard("session-a");

    await expect(h.observer.list("session-a")).resolves.toEqual([]);
    expect((await h.observer.list("session-b")).map((record) => record.id)).toEqual([1]);
  });

  it("keeps writing after one storage write rejected", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    const set = h.storage.set;
    let failNext = true;
    h.storage.set = async (values) => {
      if (failNext) {
        failNext = false;
        throw new Error("quota");
      }
      return set(values);
    };

    await h.create({ id: 1 });
    await h.create({ id: 2 });

    expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([2]);
  });

  /**
   * The wait's half (R-124): the newest record, if it is over and ended after the last answer. An
   * answer moves the watermark, so the same completion is never handed out twice, and a completion
   * that happened before the wait was even called is still handed out once.
   */
  it("hands out the newest completion once, and only one that ended after the last answer", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    await h.create({ id: 1 });
    await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();

    h.tick(10);
    await h.change({ id: 1, filename: "C:\\dl\\a.zip", state: "complete", endedAt: new Date(h.now()).toISOString() });
    h.tick(10);
    await expect(h.observer.takeCompletion("session-a")).resolves.toEqual({
      id: 1,
      filename: "C:\\dl\\a.zip",
      url: "https://example.test/report.csv",
      state: "complete",
    });
    // Answered once: the watermark is now, and the same record satisfies nothing.
    await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();

    // A failure and a cancellation are endings too, in the record's own word.
    h.tick(10);
    await h.create({ id: 2 });
    h.tick(10);
    await h.change({ id: 2, state: "canceled", endedAt: new Date(h.now()).toISOString() });
    await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 2, state: "canceled" });
    // Nobody else's: a session that was never told has nothing to take.
    await expect(h.observer.takeCompletion("session-b")).resolves.toBeUndefined();
  });

  /**
   * FR-076 and 008 FR-107, read off the source. Only the adapter may name the API, and it may only
   * subscribe *and* write the one file this extension makes: an `open`, `show`, `acceptDanger`,
   * `pause`, `resume`, `cancel`, `removeFile`, `erase` or even a `search` anywhere under the worker
   * or the adapters is a build that acts on the owner's existing files, which no requirement here
   * has ever asked for.
   *
   * `download` joined the list in 008 because FR-107 writes the session's recording through the
   * browser's own download facility - so the owner sees the file where their downloads are and the
   * session's `downloads_context` lists it like any other. It is bytes this extension encoded, into
   * the default folder, with no save dialog; it is not a reach at anything already on disk.
   */
  it("references no member of the downloads API but onCreated, onChanged and download (FR-076, FR-107)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = resolve(here, "..", "src");
    const adapterPath = join(src, "chrome-adapters", "downloads.ts");
    const files = [...walk(join(src, "service-worker")), ...walk(join(src, "chrome-adapters"))];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const mentions = [...text.matchAll(/chrome\??\.downloads\b/g)].length;
      if (file !== adapterPath) {
        expect(mentions, `${file} reaches for chrome.downloads; only the adapter may`).toBe(0);
      }
    }

    const adapter = readFileSync(adapterPath, "utf8");
    expect([...adapter.matchAll(/chrome\??\.downloads\b/g)].length).toBeGreaterThan(0);
    // Every member the adapter reads off the API, and every member its own type of the API declares.
    const used = [...adapter.matchAll(/api\(\)\??\.(\w+)/g)].map((match) => match[1]);
    const declared = /type ChromeDownloads = \{([\s\S]*?)\n\};/.exec(adapter)?.[1] ?? "";
    const members = [...declared.matchAll(/^\s{2}(\w+)\s*[:(]/gm)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set(["onCreated", "onChanged"]));
    // `download` is reached through a local binding rather than off `api()` directly, so it appears
    // in the declared members and not in the used ones; both lists are pinned either way.
    expect(new Set(members)).toEqual(new Set(["onCreated", "onChanged", "download"]));
    expect([...adapter.matchAll(/downloads\.download\(/g)]).toHaveLength(1);
  });
});

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}
