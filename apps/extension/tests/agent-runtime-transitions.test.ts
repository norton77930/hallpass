import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transitionNoticeText } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import { AGENT_TRANSITIONS_KEY } from "../src/service-worker/transition-store.js";

/**
 * 014/T362 — the rules, wired to a browser (FR-185..FR-189, R-186 §2-§4).
 *
 * `transitions.test.ts` pins the rules; this file pins the four seams that carry them, because
 * each is a place where the rules could be perfectly right and the product still wrong:
 *
 * - the *feed*: a tab this session holds moved, and nothing of ours moved it - a redirect, a form
 *   submit, the owner's own typing - so the only signal is `tabs.onUpdated`;
 * - the *seed*: a tab the session just claimed or created is on an origin nobody has to be asked
 *   about, or the session's first call on its own new tab would raise a card;
 * - the *hold*: the next call on that tab waits for the owner, reads included, and every other
 *   call of the session does not;
 * - the *answer*: the call during which the move happened still says honestly what it did, and
 *   adds where the tab went (FR-186).
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

const SESSION = "session-t1";
const TAB = 7;
const SPARE = 8;
const A = "https://a.test";
const B = "https://b.test";
const C = "https://c.test";
const HELLO = { type: "hello", sessionId: SESSION, agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: SESSION,
};

type Harness = {
  /** The browser telling the worker a tab moved - the only navigation signal this feature has. */
  moveTab(tabId: number, url: string): Promise<void>;
  /** The same signal, fired and not waited for, which is the only way the browser ever sends it. */
  fire(tabId: number, url: string): void;
  local: Record<string, unknown>;
  tabs: Array<{ id: number; url: string; title: string; groupId: number; active: boolean; windowId: number }>;
};

function installChrome(): Harness {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [
    { id: TAB, url: `${A}/one`, title: "A one", groupId: -1, active: true, windowId: 900 },
    { id: SPARE, url: `${A}/two`, title: "A two", groupId: -1, active: false, windowId: 900 },
  ];
  const updateListeners: Array<(tabId: number, change: { url?: string; status?: string }, tab: unknown) => void> = [];
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
  });
  let nextTabId = 20;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage() {
        return { documentEpoch: "doc-1", canonicalOrigin: A };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async create({ url }: { url?: string }) {
        const created = { id: (nextTabId += 1), url: url ?? "about:blank", title: "created", groupId: -1, active: true, windowId: 900 };
        tabs.push(created);
        return created;
      },
      async ungroup() {},
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        const target = groupId ?? 100;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      onUpdated: {
        addListener(listener: (tabId: number, change: { url?: string }, tab: unknown) => void) {
          updateListeners.push(listener);
        },
        removeListener() {},
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
      async sendCommand() {
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  function fire(tabId: number, url: string): void {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab) tab.url = url;
    for (const listener of updateListeners) listener(tabId, { url }, tab);
  }
  return {
    local,
    tabs,
    fire,
    async moveTab(tabId: number, url: string) {
      fire(tabId, url);
      // The worker's own handling is asynchronous (a lease read and a storage write); the browser
      // does not wait for it and neither does this, so the test waits for the state it produced.
      const origin = new URL(url).origin;
      await vi.waitFor(() => {
        const states = (session[AGENT_TRANSITIONS_KEY] ?? {}) as Record<
          string,
          { known: string[]; pending?: { to: string } }
        >;
        const recorded = Object.entries(states).find(([key]) => key.endsWith(`:${tabId}`))?.[1];
        expect(recorded?.known.includes(origin) === true || recorded?.pending?.to === origin).toBe(true);
      });
    },
  };
}

async function pairedRuntime(): Promise<{ port: FakePort; runtime: ReturnType<typeof composeAgentRuntime> }> {
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  await runtime.tabs.adopt(SESSION, TAB);
  return { port, runtime };
}

/**
 * The tab's baseline: where the session first saw it.
 *
 * In the product this is written by the claim or the create that took the tab (the seed asserted
 * further down); a test that adopts a lease directly has to say it, and the browser's own first
 * arrival on the page is exactly how it would be said.
 */
async function knownOn(fake: Harness, tabId: number, url: string): Promise<void> {
  await fake.moveTab(tabId, url);
}

function answerFor(port: FakePort, callId: string): Record<string, unknown> | undefined {
  return port.sent.find((sent) => (sent as { callId?: string }).callId === callId) as Record<string, unknown> | undefined;
}

/** What the worker has written down about the tabs it holds, as the store keeps it. */
async function storedTransitions(): Promise<Record<string, unknown>> {
  const storage = (
    globalThis as {
      chrome?: { storage: { session: { get(keys: string[]): Promise<Record<string, unknown>> } } };
    }
  ).chrome?.storage.session;
  const raw = (await storage?.get([AGENT_TRANSITIONS_KEY])) ?? {};
  return (raw[AGENT_TRANSITIONS_KEY] ?? {}) as Record<string, unknown>;
}

/** A card of this kind is up; fails loudly rather than hanging when none arrives. */
async function transitionCard(
  runtime: ReturnType<typeof composeAgentRuntime>,
): Promise<{ promptId: string; transition?: { from: string; to: string }; site: string; kind?: string }> {
  await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined(), { timeout: 3_000 });
  return runtime.prompts.current() as never;
}

