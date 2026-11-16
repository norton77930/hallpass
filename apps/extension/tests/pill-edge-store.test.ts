import { describe, expect, it } from "vitest";
import { createPillEdgeStore, PILL_EDGE_STORAGE_KEY } from "../src/service-worker/pill-edge-store.js";

/**
 * 035/T1026 - the owner's edge (R-528, data-model "Owner's edge"): one value per browser profile in
 * `chrome.storage.local` under `agentPillEdge`. Unset, unreadable or foreign is `top`; a write is read
 * back from storage; writes go one at a time; a fresh instance (a restarted worker) loads what was kept.
 */

type Area = {
  values: Record<string, unknown>;
  log: string[];
  failGet: boolean;
  failSet: boolean;
  /** When true, the first `set` is held until `release` is called, so overlap between writes is observable. */
  holdFirstSet: boolean;
  release: (() => void) | undefined;
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};

function fakeArea(seed: Record<string, unknown> = {}): Area {
  const area: Area = {
    values: { ...seed },
    log: [],
    failGet: false,
    failSet: false,
    holdFirstSet: false,
    release: undefined,
    async get(keys) {
      if (area.failGet) throw new Error("storage unavailable");
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in area.values) out[key] = area.values[key];
      return out;
    },
    async set(values) {
      if (area.failSet) throw new Error("storage unavailable");
      const value = (values as Record<string, unknown>)[PILL_EDGE_STORAGE_KEY];
      area.log.push(`start ${String(value)}`);
      if (area.holdFirstSet && area.log.length === 1) {
        await new Promise<void>((resolve) => {
          area.release = resolve;
        });
      }
      Object.assign(area.values, values);
      area.log.push(`end ${String(value)}`);
    },
  };
  return area;
}

describe("T1026 the owner's edge store", () => {
  it("keys the value agentPillEdge", () => {
    expect(PILL_EDGE_STORAGE_KEY).toBe("agentPillEdge");
  });

  it("is top when nothing is stored", async () => {
    const store = createPillEdgeStore({ storage: () => fakeArea() });

    await store.ready();

    expect(store.current()).toBe("top");
    await expect(store.read()).resolves.toBe("top");
  });

  it.each([["sideways"], [7], [null], [{ edge: "bottom" }]])("is top for an unreadable or foreign value %j", async (stored) => {
    const store = createPillEdgeStore({ storage: () => fakeArea({ [PILL_EDGE_STORAGE_KEY]: stored }) });

    await store.ready();

    expect(store.current()).toBe("top");
  });

  it("is top when storage cannot be read", async () => {
    const area = fakeArea({ [PILL_EDGE_STORAGE_KEY]: "bottom" });
    area.failGet = true;
    const store = createPillEdgeStore({ storage: () => area });

    await store.ready();

    expect(store.current()).toBe("top");
  });

  it("is top before it has loaded, and loads the stored value once ready resolves", async () => {
    const store = createPillEdgeStore({ storage: () => fakeArea({ [PILL_EDGE_STORAGE_KEY]: "bottom" }) });
    expect(store.current()).toBe("top");

    await store.ready();

    expect(store.current()).toBe("bottom");
  });

  it("reads a write back from chrome.storage.local's key", async () => {
    const area = fakeArea();
    const store = createPillEdgeStore({ storage: () => area });

    await store.set("bottom");

    expect(area.values[PILL_EDGE_STORAGE_KEY]).toBe("bottom");
    expect(store.current()).toBe("bottom");
    await expect(store.read()).resolves.toBe("bottom");
  });

  it("loads the stored value in a fresh instance, as a restarted worker does", async () => {
    const area = fakeArea();
    await createPillEdgeStore({ storage: () => area }).set("bottom");

    const fresh = createPillEdgeStore({ storage: () => area });
    await fresh.ready();

    expect(fresh.current()).toBe("bottom");
  });

  it("serialises writes: the second starts after the first has ended, and the last one wins", async () => {
    const area = fakeArea();
    area.holdFirstSet = true;
    const store = createPillEdgeStore({ storage: () => area });

    const first = store.set("bottom");
    const second = store.set("top");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(area.log, "the second write started while the first was in flight").toEqual(["start bottom"]);
    area.release?.();
    await Promise.all([first, second]);

    expect(area.log).toEqual(["start bottom", "end bottom", "start top", "end top"]);
    expect(area.values[PILL_EDGE_STORAGE_KEY]).toBe("top");
    expect(store.current()).toBe("top");
  });

  it("rejects, and keeps the old edge, when the value cannot be written", async () => {
    const area = fakeArea();
    const store = createPillEdgeStore({ storage: () => area });
    area.failSet = true;

    await expect(store.set("bottom")).rejects.toThrow();

    expect(store.current()).toBe("top");
    area.failSet = false;
    await store.set("bottom");
    expect(store.current()).toBe("bottom");
  });
});
