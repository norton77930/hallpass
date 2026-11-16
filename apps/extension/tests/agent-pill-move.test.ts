import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { createAgentIndicator, type IndicatorMessage } from "../src/service-worker/agent-tools/indicator.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 035 - the worker's half of moving the pill and opening the side panel from it (W slice).
 *
 * T1025 the four words; T1029 the indicator composer carries the owner's edge and the words and waits
 * for the store's first load; T1031 the move press (R-529); T1043 the open press (R-527), whose claim
 * is an order: `chrome.sidePanel.open` is issued inside the listener call, before anything is awaited,
 * because the browser refuses the open once the gesture has waited (measured, R-527).
 */

const WORDS = {
  "en-US": {
    moveToTop: "Move to top",
    moveToBottom: "Move to bottom",
    openPanel: "Open side panel",
    panelUnopened: "The side panel didn't open. Use the toolbar icon or Alt+A.",
  },
  "zh-TW": {
    moveToTop: "移到上方",
    moveToBottom: "移到下方",
    openPanel: "打開側邊欄",
    panelUnopened: "側邊欄沒有打開。請按工具列圖示或 Alt+A。",
  },
} as const;

describe("T1025 the pill's move and open words (FR-536, R-532)", () => {
  for (const locale of ["en-US", "zh-TW"] as const) {
    it(`has the four words in ${locale}`, () => {
      expect(lookup("agent.indicator.moveToTop", locale)).toBe(WORDS[locale].moveToTop);
      expect(lookup("agent.indicator.moveToBottom", locale)).toBe(WORDS[locale].moveToBottom);
      expect(lookup("agent.indicator.openPanel", locale)).toBe(WORDS[locale].openPanel);
      expect(lookup("agent.indicator.panelUnopened", locale)).toBe(WORDS[locale].panelUnopened);
    });
  }
});

describe("T1029 the indicator composer carries the owner's edge and the four words (R-528, R-530)", () => {
  type Edge = "top" | "bottom";

  function composed(options: { locale?: string; edge?: Edge; ready?: Promise<void> } = {}) {
    const sent: Array<{ tabId: number; message: IndicatorMessage }> = [];
    const state = { edge: options.edge ?? ("top" as Edge) };
    const indicator = createAgentIndicator({
      send: async (tabId, message) => {
        sent.push({ tabId, message });
      },
      inject: async () => undefined,
      reportDiagnostic: () => undefined,
      holderOf: async (tabId) => (tabId === 3 ? undefined : "session-a"),
      modeOf: (sessionId) => (sessionId === "held-session" ? "held" : "working"),
      tabsOf: async () => [5, 7],
      locale: () => options.locale ?? "en-US",
      pillEdge: { ready: () => options.ready ?? Promise.resolve(), current: () => state.edge },
    });
    return { indicator, sent, state };
  }

  const wordsIn = (locale: "en-US" | "zh-TW") => WORDS[locale];

  for (const locale of ["en-US", "zh-TW"] as const) {
    it(`puts the stored edge and the four words in ${locale} on a raise, working or held`, async () => {
      const { indicator, sent } = composed({ locale, edge: "bottom" });

      indicator.raise(7, "session-a");
      indicator.raise(7, "held-session");

      await expect.poll(() => sent.length, { timeout: 1000 }).toBe(2);
      for (const { message } of sent) {
        expect(message).toMatchObject({ show: true, edge: "bottom", ...wordsIn(locale) });
      }
      expect(sent.map((entry) => entry.message.mode)).toEqual(["working", "held"]);
    });
  }

  it("puts them on the answer to a page's announcement, and on a whole session's redraw", async () => {
    const { indicator, sent } = composed({ edge: "bottom" });

    await indicator.answerAnnouncement(7);
    await indicator.raiseSession("session-a");

    await expect.poll(() => sent.length, { timeout: 1000 }).toBe(3);
    for (const { message } of sent) {
      expect(message).toMatchObject({ show: true, edge: "bottom", ...wordsIn("en-US") });
    }
  });

  it("says top when the stored edge is top, and sends no pill words to a tab nobody holds", async () => {
    const { indicator, sent } = composed({ edge: "top" });

    indicator.raise(7, "session-a");
    await indicator.answerAnnouncement(3);

    await expect.poll(() => sent.length, { timeout: 1000 }).toBe(2);
    expect(sent.find((entry) => entry.tabId === 7)?.message).toMatchObject({ edge: "top" });
    expect(sent.find((entry) => entry.tabId === 3)?.message).toEqual({ type: "indicator", show: false });
  });

  it("reads the edge when the message leaves, so the next one after a move carries the new edge", async () => {
    const { indicator, sent, state } = composed({ edge: "top" });
    indicator.raise(7, "session-a");
    await expect.poll(() => sent.length, { timeout: 1000 }).toBe(1);
    state.edge = "bottom";

    indicator.raise(7, "session-a");

    await expect.poll(() => sent.map((entry) => entry.message.edge), { timeout: 1000 }).toEqual(["top", "bottom"]);
  });

  it("sends nothing until the store has loaded, then sends with the loaded edge, in the order asked", async () => {
    let load: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      load = resolve;
    });
    const { indicator, sent, state } = composed({ ready });

    indicator.raise(7, "session-a");
    indicator.lower(7);
    void indicator.answerAnnouncement(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent, "a message left before the owner's edge was known").toEqual([]);

    state.edge = "bottom";
    load();

    await expect.poll(() => sent.length, { timeout: 1000 }).toBe(3);
    expect(sent.map((entry) => [entry.tabId, entry.message.show])).toEqual([
      [7, true],
      [7, false],
      [5, true],
    ]);
    expect(sent[0]?.message.edge).toBe("bottom");
    expect(sent[2]?.message.edge).toBe("bottom");
  });

  it("sends at once, in the call, once the store has loaded", async () => {
    const { indicator, sent } = composed();
    indicator.raise(7, "session-a");
    await expect.poll(() => sent.length, { timeout: 1000 }).toBe(1);

    indicator.raise(5, "session-a");
    indicator.lower(7);

    expect(sent.length, "a loaded composer must not defer a raise or a lower").toBe(3);
  });
});