describe("T362 a tab that moved, and the call that meets it", () => {
  let fake: Harness;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("holds the next call on the tab behind a transition card, and lets it through on 繼續", async () => {
    const { port, runtime } = await pairedRuntime();
    // The session knows this tab is on A (it claimed it); the page then takes it elsewhere.
    await knownOn(fake, TAB, `${A}/one`);

    await fake.moveTab(TAB, `${B}/landing`);

    // A read, which passes no gate of its own and is silent today (FR-187's whole point).
    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    const card = await transitionCard(runtime);
    expect(card.kind).toBe("transition");
    expect(card.transition).toEqual({ from: A, to: B });
    expect(card.site).toBe(B);

    runtime.prompts.decide(card.promptId, true);
    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());
    // Whatever the read then answered, it was not refused for the move.
    expect(answerFor(port, "call-read")?.reason).not.toBe("site-transition-declined");

    // The pair is allowed for the rest of this session: the same move asks nothing a second time.
    await fake.moveTab(TAB, `${A}/back`);
    await fake.moveTab(TAB, `${B}/again`);
    port.emit({ callId: "call-2", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 10 } });
    await vi.waitFor(() => expect(answerFor(port, "call-2")).toBeDefined());
    expect(runtime.prompts.current(), "a second A→B in the same session raised a card").toBeUndefined();
  });

  /**
   * T369 review F4 — the hold reads the feed it is about, not a snapshot taken beside it.
   *
   * Every write about a tab's whereabouts goes through one queue, because the browser's signal and
   * the calls it concerns arrive in any order. The read did not, so an arrival the browser had
   * already reported but whose job had not run yet was invisible to the very check FR-187 exists
   * for: the call went through on a tab that had moved, and the owner was asked about it only
   * afterwards, by the next call.
   */
  it("holds a call behind an arrival the browser has only just reported", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);

    // The signal and the agent's next call in the same breath, which is the ordinary case: a
    // redirect commits while the agent is already sending.
    fake.fire(TAB, `${B}/landing`);
    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });

    const card = await transitionCard(runtime);
    expect(card.transition).toEqual({ from: A, to: B });
  });

  /**
   * T369 review F3 — 繼續 answers the move the owner was shown, and no other.
   *
   * A card stands for as long as the person takes to read it, and the page does not wait: a second
   * commit can replace where the tab is while the question about the first is still up. Applying
   * the answer to whatever is pending *now* would turn a yes about B into a yes about C - a site
   * the owner was never shown, admitted by a click on a card that did not mention it. So the yes
   * is spent on the pair it named, and the call asks again about where the tab has actually gone:
   * it proceeds only when the owner has said yes to *that*.
   */
  it("asks again for the pair the tab actually moved to, and proceeds only on that answer", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);

    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    const card = await transitionCard(runtime);
    expect(card.transition).toEqual({ from: A, to: B });

    // The page moves on again while the owner is still reading: the tab is now on C.
    await fake.moveTab(TAB, `${C}/onward`);
    runtime.prompts.decide(card.promptId, true);

    // The yes about B admits nothing: the same call raises the question the tab now owes.
    const second = await vi.waitFor(() => {
      const current = runtime.prompts.current();
      expect(current?.transition).toEqual({ from: A, to: C });
      return current as { promptId: string };
    });
    expect(answerFor(port, "call-read"), "the call ran on a destination nobody was asked about").toBeUndefined();

    runtime.prompts.decide(second.promptId, true);
    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());
    expect(answerFor(port, "call-read")?.reason).not.toBe("site-transition-declined");
  });

  /**
   * T369 follow-up — a page that keeps moving is answered, not asked about forever.
   *
   * Each round is a question the owner has to read, so a page that commits again every time one is
   * answered would walk the person through an unbounded sequence of cards for a single call. After
   * three the call is refused in the word a declined transition already has, with a hint that says
   * what actually happened; the question stays standing, and the agent may send the call again.
   */
  it("gives up after three rounds when the tab keeps moving under the question", async () => {
    const onward = [`${C}/one`, "https://d.test/two", "https://e.test/three"];
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);

    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    for (const next of onward) {
      const card = await transitionCard(runtime);
      // The page commits somewhere new while this card is up, every single time.
      await fake.moveTab(TAB, next);
      runtime.prompts.decide(card.promptId, true);
    }

    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());
    expect(answerFor(port, "call-read")).toMatchObject({
      outcome: "denied",
      reason: "site-transition-declined",
      hint: expect.stringContaining("kept moving"),
    });
    // A fourth card was not raised: the call gave up rather than asking again.
    expect(runtime.prompts.current()).toBeUndefined();
  });

  it("refuses the call on 拒絕, keeps the tab and the question, and still lets a navigate leave", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);

    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    const card = await transitionCard(runtime);
    runtime.prompts.decide(card.promptId, false);

    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());
    expect(answerFor(port, "call-read")).toMatchObject({ outcome: "denied", reason: "site-transition-declined" });
    // FR-188: the session and the tab are still there, and the question still stands.
    expect((await runtime.projection()).sessions[0]?.tabs.some((tab) => tab.tabId === TAB)).toBe(true);

    // A `navigate` that leaves the destination is admitted without a card - it is the way out.
    port.emit({ callId: "call-away", sessionId: SESSION, tool: "navigate", tabId: TAB, args: { tabId: TAB, url: `${A}/one` } });
    await vi.waitFor(() => expect(answerFor(port, "call-away")).toBeDefined());
    expect(runtime.prompts.current(), "a navigate away was held behind a card").toBeUndefined();
  });

  it("remembers the pair when the owner says 一律允許, with the times, for the panel and for later", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);

    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    const card = await transitionCard(runtime);
    runtime.prompts.decide(card.promptId, true, undefined, true);
    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());

    const remembered = (await runtime.projection()).transitions;
    expect(remembered).toEqual([{ from: A, to: B, allowedAt: expect.any(String) }]);
    // And it is the owner's own store, under the key the panel and the gate read.
    expect(fake.local.agentTransitionAllowances).toHaveLength(1);

    /**
     * Used again, and the row says when (FR-190).
     *
     * On another tab, because on *this* one the question is already settled twice over: B is an
     * origin this tab has been on, which rule (b) exempts before rule (d) is ever consulted. The
     * remembered pair is what a second tab - or a second session, or tomorrow - relies on.
     */
    await runtime.tabs.adopt(SESSION, SPARE);
    await knownOn(fake, SPARE, `${A}/two`);
    await fake.moveTab(SPARE, `${B}/elsewhere`);
    await vi.waitFor(async () =>
      expect((await runtime.projection()).transitions?.[0]?.lastUsedAt).toEqual(expect.any(String)),
    );
    // And it was an exemption, not a question: nothing was raised for the second tab.
    expect(runtime.prompts.current()).toBeUndefined();

    // Revoked from the panel, the next such move asks again (FR-192).
    await runtime.clearTransition(A, B);
    expect((await runtime.projection()).transitions).toEqual([]);
  });

  it("answers the call the move happened during, and says where the tab went (FR-186)", async () => {
    const { port } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    port.emit({ callId: "call-w", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 300 } });
    // *During* the call, which is the whole claim: fired once the call is certainly under way, so
    // that this stays a test about the answer a moved-under call gives and not about whether the
    // move beat the call to the transition queue - a move that lands first is FR-187's case, and
    // the call is held behind a card there rather than answered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.moveTab(TAB, `${B}/landing`);

    await vi.waitFor(() => expect(answerFor(port, "call-w")).toBeDefined(), { timeout: 3_000 });
    const answered = answerFor(port, "call-w");
    // Its own outcome is untouched: the call did what it did (FR-186's second sentence).
    expect(answered?.outcome).toBe("ok");
    expect(answered?.hint).toBe(transitionNoticeText(A, B));
  });

  it("does not hold the session's other tabs, or the tools that name no tab", async () => {
    const { port, runtime } = await pairedRuntime();
    await runtime.tabs.adopt(SESSION, SPARE);
    await knownOn(fake, TAB, `${A}/one`);
    await knownOn(fake, SPARE, `${A}/two`);
    await fake.moveTab(TAB, `${B}/landing`);

    port.emit({ callId: "call-other", sessionId: SESSION, tool: "wait", args: { tabId: SPARE, forMs: 10 } });
    await vi.waitFor(() => expect(answerFor(port, "call-other")).toBeDefined());
    expect(runtime.prompts.current(), "a call on another tab was held").toBeUndefined();

    port.emit({ callId: "call-list", sessionId: SESSION, tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(answerFor(port, "call-list")).toBeDefined());
    expect(answerFor(port, "call-list")?.outcome).toBe("ok");
    expect(runtime.prompts.current(), "a tool that names no tab was held").toBeUndefined();
  });

  it("seeds what a claimed or created tab is already on, and hears the move that follows", async () => {
    const { port, runtime } = await pairedRuntime();

    port.emit({ callId: "call-claim", sessionId: SESSION, tool: "tabs_claim", args: { tabId: SPARE } });
    await vi.waitFor(() => expect(answerFor(port, "call-claim")).toBeDefined());
    expect(answerFor(port, "call-claim")?.outcome).toBe("ok");

    // Where it already was is not a move: the session's first call on it asks nothing.
    await fake.moveTab(SPARE, `${A}/three`);
    port.emit({ callId: "call-seeded", sessionId: SESSION, tool: "wait", args: { tabId: SPARE, forMs: 10 } });
    await vi.waitFor(() => expect(answerFor(port, "call-seeded")).toBeDefined());
    expect(runtime.prompts.current()).toBeUndefined();

    // And a tab the session opened itself is known to be where it was opened.
    port.emit({ callId: "call-create", sessionId: SESSION, tool: "tabs_create", args: { url: `${A}/new` } });
    await vi.waitFor(() => expect(answerFor(port, "call-create")).toBeDefined());
    const created = (answerFor(port, "call-create")?.result as { tabId: number }).tabId;
    await fake.moveTab(created, `${A}/new`);
    port.emit({ callId: "call-new", sessionId: SESSION, tool: "wait", args: { tabId: created, forMs: 10 } });
    await vi.waitFor(() => expect(answerFor(port, "call-new")).toBeDefined());
    expect(runtime.prompts.current()).toBeUndefined();

    // But a move away from it is (rule f), on that tab and not on the session's others.
    await fake.moveTab(created, `${C}/elsewhere`);
    port.emit({ callId: "call-moved", sessionId: SESSION, tool: "wait", args: { tabId: created, forMs: 10 } });
    const card = await transitionCard(runtime);
    expect(card.transition).toEqual({ from: A, to: C });
    runtime.prompts.decide(card.promptId, false);
    await vi.waitFor(() => expect(answerFor(port, "call-moved")).toBeDefined());
  });

  it("admits the origin a navigate asked for, and asks about the one a redirect chose", async () => {
    const { port, runtime } = await pairedRuntime();

    port.emit({ callId: "call-nav", sessionId: SESSION, tool: "navigate", tabId: TAB, args: { tabId: TAB, url: `${B}/asked-for` } });
    // The tab commits where the call said it would: rule (e), no question.
    await fake.moveTab(TAB, `${B}/asked-for`);
    await vi.waitFor(() => expect(answerFor(port, "call-nav")).toBeDefined(), { timeout: 5_000 });
    expect(runtime.prompts.current(), "the navigate's own destination raised a card").toBeUndefined();

    // A further hop nobody asked for - a redirect onward - is a move the owner is owed.
    await fake.moveTab(TAB, `${C}/redirected`);
    port.emit({ callId: "call-after", sessionId: SESSION, tool: "wait", args: { tabId: TAB, forMs: 10 } });
    const card = await transitionCard(runtime);
    expect(card.transition).toEqual({ from: B, to: C });
    runtime.prompts.decide(card.promptId, true);
    await vi.waitFor(() => expect(answerFor(port, "call-after")).toBeDefined());
  });

  it("stops a batch before the step whose tab has moved, and says how far it got", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await runtime.siteModes.set(A, { mode: "skip-checks" });

    port.emit({
      callId: "call-batch",
      sessionId: SESSION,
      tool: "browser_batch",
      args: {
        tabId: TAB,
        steps: [
          { tool: "wait", args: { forMs: 10 } },
          { tool: "wait", args: { forMs: 200 } },
          { tool: "wait", args: { forMs: 10 } },
        ],
      },
    });
    // The second step's own page takes the tab elsewhere while it runs. Fired once the first step
    // (10 ms) is certainly over rather than in the same tick as the call: which step the batch had
    // reached would otherwise be decided by whether the browser's arrival or the batch's own
    // prelude finished its microtasks first, and the claim here is about a move landing *during*
    // the batch, not about that race.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.moveTab(TAB, `${B}/landing`);

    await vi.waitFor(() => expect(answerFor(port, "call-batch")).toBeDefined(), { timeout: 5_000 });
    const answer = answerFor(port, "call-batch") as { outcome: string; result: Record<string, unknown> };
    // The batch convention, as S1 kept it: the call is `ok` and the step carries the reason.
    expect(answer.outcome).toBe("ok");
    const results = answer.result.results as Array<{ index: number; outcome: string; reason?: string }>;
    const stoppedAt = answer.result.stoppedAt as number;
    expect(stoppedAt).toBeGreaterThan(0);
    expect(results[stoppedAt]).toMatchObject({ outcome: "stopped", reason: "site-transition" });
    for (const later of results.slice(stoppedAt + 1)) {
      expect(later).toMatchObject({ outcome: "stopped", reason: "not-run" });
    }
    // No card was raised mid-batch: the agent's next single call is what asks.
    expect(runtime.prompts.current()).toBeUndefined();
    expect(answer.result.notRun).toEqual(results.slice(stoppedAt + 1).map((step) => step.index));
  });

  /**
   * Letting go is not acting there (owner's ruling, 2026-09-22).
   *
   * `tabs_release` and `tabs_close` name the tab, so the rule that holds "any tool, reads
   * included" would hold them too - and then an agent that landed somewhere it should not be
   * could not leave without the owner answering a card first. They are the same act as the
   * `navigate` elsewhere FR-188 already admits, and they are admitted for the same reason.
   */
  it("admits the calls that leave the tab, and drops what it knew when they do", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);
    port.emit({ callId: "call-release", sessionId: SESSION, tool: "tabs_release", args: { tabId: TAB } });
    await vi.waitFor(() => expect(answerFor(port, "call-release")).toBeDefined());
    expect(answerFor(port, "call-release")).toMatchObject({ outcome: "ok" });
    expect(runtime.prompts.current(), "handing the tab back was held behind a card").toBeUndefined();

    // The lease is over, so the tab's state is nobody's business any more.
    await vi.waitFor(async () => {
      const raw = (await (globalThis as { chrome?: { storage: { session: { get(keys: string[]): Promise<Record<string, unknown>> } } } }).chrome!.storage.session.get([
        "agentTransitions",
      ])) as { agentTransitions?: Record<string, unknown> };
      expect(Object.keys(raw.agentTransitions ?? {})).toEqual([]);
    });
  });

  /**
   * T369 review F8 — a place that is not a web page is not an arrival.
   *
   * The rules are about sites: origins the owner holds a decision about, that an agent can be
   * asked to act on. A tab landing on the browser's own pages, on this extension's, or on a
   * scheme that is not the web is none of those - and a question about one would be a card the
   * owner cannot answer usefully and a pending state that holds the session's next call.
   */
  it("ignores an arrival on a scheme that is not a web page", async () => {
    const { port, runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);

    // Chrome gives its own pages a real origin (this runner's URL parser gives them none, which is
    // why the executable half of the claim uses a scheme both agree is origin-bearing).
    fake.fire(TAB, "chrome://newtab");
    fake.fire(TAB, "ftp://files.a.test/pub");

    port.emit({ callId: "call-read", sessionId: SESSION, tool: "get_page_text", args: { tabId: TAB } });
    await vi.waitFor(() => expect(answerFor(port, "call-read")).toBeDefined());

    expect(runtime.prompts.current(), "a card was raised about a page that is not a site").toBeUndefined();
    // And nothing was written down either: the tab is still known to be where the session saw it.
    const state = Object.values(await storedTransitions())[0] as { known: string[]; pending?: unknown };
    expect(state.pending).toBeUndefined();
    expect(state.known).toEqual([A]);
  });

  /**
   * T369 review F6 — the panel's Release tabs is the same letting go, by the owner's hand.
   *
   * `tabs_release` drops what the session knew about where the tab had been; the control on the
   * card released the lease and left that record behind. The tab ids Chrome hands out come round
   * again, so a record outliving its lease is a question waiting to be asked about somebody else's
   * tab - and it is the owner's own browsing it would be about.
   */
  it("drops what it knew about every tab when the owner hands the session's tabs back", async () => {
    const { runtime } = await pairedRuntime();
    await knownOn(fake, TAB, `${A}/one`);
    await fake.moveTab(TAB, `${B}/landing`);
    expect(Object.keys(await storedTransitions()), "nothing was written down to begin with").toHaveLength(1);

    await runtime.releaseSessionTabs(SESSION);

    expect(Object.keys(await storedTransitions())).toEqual([]);
  });
});
