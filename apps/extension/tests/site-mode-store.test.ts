import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSiteModeStore,
  siteOfUrl,
  type SiteModeStore,
} from "../src/service-worker/site-mode-store.js";

/**
 * 003/T022 — the owner's standing decision per site (FR-041, FR-042, R-107, R-108).
 *
 * What is asserted here is the part the rest of the feature relies on and cannot re-derive: that a
 * site nobody has decided about is `ask` rather than anything more permissive, that a decision is
 * keyed by scheme+host+port and so cannot leak across origins, and that it outlives the worker by
 * living in `chrome.storage.local`.
 */

function installChrome(): Record<string, unknown> {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
  };
  return local;
}

describe("T022 site mode store", () => {
  let storage: Record<string, unknown>;
  let store: SiteModeStore;

  beforeEach(() => {
    storage = installChrome();
    store = createSiteModeStore();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers ask for a site nobody has decided about", async () => {
    await expect(store.get("https://fixtures.test")).resolves.toEqual({
      site: "https://fixtures.test",
      mode: "ask",
      diagnosticsGranted: false,
    });
    // Reading is not deciding: an unvisited site must not appear in the panel's list as if the
    // owner had already been asked about it.
    await expect(store.list()).resolves.toEqual([]);
  });

  it("keeps a set mode and lists it", async () => {
    await store.set("https://fixtures.test", { mode: "skip-checks" });

    await expect(store.get("https://fixtures.test")).resolves.toEqual({
      site: "https://fixtures.test",
      mode: "skip-checks",
      diagnosticsGranted: false,
    });
    await expect(store.list()).resolves.toEqual([
      { site: "https://fixtures.test", mode: "skip-checks", diagnosticsGranted: false },
    ]);
  });

  it("keeps the diagnostics grant separate from the mode", async () => {
    await store.set("https://fixtures.test", { mode: "follow-a-plan" });
    await store.set("https://fixtures.test", { diagnosticsGranted: true });

    await expect(store.get("https://fixtures.test")).resolves.toEqual({
      site: "https://fixtures.test",
      mode: "follow-a-plan",
      diagnosticsGranted: true,
    });
  });

  /**
   * 2026-09-16: a record whose content is the default is not a decision. Setting the mode back to
   * `ask`, or granting diagnostics and then revoking, used to leave a row in the panel that looked
   * like a decision the owner had made and could revoke - about a site nothing was decided for.
   */
  it("forgets a site whose record has gone back to the default, so the list shows decisions only", async () => {
    await store.set("https://fixtures.test", { mode: "skip-checks" });
    await store.set("https://fixtures.test", { mode: "ask" });
    await expect(store.list(), "mode back to the default").resolves.toEqual([]);

    await store.set("https://fixtures.test", { diagnosticsGranted: true });
    await store.set("https://fixtures.test", { diagnosticsGranted: false });
    await expect(store.list(), "diagnostics granted and revoked").resolves.toEqual([]);

    // Setting the default on a site never decided about creates nothing either.
    await store.set("https://other.test", { mode: "ask" });
    await expect(store.list()).resolves.toEqual([]);
    expect(storage.agentSiteModes ?? {}).toEqual({});

    // A real decision on one half keeps the record whatever the other half says.
    await store.set("https://fixtures.test", { mode: "follow-a-plan" });
    await store.set("https://fixtures.test", { diagnosticsGranted: false });
    await expect(store.list()).resolves.toEqual([{ site: "https://fixtures.test", mode: "follow-a-plan", diagnosticsGranted: false }]);
  });

  it("keys by scheme, host and port, so one site's decision is not another's", async () => {
    await store.set("https://fixtures.test:19443", { mode: "skip-checks" });

    for (const other of ["https://fixtures.test", "http://fixtures.test:19443", "https://other.test:19443"]) {
      await expect(store.get(other)).resolves.toMatchObject({ mode: "ask" });
    }
  });

  it("refuses anything that is not a bare origin", async () => {
    for (const bad of ["https://fixtures.test/path", "fixtures.test", "https://*.test", ""]) {
      await expect(store.set(bad, { mode: "skip-checks" })).rejects.toThrow(/site/);
    }
  });

  it("writes through to storage so the decision outlives the worker", async () => {
    await store.set("https://fixtures.test", { mode: "skip-checks" });

    const revived = createSiteModeStore();
    await expect(revived.get("https://fixtures.test")).resolves.toMatchObject({ mode: "skip-checks" });
    expect(Object.keys(storage)).toEqual(["agentSiteModes"]);
  });

  it("derives the site of a page URL, port included", () => {
    expect(siteOfUrl("https://fixtures.test:19443/form?q=1#x")).toBe("https://fixtures.test:19443");
    expect(siteOfUrl("https://fixtures.test/")).toBe("https://fixtures.test");
    // A page the agent may not act on at all has no site to decide about.
    expect(siteOfUrl("chrome://settings")).toBe(undefined);
    expect(siteOfUrl("not a url")).toBe(undefined);
  });
});