/* ---------------------------------------------------------------------------------------------- */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

const EXTENSION_ID = "hallpass-test-extension";
const UNHELD_TAB = 3;
const TAB = 7;
const SECOND_TAB = 8;
const OTHER_SESSION_TAB = 9;
const SITE = "https://agent.test";

type ContentSender = { id?: string; tab?: { id?: number } };
type ContentListener = (message: unknown, sender: ContentSender, sendResponse: (reply: unknown) => void) => boolean | void;

type Fake = {
  local: Record<string, unknown>;
  /** The page-bound messages, and the moments the listener answered, in the order they happened. */
  events: string[];
  pageMessages: Array<{ tabId: number; message: Record<string, unknown> }>;
  /** Every `chrome.sidePanel.open` call, in order. */
  opens: Array<{ tabId?: number; windowId?: number }>;
  /** What `sidePanel.open` does; the default resolves. */
  openBehaviour: "resolve" | "reject";
  /** Every write of `agentPillEdge` fails, as a storage area can. */
  edgeWritesFail: boolean;
  press(message: unknown, sender: ContentSender): { returned: unknown; reply: Promise<unknown>; replies: unknown[] };
};

function installChrome(seed: { local?: Record<string, unknown> } = {}): Fake {
  const local: Record<string, unknown> = seed.local ?? {};
  const session: Record<string, unknown> = {};
  const listeners: ContentListener[] = [];
  const tabs = [UNHELD_TAB, TAB, SECOND_TAB, OTHER_SESSION_TAB].map((id) => ({
    id,
    url: `${SITE}/${id}`,
    title: `Tab ${id}`,
    groupId: -1,
    active: id === TAB,
    windowId: 900,
  }));
  const fake: Fake = {
    local,
    events: [],
    pageMessages: [],
    opens: [],
    openBehaviour: "resolve",
    edgeWritesFail: false,
    press(message, sender) {
      const replies: unknown[] = [];
      let answer: (reply: unknown) => void = () => undefined;
      const reply = new Promise<unknown>((resolve) => {
        answer = (value) => {
          replies.push(value);
          fake.events.push("reply");
          resolve(value);
        };
      });
      const returned = listeners.map((listener) => listener(message, sender, answer)).find((value) => value === true) ?? false;
      return { returned, reply, replies };
    },
  };
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[] | string) {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in store) out[key] = structuredClone(store[key]);
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, structuredClone(values));
    },
    async remove(keys: string[]) {
      for (const key of keys) delete store[key];
    },
  });
  let nextGroupId = 100;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        ...area(local),
        async set(values: Record<string, unknown>) {
          if ("agentPillEdge" in values && fake.edgeWritesFail) throw new Error("storage unavailable");
          return area(local).set(values);
        },
      },
      session: area(session),
    },
    alarms: { create() {}, clear: async () => true, getAll: async () => [], onAlarm: { addListener() {} } },
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (listener: ContentListener) => void listeners.push(listener) },
    },
    i18n: { getUILanguage: () => "en-US" },
    scripting: { async executeScript() { return []; } },
    sidePanel: {
      open(options: { tabId?: number; windowId?: number }) {
        fake.opens.push(options);
        fake.events.push("open");
        return fake.openBehaviour === "reject"
          ? Promise.reject(new Error("sidePanel.open() may only be called in response to a user gesture."))
          : Promise.resolve();
      },
      async setOptions() {},
    },
    tabs: {
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        fake.pageMessages.push({ tabId, message });
        if (message.type === "indicator") fake.events.push(`indicator:${tabId}`);
        return undefined;
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async ungroup() {},
      async update(tabId: number) {
        return tabs.find((candidate) => candidate.id === tabId);
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    windows: { async update(windowId: number) { return { id: windowId }; } },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return fake;
}

async function started(seed: { local?: Record<string, unknown> } = {}) {
  const fake = installChrome(seed);
  const runtime = composeAgentRuntime({ connectNative: () => fakePort() });
  runtime.start();
  return { fake, runtime };
}

/** Two sessions: one holds 7 and 8, the other 9; 3 is held by nobody. */
async function withHeldTabs(seed: { local?: Record<string, unknown> } = {}) {
  const context = await started(seed);
  await context.runtime.tabs.adopt("session-p1", TAB);
  await context.runtime.tabs.adopt("session-p1", SECOND_TAB);
  await context.runtime.tabs.adopt("session-p2", OTHER_SESSION_TAB);
  await vi.waitFor(() => expect(indicatorsTo(context.fake)).toHaveLength(3));
  return context;
}

function indicatorsTo(fake: Fake): Array<{ tabId: number; message: Record<string, unknown> }> {
  return fake.pageMessages.filter((sent) => sent.message.type === "indicator");
}

const FROM_TAB = { id: EXTENSION_ID, tab: { id: TAB } };
const MOVE_TO_BOTTOM = { type: "ui.agent.pill-move", to: "bottom" };
const OPEN = { type: "ui.agent.pill-open-panel" };

describe("T1031 the move press (R-529, FR-533)", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("stores the edge, answers accepted, then redraws every tab every session holds with the new edge", async () => {
    const { fake } = await withHeldTabs();
    expect(indicatorsTo(fake).map((sent) => sent.message.edge)).toEqual(["top", "top", "top"]);
    const before = fake.pageMessages.length;
    fake.events.length = 0;

    const pressed = fake.press(MOVE_TO_BOTTOM, FROM_TAB);

    expect(pressed.returned).toBe(true);
    await expect(pressed.reply).resolves.toEqual({ accepted: true });
    expect(fake.local.agentPillEdge).toBe("bottom");
    await vi.waitFor(() => expect(fake.pageMessages.length - before).toBe(3));
    const redrawn = fake.pageMessages.slice(before);
    expect(redrawn.map((sent) => sent.tabId).sort()).toEqual([TAB, SECOND_TAB, OTHER_SESSION_TAB].sort());
    for (const { message } of redrawn) {
      expect(message).toMatchObject({ type: "indicator", show: true, mode: "working", edge: "bottom" });
    }
    expect(fake.events[0], "the press is answered before the pills are redrawn").toBe("reply");
  });

  it("moves back: a press naming top stores top", async () => {
    const { fake } = await withHeldTabs({ local: { agentPillEdge: "bottom" } });

    await expect(fake.press({ type: "ui.agent.pill-move", to: "top" }, FROM_TAB).reply).resolves.toEqual({ accepted: true });

    expect(fake.local.agentPillEdge).toBe("top");
  });

  it("draws the stored edge at once on a worker that restarted: the first indicator waits for the load", async () => {
    const { fake } = await withHeldTabs({ local: { agentPillEdge: "bottom" } });

    expect(indicatorsTo(fake).map((sent) => sent.message.edge)).toEqual(["bottom", "bottom", "bottom"]);
  });

  it("needs no lease: a press from a tab no session holds is the owner's setting all the same", async () => {
    const { fake } = await withHeldTabs();

    await expect(fake.press(MOVE_TO_BOTTOM, { id: EXTENSION_ID, tab: { id: UNHELD_TAB } }).reply).resolves.toEqual({ accepted: true });

    expect(fake.local.agentPillEdge).toBe("bottom");
  });

  it("answers not accepted, and keeps the old edge, when it cannot be stored", async () => {
    const { fake } = await withHeldTabs();
    fake.edgeWritesFail = true;
    const before = fake.pageMessages.length;

    await expect(fake.press(MOVE_TO_BOTTOM, FROM_TAB).reply).resolves.toEqual({ accepted: false });

    expect(fake.local).not.toHaveProperty("agentPillEdge");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.pageMessages.length, "a pill was redrawn for a move that was not stored").toBe(before);
  });

  it.each([
    ["an edge outside the two", { type: "ui.agent.pill-move", to: "left" }, FROM_TAB],
    ["no edge", { type: "ui.agent.pill-move" }, FROM_TAB],
    ["an extra field", { ...MOVE_TO_BOTTOM, tabId: TAB }, FROM_TAB],
    ["another extension's sender", MOVE_TO_BOTTOM, { id: "some-other-extension", tab: { id: TAB } }],
    ["a sender with no id", MOVE_TO_BOTTOM, { tab: { id: TAB } }],
    ["a sender with no tab", MOVE_TO_BOTTOM, { id: EXTENSION_ID }],
  ])("refuses %s, stores nothing and redraws nothing, and still answers once", async (_name, message, sender) => {
    const { fake } = await withHeldTabs();
    const before = fake.pageMessages.length;

    const pressed = fake.press(message, sender);

    expect(pressed.returned).toBe(true);
    await expect(pressed.reply).resolves.toEqual({ accepted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pressed.replies).toEqual([{ accepted: false }]);
    expect(fake.local).not.toHaveProperty("agentPillEdge");
    expect(fake.pageMessages.length).toBe(before);
  });

  it("is a different message from the two 034 presses and the other content messages: those are unchanged", async () => {
    const { fake } = await withHeldTabs();

    expect(fake.press({ type: "ui.agent.announce" }, FROM_TAB).returned).toBe(false);
    expect(fake.press({ type: "ui.agent.focus-main" }, FROM_TAB).returned).toBe(false);
    expect(fake.press({ type: "ui.agent.pill-stop" }, FROM_TAB).returned).toBe(true);
    expect(fake.press({ type: "ui.agent.pill-resume" }, FROM_TAB).returned).toBe(true);
  });
});

