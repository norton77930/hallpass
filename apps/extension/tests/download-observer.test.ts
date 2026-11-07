import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  AGENT_DOWNLOADS_KEY,
  createDownloadObserver,
  type DownloadHolder,
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
  let holders: DownloadHolder[] = [];
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
    ownOrigin: "chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd",
    storage,
    now: () => now,
    ...overrides,
  });
  observer.start();
  return {
    observer,
    store,
    storage,
    /** A bare session id holds a tab on the default download's own site (`https://example.test`). */
    setHolders: (next: Array<string | DownloadHolder>) =>
      void (holders = next.map((entry) => (typeof entry === "string" ? { sessionId: entry, origins: ["https://example.test"] } : entry))),
    tick: (ms: number) => void (now += ms),
    now: () => now,
    async create(item: Partial<DownloadSnapshot> & { id: number }) {
      const snapshot: DownloadSnapshot = {
        url: "https://example.test/report.csv",
        referrer: "",
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
    // Where it lives: session storage, under one key, per session, with the ids the wait has
    // already answered (none yet) - and no legacy watermark (015/R-199).
    expect(h.store[AGENT_DOWNLOADS_KEY]).toMatchObject({ "session-a": { answered: [] } });
    expect((h.store[AGENT_DOWNLOADS_KEY] as Record<string, object>)["session-a"]).not.toHaveProperty("waitWatermark");
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

  /**
   * Security review 2026-11-05 (#36) - the owner's own downloads are not an agent's business. The
   * browser's record names no tab, but it names the page that started it (`referrer`) and the
   * source (`url`), and a session's tabs have addresses: a download is a session's only when one of
   * those origins is a site one of its tabs is on, or is about to be on (`pendingUrl`, for a
   * navigation the browser turned into a download). Everything else is the owner's and no ring
   * carries it, however many tabs an idle agent holds elsewhere.
   */
  describe("#36 attribution by origin", () => {
    it("does not report the owner's download from a site no session's tab is on", async () => {
      const h = harness();
      h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);

      await h.create({ id: 1, url: "https://bank.example/statement.pdf", referrer: "https://bank.example/account" });

      await expect(h.observer.list("session-a")).resolves.toEqual([]);
      expect(JSON.stringify(h.store)).not.toContain('"id":1');
    });

    it("reports a download to the session whose tab is on the referring site, and to that one alone", async () => {
      const h = harness();
      h.setHolders([
        { sessionId: "session-a", origins: ["https://shop.example"] },
        { sessionId: "session-b", origins: ["https://mail.example"] },
      ]);

      await h.create({ id: 1, url: "https://cdn.example/invoice.pdf", referrer: "https://shop.example/orders" });

      expect((await h.observer.list("session-a")).map((record) => [record.id, record.attribution])).toEqual([[1, "session"]]);
      await expect(h.observer.list("session-b")).resolves.toEqual([]);
    });

    it("matches the source url's origin too, including a blob the page minted, and a pending navigation", async () => {
      const h = harness();
      h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example", "https://files.example"] }]);

      await h.create({ id: 1, url: "blob:https://shop.example/0f3a-export", referrer: "" });
      await h.create({ id: 2, url: "https://files.example/report.zip", referrer: "" });

      expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([2, 1]);
    });

    it("honours a navigation the session announced, until its bound", async () => {
      const h = harness();
      h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
      h.observer.expect("session-a", "https://mirror.example", h.now() + 5_000);

      await h.create({ id: 1, url: "https://mirror.example/a.zip", referrer: "" });
      h.tick(6_000);
      await h.create({ id: 2, url: "https://mirror.example/b.zip", referrer: "" });

      expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([1]);
    });

    it("decides an announced navigation when the event arrives, not when the write gets its turn", async () => {
      const h = harness();
      h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
      h.observer.expect("session-a", "https://mirror.example", h.now() + 5_000);

      // The event is raised inside the bound; the bound passes before the queued write runs.
      const creating = h.create({ id: 1, url: "https://mirror.example/a.zip", referrer: "" });
      h.tick(6_000);
      await creating;

      expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([1]);
    });

    /**
     * #36 follow-up (2026-11-07, measured in Chromium): a page link to a `data:` url, with a
     * `download` attribute, yields a record with an empty referrer and a url that names no origin.
     * The origin rule alone gave it to nobody, so the agent that clicked it waited in vain. A file
     * with no origin is the session's when it appeared while that session's own page action was
     * under way - and nobody's outside every such window.
     */
    describe("a download that names no origin", () => {
      const DATA = { url: "data:text/csv,a%2Cb", referrer: "" };

      it("is the session's when it appears while that session's own action is under way", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
        const close = h.observer.actingOnPage("session-a", h.now() + 30_000);

        await h.create({ id: 1, ...DATA });
        close();

        expect((await h.observer.list("session-a")).map((record) => [record.id, record.attribution])).toEqual([[1, "session"]]);
      });

      it("is nobody's outside every window: before one opens and after it closes", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);

        await h.create({ id: 1, ...DATA });
        const close = h.observer.actingOnPage("session-a", h.now() + 30_000);
        close();
        await h.create({ id: 2, ...DATA });

        await expect(h.observer.list("session-a")).resolves.toEqual([]);
        expect(JSON.stringify(h.store)).not.toContain('"id":');
      });

      it("is decided at the moment it appears, not when the write gets its turn", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
        const close = h.observer.actingOnPage("session-a", h.now() + 30_000);

        // The event is raised inside the window; the call ends before the queued write runs.
        const creating = h.create({ id: 1, ...DATA });
        close();
        await creating;

        expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([1]);
      });

      it("expires at its bound even if the call never ends", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
        h.observer.actingOnPage("session-a", h.now() + 5_000);

        h.tick(6_000);
        await h.create({ id: 1, ...DATA });

        await expect(h.observer.list("session-a")).resolves.toEqual([]);
      });

      it("goes to every session whose window is open, marked shared", async () => {
        const h = harness();
        h.setHolders([
          { sessionId: "session-a", origins: ["https://shop.example"] },
          { sessionId: "session-b", origins: ["https://mail.example"] },
          { sessionId: "session-c", origins: ["https://news.example"] },
        ]);
        h.observer.actingOnPage("session-a", h.now() + 30_000);
        h.observer.actingOnPage("session-b", h.now() + 30_000);

        await h.create({ id: 1, ...DATA });

        expect((await h.observer.list("session-a")).map((record) => record.attribution)).toEqual(["shared"]);
        expect((await h.observer.list("session-b")).map((record) => record.attribution)).toEqual(["shared"]);
        await expect(h.observer.list("session-c")).resolves.toEqual([]);
      });

      it("does not widen the origin rule: a download from an unrelated site during the window is not the session's", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
        h.observer.actingOnPage("session-a", h.now() + 30_000);

        await h.create({ id: 1, url: "https://bank.example/statement.pdf", referrer: "https://bank.example/account" });
        await h.create({ id: 2, url: "data:text/csv,x", referrer: "https://bank.example/account" });

        await expect(h.observer.list("session-a")).resolves.toEqual([]);
      });

      it("takes only a file the page built itself: a `data:` url or an opaque-origin blob, not a local path or another extension's file", async () => {
        const h = harness();
        h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);
        h.observer.actingOnPage("session-a", h.now() + 30_000);

        await h.create({ id: 1, url: "file:///C:/x.txt", referrer: "" });
        await h.create({ id: 2, url: "ftp://host/x", referrer: "" });
        await h.create({ id: 3, url: "blob:chrome-extension://abcdefghijklmnopabcdefghijklmnop/uuid", referrer: "" });
        await h.create({ id: 4, url: "data:text/plain,x", referrer: "" });
        await h.create({ id: 5, url: "blob:null/uuid", referrer: "" });

        expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([5, 4]);
      });
    });

    it("still gives the extension's own file - a recording export - to whoever holds a tab", async () => {
      const h = harness();
      h.setHolders([{ sessionId: "session-a", origins: ["https://shop.example"] }]);

      await h.create({ id: 1, url: "blob:chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/9c1d", referrer: "" });

      expect((await h.observer.list("session-a")).map((record) => record.id)).toEqual([1]);
    });

    it("carries the file's name, never the saved path", async () => {
      const h = harness();
      h.setHolders(["session-a"]);

      await h.create({ id: 1, filename: "C:\\Users\\owner\\Downloads\\report.csv" });
      await h.change({ id: 1, filename: "/home/owner/Downloads/report (1).csv" });

      const [record] = await h.observer.list("session-a");
      expect(record?.filename).toBe("report (1).csv");
      expect(JSON.stringify(h.store)).not.toContain("owner");
    });
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
      filename: "report.csv",
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
      filename: "a.zip",
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
   * 015/T415 (R-199, FR-207..FR-209): every finished download, once, in finish order. The newest
   * record is no longer the only candidate: two downloads that finish out of creation order are
   * both answered, earliest end first, and none twice.
   */
  describe("015 every finished download, once", () => {
    const at = (h: ReturnType<typeof harness>) => new Date(h.now()).toISOString();

    it("answers two downloads in the order they finished, not the order they began", async () => {
      const h = harness();
      h.setHolders(["session-a"]);
      await h.create({ id: 1, url: "https://example.test/slow.csv" });
      h.tick(10);
      await h.create({ id: 2, url: "https://example.test/fast.csv" });
      h.tick(10);
      await h.change({ id: 2, filename: "C:\\dl\\fast.csv", state: "complete", endedAt: at(h) });
      h.tick(1500);
      await h.change({ id: 1, filename: "C:\\dl\\slow.csv", state: "complete", endedAt: at(h) });

      await expect(h.observer.takeCompletion("session-a")).resolves.toEqual({
        id: 2,
        filename: "fast.csv",
        url: "https://example.test/fast.csv",
        state: "complete",
      });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 1, state: "complete" });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
    });

    it("answers a completion that finished while a newer one was still running, then the newer one", async () => {
      const h = harness();
      h.setHolders(["session-a"]);
      await h.create({ id: 1 });
      h.tick(10);
      await h.create({ id: 2 });
      h.tick(10);
      await h.change({ id: 1, state: "complete", endedAt: at(h) });
      // Id 2 is the newest and still running; the old rule looked only at it and answered nothing.
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 1 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
      h.tick(10);
      await h.change({ id: 2, state: "complete", endedAt: at(h) });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 2 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
    });

    it("breaks an end-time tie by the smaller id", async () => {
      const h = harness();
      h.setHolders(["session-a"]);
      await h.create({ id: 8 });
      await h.create({ id: 7 });
      h.tick(10);
      await h.change({ id: 8, state: "complete", endedAt: at(h) });
      await h.change({ id: 7, state: "complete", endedAt: at(h) });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 7 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 8 });
    });

    it("answers a failure and a cancellation in their own word, each once", async () => {
      const h = harness();
      h.setHolders(["session-a"]);
      await h.create({ id: 1 });
      await h.create({ id: 2 });
      h.tick(10);
      await h.change({ id: 1, state: "failed", endedAt: at(h) });
      h.tick(10);
      await h.change({ id: 2, state: "canceled", endedAt: at(h) });

      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 1, state: "failed" });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 2, state: "canceled" });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
    });

    it("keeps each session's answers its own", async () => {
      const h = harness();
      h.setHolders(["session-a", "session-b"]);
      await h.create({ id: 1 });
      h.tick(10);
      await h.change({ id: 1, state: "complete", endedAt: at(h) });

      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 1 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
      // Answering session-a told session-b nothing: it still has its own copy to take, once.
      await expect(h.observer.takeCompletion("session-b")).resolves.toMatchObject({ id: 1 });
      await expect(h.observer.takeCompletion("session-b")).resolves.toBeUndefined();
      await expect(h.observer.takeCompletion("session-c")).resolves.toBeUndefined();
    });

    it("migrates a ring that has only a watermark: what ended by it counts as answered", async () => {
      const h = harness();
      const record = (id: number, endedAt?: number, state = "complete") => ({
        id,
        filename: `C:\\dl\\${id}.csv`,
        url: `https://example.test/${id}.csv`,
        state,
        startedAt: new Date(100).toISOString(),
        ...(endedAt === undefined ? {} : { endedAt: new Date(endedAt).toISOString() }),
        bytesReceived: 0,
        totalBytes: -1,
        danger: false,
        attribution: "session",
      });
      h.store[AGENT_DOWNLOADS_KEY] = {
        "session-a": {
          items: [record(4, undefined, "in_progress"), record(3, 900), record(2, 600), record(1, 400)],
          waitWatermark: 500,
        },
      };

      // 1 ended before the watermark: answered by the old rule, never again. 2 and 3 are pending.
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 2 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 3 });
      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();

      const ring = (h.store[AGENT_DOWNLOADS_KEY] as Record<string, Record<string, unknown>>)["session-a"]!;
      expect(ring).not.toHaveProperty("waitWatermark");
      expect([...(ring.answered as number[])].sort()).toEqual([1, 2, 3]);
      // The list itself is untouched by the migration.
      expect((await h.observer.list("session-a")).map((held) => held.id)).toEqual([4, 3, 2, 1]);
    });

    it("lets an unanswered completion that fell off the ring go, and forgets answered ids that left", async () => {
      const h = harness();
      h.setHolders(["session-a"]);
      await h.create({ id: 1 });
      h.tick(10);
      await h.change({ id: 1, state: "complete", endedAt: at(h) });
      await h.create({ id: 2 });
      h.tick(10);
      await h.change({ id: 2, state: "complete", endedAt: at(h) });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 1 });
      // Twenty more push both 1 (answered) and 2 (not answered) off the end of the ring.
      for (let id = 3; id <= 22; id += 1) await h.create({ id });

      await expect(h.observer.takeCompletion("session-a")).resolves.toBeUndefined();
      h.tick(10);
      await h.change({ id: 22, state: "complete", endedAt: at(h) });
      await expect(h.observer.takeCompletion("session-a")).resolves.toMatchObject({ id: 22 });
      const ring = (h.store[AGENT_DOWNLOADS_KEY] as Record<string, { answered: number[] }>)["session-a"]!;
      expect(ring.answered).toEqual([22]);
    });
  });

  /**
   * 015/T405: the session's downloads since a moment - read-only, so the press path can say "this
   * press started a download" without taking anything a wait would answer.
   */
  it("lists the records created at or after a moment, newest first, and changes nothing", async () => {
    const h = harness();
    h.setHolders(["session-a"]);
    await h.create({ id: 1 });
    h.tick(100);
    const since = h.now();
    await h.create({ id: 2 });
    h.tick(50);
    await h.create({ id: 3 });
    const before = JSON.stringify(h.store);

    expect((await h.observer.createdSince("session-a", since)).map((record) => record.id)).toEqual([3, 2]);
    expect(await h.observer.createdSince("session-a", h.now() + 1)).toEqual([]);
    expect(await h.observer.createdSince("session-b", 0)).toEqual([]);
    expect(JSON.stringify(h.store)).toBe(before);
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
