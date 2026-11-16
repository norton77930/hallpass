import { afterEach, describe, expect, it, vi } from "vitest";
import { HELD_HINT } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { AGENT_SESSION_HOLDS_KEY } from "../src/service-worker/hold-store.js";
import { PANEL_CONSENT_KEY } from "../src/service-worker/panel-consent.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 034/T1008 - Stop and Resume pressed on the in-page pill (R-515, R-517, R-519, R-520, R-522).
 *
 * The trust claim first: the page names nothing. Chrome's `sender.id` says the press is this
 * extension's content script, `sender.tab.id` is the only tab it can be about, and the lease on
 * that tab is the only session it can stop - so a press from anywhere else, from a tab nobody
 * holds, or carrying a field of its own, is refused and changes nothing.
 *
 * Then the order: for an outside session the hold is in place before the in-flight calls unwind, so
 * nothing the agent sends in that moment runs; the calls in flight end as an interrupt ends them;
 * the pills say "Stopped" and the pointer says so too. A side-panel conversation is not held: its
 * own Stop is forwarded to the broker, which ends the turn.
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void; onPost?: (message: unknown) => void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
      this.onPost?.(message);
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
const SESSION = "session-p1";
const TAB = 7;
const SECOND_TAB = 8;
const UNHELD_TAB = 3;
const SITE = "https://agent.test";
const HELLO = { type: "hello", sessionId: SESSION, agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = { type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: SESSION };

type ContentSender = { id?: string; tab?: { id?: number } };
type ContentListener = (message: unknown, sender: ContentSender, sendResponse: (reply: unknown) => void) => boolean | void;

type Parkable = "tabs.get" | "tabs.sendMessage";

type Fake = {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  pageMessages: Array<{ tabId: number; message: unknown }>;
  /** Every `tabs.update`, by tab: a `navigate` reaching the page. */
  tabUpdates: number[];
  /**
   * Parks writes of the pairing record. The pairing controller answers one question at a time, so a
   * call's admission check queued behind a parked write is a call inside its admission check.
   */
  parkPairingWrites(): () => void;
  /**
   * How many more reads of the tab leases succeed; `undefined` is every one. A read past it fails as
   * a storage area can, so a press can fail at the step a test names.
   */
  leaseReadsLeft: number | undefined;
  /** Every write of the holds fails, as a storage area can. */
  holdWritesFail: boolean;
  /**
   * Parks the next `chrome.tabs.get`, or the next `chrome.tabs.sendMessage`, until `release`;
   * `reached` says whether a caller is parked on it. Only that one call: every one after it answers
   * at once.
   */
  parkNext(what: Parkable): { reached: () => boolean; release: () => void };
  /** `replies` counts every answer the listener gave the press, so "answered once" is assertable. */
  press(message: unknown, sender: ContentSender): { returned: unknown; reply: Promise<unknown>; replies: unknown[] };
};

function installChrome(seed: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}): Fake {
  const local: Record<string, unknown> = seed.local ?? {};
  const session: Record<string, unknown> = seed.session ?? {};
  const listeners: ContentListener[] = [];
  let parked: Promise<void> | undefined;
  const parkedNext = new Map<Parkable, { gate: Promise<void>; reached: boolean }>();
  async function passParked(what: Parkable): Promise<void> {
    const one = parkedNext.get(what);
    if (one === undefined) return;
    parkedNext.delete(what);
    one.reached = true;
    await one.gate;
  }
  const tabs = [
    { id: UNHELD_TAB, url: "https://owner.test/", title: "Owner", groupId: -1, active: false, windowId: 900 },
    { id: TAB, url: `${SITE}/one`, title: "Agent one", groupId: -1, active: true, windowId: 900 },
    { id: SECOND_TAB, url: `${SITE}/two`, title: "Agent two", groupId: -1, active: false, windowId: 900 },
  ];
  const fake: Fake = {
    local,
    session,
    pageMessages: [],
    tabUpdates: [],
    leaseReadsLeft: undefined,
    holdWritesFail: false,
    parkPairingWrites() {
      let release = (): void => undefined;
      parked = new Promise<void>((resolve) => {
        release = () => {
          parked = undefined;
          resolve();
        };
      });
      return release;
    },
    parkNext(what) {
      let release = (): void => undefined;
      const one = {
        reached: false,
        gate: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      parkedNext.set(what, one);
      return { reached: () => one.reached, release };
    },
    press(message, sender) {
      let answer: (reply: unknown) => void = () => undefined;
      const replies: unknown[] = [];
      const reply = new Promise<unknown>((resolve) => {
        answer = (value) => {
          replies.push(value);
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
          if ("agentPairings" in values && parked) await parked;
          return area(local).set(values);
        },
      },
      session: {
        ...area(session),
        async get(keys: string[] | string) {
          if ((Array.isArray(keys) ? keys : [keys]).includes("agentTabLeases") && fake.leaseReadsLeft !== undefined) {
            if (fake.leaseReadsLeft <= 0) throw new Error("storage.session unavailable");
            fake.leaseReadsLeft -= 1;
          }
          return area(session).get(keys);
        },
        async set(values: Record<string, unknown>) {
          if (AGENT_SESSION_HOLDS_KEY in values && fake.holdWritesFail) throw new Error("storage.session unavailable");
          return area(session).set(values);
        },
      },
    },
    alarms: { create() {}, clear: async () => true, getAll: async () => [], onAlarm: { addListener() {} } },
    runtime: {
      id: EXTENSION_ID,
      onMessage: { addListener: (listener: ContentListener) => void listeners.push(listener) },
    },
    i18n: { getUILanguage: () => "en-US" },
    scripting: { async executeScript() { return []; } },
    tabs: {
      async sendMessage(tabId: number, message: unknown) {
        await passParked("tabs.sendMessage");
        fake.pageMessages.push({ tabId, message });
        return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      },
      async get(tabId: number) {
        await passParked("tabs.get");
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
        fake.tabUpdates.push(tabId);
        return tabs.find((candidate) => candidate.id === tabId);
      },
      async captureVisibleTab() {
        return "data:image/png;base64,cGljdHVyZQ==";
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

const FROM_TAB = { id: EXTENSION_ID, tab: { id: TAB } };
const STOP = { type: "ui.agent.pill-stop" };
const RESUME = { type: "ui.agent.pill-resume" };

function answerFor(port: FakePort, callId: string): Record<string, unknown> | undefined {
  return port.sent.find(
    (sent) => (sent as { callId?: string }).callId === callId && "outcome" in (sent as object),
  ) as Record<string, unknown> | undefined;
}

function storedHolds(fake: Fake): Record<string, unknown> {
  return (fake.session[AGENT_SESSION_HOLDS_KEY] ?? {}) as Record<string, unknown>;
}

function messagesTo(fake: Fake, type: string): Array<{ tabId: number; message: Record<string, unknown> }> {
  return fake.pageMessages.filter((sent) => (sent.message as { type?: string }).type === type) as Array<{
    tabId: number;
    message: Record<string, unknown>;
  }>;
}

async function outsideSession(): Promise<{ fake: Fake; port: FakePort; runtime: ReturnType<typeof composeAgentRuntime> }> {
  const fake = installChrome();
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).paired).toHaveLength(1));
  await runtime.tabs.adopt(SESSION, TAB);
  await runtime.tabs.adopt(SESSION, SECOND_TAB);
  return { fake, port, runtime };
}

describe("T1008 a press on the pill", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  describe("whose press it is (R-522)", () => {
    it.each([
      ["another extension's", STOP, { id: "some-other-extension", tab: { id: TAB } }],
      ["no tab's", STOP, { id: EXTENSION_ID }],
      ["a tab nobody holds", STOP, { id: EXTENSION_ID, tab: { id: UNHELD_TAB } }],
      ["one naming a session", { ...STOP, sessionId: SESSION }, FROM_TAB],
      ["one naming a tab", { ...STOP, tabId: TAB }, FROM_TAB],
      ["a Resume naming a session", { ...RESUME, sessionId: SESSION }, FROM_TAB],
    ])("refuses %s press and changes nothing", async (_name, message, sender) => {
      const { fake, runtime } = await outsideSession();

      const pressed = fake.press(message, sender);

      expect(pressed.returned).toBe(true);
      await expect(pressed.reply).resolves.toEqual({ accepted: false });
      expect(storedHolds(fake)).toEqual({});
      expect((await runtime.projection()).sessions[0]).not.toHaveProperty("heldAt");
    });

    // Review I3: a press that fails inside is answered, once, as not taken - never left unanswered.
    it("answers a press that fails inside once, as not taken", async () => {
      const { fake } = await outsideSession();
      fake.leaseReadsLeft = 0;

      const pressed = fake.press(STOP, FROM_TAB);

      await vi.waitFor(() => expect(pressed.replies).toEqual([{ accepted: false }]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pressed.replies).toEqual([{ accepted: false }]);
      fake.leaseReadsLeft = undefined;
      expect(storedHolds(fake)).toEqual({});
    });

    it("keeps every other content message unanswered: the listener returns true for the two presses only", async () => {
      const { fake } = await outsideSession();

      expect(fake.press({ type: "ui.agent.announce" }, FROM_TAB).returned).toBe(false);
      expect(fake.press({ type: "ui.agent.focus-main" }, FROM_TAB).returned).toBe(false);
      expect(fake.press({ type: "something-else" }, FROM_TAB).returned).toBe(false);
      expect(fake.press("nonsense", FROM_TAB).returned).toBe(false);
      expect(fake.press(STOP, FROM_TAB).returned).toBe(true);
      expect(fake.press(RESUME, FROM_TAB).returned).toBe(true);
    });
  });

  describe("Stop for an outside session (R-515)", () => {
    it("holds the session, ends what is in flight as an interrupt does, and refuses what comes after", async () => {
      const { fake, port, runtime } = await outsideSession();
      port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));
      // The agent's next call, sent the moment its in-flight one is answered - inside the unwind.
      port.onPost = (message) => {
        if ((message as { callId?: string }).callId === "call-w") {
          port.emit({ callId: "call-next", sessionId: SESSION, tool: "tabs_context", args: {} });
        }
      };

      const pressed = fake.press(STOP, FROM_TAB);

      await expect(pressed.reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined());
      expect(answerFor(port, "call-w")).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
      await vi.waitFor(() => expect(answerFor(port, "call-next")).toBeDefined());
      expect(answerFor(port, "call-next")).toEqual({
        callId: "call-next",
        outcome: "stopped",
        reason: "owner-held",
        hint: HELD_HINT,
      });
      await vi.waitFor(() => expect(storedHolds(fake)).toEqual({ [SESSION]: { at: expect.any(String), tabId: TAB, sessionKnown: true } }));
      const card = (await runtime.projection()).sessions[0];
      expect(card?.heldAt).toEqual(expect.any(String));
      expect(card?.activity).toEqual([expect.objectContaining({ kind: "hold", outcome: "held" })]);
    });

    it("refuses a call that was already inside its admission check when Stop was pressed", async () => {
      const { fake, port, runtime } = await outsideSession();
      // A second agent's pairing card, answered while its write is parked: the controller is busy.
      port.emit({ ...HELLO, sessionId: "session-p2", agentId: "agent-2" });
      port.emit({ ...PAIR_REQUEST, sessionId: "session-p2", agentId: "agent-2" });
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending?.agentId).toBe("agent-2"));
      const release = fake.parkPairingWrites();
      void runtime.pairing.decide("agent-2", true);
      port.emit({ callId: "call-mid", sessionId: SESSION, tool: "tabs_context", args: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answerFor(port, "call-mid"), "the call was not parked in its admission check").toBeUndefined();

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      release();

      await vi.waitFor(() => expect(answerFor(port, "call-mid")).toBeDefined());
      expect(answerFor(port, "call-mid")).toMatchObject({ outcome: "stopped", reason: "owner-held" });
    });

    it("withdraws a consent card the session was waiting on, and leaves the site's mode as it was", async () => {
      const { fake, port, runtime } = await outsideSession();
      port.emit({ callId: "call-c", sessionId: SESSION, tool: "click", tabId: TAB, args: { tabId: TAB, target: { ref: "r1" } } });
      await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined());

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      await vi.waitFor(() => expect(answerFor(port, "call-c")).toBeDefined());
      expect(answerFor(port, "call-c")).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
      expect(runtime.prompts.current()).toBeUndefined();
      expect((await runtime.siteModes.list()).filter((entry) => entry.site === SITE && entry.mode !== "ask")).toEqual([]);
    });

    it("draws the held pill on every tab the session holds, and the stopped pointer once on each", async () => {
      const { fake } = await outsideSession();
      await vi.waitFor(() => expect(messagesTo(fake, "indicator")).toHaveLength(2));
      const before = fake.pageMessages.length;

      // Pressed on the second tab: every tab of the session goes held, not only the one pressed.
      await expect(fake.press(STOP, { id: EXTENSION_ID, tab: { id: SECOND_TAB } }).reply).resolves.toEqual({ accepted: true });

      await vi.waitFor(() => expect(fake.pageMessages.length - before).toBe(4));
      const after = fake.pageMessages.slice(before);
      const held = {
        type: "indicator",
        show: true,
        mode: "held",
        heldLabel: lookup("agent.indicator.held", "en-US"),
        resume: lookup("agent.indicator.resume", "en-US"),
        resumeUndelivered: lookup("agent.indicator.resumeUndelivered", "en-US"),
      };
      for (const tabId of [TAB, SECOND_TAB]) {
        expect(after).toContainEqual({ tabId, message: expect.objectContaining(held) });
        expect(after.filter((sent) => sent.tabId === tabId && (sent.message as { type?: string }).type === "pointer-step")).toEqual([
          { tabId, message: { type: "pointer-step", words: lookup("agent.pointer.stopped", "en-US"), mode: "rest" } },
        ]);
      }
    });

    /**
     * Review N2: a second Stop keeps the first hold - its time, its tab, its one line on the card -
     * and draws the held pill again on every tab, because a page still showing Stop is the reason the
     * owner pressed it twice.
     */
    it("keeps the first hold on a second Stop, and draws the held pill again", async () => {
      const { fake, runtime } = await outsideSession();
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));
      const first = structuredClone(storedHolds(fake));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fake.pageMessages.length;

      await expect(fake.press(STOP, { id: EXTENSION_ID, tab: { id: SECOND_TAB } }).reply).resolves.toEqual({ accepted: true });

      await vi.waitFor(() => expect(fake.pageMessages.length - before).toBe(2));
      for (const tabId of [TAB, SECOND_TAB]) {
        expect(fake.pageMessages.slice(before)).toContainEqual({
          tabId,
          message: expect.objectContaining({ type: "indicator", show: true, mode: "held" }),
        });
      }
      expect(storedHolds(fake)).toEqual(first);
      expect((await runtime.projection()).sessions[0]?.activity).toHaveLength(1);
    });

    /**
     * Review N2: once the hold is set the press has been taken - the session is held and its calls
     * are refused - so a pill that cannot be redrawn afterwards is a diagnostic, not "not taken",
     * which would show the owner the not-delivered words for a Stop that worked.
     */
    // Review I3: the store is what outlives the worker; this worker still holds the session without it.
    it("holds the session in this worker when the hold cannot be written down", async () => {
      const { fake, port } = await outsideSession();
      fake.holdWritesFail = true;

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      expect(storedHolds(fake)).toEqual({});
      port.emit({ callId: "call-after", sessionId: SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(answerFor(port, "call-after")).toMatchObject({ reason: "owner-held" }));
    });

    it("answers accepted once the hold is set, even when the pills cannot be redrawn", async () => {
      const { fake, port } = await outsideSession();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The press's own lease lookup succeeds; every read after it fails.
      fake.leaseReadsLeft = 1;

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      fake.leaseReadsLeft = undefined;
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));
      port.emit({ callId: "call-after", sessionId: SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(answerFor(port, "call-after")).toMatchObject({ reason: "owner-held" }));
    });

    /**
     * Review round 2 (G1): the upload-directory question looks up the session's site before it asks,
     * and a Stop landing in that await holds the session after the hold was checked and cancels only
     * a card already standing - so the question must look at the hold again before it raises one.
     */
    it("answers an upload-directory question held when Stop lands while it looks up the site", async () => {
      const { fake, port, runtime } = await outsideSession();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const parked = fake.parkNext("tabs.get");
      const directory = "C:\\Users\\owner\\docs";
      port.emit({ type: "upload-consent-request", sessionId: SESSION, callId: "u1", files: [{ path: `${directory}\\a.txt`, directory }] });
      await vi.waitFor(() => expect(parked.reached(), "the question did not look up the site").toBe(true));

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.heldAt).toEqual(expect.any(String)));
      parked.release();

      await vi.waitFor(() => expect(port.sent).toContainEqual({ type: "upload-consent-result", callId: "u1", decision: "held" }));
      expect(runtime.prompts.current(), "a card was raised for a held session").toBeUndefined();
    });

    /**
     * Review round 2 (G2): a greeting with a panel token drops a hold only for a session this worker
     * has not met (the restart case) or already knows as a conversation. A link client that
     * re-greets a held outside session with a token of its own choosing - and then without one -
     * keeps the hold the owner set.
     */
    it("keeps an outside session's hold when it greets again with a panel token", async () => {
      const { fake, port } = await outsideSession();
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));

      // Review round 3 (H1): the greeting rewrites the session's kind, so a second token greeting
      // must not read the first one's "panel" as the session having been a conversation all along.
      const greetings = [
        ["call-token", { ...HELLO, panelToken: "x".repeat(43) }],
        ["call-token-again", { ...HELLO, panelToken: "x".repeat(43) }],
        ["call-plain", HELLO],
      ] as const;
      for (const [callId, hello] of greetings) {
        port.emit(hello);
        await new Promise((resolve) => setTimeout(resolve, 20));
        port.emit({ callId, sessionId: SESSION, tool: "tabs_context", args: {} });
        await vi.waitFor(() => expect(answerFor(port, callId)).toBeDefined());
        expect(answerFor(port, callId), callId).toMatchObject({ outcome: "stopped", reason: "owner-held" });
        expect(Object.keys(storedHolds(fake)), callId).toEqual([SESSION]);
      }
    });

    /** Each greeting, then a call: the call answers owner-held and the hold is still stored. */
    async function expectHeldThrough(fake: Fake, port: FakePort, greetings: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
      for (const [callId, hello] of greetings) {
        port.emit(hello);
        await new Promise((resolve) => setTimeout(resolve, 20));
        port.emit({ callId, sessionId: SESSION, tool: "tabs_context", args: {} });
        await vi.waitFor(() => expect(answerFor(port, callId)).toBeDefined());
        expect(answerFor(port, callId), callId).toMatchObject({ outcome: "stopped", reason: "owner-held" });
        expect(Object.keys(storedHolds(fake)), callId).toEqual([SESSION]);
      }
    }
    const TOKEN_HELLO = { ...HELLO, panelToken: "x".repeat(43) };

    /**
     * Review round 4: whether a greeting may lift a hold is decided from what the owner's side wrote
     * down at the press - was the session registered here - never from what the link client puts in
     * its greetings. A session that first greeted with a token and then without one was known when
     * the owner stopped it, so no later greeting lets it go.
     */
    it("keeps the hold of a session that first greeted with a token, through a token and a plain greeting after Stop", async () => {
      const fake = installChrome();
      const port = fakePort();
      const runtime = composeAgentRuntime({ connectNative: () => port });
      runtime.start();
      port.emit(TOKEN_HELLO);
      await new Promise((resolve) => setTimeout(resolve, 20));
      port.emit(HELLO);
      port.emit(PAIR_REQUEST);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
      await runtime.pairing.decide("agent-1", true);
      await vi.waitFor(async () => expect((await runtime.pairing.state()).paired).toHaveLength(1));
      await runtime.tabs.adopt(SESSION, TAB);
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));

      await expectHeldThrough(fake, port, [
        ["call-token", TOKEN_HELLO],
        ["call-plain", HELLO],
      ]);
    });

    /** Review round 4: known at the press, so a restarted worker's first greeting carrying a token keeps it too. */
    it("keeps a hold set while the session was known when its first greeting to a restarted worker carries a token", async () => {
      const first = await outsideSession();
      await expect(first.fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(first.fake))).toEqual([SESSION]));
      const fake = installChrome({ local: first.fake.local, session: first.fake.session });
      const port = fakePort();
      composeAgentRuntime({ connectNative: () => port }).start();

      await expectHeldThrough(fake, port, [
        ["call-token", TOKEN_HELLO],
        ["call-plain", HELLO],
      ]);
    });

    /**
     * Review round 4: a Stop pressed before a restarted worker has met the session is settled by the
     * session's first greeting to it. A plain one says it is an outside agent, so the hold becomes
     * one set knowingly and a token greeting after it changes nothing.
     */
    it("keeps a hold pressed before a restarted worker met the session once its first greeting is plain", async () => {
      const first = await outsideSession();
      const fake = installChrome({ local: first.fake.local, session: first.fake.session });
      const port = fakePort();
      composeAgentRuntime({ connectNative: () => port }).start();
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));

      await expectHeldThrough(fake, port, [
        ["call-plain", HELLO],
        ["call-token", TOKEN_HELLO],
        ["call-plain-again", HELLO],
      ]);
    });

    /**
     * Review round 2 (G3): a batch's steps each register their own stop handle when they are
     * dispatched, and the batch registers its own only after its ownership and site reads. A Stop
     * landing in those reads interrupts the call's handle and holds the session, but no step's handle
     * exists yet to be flagged - so what keeps the first step from the page is the hold, read again
     * at the step's dispatch before its runner starts.
     */
    it("keeps a batch's steps from the page when Stop lands before the batch's first step", async () => {
      const { fake, port, runtime } = await outsideSession();
      await runtime.siteModes.set(SITE, { mode: "skip-checks" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const parked = fake.parkNext("tabs.sendMessage");
      port.emit({
        callId: "call-b",
        sessionId: SESSION,
        tool: "browser_batch",
        tabId: TAB,
        args: { tabId: TAB, steps: [{ tool: "navigate", args: { url: `${SITE}/next` } }] },
      });
      await vi.waitFor(() => expect(parked.reached(), "the batch did not bind its tab").toBe(true));
      expect((await runtime.projection()).sessions[0]?.inFlight, "the call had not registered").toBe(1);

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.heldAt).toEqual(expect.any(String)));
      parked.release();

      await vi.waitFor(() => expect(answerFor(port, "call-b")).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.tabUpdates, "a step reached the page after Stop").toEqual([]);
      // The batch answers ok with the step it was on named as interrupted and nothing completed (FR-180).
      expect(answerFor(port, "call-b")).toMatchObject({ outcome: "ok", result: { completed: [], interruptedAt: 0 } });
    });

    it("answers a reloaded page of a held tab with the held pill", async () => {
      const { fake } = await outsideSession();
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fake.pageMessages.length;

      fake.press({ type: "ui.agent.announce" }, FROM_TAB);

      await vi.waitFor(() => expect(fake.pageMessages.length).toBe(before + 1));
      expect(fake.pageMessages[before]).toEqual({ tabId: TAB, message: expect.objectContaining({ type: "indicator", mode: "held" }) });
    });
  });

  describe("Resume", () => {
    it("lifts the hold, draws the working pill again and notes it; the next call runs", async () => {
      const { fake, port, runtime } = await outsideSession();
      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => expect(Object.keys(storedHolds(fake))).toEqual([SESSION]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fake.pageMessages.length;

      await expect(fake.press(RESUME, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      await vi.waitFor(() => expect(storedHolds(fake)).toEqual({}));
      await vi.waitFor(() => expect(fake.pageMessages.length - before).toBe(2));
      for (const tabId of [TAB, SECOND_TAB]) {
        expect(fake.pageMessages.slice(before)).toContainEqual({
          tabId,
          message: expect.objectContaining({ type: "indicator", show: true, mode: "working", stop: lookup("agent.indicator.stop", "en-US") }),
        });
      }
      const card = (await runtime.projection()).sessions[0];
      expect(card).not.toHaveProperty("heldAt");
      expect(card?.activity?.[0]).toMatchObject({ kind: "resume", outcome: "resumed" });
      port.emit({ callId: "call-after", sessionId: SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(answerFor(port, "call-after")).toMatchObject({ outcome: "ok" }));
    });

    it("answers accepted and changes nothing for a session that is not held", async () => {
      const { fake, runtime } = await outsideSession();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fake.pageMessages.length;

      await expect(fake.press(RESUME, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.pageMessages.length).toBe(before);
      expect((await runtime.projection()).sessions[0]?.activity ?? []).toEqual([]);
    });
  });

  describe("Stop for a side-panel conversation (R-520)", () => {
    const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
    const CONVERSATION = "conv-0123456789abcdef";
    const TOKEN = "t".repeat(43);
    const PANEL_SESSION = "panel-session-1";
    const PANEL_AGENT = `panel:${CONVERSATION}`;

    async function panelSession() {
      const fake = installChrome({ local: { [PANEL_CONSENT_KEY]: { granted: true, at: "2026-10-19T00:00:00.000Z" } } });
      const port = fakePort();
      const runtime = composeAgentRuntime({ connectNative: () => port });
      runtime.start();
      port.emit({ type: "relay-started", relayPid: 4242 });
      await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
      port.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass", role: "broker" });
      port.emit({ type: "conversation-browser-token", sessionId: BROKER, conversationId: CONVERSATION, token: TOKEN });
      port.emit({ type: "hello", sessionId: PANEL_SESSION, agentId: PANEL_AGENT, displayName: "claude-code", panelToken: TOKEN });
      await runtime.tabs.adopt(PANEL_SESSION, TAB);
      return { fake, port, runtime };
    }

    const stopCommands = (port: FakePort) =>
      port.sent.filter(
        (frame) =>
          (frame as { type?: string }).type === "conversation-command" &&
          (frame as { command?: { type?: string } }).command?.type === "ui.conversation.stop",
      ) as Array<{ command: unknown }>;

    it("ends the browser step at once, forwards the conversation's own Stop, and holds nothing", async () => {
      const { fake, port, runtime } = await panelSession();
      port.emit({ callId: "call-p", sessionId: PANEL_SESSION, tool: "wait", args: { tabId: TAB, forMs: 15_000 } });
      await vi.waitFor(async () => expect((await runtime.projection()).sessions[0]?.inFlight).toBe(1));

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });

      await vi.waitFor(() => expect(answerFor(port, "call-p")).toBeDefined());
      expect(answerFor(port, "call-p")).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
      expect(stopCommands(port).map((frame) => frame.command)).toEqual([
        { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION } },
      ]);
      expect(storedHolds(fake)).toEqual({});
      expect((await runtime.projection()).sessions[0]).not.toHaveProperty("heldAt");
      // The next turn's call is not refused: nothing holds a conversation.
      port.emit({ callId: "call-q", sessionId: PANEL_SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(answerFor(port, "call-q")).toMatchObject({ outcome: "ok" }));
    });

    it("draws the conversation pill: Stop, never Resume", async () => {
      const { fake } = await panelSession();

      await vi.waitFor(() => expect(messagesTo(fake, "indicator")).toHaveLength(1));
      expect(messagesTo(fake, "indicator")[0]?.message).toMatchObject({ mode: "conversation", stop: lookup("agent.indicator.stop", "en-US") });
      expect(messagesTo(fake, "indicator")[0]?.message).not.toHaveProperty("resume");
    });

    /**
     * Review I1: `sessions` is this worker's memory and the leases are not, so after a restart the
     * conversation's tab is leased to a session this worker has not met yet. A Stop pressed in that
     * gap cannot tell it is a conversation - but the greeting that follows can, and a conversation
     * is never held.
     */
    it("holds nothing for a conversation once it greets a restarted worker, even when Stop came first", async () => {
      const first = await panelSession();
      const fake = installChrome({ local: first.fake.local, session: first.fake.session });
      const port = fakePort();
      const runtime = composeAgentRuntime({ connectNative: () => port });
      runtime.start();

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: true });
      port.emit({ type: "relay-started", relayPid: 4242 });
      await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "relay-ack" })));
      port.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass", role: "broker" });
      port.emit({ type: "conversation-browser-token", sessionId: BROKER, conversationId: CONVERSATION, token: TOKEN });
      port.emit({ type: "hello", sessionId: PANEL_SESSION, agentId: PANEL_AGENT, displayName: "claude-code", panelToken: TOKEN });

      port.emit({ callId: "call-r", sessionId: PANEL_SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(answerFor(port, "call-r")).toBeDefined());
      expect(answerFor(port, "call-r")).toMatchObject({ outcome: "ok" });
      await vi.waitFor(() => expect(storedHolds(fake)).toEqual({}));
      expect((await runtime.projection()).sessions[0]).not.toHaveProperty("heldAt");
    });

    it("answers accepted false when no broker is connected", async () => {
      const { fake, port } = await panelSession();
      // A new relay: the broker has not greeted it yet, and the tokens wait out its window.
      port.emit({ type: "relay-started", relayPid: 4343 });

      await expect(fake.press(STOP, FROM_TAB).reply).resolves.toEqual({ accepted: false });
      expect(stopCommands(port)).toEqual([]);
      expect(storedHolds(fake)).toEqual({});
    });
  });
});
