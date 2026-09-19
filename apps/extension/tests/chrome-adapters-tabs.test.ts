import { afterEach, describe, expect, it } from "vitest";
import { getTabSnapshot, queryTabSnapshots } from "../src/chrome-adapters/tabs.js";

/**
 * 004/T166 — a tab with no address is reported as one, not as an empty field.
 *
 * Chrome's own tab record answers `url: ""` for a document that has committed nothing yet - the
 * same fact `about:blank` names everywhere else in this codebase (the packaged `agent-tabs` spec
 * asserts a freshly created blank tab's own `chrome.tabs.get().url` is the literal string). An
 * agent reading an empty string cannot tell "no address" from "the field was left out"; the honest
 * answer is the address Chrome uses for that state.
 */
describe("T166 a tab snapshot's url for a document with no address", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  function installChrome(url: string | undefined): void {
    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        async get(tabId: number) {
          return { id: tabId, url, title: "", groupId: -1, active: false, windowId: 900 };
        },
        async query() {
          return [{ id: 7, url, title: "", groupId: -1, active: false, windowId: 900 }];
        },
      },
    };
  }

  it("reports 'about:blank' rather than an empty string, from getTabSnapshot", async () => {
    installChrome("");

    const snapshot = await getTabSnapshot(7);

    expect(snapshot?.url).toBe("about:blank");
  });

  it("reports 'about:blank' rather than an empty string, from queryTabSnapshots", async () => {
    installChrome("");

    const [snapshot] = await queryTabSnapshots();

    expect(snapshot?.url).toBe("about:blank");
  });

  it("leaves an ordinary url exactly as Chrome reported it", async () => {
    installChrome("https://example.test/");

    const snapshot = await getTabSnapshot(7);

    expect(snapshot?.url).toBe("https://example.test/");
  });
});
