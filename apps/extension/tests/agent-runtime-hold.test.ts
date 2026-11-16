import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME, HELD_HINT } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { AGENT_SESSION_HOLDS_KEY } from "../src/service-worker/hold-store.js";

/**
 * 034/T1007 - a held session's calls are refused before anything runs (R-512..R-514, R-516).
 *
 * The hold is set here the way a previous worker would have left it - in the session area - so
 * these claims are about the refusal and the hold's lifetime, not about the page press (T1008):
 * every tool answers `owner-held` and touches nothing (no runner, no pointer step, no page message),
 * a new worker refuses the session's first call after it greets again because it waits for the load,
 * and the hold goes exactly when its session does - End session, another agent taking the id, unpair -
 * or when the owner resumes it.
 */

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
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;
const SESSION = "session-h1";
const OTHER = "session-h2";
const TAB = 7;
const OTHER_TAB = 8;
const SITE = "https://agent.test";
const HELD_AT = "2026-11-15T09:00:00.000Z";
const hello = (sessionId = SESSION, agentId = "agent-1") => ({
  type: "hello",
  sessionId,
  agentId,
  displayName: "Claude Code",
});
const pairRequest = (sessionId = SESSION, agentId = "agent-1") => ({
  type: "pair-request",
  agentId,
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId,
});

type Fake = {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  /** Every page message the worker sent: indicators, pointer steps, content-runtime calls. */
  pageMessages: Array<{ tabId: number; message: unknown }>;
  /** Every CDP command, and every capture: a runner reached at all leaves one of these. */
  commands: string[];
  captures: number;
  /** Parks the hold store's reads, standing for a worker whose storage has not answered yet. */
  parkHoldReads(): () => void;
  /** How many of the hold store's next reads fail, as a storage area can. */
  holdReadsToFail: number;
};

function installChrome(seed: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}): Fake {
  const local = seed.local ?? {};
  const session = seed.session ?? {};
  let parked: Promise<void> | undefined;
  const tabs = [
    { id: TAB, url: `${SITE}/one`, title: "Agent one", groupId: -1, active: true, windowId: 900 },
    { id: OTHER_TAB, url: `${SITE}/two`, title: "Agent two", groupId: -1, active: false, windowId: 900 },
  ];
  const fake: Fake = {
    local,
    session,
    pageMessages: [],
    commands: [],
    captures: 0,
    holdReadsToFail: 0,
    parkHoldReads() {
      let release = (): void => undefined;
      parked = new Promise<void>((resolve) => {
        release = () => {
          parked = undefined;
          resolve();
        };
      });
      return release;
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
      local: area(local),
      session: {
        ...area(session),
        async get(keys: string[] | string) {
          const holdsRead = (Array.isArray(keys) ? keys : [keys]).includes(AGENT_SESSION_HOLDS_KEY);
          if (holdsRead && parked) await parked;
          if (holdsRead && fake.holdReadsToFail > 0) {
            fake.holdReadsToFail -= 1;
            throw new Error("storage.session unavailable");
          }
          return area(session).get(keys);
        },
      },
    },
    alarms: { create() {}, clear: async () => true, getAll: async () => [], onAlarm: { addListener() {} } },
    runtime: { id: EXTENSION_ID, onMessage: { addListener() {} } },
    i18n: { getUILanguage: () => "en-US" },
    scripting: { async executeScript() { return []; } },
    tabs: {
      async sendMessage(tabId: number, message: unknown) {
        fake.pageMessages.push({ tabId, message });
        return { documentEpoch: "doc-1", canonicalOrigin: SITE };
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
      async ungroup(tabIds: number[]) {
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = -1;
        }
      },
      async captureVisibleTab() {
        fake.captures += 1;
        return "data:image/png;base64,cGljdHVyZQ==";
      },
    },
    tabGroups: { async update(groupId: number) { return { id: groupId }; } },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach() {},
      async sendCommand(_target: unknown, method: string) {
        fake.commands.push(method);
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return fake;
}

/** The call's answer - a frame with an outcome, not a `prompt-waiting` tick that names the call too. */
function answerFor(port: FakePort, callId: string): Record<string, unknown> | undefined {
  return port.sent.find(
    (sent) => (sent as { callId?: string }).callId === callId && "outcome" in (sent as object),
  ) as Record<string, unknown> | undefined;
}

const heldAnswer = (callId: string) => ({ callId, outcome: "stopped", reason: "owner-held", hint: HELD_HINT });

const seededHold = (sessionId = SESSION) => ({ [AGENT_SESSION_HOLDS_KEY]: { [sessionId]: { at: HELD_AT, tabId: TAB } } });

function storedHolds(fake: Fake): Record<string, unknown> {
  return (fake.session[AGENT_SESSION_HOLDS_KEY] ?? {}) as Record<string, unknown>;
}

async function pair(port: FakePort, runtime: ReturnType<typeof composeAgentRuntime>, sessionId = SESSION, agentId = "agent-1") {
  port.emit(hello(sessionId, agentId));
  port.emit(pairRequest(sessionId, agentId));
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending?.agentId).toBe(agentId));
  await runtime.pairing.decide(agentId, true);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).paired.map((entry) => entry.agentId)).toContain(agentId));
}