/**
 * 004/T129c — the cache the store keeps must never outrank the record it caches.
 *
 * The store reads the map once per worker and writes that *cache* back on every mutation, so a mode
 * written by anything else - the panel in another worker generation, a repair, the CDP helper a
 * probe run uses to set `skip-checks` before it starts - was invisible to a worker that had already
 * read that site, and was silently overwritten by the next `set`. That is the same defect T111f
 * fixed for the pairing controller, and it is answered the same way: storage announces the change,
 * the cache is dropped, and the next read comes from the record.
 */
describe("T129c the stored record outranks the cache", () => {
  const STORAGE_KEY = "agentSiteModes";
  type Entry = { mode: string; diagnosticsGranted: boolean };

  let local: Record<string, unknown>;
  let listeners: ((changes: Record<string, unknown>, areaName: string) => void)[];

  beforeEach(() => {
    local = {};
    listeners = [];
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          async get(keys: string[]) {
            const out: Record<string, unknown> = {};
            for (const key of keys) if (key in local) out[key] = local[key];
            return out;
          },
          async set(values: Record<string, unknown>) {
            Object.assign(local, values);
            for (const listener of listeners) {
              listener(
                Object.fromEntries(Object.keys(values).map((key) => [key, { newValue: values[key] }])),
                "local",
              );
            }
          },
        },
        onChanged: {
          addListener(listener: (changes: Record<string, unknown>, areaName: string) => void) {
            listeners.push(listener);
          },
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  /** A write to the key by something other than this store, and the event storage raises for it. */
  function writeElsewhere(records: Record<string, Entry>): void {
    local[STORAGE_KEY] = records;
    for (const listener of listeners) {
      listener({ [STORAGE_KEY]: { newValue: records } }, "local");
    }
  }

  it("reads back a mode set outside it for a site it has already read", async () => {
    const store = createSiteModeStore();
    // The store has read this site, so from here on it is answering from its cache.
    await expect(store.get("https://fixtures.test")).resolves.toMatchObject({ mode: "ask" });

    writeElsewhere({ "https://fixtures.test": { mode: "skip-checks", diagnosticsGranted: false } });

    await expect(store.get("https://fixtures.test")).resolves.toMatchObject({ mode: "skip-checks" });
  });

  it("keeps a mode written outside it when an unrelated mutation follows", async () => {
    const store = createSiteModeStore();
    await store.get("https://fixtures.test");

    writeElsewhere({ "https://fixtures.test": { mode: "skip-checks", diagnosticsGranted: false } });
    await store.set("https://other.test", { mode: "follow-a-plan" });

    await expect(store.get("https://fixtures.test")).resolves.toMatchObject({ mode: "skip-checks" });
    expect((local[STORAGE_KEY] as Record<string, Entry>)["https://fixtures.test"]).toEqual({
      mode: "skip-checks",
      diagnosticsGranted: false,
    });
  });
});
