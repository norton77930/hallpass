import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDownloadRecord, AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentTabTools } from "../src/service-worker/agent-tools/tabs.js";
import { createAgentTabManager } from "../src/service-worker/agent-tab-manager.js";

/**
 * 003/T041 — the tab tools (US4, FR-044..FR-046).
 *
 * The claims are about what the agent is *told*. A navigation reports the url the tab settled on,
 * never the one it was asked for, because a redirect and a refusal both end somewhere else. A tab
 * the owner closed by hand is `stale`, not a silent success on a tab that is not there. A tab
 * outside the session's group is refused however ordinary the request looks (SC-024). And nothing
 * here ever prompts the owner: navigating is not an effect on a page, it is a change of which page
 * the session is looking at, and the mode of wherever it lands governs what may happen next
 * (FR-045).
 */

type FakeTab = {
  id: number;
  url: string;
  title: string;
  groupId: number;
  windowId: number;
  active: boolean;
  history: string[];
  historyIndex: number;
  /** The tab's content area, as Chrome reports it (012/S2c F4): smaller than the window it is in. */
  width: number;
  height: number;
  /** Where the tab is on its way to, before its first document commits (010 coverage, Edge). */
  pendingUrl?: string;
  status?: string;
};

type FakeChrome = {
  tabs: FakeTab[];
  removed: number[];
  windows: Array<{ id: number; width: number; height: number }>;
  /** Set to a status the navigation never reaches, to exercise the bound. */
  neverCompletes: boolean;
  /**
   * Chrome announcing that the page the tab is *leaving* has finished loading, after the navigation
   * was issued but before it began (003/B4). Real and common: a slow page finishes while the agent
   * is asking for the next one.
   */
  staleCompleteFirst: boolean;
  /**
   * The owner closing the tab by hand in the moment between the ownership check and the close
   * itself, which is how Chrome's own `tabs.remove` comes to throw (003/B7).
   */
  closeRaces: boolean;
  /**
   * Chrome's real shape for `tabs.create({ url })`: the promise resolves before the navigation has
   * committed, with `url: ""`, and the address appears on the record only when the document commits
   * a moment later (004/T167). The default fake commits at once, which is the shape the T167 red
   * could never be seen in.
   */
  commitsLate: boolean;
  /**
   * The worker's own record of the session's downloads (005/US2), as the observer would list them.
   * A url the browser downloads never commits, so a navigation there is told by *this* list that it
   * became a download rather than by a `complete` that never comes.
   */
  downloads: AgentDownloadRecord[];
  /**
   * Edge's shape for `tabs.create({ url })` (010 coverage, Edge transitions): the tab answers on its
   * initial empty document with the url it was asked for still pending, and commits it a moment
   * later. A `tabs.update` that lands before that commit is lost the way Edge loses it - see the
   * fake `update`.
   */
  firstNavigationPending: boolean;
  /**
   * With `firstNavigationPending`: the first navigation never commits, so the tab stays on its
   * empty document with the url still pending until the hold's own bound releases it.
   */
  firstNavigationNeverCommits: boolean;
  /** When each `tabs.update` was made, against when the first navigation committed. */
  updatedAt: number[];
  committedAt: number | undefined;
};

const UNGROUPED = -1;

