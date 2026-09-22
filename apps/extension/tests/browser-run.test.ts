import { describe, expect, it } from "vitest";
import {
  AGENT_BROWSER_RUN_KEY,
  createBrowserRun,
  type StorageAreaLike,
} from "../src/service-worker/browser-run.js";

/**
 * 013/S4 (R-184, FR-168) — the one id that says which run of the browser this is.
 *
 * It exists so the host can tell a recycled service worker from a browser that exited: those look
 * identical on the link, and FR-168 promises the retention survives the first and ends with the
 * second. Everything the id has to do follows from that - minted once per browser start, read back
 * unchanged by a worker Chrome evicted and started again, and gone when `chrome.storage.session`
 * is (which is when the browser goes).
 */
describe("S4 the browser run id", () => {
  /** `chrome.storage.session` as this module uses it; the store outlives the worker, as it does. */
  function fakeArea(): StorageAreaLike & { items: Record<string, unknown> } {
    const items: Record<string, unknown> = {};
    return {
      items,
      async get(keys: string[]) {
        return Object.fromEntries(keys.filter((key) => key in items).map((key) => [key, items[key]]));
      },
      async set(next: Record<string, unknown>) {
        Object.assign(items, next);
      },
    };
  }

  it("mints one id for the browser and hands the same one back", async () => {
    const area = fakeArea();
    const run = createBrowserRun(area);

    const first = await run.id();
    const second = await run.id();

    expect(first).toMatch(/^[0-9a-f-]{8,64}$/u);
    expect(second).toBe(first);
    // In storage, not in a variable: a variable is the one thing an eviction takes away.
    expect(area.items[AGENT_BROWSER_RUN_KEY]).toBe(first);
  });

  it("reads the same id back after the worker was recycled", async () => {
    const area = fakeArea();
    const before = await createBrowserRun(area).id();

    // A new module instance over the same storage area is what a restarted worker is: Chrome keeps
    // `storage.session` across the eviction and hands the next worker the same area.
    const after = await createBrowserRun(area).id();

    expect(after).toBe(before);
  });

  it("mints a new id once the browser has gone", async () => {
    const before = await createBrowserRun(fakeArea()).id();

    // A new browser gets an empty `storage.session`, which is the whole of "the browser exited".
    const after = await createBrowserRun(fakeArea()).id();

    expect(after).not.toBe(before);
  });

  it("mints once when two callers ask at the same time", async () => {
    const area = fakeArea();
    const run = createBrowserRun(area);

    const [first, second] = await Promise.all([run.id(), run.id()]);

    // Two concurrent pairing answers must not describe the same browser as two runs; the host
    // would read the second as a restart and forget a picture it promised to keep.
    expect(second).toBe(first);
  });

  it("says nothing when there is no session storage to keep an id in", async () => {
    // A run id this worker cannot keep would be a new one after every eviction, which the host
    // would read as a browser restart every time; `undefined` leaves it on its honest fall-back.
    await expect(createBrowserRun(undefined).id()).resolves.toBeUndefined();
  });
});
