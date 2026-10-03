import { describe, expect, it } from "vitest";
import type { AgentBrowserSummary } from "@hallpass/contracts";
import { resolveBrowser, type BrowserResolution, type ResolveBrowserInput } from "../src/resolve-browser.js";

/**
 * 018 T502 - the data-model "Resolution" table (R-270, R-278, FR-271, FR-272, FR-277, D-018-13),
 * one row per case: 0 / 1 / several connected, crossed with no choice, a remembered browser online
 * and offline, and a session-bound browser present, absent within the attach bound and beyond it.
 */

const A: AgentBrowserSummary = { browserId: "browser-a", name: "Chrome", kind: "chrome" };
const B: AgentBrowserSummary = { browserId: "browser-b", name: "Edge", kind: "edge" };
const GONE: AgentBrowserSummary = { browserId: "browser-gone", name: "Work Brave", kind: "brave" };

const NOW = 1_000_000;
const GRACE = 10_000;

function resolve(overrides: Partial<ResolveBrowserInput>): BrowserResolution {
  return resolveBrowser({ connected: [], attachGraceMs: GRACE, now: NOW, ...overrides });
}

const notChosen = (browsers: AgentBrowserSummary[]): BrowserResolution => ({ kind: "refuse-not-chosen", browsers });
const use = (browserId: string): BrowserResolution => ({ kind: "use", browserId });

describe("018 T502 resolveBrowser: not bound", () => {
  it("none connected is the bridge-unavailable case, whatever is remembered", () => {
    expect(resolve({})).toEqual({ kind: "none" });
    expect(resolve({ rememberedBrowserId: A.browserId })).toEqual({ kind: "none" });
  });

  it("no remembered browser: one connected is used, several are refused (FR-271, FR-272)", () => {
    expect(resolve({ connected: [A] })).toEqual(use(A.browserId));
    expect(resolve({ connected: [A, B] })).toEqual(notChosen([A, B]));
  });

  it("a remembered browser that is connected is used, with one or several (FR-273)", () => {
    expect(resolve({ connected: [A], rememberedBrowserId: A.browserId })).toEqual(use(A.browserId));
    expect(resolve({ connected: [A, B], rememberedBrowserId: B.browserId })).toEqual(use(B.browserId));
  });

  it("a remembered browser that is offline is still the choice: refused even with one other (D-018-13)", () => {
    expect(resolve({ connected: [A], rememberedBrowserId: GONE.browserId })).toEqual(notChosen([A]));
    expect(resolve({ connected: [A, B], rememberedBrowserId: GONE.browserId })).toEqual(notChosen([A, B]));
  });
});

describe("018 T502 resolveBrowser: bound to a browser (R-278, FR-277)", () => {
  it("a connected bound browser is used, whatever is remembered or connected besides", () => {
    expect(resolve({ connected: [A], boundBrowserId: A.browserId })).toEqual(use(A.browserId));
    expect(
      resolve({ connected: [A, B], boundBrowserId: A.browserId, rememberedBrowserId: B.browserId }),
    ).toEqual(use(A.browserId));
  });

  it("an absent bound browser is waited for within the attach bound, with 0, 1 or several others", () => {
    for (const connected of [[], [A], [A, B]]) {
      expect(
        resolve({ connected, boundBrowserId: GONE.browserId, boundAbsentSinceMs: NOW - GRACE + 1 }),
      ).toEqual({ kind: "wait" });
    }
  });

  it("an absent bound browser with no absence time yet has only just gone: wait", () => {
    expect(resolve({ connected: [A], boundBrowserId: GONE.browserId })).toEqual({ kind: "wait" });
  });

  it("beyond the attach bound it is refused as disconnected, never replaced - even by exactly one", () => {
    for (const connected of [[], [A], [A, B]]) {
      expect(
        resolve({
          connected,
          boundBrowserId: GONE.browserId,
          boundBrowser: GONE,
          boundAbsentSinceMs: NOW - GRACE,
          rememberedBrowserId: A.browserId,
        }),
      ).toEqual({ kind: "refuse-disconnected", browser: GONE, browsers: connected });
    }
  });

  it("names a lost browser it has no summary for by its id, as an unknown browser", () => {
    expect(
      resolve({ connected: [A], boundBrowserId: GONE.browserId, boundAbsentSinceMs: NOW - GRACE - 1 }),
    ).toEqual({
      kind: "refuse-disconnected",
      browser: { browserId: GONE.browserId, name: "Browser", kind: "unknown" },
      browsers: [A],
    });
  });
});