function installChrome(): FakeChrome {
  const state: FakeChrome = {
    tabs: [
      {
        id: 1,
        url: "https://owner.test/",
        title: "The owner's page",
        groupId: UNGROUPED,
        windowId: 900,
        active: true,
        history: ["https://owner.test/"],
        historyIndex: 0,
        width: 1180,
        height: 700,
      },
      // A page no session may hold, so a claim has something to refuse for a reason that is about
      // the page rather than about another session (004/T104).
      {
        id: 50,
        url: "chrome://settings/",
        title: "Settings",
        groupId: UNGROUPED,
        windowId: 900,
        active: false,
        history: ["chrome://settings/"],
        historyIndex: 0,
        width: 1180,
        height: 700,
      },
    ],
    removed: [],
    windows: [{ id: 900, width: 1200, height: 900 }],
    neverCompletes: false,
    staleCompleteFirst: false,
    closeRaces: false,
    commitsLate: false,
    downloads: [],
    firstNavigationPending: false,
    firstNavigationNeverCommits: false,
    updatedAt: [],
    committedAt: undefined,
  };
  let nextTabId = 2;
  let nextGroupId = 100;
  const store: Record<string, unknown> = {};
  const updateListeners: Array<(tabId: number, changeInfo: { status?: string }, tab: unknown) => void> = [];

  function announce(tab: FakeTab, changeInfo: { status?: string; url?: string }): void {
    for (const listener of updateListeners) listener(tab.id, changeInfo, tab);
  }

  function settle(tab: FakeTab): void {
    if (state.neverCompletes) return;
    // Chrome reports the status changes asynchronously, after the caller's own promise resolves,
    // and a real load is `loading` before it is `complete`.
    setTimeout(() => {
      announce(tab, { status: "loading", url: tab.url });
      announce(tab, { status: "complete" });
    }, 0);
  }

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(store, values);
        },
      },
    },
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return state.tabs;
      },
      async create({ url }: { url?: string }) {
        const tab: FakeTab = {
          id: nextTabId++,
          url: state.commitsLate ? "" : (url ?? "about:blank"),
          // Chrome has no title for a tab it has only just created; the empty string is that fact.
          title: "",
          groupId: UNGROUPED,
          windowId: 900,
          active: false,
          history: [url ?? "about:blank"],
          historyIndex: 0,
          width: 1180,
          height: 700,
        };
        state.tabs.push(tab);
        if (state.firstNavigationPending && url !== undefined) {
          tab.url = "about:blank";
          tab.pendingUrl = url;
          tab.status = "loading";
          setTimeout(() => {
            if (state.firstNavigationNeverCommits || tab.pendingUrl !== url) return;
            tab.url = url;
            delete tab.pendingUrl;
            state.committedAt = Date.now();
            announce(tab, { status: "loading", url });
            tab.status = "complete";
            announce(tab, { status: "complete" });
          }, 100);
          return tab;
        }
        if (state.commitsLate) {
          setTimeout(() => {
            tab.url = url ?? "about:blank";
            settle(tab);
          }, 10);
        } else {
          settle(tab);
        }
        return tab;
      },
      async update(tabId: number, { url }: { url?: string }) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        if (url === "https://refused.test/") throw new Error("Cannot navigate to that url");
        state.updatedAt.push(Date.now());
        if (url !== undefined && tab.url === "about:blank" && tab.pendingUrl !== undefined) {
          // Edge, measured: the tab goes on to load its *original* url, then drops to `unloaded` with
          // no renderer. The url asked for here is never loaded and nothing ever completes.
          const original = tab.pendingUrl;
          delete tab.pendingUrl;
          setTimeout(() => {
            tab.status = "loading";
            announce(tab, { status: "loading", url: original });
            setTimeout(() => {
              tab.status = "unloaded";
              announce(tab, { status: "unloaded" });
            }, 20);
          }, 10);
          return tab;
        }
        // A url the browser downloads rather than renders (005/US2): the tab stays on its page,
        // nothing commits and nothing is announced - the download record is the only trace.
        if (url?.endsWith(".zip")) return tab;
        if (state.staleCompleteFirst && url !== undefined) {
          // The page being left finishes loading first, and the new one starts only afterwards.
          announce(tab, { status: "complete" });
          const leaving = tab;
          setTimeout(() => {
            leaving.history = [...leaving.history.slice(0, leaving.historyIndex + 1), url];
            leaving.historyIndex = leaving.history.length - 1;
            leaving.url = url;
            settle(leaving);
          }, 5);
          return tab;
        }
        if (url !== undefined) {
          tab.history = [...tab.history.slice(0, tab.historyIndex + 1), url];
          tab.historyIndex = tab.history.length - 1;
          // A redirect: what the tab settles on is not what was asked for.
          tab.url = url === "https://example.test/redirect" ? "https://example.test/landed" : url;
          tab.history[tab.historyIndex] = tab.url;
        }
        settle(tab);
        return tab;
      },
      async goBack(tabId: number) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.historyIndex === 0) throw new Error("Cannot find a previous page");
        tab.historyIndex -= 1;
        tab.url = tab.history[tab.historyIndex] ?? tab.url;
        settle(tab);
      },
      async goForward(tabId: number) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab || tab.historyIndex >= tab.history.length - 1) throw new Error("Cannot find a next page");
        tab.historyIndex += 1;
        tab.url = tab.history[tab.historyIndex] ?? tab.url;
        settle(tab);
      },
      async remove(tabId: number) {
        if (state.closeRaces) {
          // Chrome's own words when the tab went away first.
          state.tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
          throw new Error(`No tab with id: ${tabId}.`);
        }
        state.removed.push(tabId);
        state.tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = UNGROUPED;
        }
      },
      onUpdated: {
        addListener(callback: (tabId: number, changeInfo: { status?: string }, tab: unknown) => void) {
          updateListeners.push(callback);
        },
        removeListener(callback: (tabId: number, changeInfo: { status?: string }, tab: unknown) => void) {
          const at = updateListeners.indexOf(callback);
          if (at >= 0) updateListeners.splice(at, 1);
        },
      },
    },
    tabGroups: {
      async update(groupId: number, properties: unknown) {
        return { id: groupId, ...(properties as object) };
      },
    },
    windows: {
      // The adapter reads the window's state before resizing; every window here is a normal one.
      async get(windowId: number) {
        const window = state.windows.find((candidate) => candidate.id === windowId);
        if (!window) throw new Error("No window with id");
        return { ...window, state: "normal" };
      },
      async update(windowId: number, { width, height }: { width?: number; height?: number }) {
        const window = state.windows.find((candidate) => candidate.id === windowId);
        if (!window) throw new Error("No window with id");
        // Chrome clamps to what fits; the agent is told what it got, not what it asked for.
        if (width !== undefined) window.width = Math.min(width, 1600);
        if (height !== undefined) window.height = Math.min(height, 1200);
        return window;
      },
    },
  };
  return state;
}