async function heldRuntime(fake?: Fake): Promise<{ port: FakePort; runtime: ReturnType<typeof composeAgentRuntime>; fake: Fake }> {
  const installed = fake ?? installChrome({ session: seededHold() });
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port });
  runtime.start();
  await pair(port, runtime);
  await runtime.tabs.adopt(SESSION, TAB);
  return { port, runtime, fake: installed };
}

/** A call that runs answers `ok`; this one needs no page, so it proves the session is not held. */
async function expectRuns(port: FakePort, sessionId: string, callId: string): Promise<void> {
  port.emit({ callId, sessionId, tool: "tabs_context", args: {} });
  await vi.waitFor(() => expect(answerFor(port, callId)).toBeDefined());
  expect(answerFor(port, callId)).toMatchObject({ outcome: "ok" });
}

describe("T1007 a held session's calls", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers every tool owner-held and runs nothing: no runner, no pointer step, no page message", async () => {
    const { port, fake } = await heldRuntime();
    // The raise on adopt is the only page message so far; nothing a refused call does may add one.
    await vi.waitFor(() => expect(fake.pageMessages.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = fake.pageMessages.length;

    const calls = [
      { callId: "c-click", tool: "click", args: { tabId: TAB, target: { ref: "r1" } } },
      { callId: "c-read", tool: "read_page", args: { tabId: TAB } },
      { callId: "c-shot", tool: "screenshot", args: { tabId: TAB } },
      { callId: "c-tabs", tool: "tabs_context", args: {} },
      { callId: "c-find", tool: "find", args: { tabId: TAB, query: "the button" } },
    ];
    for (const call of calls) port.emit({ ...call, sessionId: SESSION, tabId: TAB });
    for (const call of calls) {
      await vi.waitFor(() => expect(answerFor(port, call.callId)).toBeDefined());
      expect(answerFor(port, call.callId)).toEqual(heldAnswer(call.callId));
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.pageMessages.slice(before), "a refused call reached the page").toEqual([]);
    expect(fake.commands, "a refused call reached the debugger").toEqual([]);
    expect(fake.captures, "a refused call took a screenshot").toBe(0);
  });

  /**
   * Review I2 (FR-515): the host asks about a file outside the owner's directories *before* the
   * call crosses, so a held session's `file_upload` would put an upload-directory card in front of
   * the owner who just stopped it. The worker answers the question itself, in its own word, and
   * the host refuses the call `owner-held` without reading a file or writing a root.
   */
  it("answers a held session's upload-directory question held, and raises no card", async () => {
    const { port, runtime } = await heldRuntime();
    const directory = "C:\\Users\\owner\\docs";

    port.emit({
      type: "upload-consent-request",
      sessionId: SESSION,
      callId: "host-call-u",
      files: [{ path: `${directory}\\receipt.txt`, directory }],
    });

    await vi.waitFor(() =>
      expect(port.sent).toContainEqual({ type: "upload-consent-result", callId: "host-call-u", decision: "held" }),
    );
    expect(runtime.prompts.current(), "a card was raised for a held session").toBeUndefined();
    expect(port.sent.filter((sent) => (sent as { type?: string }).type === "upload-roots-list")).toEqual([]);
  });

  it("leaves another session's calls running", async () => {
    const { port, runtime } = await heldRuntime();
    port.emit(hello(OTHER));
    await runtime.tabs.adopt(OTHER, OTHER_TAB);

    await expectRuns(port, OTHER, "c-other");
  });

  it("shows when it was held on the session's card, and on nobody else's", async () => {
    const { port, runtime } = await heldRuntime();
    port.emit(hello(OTHER));

    const sessions = (await runtime.projection()).sessions;
    expect(sessions.find((entry) => entry.sessionId === SESSION)?.heldAt).toBe(HELD_AT);
    expect(sessions.find((entry) => entry.sessionId === OTHER)).not.toHaveProperty("heldAt");
  });

  it("is loaded by a new worker before the session's first call after it greets again", async () => {
    // What the previous worker left in the session area, and its pairing in the local one.
    const first = installChrome({ session: seededHold() });
    await heldRuntime(first);

    const fake = installChrome({ local: first.local, session: first.session });
    const release = fake.parkHoldReads();
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(hello());
    port.emit({ callId: "c-first", sessionId: SESSION, tool: "tabs_context", args: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answerFor(port, "c-first"), "the call was answered before the holds were read").toBeUndefined();

    release();
    await vi.waitFor(() => expect(answerFor(port, "c-first")).toBeDefined());
    expect(answerFor(port, "c-first")).toEqual(heldAnswer("c-first"));
  });

  /**
   * Review N1: a hold read that failed at start used to lift every hold for that worker's life. The
   * load is tried again before the next call is decided, and only a second failure lets the call
   * through (with the diagnostic, as before).
   */
  it("reads the holds again before the first call when the read at start failed", async () => {
    const first = installChrome({ session: seededHold() });
    await heldRuntime(first);

    const fake = installChrome({ local: first.local, session: first.session });
    fake.holdReadsToFail = 1;
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    port.emit(hello());
    port.emit({ callId: "c-first", sessionId: SESSION, tool: "tabs_context", args: {} });

    await vi.waitFor(() => expect(answerFor(port, "c-first")).toBeDefined());
    expect(answerFor(port, "c-first")).toEqual(heldAnswer("c-first"));
  });

  /**
   * Review round 2 (G4): while the reads were failing the session's pills were drawn as working, so a
   * retried read that finds the hold draws them held again - the owner's Stop is on the page as well
   * as in the mirror.
   */
  it("draws the held pill again when a retried read finds the hold after the pill was drawn working", async () => {
    const first = installChrome({ session: seededHold() });
    await heldRuntime(first);

    const fake = installChrome({ local: first.local, session: first.session });
    // At start, and the greeting's try: the tab is adopted while nothing is known to be held.
    fake.holdReadsToFail = 2;
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    port.emit(hello());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.tabs.adopt(SESSION, TAB);
    const indicators = () =>
      fake.pageMessages.filter((sent) => sent.tabId === TAB && (sent.message as { type?: string }).type === "indicator");
    await vi.waitFor(() => expect(indicators().at(-1)?.message).toMatchObject({ show: true, mode: "working" }));
    const before = indicators().length;

    port.emit({ callId: "c-first", sessionId: SESSION, tool: "tabs_context", args: {} });

    await vi.waitFor(() => expect(answerFor(port, "c-first")).toEqual(heldAnswer("c-first")));
    await vi.waitFor(() => expect(indicators().slice(before)).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ show: true, mode: "held" }) })));
    // Review round 3 (H3): and held is what the tab is left showing, not a draw a later one undid.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(indicators().at(-1)?.message).toMatchObject({ show: true, mode: "held" });
  });

  /**
   * Review round 4: a hold the previous worker set before it met the session is settled by the
   * session's first greeting to this worker - even when the reads were failing as it greeted, so the
   * hold reaches this worker only later. That first greeting was plain, so a token greeting after
   * the read succeeds does not lift it.
   */
  it("settles a stored hold by the session's first greeting even when it came while the reads were failing", async () => {
    const first = installChrome({ session: { [AGENT_SESSION_HOLDS_KEY]: { [SESSION]: { at: HELD_AT, tabId: TAB, sessionKnown: false } } } });
    // Paired by a worker before the hold was set; the hold names a session that worker never met.
    const before = fakePort();
    const pairing = composeAgentRuntime({ connectNative: () => before });
    first.holdReadsToFail = Number.POSITIVE_INFINITY;
    pairing.start();
    await pair(before, pairing);

    const fake = installChrome({ local: first.local, session: first.session });
    // At start, and the greeting's try.
    fake.holdReadsToFail = 2;
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    port.emit(hello());
    await new Promise((resolve) => setTimeout(resolve, 20));
    port.emit({ callId: "c-first", sessionId: SESSION, tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(answerFor(port, "c-first")).toEqual(heldAnswer("c-first")));

    port.emit({ ...hello(), panelToken: "x".repeat(43) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    port.emit({ callId: "c-token", sessionId: SESSION, tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(answerFor(port, "c-token")).toBeDefined());
    expect(answerFor(port, "c-token")).toEqual(heldAnswer("c-token"));
    expect(Object.keys(storedHolds(fake))).toEqual([SESSION]);
  });

  /**
   * Review round 3 (H2): only a read that failed is a failed load. A subscriber that throws when the
   * loaded holds are told used to land in the load's own catch and be reported as the read failing.
   */
  it("does not report a failed load when telling the subscribers about a successful one throws", async () => {
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      installChrome({ session: seededHold() });
      const runtime = composeAgentRuntime({ connectNative: () => fakePort() });
      let throwing = false;
      runtime.subscribe(() => {
        if (throwing) throw new Error("a subscriber that throws");
      });
      runtime.start();
      throwing = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      throwing = false;

      const lines = warned.mock.calls.map(([line]) => line);
      expect(lines).not.toContain("[hallpass] agent.hold.load-failed");
      expect(lines).toContain("[hallpass] agent.hold.notify-failed");
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });

  it("lets the call through, and says so, when the read fails at start and again before the call", async () => {
    (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ = "test";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = installChrome({ session: seededHold() });
      await heldRuntime(first);

      const fake = installChrome({ local: first.local, session: first.session });
      // A store that never answers: every try fails, so the call is decided as before the fix.
      fake.holdReadsToFail = Number.POSITIVE_INFINITY;
      const port = fakePort();
      const runtime = composeAgentRuntime({ connectNative: () => port });
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      port.emit(hello());
      port.emit({ callId: "c-first", sessionId: SESSION, tool: "tabs_context", args: {} });

      await vi.waitFor(() => expect(answerFor(port, "c-first")).toBeDefined());
      expect(answerFor(port, "c-first")).toMatchObject({ outcome: "ok" });
      // Once at start, and at least once more before the call was decided.
      expect(warned.mock.calls.filter(([line]) => line === "[hallpass] agent.hold.load-failed").length).toBeGreaterThanOrEqual(2);
    } finally {
      warned.mockRestore();
      delete (globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__;
    }
  });

  // Review I3: a hold deleted while the load is still reading is not put back by what the load read.
  it("does not restore a hold the session's end deleted while the load was reading", async () => {
    const first = installChrome({ session: seededHold() });
    await heldRuntime(first);

    const fake = installChrome({ local: first.local, session: first.session });
    const release = fake.parkHoldReads();
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit(hello());
    await vi.waitFor(async () => expect((await runtime.projection()).sessions.map((entry) => entry.sessionId)).toContain(SESSION));

    const ended = runtime.stopSessionFromOwner(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await ended;

    await vi.waitFor(() => expect(storedHolds(fake)).not.toHaveProperty(SESSION));
    port.emit(hello());
    await expectRuns(port, SESSION, "c-after-end");
  });

  it("goes when the owner ends the session: the same id greeting later is not held", async () => {
    const { port, runtime, fake } = await heldRuntime();

    await runtime.stopSessionFromOwner(SESSION);

    await vi.waitFor(() => expect(storedHolds(fake)).not.toHaveProperty(SESSION));
    port.emit(hello());
    await expectRuns(port, SESSION, "c-after-end");
    expect((await runtime.projection()).sessions[0]).not.toHaveProperty("heldAt");
  });

  it("goes when another agent greets under the session's id", async () => {
    const { port, runtime, fake } = await heldRuntime();

    await pair(port, runtime, SESSION, "agent-2");

    await vi.waitFor(() => expect(storedHolds(fake)).not.toHaveProperty(SESSION));
    await expectRuns(port, SESSION, "c-agent-2");
  });

  it("goes when the owner unpairs the session's agent", async () => {
    const { port, runtime, fake } = await heldRuntime();

    await runtime.unpair("agent-1");

    await vi.waitFor(() => expect(storedHolds(fake)).not.toHaveProperty(SESSION));
    await pair(port, runtime);
    await expectRuns(port, SESSION, "c-after-unpair");
  });

  describe("Resume from the side panel", () => {
    function panelFor(runtime: ReturnType<typeof composeAgentRuntime>) {
      const listeners: Array<(message: unknown) => void> = [];
      const port: AgentPanelPortLike & { emit(message: unknown): void } = {
        name: AGENT_PANEL_PORT_NAME,
        sender: { id: EXTENSION_ID, url: PANEL_URL } as AgentPanelPortLike["sender"],
        postMessage() {},
        disconnect() {},
        onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
        onDisconnect: { addListener: () => undefined },
        emit(message: unknown) {
          for (const listener of listeners) listener(message);
        },
      };
      createAgentPanelPort({ extensionId: EXTENSION_ID, sidePanelUrl: PANEL_URL, runtime }).accept(port);
      return port;
    }

    it("lifts the hold, the next call runs, and the call refused while held is never run", async () => {
      const { port, runtime, fake } = await heldRuntime();
      port.emit({ callId: "c-shot", sessionId: SESSION, tool: "screenshot", tabId: TAB, args: { tabId: TAB } });
      await vi.waitFor(() => expect(answerFor(port, "c-shot")).toEqual(heldAnswer("c-shot")));

      panelFor(runtime).emit({ type: "ui.agent.session-resume", payload: { sessionId: SESSION } });

      await vi.waitFor(() => expect(storedHolds(fake)).not.toHaveProperty(SESSION));
      expect((await runtime.projection()).sessions[0]).not.toHaveProperty("heldAt");
      await expectRuns(port, SESSION, "c-after-resume");
      // The refused screenshot was answered once and stays answered: nothing replays it.
      expect(
        port.sent.filter((sent) => (sent as { callId?: string }).callId === "c-shot" && "outcome" in (sent as object)),
      ).toHaveLength(1);
      expect(fake.captures).toBe(0);
    });

    it("changes nothing for a session that is not held, or one this worker does not know", async () => {
      const fake = installChrome();
      const { port, runtime } = await heldRuntime(fake);

      const panel = panelFor(runtime);
      panel.emit({ type: "ui.agent.session-resume", payload: { sessionId: SESSION } });
      panel.emit({ type: "ui.agent.session-resume", payload: { sessionId: "nobody" } });

      await expectRuns(port, SESSION, "c-not-held");
      expect(storedHolds(fake)).toEqual({});
      expect((await runtime.projection()).sessions[0]?.activity ?? []).toEqual([]);
    });
  });
});
