import { describe, expect, it } from "vitest";
import {
  AGENT_WINDOW_RESTORES_KEY,
  createWindowRestoreStore,
  decideRestore,
  type WindowRestoreRecord,
} from "../src/service-worker/window-restore.js";

/**
 * 008/T231 — what a resized window is owed back, and what it is not (FR-118..FR-120).
 *
 * There is no reference behaviour for this (design-notes §5): it is our own design, and the four ways
 * it must *not* act are the whole of it. Each one is a fact about the window at the moment of
 * release, so the decision is a pure function of three things - the record, the window as Chrome
 * reports it now, and how many other sessions still hold a record for it - and this file is where
 * every one of them is pinned. The gate (T233) proves the same rules against a real window.
 */

const RECORD: WindowRestoreRecord = {
  windowId: 900,
  priorState: "maximized",
  sessionId: "session-w1",
  setSize: { width: 1024, height: 768 },
};

function fakeArea(store: Record<string, unknown> = {}): {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  raw: Record<string, unknown>;
} {
  return {
    raw: store,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
  };
}

describe("decideRestore", () => {
  it("restores a window that is still the size the tool set it to", () => {
    expect(decideRestore(RECORD, { state: "normal", width: 1024, height: 768 }, 0)).toBe("restore");
  });

  it("drops the record for a window that is gone", () => {
    expect(decideRestore(RECORD, undefined, 0)).toBe("drop");
  });

  it("does nothing for a window the owner re-maximised by hand", () => {
    expect(decideRestore(RECORD, { state: "maximized", width: 2064, height: 1120 }, 0)).toBe("drop");
  });

  it("leaves a window another session also resized to that session", () => {
    expect(decideRestore(RECORD, { state: "normal", width: 1024, height: 768 }, 1)).toBe("leave-to-other");
  });

  it("does nothing for a window the owner resized by hand - their choice wins", () => {
    expect(decideRestore(RECORD, { state: "normal", width: 1200, height: 768 }, 0)).toBe("drop");
  });

  it("does nothing when Chrome reports no bounds at all, because nothing can be compared", () => {
    expect(decideRestore(RECORD, { state: "normal" }, 0)).toBe("drop");
  });

  it("asks about the state before it asks about the other holders", () => {
    // A window already back where it belongs needs no restore from anybody.
    expect(decideRestore(RECORD, { state: "maximized", width: 1024, height: 768 }, 2)).toBe("drop");
  });
});

describe("the window restore store", () => {
  it("keeps the first state seen and updates only the size (FR-120)", async () => {
    const store = createWindowRestoreStore(fakeArea());

    await store.remember(RECORD);
    await store.remember({ ...RECORD, priorState: "fullscreen", setSize: { width: 900, height: 600 } });

    expect(await store.forSession("session-w1")).toEqual([
      { ...RECORD, priorState: "maximized", setSize: { width: 900, height: 600 } },
    ]);
  });

  it("survives the worker: a fresh store over the same storage reads what the last one wrote", async () => {
    const area = fakeArea();
    await createWindowRestoreStore(area).remember(RECORD);

    const evicted = createWindowRestoreStore(area);

    expect(area.raw[AGENT_WINDOW_RESTORES_KEY]).toEqual([RECORD]);
    expect(await evicted.forSession("session-w1")).toEqual([RECORD]);
  });

  it("counts the records other sessions hold for a window, and forgets one session's", async () => {
    const area = fakeArea();
    const store = createWindowRestoreStore(area);
    await store.remember(RECORD);
    await store.remember({ ...RECORD, sessionId: "session-w2" });
    await store.remember({ ...RECORD, windowId: 901, sessionId: "session-w2" });

    expect(await store.othersForWindow(900, "session-w1")).toBe(1);
    expect(await store.othersForWindow(901, "session-w2")).toBe(0);

    await store.forget(900, "session-w2");

    expect(await store.othersForWindow(900, "session-w1")).toBe(0);
    expect(await store.forSession("session-w1")).toEqual([RECORD]);
    expect(await store.forSession("session-w2")).toEqual([{ ...RECORD, windowId: 901, sessionId: "session-w2" }]);
  });

  it("answers an empty list where nothing was ever remembered", async () => {
    const store = createWindowRestoreStore(fakeArea({ [AGENT_WINDOW_RESTORES_KEY]: "not a list" }));

    expect(await store.forSession("session-w1")).toEqual([]);
    expect(await store.othersForWindow(900, "session-w1")).toBe(0);
  });
});