const SESSION = "session-a";

function call(tool: string, args: Record<string, unknown>, callId = "call-1"): AgentNativeRequest {
  return { callId, sessionId: SESSION, tool: tool as AgentNativeRequest["tool"], args };
}

describe("T041 agent tab tools", () => {
  let fake: FakeChrome;
  let invalidated: number[];
  let changes: number;
  /** The same store the tools run against, so a test can put a tab in another session's hands. */
  let manager: ReturnType<typeof createAgentTabManager>;
  let viewportCalls: Array<{
    verb: "set" | "reset";
    sessionId: string;
    tabId: number;
    size?: { width: number; height: number };
  }>;
  /** Set by the test that wants Chrome to refuse the attachment the emulation needs. */
  let viewportRefusal: "devtools-open" | "restricted-page" | undefined;
  /** What a `reset` could measure of the real page; `undefined` when it could not read it. */
  let viewportReal: { width: number; height: number } | undefined;

  function build(
    navigationTimeoutMs = 60,
    extra: Partial<Parameters<typeof createAgentTabTools>[0]> = {},
  ): ReturnType<typeof createAgentTabTools> {
    invalidated = [];
    changes = 0;
    viewportCalls = [];
    manager = createAgentTabManager();
    return createAgentTabTools({
      context: testSessionContexts(),
      tabs: manager,
      bindings: {
        invalidate(tabId: number) {
          invalidated.push(tabId);
        },
      },
      navigationTimeoutMs,
      onTabsChanged() {
        changes += 1;
      },
      downloads: { list: async (sessionId) => (sessionId === SESSION ? fake.downloads : []) },
      viewport: viewportModule(),
      ...extra,
    });
  }

  /**
   * The viewport module as this tool uses it (012/T307): two calls, and the honest answers the
   * real one gives - an attachment Chrome refused, and a `reset` that could not measure the page.
   */
  function viewportModule(): Parameters<typeof createAgentTabTools>[0]["viewport"] {
    return {
      async set(sessionId, tabId, size) {
        viewportCalls.push({ verb: "set", sessionId, tabId, size });
        return viewportRefusal === undefined ? { ok: true } : { ok: false, unavailableReason: viewportRefusal };
      },
      async reset(sessionId, tabId) {
        viewportCalls.push({ verb: "reset", sessionId, tabId });
        if (viewportRefusal !== undefined) return { ok: false, unavailableReason: viewportRefusal };
        return { ok: true, ...(viewportReal === undefined ? {} : { real: viewportReal }) };
      },
    };
  }

  /** A download record as the observer writes one at `onCreated`: no name yet, size unknown. */
  function download(id: number, url: string, startedAt = new Date().toISOString()): AgentDownloadRecord {
    return {
      id,
      filename: "",
      url,
      state: "in_progress",
      startedAt,
      bytesReceived: 0,
      totalBytes: -1,
      danger: false,
      attribution: "session",
    };
  }

  beforeEach(() => {
    fake = installChrome();
    viewportRefusal = undefined;
    viewportReal = { width: 1187, height: 707 };
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("creates a tab inside the session's own group and adopts it", async () => {
    const tools = build();

    const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));

    expect(created.outcome).toBe("ok");
    const { tabId } = created.result as { tabId: number };
    const tab = fake.tabs.find((candidate) => candidate.id === tabId);
    expect(tab?.groupId).not.toBe(UNGROUPED);
    // The owner's own tab is not in the group, which is what SC-024's refusals rest on.
    expect(fake.tabs.find((candidate) => candidate.id === 1)?.groupId).toBe(UNGROUPED);
  });

  /**
   * 004/T167. `chrome.tabs.create({ url })` resolves before the document commits, so the record the
   * tool announces the tab from may still say `about:blank`, and the panel's per-site list - built
   * from where the session's tabs are - then has no entry for the page the agent just opened. Nothing
   * later refreshes it: the projection is announced by the tools, not watched on `tabs.onUpdated`.
   * The owner could not set a mode for the site until the agent's next tab call, and a journey that
   * waits for the entry timed out (the `side-panel-text-timeout` inside `setSiteMode`).
   */
  it("announces the tab again once its address has committed, so the panel can list its site (T167)", async () => {
    fake.commitsLate = true;
    const tools = build();

    const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
    expect(created.outcome).toBe("ok");
    const announcedBeforeCommit = changes;

    // Past the harness's navigation bound (60 ms), so the re-read has run its course either way.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { tabId } = created.result as { tabId: number };
    expect(fake.tabs.find((candidate) => candidate.id === tabId)?.url).toBe("https://example.test/one");
    expect(changes).toBeGreaterThan(announcedBeforeCommit);
  });

  it("does not announce a second time when the address was already committed at creation", async () => {
    const tools = build();

    await tools.run(call("tabs_create", { url: "https://example.test/one" }));
    const announced = changes;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(changes).toBe(announced);
  });

  it("opens a blank tab when no url is named", async () => {
    const tools = build();

    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    expect(fake.tabs.find((candidate) => candidate.id === tabId)?.url).toBe("about:blank");
  });

  it("lists every tab in the browser, who holds it, and which one the owner is looking at", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
    const { tabId } = created.result as { tabId: number };
    // Another agent is holding the owner's first tab; the list has to say so by name, because
    // "wait" and "claim" are different next moves (004/T104, R-117).
    await manager.claim("session-b", 1);

    const listed = await tools.run(call("tabs_context", {}));

    expect(listed.result).toEqual([
      {
        tabId: 1,
        url: "https://owner.test/",
        title: "The owner's page",
        active: true,
        windowId: 900,
        holder: { sessionId: "session-b" },
      },
      { tabId: 50, url: "chrome://settings/", title: "Settings", active: false, windowId: 900, holder: "none" },
      { tabId, url: "https://example.test/one", title: "", active: false, windowId: 900, holder: "this" },
    ]);
  });

  /**
   * The list is the one tool that answers before anything is held: an agent that had to hold a tab
   * to find out which tabs exist could never make its first claim (004/T104, FR-057).
   */
  it("lists the browser for a session holding nothing at all", async () => {
    const tools = build();

    const listed = await tools.run(call("tabs_context", {}));

    expect(listed).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: [
        { tabId: 1, url: "https://owner.test/", title: "The owner's page", active: true, windowId: 900, holder: "none" },
        { tabId: 50, url: "chrome://settings/", title: "Settings", active: false, windowId: 900, holder: "none" },
      ],
    });
  });

  it("claims one of the owner's tabs, groups it, and makes it the session's main tab", async () => {
    const tools = build();

    const claimed = await tools.run(call("tabs_claim", { tabId: 1 }));

    const groupId = fake.tabs.find((candidate) => candidate.id === 1)?.groupId ?? UNGROUPED;
    expect(groupId).not.toBe(UNGROUPED);
    expect(claimed).toEqual({ callId: "call-1", outcome: "ok", result: { tabId: 1, groupId } });
    // Held now, so the tools that were refusing it work - and the indicator's control has a target.
    await expect(manager.mainTabId(SESSION)).resolves.toBe(1);
    await expect(
      tools.run(call("resize_window", { tabId: 1, width: 800, height: 600 })),
    ).resolves.toMatchObject({ outcome: "ok" });
  });

  it("refuses a claim on a tab another session holds, naming that session", async () => {
    const tools = build();
    await manager.claim("session-b", 1);

    const refused = await tools.run(call("tabs_claim", { tabId: 1 }));

    expect(refused).toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "held-by-session",
      refusal: { reason: "held-by-session", sessionId: "session-b" },
    });
  });

  it("refuses a claim on a restricted page and on a tab that is gone", async () => {
    const tools = build();

    await expect(tools.run(call("tabs_claim", { tabId: 50 }))).resolves.toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "restricted-page",
      refusal: { reason: "restricted-page" },
    });
    await expect(tools.run(call("tabs_claim", { tabId: 404 }))).resolves.toEqual({
      callId: "call-1",
      outcome: "stale",
      reason: "tab-gone",
    });
  });

  it("releases a claimed tab: it leaves the group, stays open, and is anybody's again", async () => {
    const tools = build();
    await tools.run(call("tabs_claim", { tabId: 1 }));

    const released = await tools.run(call("tabs_release", { tabId: 1 }));

    expect(released).toEqual({ callId: "call-1", outcome: "ok", result: { released: true } });
    expect(fake.tabs.find((candidate) => candidate.id === 1)?.groupId).toBe(UNGROUPED);
    expect(fake.removed).toEqual([]);
    const listed = await tools.run(call("tabs_context", {}));
    expect(listed.result).toContainEqual(expect.objectContaining({ tabId: 1, holder: "none" }));
  });

  it("refuses to release a tab this session does not hold", async () => {
    const tools = build();
    await manager.claim("session-b", 1);

    await expect(tools.run(call("tabs_release", { tabId: 1 }))).resolves.toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "held-by-session",
      refusal: { reason: "held-by-session", sessionId: "session-b" },
    });
    expect(fake.tabs.find((candidate) => candidate.id === 1)?.groupId).not.toBe(UNGROUPED);
  });

  it("reports the url the tab settled on, not the one it was asked for", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/redirect" }));

    expect(navigated).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { url: "https://example.test/landed" },
    });
    // Every ref minted against the old document belongs to a page that is no longer there.
    expect(invalidated).toContain(tabId);
  });

  /**
   * 010 coverage (Edge transitions). `tabs_create` answers before the tab's first navigation has
   * begun (004/T167), and an agent that navigates at once used to send the tab elsewhere while it
   * was still on its initial empty document. Edge then loaded the original url anyway, dropped the
   * tab to `unloaded` and never loaded ours: half the runs answered `navigation-timeout` at the full
   * bound. The navigation now waits, briefly, for the tab's own first commit.
   */
  it("waits for a new tab's own first navigation to commit before sending it elsewhere (010, Edge)", async () => {
    fake.firstNavigationPending = true;
    const tools = build(2_000);
    const created = await tools.run(call("tabs_create", { url: "https://example.test/transition-a" }));
    const { tabId } = created.result as { tabId: number };

    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/go-b" }));

    expect(navigated).toEqual({ callId: "call-1", outcome: "ok", result: { url: "https://example.test/go-b" } });
    expect(fake.committedAt).toBeDefined();
    expect(fake.updatedAt[0]).toBeGreaterThanOrEqual(fake.committedAt ?? Infinity);
  });

  it("answers a tab closed during the first-commit hold as gone, not refused (010, Edge)", async () => {
    fake.firstNavigationPending = true;
    fake.firstNavigationNeverCommits = true;
    // A 20 s bound holds for up to 4 s: the tab is closed 2 s into that.
    const tools = build(20_000);
    const created = await tools.run(call("tabs_create", { url: "https://example.test/closing" }));
    const { tabId } = created.result as { tabId: number };
    setTimeout(() => {
      fake.tabs.splice(
        fake.tabs.findIndex((candidate) => candidate.id === tabId),
        1,
      );
    }, 2_000);

    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/go-b" }));

    expect(navigated).toEqual({ callId: "call-1", outcome: "stale", reason: "tab-gone" });
    expect(fake.updatedAt).toEqual([]);
  });

  it("releases the hold on a first navigation that never commits, inside the navigation bound (010, Edge)", async () => {
    fake.firstNavigationPending = true;
    fake.firstNavigationNeverCommits = true;
    const bound = 2_000;
    const tools = build(bound);
    const created = await tools.run(call("tabs_create", { url: "https://example.test/stuck" }));
    const { tabId } = created.result as { tabId: number };

    const startedAt = Date.now();
    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/go-b" }));
    const elapsed = Date.now() - startedAt;

    // The update goes out once the hold's own bound - min(5 s, bound / 5) = 400 ms - has passed.
    const sentAfter = (fake.updatedAt[0] ?? Infinity) - startedAt;
    expect(sentAfter).toBeGreaterThanOrEqual(bound / 5);
    expect(sentAfter).toBeLessThan(bound / 5 + 150);
    // Edge loses that update, so the call runs out its bound: the one bound with the hold taken out
    // of it, not the bound on top of the hold (bound + 400 ms). The slack is timer jitter only.
    expect(navigated).toEqual({ callId: "call-1", outcome: "failed", reason: "navigation-timeout" });
    expect(elapsed).toBeLessThan(bound + 100);
  });

  it("navigates a deliberately blank tab at once: nothing pending is nothing to wait for (010, Edge)", async () => {
    const tools = build(2_000);
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    const tab = fake.tabs.find((candidate) => candidate.id === tabId);
    if (tab) tab.status = "complete";

    const startedAt = Date.now();
    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/two" }));

    expect(navigated.outcome).toBe("ok");
    // Well inside the first-commit wait's bound (400 ms at a 2 s navigation bound).
    expect((fake.updatedAt[0] ?? Infinity) - startedAt).toBeLessThan(50);
  });

  it("walks the tab's own history back and forward", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
    const { tabId } = created.result as { tabId: number };
    await tools.run(call("navigate", { tabId, url: "https://example.test/two" }));

    const back = await tools.run(call("navigate", { tabId, direction: "back" }));
    expect(back.result).toEqual({ url: "https://example.test/one" });

    const forward = await tools.run(call("navigate", { tabId, direction: "forward" }));
    expect(forward.result).toEqual({ url: "https://example.test/two" });
  });

  it("says the browser refused a url rather than claiming it went there", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const navigated = await tools.run(call("navigate", { tabId, url: "https://refused.test/" }));

    expect(navigated.outcome).toBe("failed");
    expect(navigated.reason).toBe("navigation-refused");
  });

  it("bounds a navigation that never settles", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    // Let the new tab's own `complete` land first: the bound is about a navigation that never
    // finishes, not about a stale completion from the load before it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.neverCompletes = true;

    const navigated = await tools.run(call("navigate", { tabId, url: "https://slow.test/" }));

    expect(navigated.outcome).toBe("failed");
    expect(navigated.reason).toBe("navigation-timeout");
  });

  /**
   * 005/US2 (T187 B19) — a url the browser downloads never commits, so the navigation's `complete`
   * never comes and the tool ran to its full bound before saying `navigation-timeout` about a
   * download that had long since landed (probe S8, 2026-09-13). The download record is the fact
   * that ends it: the session's, for the url asked for, begun after the navigation began.
   */
  it("answers ok with the download when the url is one the browser downloads", async () => {
    const tools = build(2_000);
    const created = await tools.run(call("tabs_create", { url: "https://example.test/" }));
    const { tabId } = created.result as { tabId: number };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const url = "https://example.test/archive/master.zip";
    // The browser's record appears a moment after the navigation is issued, as the observer would
    // write it: unnamed, size unknown, still running.
    setTimeout(() => fake.downloads.unshift(download(12, url)), 10);

    const startedAt = Date.now();
    const navigated = await tools.run(call("navigate", { tabId, url }));

    expect(navigated).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        url: "https://example.test/",
        download: { id: 12, filename: "", url, state: "in_progress" },
      },
    });
    // Well before the 2 s bound: the answer came from the record, not from the timer.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(invalidated).toContain(tabId);
  });

  it("is not fooled by an earlier download, or by another url's, into calling a navigation a download", async () => {
    const tools = build(150);
    const created = await tools.run(call("tabs_create", { url: "https://example.test/" }));
    const { tabId } = created.result as { tabId: number };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const url = "https://example.test/archive/master.zip";
    // A record of the same url from before this navigation, and one of a different url after it.
    fake.downloads.unshift(download(3, url, new Date(Date.now() - 5_000).toISOString()));
    setTimeout(() => fake.downloads.unshift(download(4, "https://example.test/other.zip")), 10);

    const navigated = await tools.run(call("navigate", { tabId, url }));

    expect(navigated).toEqual({ callId: "call-1", outcome: "failed", reason: "navigation-timeout" });
  });

  /**
   * 003/B4 — a `complete` is only this navigation's when this navigation caused it.
   *
   * The watcher is armed before the action, which is right, but it then accepted the very first
   * `complete` it saw - including the one announcing that the page being *left* had finished
   * loading. The navigation was reported as settled before it had started, and the url handed back
   * was the old page's.
   */
  it("ignores a completion that belongs to the page it is leaving (B4)", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
    const { tabId } = created.result as { tabId: number };
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.staleCompleteFirst = true;

    const navigated = await tools.run(call("navigate", { tabId, url: "https://example.test/two" }));

    expect(navigated).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { url: "https://example.test/two" },
    });
  });

  /**
   * 003/B7 — closing a tab the owner just closed is not a failure of this tool.
   *
   * The ownership check and the close are two moments, and the owner can act between them. The
   * throw that follows was reported as a handler error, which reads as "something is broken here";
   * what actually happened is the ordinary FR-044 case, and the agent has one word for it.
   */
  it("answers stale when the owner closed the tab first (B7)", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    fake.closeRaces = true;

    const closed = await tools.run(call("tabs_close", { tabId }));

    expect(closed).toEqual({ callId: "call-1", outcome: "stale", reason: "tab-gone" });
    // And the session lets it go: a tab nobody has is not held against the next call.
    expect(invalidated).toContain(tabId);
  });

  /**
   * 012/T307 — `viewport` answers about the page, never about the window (FR-156, FR-157).
   *
   * The three answers are the whole tool: the size that was asked for and honoured, the page's real
   * size after it is given back, and the refusal for a tab Chrome will not let this session debug.
   * The window is not touched on any of them - that is `resize_window`, and the two are independent
   * (FR-165).
   */
  it("gives a tab the size it asked for, and says the size is emulated", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const set = await tools.run(call("viewport", { tabId, action: "set", width: 375, height: 812 }));

    expect(set).toEqual({ callId: "call-1", outcome: "ok", result: { width: 375, height: 812, emulated: true } });
    expect(viewportCalls).toEqual([{ verb: "set", sessionId: SESSION, tabId, size: { width: 375, height: 812 } }]);
    // The owner's window is where they left it: this tool changes what the page believes, nothing else.
    expect(fake.windows[0]).toEqual({ id: 900, width: 1200, height: 900 });
  });

  it("answers a reset with the page's real size, and falls back to the window when it cannot read one", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const reset = await tools.run(call("viewport", { tabId, action: "reset" }));

    expect(reset).toEqual({ callId: "call-1", outcome: "ok", result: { width: 1187, height: 707, emulated: false } });
    expect(viewportCalls).toEqual([{ verb: "reset", sessionId: SESSION, tabId }]);

    // A page that cannot be measured - no attachment, a tab that never had a viewport - still gets
    // an answer, and it is the tab's own content area (012/S2c F4). The window's outer bounds are
    // a fact about furniture: they include the browser's own chrome, and an agent told 1 200x900
    // for a 1 180x700 page would aim every later coordinate at the wrong place.
    viewportReal = undefined;
    const unmeasured = await tools.run(call("viewport", { tabId, action: "reset" }));
    expect(unmeasured).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { width: 1180, height: 700, emulated: false },
    });
  });

  /**
   * 012/S2c F4 - a reset the attachment refused is not a reset.
   *
   * Chrome will not let an extension debug a tab with developer tools open on it, so the clear
   * never went out and the page is still the size the agent gave it. `emulated: false` there would
   * be this worker telling the agent something it has no reason to believe.
   */
  it("says input is unavailable when the reset could not be delivered", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    viewportRefusal = "devtools-open";

    const refused = await tools.run(call("viewport", { tabId, action: "reset" }));

    expect(refused).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "input-unavailable",
      refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
    });
  });

  it("says input is unavailable when Chrome will not let the session debug the tab, and stale when it is gone", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    viewportRefusal = "devtools-open";

    const refused = await tools.run(call("viewport", { tabId, action: "set", width: 375, height: 812 }));

    expect(refused).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "input-unavailable",
      refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
    });

    fake.tabs = fake.tabs.filter((candidate) => candidate.id !== tabId);
    const gone = await tools.run(call("viewport", { tabId, action: "reset" }));
    expect(gone).toEqual({ callId: "call-1", outcome: "stale", reason: "tab-gone" });
  });

  it("refuses every tab tool on a tab this session does not hold (SC-024)", async () => {
    const tools = build();

    for (const request of [
      call("navigate", { tabId: 1, url: "https://example.test/one" }),
      call("tabs_close", { tabId: 1 }),
      call("resize_window", { tabId: 1, width: 800, height: 600 }),
    ]) {
      const answer = await tools.run(request);
      expect(answer.outcome, request.tool).toBe("denied");
      // 004/T104: the owner's own tab is nobody's, which is a different fact from another
      // session's and leads to a different next move - claim it rather than wait for it.
      expect(answer.reason, request.tool).toBe("not-yours");
    }
    expect(fake.removed).toEqual([]);
  });

  it("names the holder when the refused tab belongs to another session (SC-024)", async () => {
    const tools = build();
    await manager.claim("session-b", 1);

    for (const request of [
      call("navigate", { tabId: 1, url: "https://example.test/one" }),
      call("tabs_close", { tabId: 1 }),
      call("resize_window", { tabId: 1, width: 800, height: 600 }),
    ]) {
      const answer = await tools.run(request);
      expect(answer, request.tool).toMatchObject({
        outcome: "denied",
        reason: "held-by-session",
        refusal: { reason: "held-by-session", sessionId: "session-b" },
      });
    }
    expect(fake.removed).toEqual([]);
  });

  it("answers stale for a tab the owner closed by hand (FR-044)", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };
    fake.tabs = fake.tabs.filter((candidate) => candidate.id !== tabId);

    const closed = await tools.run(call("tabs_close", { tabId }));

    expect(closed.outcome).toBe("stale");
    expect(closed.reason).toBe("tab-gone");
  });

  it("closes a tab it owns and stops listing it", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const closed = await tools.run(call("tabs_close", { tabId }));

    expect(closed).toEqual({ callId: "call-1", outcome: "ok", result: { closed: true } });
    expect(fake.removed).toEqual([tabId]);
    // Closed by the session itself, so it is not then reported "gone" as if the owner had done it -
    // and with 004's whole-browser listing, the claim is that the tab is not in it, held by nobody.
    const listed = await tools.run(call("tabs_context", {}));
    expect(listed.result).toEqual([
      { tabId: 1, url: "https://owner.test/", title: "The owner's page", active: true, windowId: 900, holder: "none" },
      { tabId: 50, url: "chrome://settings/", title: "Settings", active: false, windowId: 900, holder: "none" },
    ]);
  });

  it("resizes the window holding the tab and reports the size it got", async () => {
    const tools = build();
    const created = await tools.run(call("tabs_create", {}));
    const { tabId } = created.result as { tabId: number };

    const resized = await tools.run(call("resize_window", { tabId, width: 2000, height: 700 }));

    expect(resized.result).toEqual({ width: 1600, height: 700 });
  });

  /**
   * The panel's site list is built from the sites the session's tabs are on, so a tab tool that
   * changed which tabs those are without saying so would leave the owner unable to decide about a
   * page the agent is already sitting on (FR-042).
   */
  it("tells the panel whenever the session's tabs changed", async () => {
    const tools = build();
    expect(changes).toBe(0);

    const created = await tools.run(call("tabs_create", {}));
    expect(changes).toBe(1);
    const { tabId } = created.result as { tabId: number };

    await tools.run(call("navigate", { tabId, url: "https://example.test/one" }));
    expect(changes).toBe(2);

    await tools.run(call("tabs_close", { tabId }));
    expect(changes).toBe(3);

    // Reading the list changes nothing, so it announces nothing.
    await tools.run(call("tabs_context", {}));
    expect(changes).toBe(3);
  });

  it("refuses arguments the contract does not declare", async () => {
    const tools = build();

    const answer = await tools.run(call("navigate", { tabId: 1, url: "javascript:alert(1)" }));

    expect(answer).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments" });
  });

  /**
   * 008/T226 — a page with unsaved work is not left behind the owner's back (FR-115, US3 scenario 10).
   *
   * The default is the reference's own (design-notes §1): stay, tell the caller, lose nothing. What
   * is ours is that the caller is told *which page* refused, so `force` has something to aim at,
   * and that `force` is a decision the owner makes under the site's mode rather than a flag an
   * agent sets for itself.
   */
  describe("leaving a page that asked to stay", () => {
    /** The dialogs module as `agent-runtime.ts` wires it, with the outcome the policy produces. */
    function unloadStub(pageUrl: string) {
      const armed: Array<"stay" | "leave"> = [];
      let ended = 0;
      return {
        armed,
        ends: () => ended,
        dialogs: {
          beginUnload(tabId: number, policy: "stay" | "leave") {
            armed.push(policy);
            return {
              settled: Promise.resolve({ tabId, action: policy, url: pageUrl, at: Date.now() } as const),
              end() {
                ended += 1;
              },
            };
          },
        },
      };
    }

    it("answers blocked-by-beforeunload with the page's own url, and does not navigate", async () => {
      const stub = unloadStub("https://example.test/one");
      const tools = build(60, { dialogs: stub.dialogs });
      const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
      const { tabId } = created.result as { tabId: number };

      const answer = await tools.run(call("navigate", { tabId, url: "https://example.test/two" }));

      expect(answer).toMatchObject({
        outcome: "failed",
        reason: "blocked-by-beforeunload",
        refusal: { reason: "blocked-by-beforeunload", url: "https://example.test/one" },
      });
      // Armed to stay, and put back afterwards: the policy belongs to the call, not to the tab.
      expect(stub.armed).toEqual(["stay"]);
      expect(stub.ends()).toBe(1);
    });

    it("asks the owner before a forced leave, and leaves once they allow it", async () => {
      const stub = unloadStub("https://example.test/one");
      const asked: Array<Record<string, unknown>> = [];
      const tools = build(60, {
        dialogs: stub.dialogs,
        siteModes: {
          async get() {
            return { site: "https://example.test", mode: "ask" as const, diagnosticsGranted: false };
          },
          async set(site: string) {
            return { site, mode: "ask" as const, diagnosticsGranted: false };
          },
        },
        prompts: {
          async ask(prompt) {
            asked.push(prompt as unknown as Record<string, unknown>);
            return { decision: "allow" as const };
          },
        },
      });
      const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
      const { tabId } = created.result as { tabId: number };

      const answer = await tools.run(call("navigate", { tabId, url: "https://example.test/two", force: true }));

      // The owner was asked about *this* decision, in its own words, and the page was left.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ kind: "beforeunload-force", tool: "navigate" });
      expect(stub.armed).toEqual(["leave"]);
      expect(answer).toMatchObject({ outcome: "ok", result: { url: "https://example.test/two" } });
    });

    it("runs nothing when the owner refuses the forced leave", async () => {
      const stub = unloadStub("https://example.test/one");
      const tools = build(60, {
        dialogs: stub.dialogs,
        siteModes: {
          async get() {
            return { site: "https://example.test", mode: "ask" as const, diagnosticsGranted: false };
          },
          async set(site: string) {
            return { site, mode: "ask" as const, diagnosticsGranted: false };
          },
        },
        prompts: {
          async ask() {
            return { decision: "deny" as const };
          },
        },
      });
      const created = await tools.run(call("tabs_create", { url: "https://example.test/one" }));
      const { tabId } = created.result as { tabId: number };

      const answer = await tools.run(call("navigate", { tabId, url: "https://example.test/two", force: true }));

      expect(answer).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      // Nothing was armed at all: the page was never asked to go.
      expect(stub.armed).toEqual([]);
    });
  });
});
