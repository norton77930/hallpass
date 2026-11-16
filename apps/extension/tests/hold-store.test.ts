import { describe, expect, it } from "vitest";
import { AGENT_SESSION_HOLDS_KEY, createHoldStore } from "../src/service-worker/hold-store.js";

const STAMP = "2026-11-15T10:00:00.000Z";

function fakeArea(store: Record<string, unknown> = {}): {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  raw: Record<string, unknown>;
} {
  return {
    raw: store,
    async get(keys) {
      const out: Record<string, unknown> = {};
      // A copy, as a real storage area hands back: a write must not see a read's object change.
      for (const key of keys) if (key in store) out[key] = structuredClone(store[key]);
      return out;
    },
    async set(items) {
      Object.assign(store, structuredClone(items));
    },
  };
}

/**
 * 034/T1005 - the page-Stop hold's store (R-513, data-model "Hold").
 *
 * One record per held session in the session area, under its own key: it survives a worker
 * restart (the next worker loads it before the first call), and only the caller deletes it.
 */
describe("T1005 the hold store", () => {
  it("sets, reads and deletes one hold per session", async () => {
    const session = fakeArea();
    const store = createHoldStore({ session });
    await store.set("s1", { at: STAMP, tabId: 7, sessionKnown: true });
    await store.set("s2", { at: STAMP, tabId: 8, sessionKnown: true });

    expect(await store.get("s1")).toEqual({ at: STAMP, tabId: 7, sessionKnown: true });
    expect(await store.get("s3")).toBeUndefined();
    expect(session.raw[AGENT_SESSION_HOLDS_KEY]).toEqual({
      s1: { at: STAMP, tabId: 7, sessionKnown: true },
      s2: { at: STAMP, tabId: 8, sessionKnown: true },
    });

    await store.delete("s1");
    expect(await store.get("s1")).toBeUndefined();
    expect(await store.get("s2")).toEqual({ at: STAMP, tabId: 8, sessionKnown: true });
  });

  it("loads every hold", async () => {
    const store = createHoldStore({ session: fakeArea() });
    await store.set("s1", { at: STAMP, tabId: 7, sessionKnown: true });
    await store.set("s2", { at: STAMP, tabId: 8, sessionKnown: true });

    expect(await store.load()).toEqual({ s1: { at: STAMP, tabId: 7, sessionKnown: true }, s2: { at: STAMP, tabId: 8, sessionKnown: true } });
  });

  it("serialises two writes in a row: the second sees the first", async () => {
    const session = fakeArea();
    const store = createHoldStore({ session });
    // Not awaited one by one: both reads would otherwise see the empty map.
    await Promise.all([store.set("s1", { at: STAMP, tabId: 7, sessionKnown: true }), store.set("s2", { at: STAMP, tabId: 8, sessionKnown: true })]);
    expect(Object.keys(await store.load()).sort()).toEqual(["s1", "s2"]);

    await Promise.all([store.delete("s1"), store.set("s3", { at: STAMP, tabId: 9, sessionKnown: true })]);
    expect(Object.keys(await store.load()).sort()).toEqual(["s2", "s3"]);
  });

  it("a second store over the same storage (a worker restart) loads what the first wrote", async () => {
    const session = fakeArea();
    await createHoldStore({ session }).set("s1", { at: STAMP, tabId: 7, sessionKnown: true });

    const restarted = createHoldStore({ session });
    expect(await restarted.load()).toEqual({ s1: { at: STAMP, tabId: 7, sessionKnown: true } });
  });

  it("deleteMany removes only the named sessions", async () => {
    const store = createHoldStore({ session: fakeArea() });
    await store.set("s1", { at: STAMP, tabId: 7, sessionKnown: true });
    await store.set("s2", { at: STAMP, tabId: 8, sessionKnown: true });
    await store.set("s3", { at: STAMP, tabId: 9, sessionKnown: true });

    await store.deleteMany(["s1", "s3", "unknown"]);
    expect(await store.load()).toEqual({ s2: { at: STAMP, tabId: 8, sessionKnown: true } });
  });

  it("reads malformed data as no hold, and no area as no hold", async () => {
    const session = fakeArea({
      [AGENT_SESSION_HOLDS_KEY]: { s1: { at: STAMP, tabId: 7, sessionKnown: true }, s2: { at: 3 }, s3: "held", s4: { at: STAMP, tabId: "7" } },
    });
    expect(await createHoldStore({ session }).load()).toEqual({ s1: { at: STAMP, tabId: 7, sessionKnown: true } });
    expect(await createHoldStore({ session: fakeArea({ [AGENT_SESSION_HOLDS_KEY]: [] }) }).load()).toEqual({});
    expect(await createHoldStore({ session: undefined }).load()).toEqual({});
  });

  // Review N3: `at` is shown as the card's `heldAt`, an ISO date-time; anything else is malformed.
  it("reads a hold whose time is not an ISO date-time as no hold", async () => {
    const session = fakeArea({
      [AGENT_SESSION_HOLDS_KEY]: {
        s1: { at: STAMP, tabId: 7, sessionKnown: true },
        s2: { at: "yesterday", tabId: 7 },
        s3: { at: "", tabId: 7 },
        s4: { at: "2026-02-30T10:00:00.000Z", tabId: 7 },
      },
    });
    expect(await createHoldStore({ session }).load()).toEqual({ s1: { at: STAMP, tabId: 7, sessionKnown: true } });
  });

  /**
   * Review round 4: whether the session was registered when the Stop was handled is the owner-side
   * fact a greeting's right to lift the hold is decided on, so it is written down and read back.
   * A record from the build before it has no such field and reads as not known; a field that is
   * there and is not a boolean is malformed, and malformed data reads as no hold.
   */
  it("keeps whether the session was known at the press, reads an old record as not known, and a bad value as no hold", async () => {
    const session = fakeArea();
    const store = createHoldStore({ session });
    await store.set("s1", { at: STAMP, tabId: 7, sessionKnown: true });
    await store.set("s2", { at: STAMP, tabId: 8, sessionKnown: false });
    expect(await createHoldStore({ session }).load()).toEqual({
      s1: { at: STAMP, tabId: 7, sessionKnown: true },
      s2: { at: STAMP, tabId: 8, sessionKnown: false },
    });

    const old = fakeArea({
      [AGENT_SESSION_HOLDS_KEY]: { s1: { at: STAMP, tabId: 7 }, s2: { at: STAMP, tabId: 8, sessionKnown: "yes" }, s3: { at: STAMP, tabId: 9, sessionKnown: null } },
    });
    expect(await createHoldStore({ session: old }).load()).toEqual({ s1: { at: STAMP, tabId: 7, sessionKnown: false } });
  });

  // Review N3: a session id is the agent's to choose, so the map is keyed by any string.
  it("keeps a hold for a session named __proto__, across a restart, and deletes it", async () => {
    const session = fakeArea();
    const store = createHoldStore({ session });
    await store.set("__proto__", { at: STAMP, tabId: 7, sessionKnown: true });

    expect(await store.get("__proto__")).toEqual({ at: STAMP, tabId: 7, sessionKnown: true });
    expect(await store.get("constructor")).toBeUndefined();
    const restarted = await createHoldStore({ session }).load();
    expect(Object.keys(restarted)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(restarted, "__proto__")?.value).toEqual({ at: STAMP, tabId: 7, sessionKnown: true });

    await store.delete("__proto__");
    expect(Object.keys(await store.load())).toEqual([]);
  });
});