describe("T1043 the open press (R-527, FR-531, FR-532)", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("issues sidePanel.open for the sender's tab inside the listener call, before anything is awaited", async () => {
    const { fake } = await started();

    const pressed = fake.press(OPEN, FROM_TAB);

    // No await between the listener call and this line: a microtask has not run yet, so the open was
    // issued synchronously - the only moment the browser still treats the press as a user gesture.
    expect(fake.opens).toEqual([{ tabId: TAB }]);
    expect(pressed.returned).toBe(true);
    await expect(pressed.reply).resolves.toEqual({ opened: true });
  });

  it("answers opened false when the browser refuses the open", async () => {
    const { fake } = await started();
    fake.openBehaviour = "reject";

    const pressed = fake.press(OPEN, FROM_TAB);

    expect(fake.opens).toEqual([{ tabId: TAB }]);
    await expect(pressed.reply).resolves.toEqual({ opened: false });
    expect(pressed.replies).toEqual([{ opened: false }]);
  });

  it("needs no lease: a tab no session holds opens the panel too (opening grants nothing)", async () => {
    const { fake } = await started();

    const pressed = fake.press(OPEN, { id: EXTENSION_ID, tab: { id: UNHELD_TAB } });

    expect(fake.opens).toEqual([{ tabId: UNHELD_TAB }]);
    await expect(pressed.reply).resolves.toEqual({ opened: true });
  });

  it.each([
    ["an extra field", { ...OPEN, tabId: TAB }, FROM_TAB],
    ["another extension's sender", OPEN, { id: "some-other-extension", tab: { id: TAB } }],
    ["a sender with no id", OPEN, { tab: { id: TAB } }],
    ["a sender with no tab", OPEN, { id: EXTENSION_ID }],
    ["a sender whose tab has no id", OPEN, { id: EXTENSION_ID, tab: {} }],
  ])("refuses %s: opened false, no open, and the listener still answers", async (_name, message, sender) => {
    const { fake } = await started();

    const pressed = fake.press(message, sender);

    expect(pressed.returned).toBe(true);
    await expect(pressed.reply).resolves.toEqual({ opened: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.opens).toEqual([]);
    expect(pressed.replies).toEqual([{ opened: false }]);
  });
});
