import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_TIMEOUT_HINT, promptWaitingFrameSchema } from "@hallpass/contracts";
import {
  CLOSED_PANEL_TIMEOUT_MS,
  PROMPT_WAITING_TICK_MS,
  createAgentPromptController,
  type PromptWaitingTick,
} from "../src/service-worker/agent-tools/prompts.js";
import { deriveAttention } from "../src/service-worker/agent-runtime.js";
import {
  EMPTY_PAIRING_STATE,
  PAIRING_BOUND_MS,
  createPairingController,
  type PairingState,
  type PairingWaitingTick,
} from "../src/service-worker/pairing-controller.js";

/**
 * 011/T290, T291 — the bound a question is given, and the tick that says it is still waiting.
 *
 * The first call of a session raises its card into a side panel nobody has opened, and Chrome will
 * not let the worker open one (R-160). So two things change here and nothing else: the bound is
 * chosen from whether anybody could see the card, at the moment the card is raised; and while the
 * card stands, the worker says so every five seconds, which is what keeps the host's backstop off
 * the call and what carries the sentence to the person's terminal.
 *
 * The bound is read once, at raise, and never again (R-163). A panel opening mid-wait shows the
 * card - the projection already does that - but must not shorten a bound the person is already
 * inside; re-arming on presence would time out a question the moment somebody walked up to answer it.
 */

const PROMPT = {
  callId: "call-1",
  sessionId: "session-h1",
  site: "https://agent.test",
  tool: "click" as const,
  argsSummary: "click a page element",
};

function collector(): { ticks: PromptWaitingTick[]; onWaiting: (tick: PromptWaitingTick) => void } {
  const ticks: PromptWaitingTick[] = [];
  return { ticks, onWaiting: (tick) => ticks.push(tick) };
}

describe("T290 the bound a question is raised with", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 031/T926 (D-031-6, FR-473, R-453): one bound for every question. The old rule gave a card in
   * front of the person 25 s, which an owner reading the question in their terminal - or walking
   * back to Chrome - routinely lost.
   */
  it("holds every question for two minutes, whether or not a panel is visible", async () => {
    const closed = createAgentPromptController({ panelPresence: () => false });
    const open = createAgentPromptController({ panelPresence: () => true });

    const unseen = closed.ask({ ...PROMPT });
    const seen = open.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(open.current(), "the visible question expired at the old 25 s bound").toBeDefined();
    expect(closed.current()).toBeDefined();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 25_000);
    await expect(seen).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
    await expect(unseen).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
    expect(CLOSED_PANEL_TIMEOUT_MS).toBe(120_000);
  });

  it("keeps the bound it was raised with when a panel connects mid-wait", async () => {
    let connected = false;
    const controller = createAgentPromptController({ panelPresence: () => connected });

    const asked = controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    connected = true;

    await vi.advanceTimersByTimeAsync(25_000);
    expect(controller.current(), "the running bound was shortened under the person answering it").toBeDefined();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    await expect(asked).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
  });

  /**
   * 031/T926 (FR-474, R-455): the expiry always tells the agent what to do. The old rule sent no
   * hint for a card a panel could show; but the owner may have been reading the question in their
   * terminal, and "a panel was visible" is no evidence that anybody saw it.
   */
  it("tells the agent to have the owner answer in Chrome on every expiry, panel or not", async () => {
    const open = createAgentPromptController({ panelPresence: () => true });

    const asked = open.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    await expect(asked).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
    expect(CONSENT_TIMEOUT_HINT).toContain("retry");
  });
});

describe("T290 the ticks while a question waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 032 T961 (R-486, FR-488): the first tick goes the moment a question is armed, having waited
   * nothing. It is what tells the host when a question only Chrome shows was shown - such a
   * question sends no `prompt-raised` - so the host's cap counts that question's two minutes from
   * then, and there is no five-second gap in which the backstop could fire first.
   */
  it("says so the moment a question is armed, with nothing waited yet, for every kind", () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });
    const base = { boundMs: CLOSED_PANEL_TIMEOUT_MS, panelConnected: false, sessionId: "session-h1", waitedMs: 0 };

    void controller.ask({ ...PROMPT });
    expect(ticks).toEqual([{ ...base, kind: "ask", callId: "call-1" }]);
    controller.cancel();

    void controller.ask({ ...PROMPT, callId: "call-t", kind: "transition", transition: { from: "https://a.test", to: "https://agent.test" } });
    controller.cancel();
    void controller.askPlan({ callId: "call-p", sessionId: "session-h1", site: "https://agent.test", steps: [] });
    controller.cancel();
    void controller.askSitePlan({ callId: "call-s", hostCallId: "call-h", sessionId: "session-h1", origins: ["https://a.test"], purpose: "x" });
    controller.cancel();
    void controller.ask({ ...PROMPT, callId: "call-u", kind: "upload-directory", tool: "file_upload" });

    expect(ticks.slice(1)).toEqual([
      { ...base, kind: "ask", callId: "call-t" },
      { ...base, kind: "plan", callId: "call-p" },
      { ...base, kind: "plan", callId: "call-h" },
      { ...base, kind: "ask", callId: "call-u" },
    ]);
  });

  it("says it is still waiting every five seconds, with the wait and the bound it was given", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });

    void controller.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    const tick = {
      kind: "ask",
      callId: "call-1",
      sessionId: "session-h1",
      boundMs: CLOSED_PANEL_TIMEOUT_MS,
      panelConnected: false,
    };
    // 032 R-486: the tick at the raise, then every five seconds.
    expect(ticks).toEqual([
      { ...tick, waitedMs: 0 },
      { ...tick, waitedMs: PROMPT_WAITING_TICK_MS },
    ]);

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks[2]).toEqual({ ...tick, waitedMs: 2 * PROMPT_WAITING_TICK_MS });
    // The host reads the arithmetic and nothing else, so each tick has to stand on its own.
    expect(promptWaitingFrameSchema.safeParse({ type: "prompt-waiting", ...ticks[0] }).success).toBe(true);
    expect(promptWaitingFrameSchema.safeParse({ type: "prompt-waiting", ...ticks[2] }).success).toBe(true);
  });

  it("carries the kind the raising tool gave it, and `plan` for a whole batch", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });

    void controller.ask({ ...PROMPT, promptKind: "dialog" });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    controller.cancel();

    void controller.askPlan({
      callId: "call-2",
      sessionId: "session-h1",
      site: "https://agent.test",
      steps: [{ tool: "click", summary: "click a page element" }],
    });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);

    // Each question's tick at its raise (032 R-486) and its first five-second one.
    expect(ticks.map((tick) => tick.kind)).toEqual(["dialog", "dialog", "plan", "plan"]);
    expect(ticks[2]?.callId).toBe("call-2");
  });

  it("stops the moment the question ends, whichever way it ends", async () => {
    for (const ending of ["answered", "timed-out", "stopped", "released"] as const) {
      const { ticks, onWaiting } = collector();
      const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });
      const asked = controller.ask({ ...PROMPT });
      await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
      // The tick at the raise (032 R-486) and the first five-second one.
      expect(ticks, `${ending}: the first ticks`).toHaveLength(2);

      if (ending === "answered") controller.decide(controller.current()?.promptId ?? "", true);
      else if (ending === "timed-out") await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
      else controller.cancelSession("session-h1", ending);
      await asked;
      const heard = ticks.length;

      // A question that is over is not waiting: a tick after it would re-arm the host's backstop
      // for a call that has already been answered.
      await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
      expect(ticks, `${ending}: ticks after the question ended`).toHaveLength(heard);
      expect(controller.current(), `${ending}: the question is over`).toBeUndefined();
    }
  });

  /**
   * 011 review M1 — the ticks are for the person who cannot see the card.
   *
   * FR-148's progress notice is about a question raised into a panel nobody has open: that is the
   * situation the agent's reply has to describe, and the only one where the host's backstop has to
   * step out of the way. With a panel open the card is in front of the person, the ordinary bounds
   * apply, and the server's own pairing ticker is already saying something - so a tick here would
   * be a second progress line about a question the person is looking at.
   */
  /**
   * 031/T926 (R-453): the ticks start at every raise. Without them a question shown in a visible
   * panel - and now in the agent's client - lost its call to the host's 30 s backstop long before
   * its own two minutes, so they are the keep-alive for every question, and `panelConnected` alone
   * picks what the person is told.
   */
  it("ticks from the raise while a panel is open too, saying the panel is connected", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => true, onWaiting });

    void controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(2 * PROMPT_WAITING_TICK_MS);

    const tick = { kind: "ask", callId: "call-1", sessionId: "session-h1", boundMs: CLOSED_PANEL_TIMEOUT_MS, panelConnected: true };
    expect(ticks).toEqual([
      { ...tick, waitedMs: 0 },
      { ...tick, waitedMs: 5_000 },
      { ...tick, waitedMs: 10_000 },
    ]);
  });

  it("says nothing while nothing is pending", async () => {
    const { ticks, onWaiting } = collector();
    createAgentPromptController({ panelPresence: () => false, onWaiting });

    await vi.advanceTimersByTimeAsync(10 * PROMPT_WAITING_TICK_MS);

    expect(ticks).toEqual([]);
  });
});

/**
 * 011/T292 — when the toolbar icon is marked, as a table.
 *
 * The derivation is pulled out as a function of three booleans because that is all it is, and
 * because the transitions are the claim rather than any one row: the badge has to go on when the
 * last panel closes under a standing question, and off when the question ends *or* when a panel
 * opens - a person who is looking at the card does not need to be told where the card is.
 */
describe("T292 the attention derivation", () => {
  /**
   * 031/T926 (D-031-6, FR-473, R-454): the mark is shown whenever a question is pending. The old
   * rule switched it off while a panel was visible; but "visible" is a panel in the focused window,
   * not the owner's eyes on it, and the owner may be in the terminal. Presence no longer suppresses.
   */
  const rows: Array<{ pairingPending: boolean; promptPending: boolean; panelConnected: boolean; on: boolean }> = [
    { pairingPending: false, promptPending: false, panelConnected: false, on: false },
    { pairingPending: false, promptPending: false, panelConnected: true, on: false },
    { pairingPending: false, promptPending: true, panelConnected: false, on: true },
    { pairingPending: false, promptPending: true, panelConnected: true, on: true },
    { pairingPending: true, promptPending: false, panelConnected: false, on: true },
    { pairingPending: true, promptPending: false, panelConnected: true, on: true },
    { pairingPending: true, promptPending: true, panelConnected: false, on: true },
    { pairingPending: true, promptPending: true, panelConnected: true, on: true },
  ];

  it("marks the icon exactly when something is waiting, whoever can see it", () => {
    for (const row of rows) {
      const { on, ...input } = row;
      expect(deriveAttention(input), JSON.stringify(input)).toBe(on);
    }
  });

  it("follows the question, not the panel", () => {
    const waiting = { pairingPending: false, promptPending: true, panelConnected: true };

    // The person closes the panel while the card is up, and opens it again: the mark stays.
    expect(deriveAttention({ ...waiting, panelConnected: false })).toBe(true);
    expect(deriveAttention(waiting)).toBe(true);
    // The question ends - answered, expired, stopped - with the panel open or closed.
    expect(deriveAttention({ ...waiting, promptPending: false, panelConnected: false })).toBe(false);
    expect(deriveAttention({ ...waiting, promptPending: false })).toBe(false);
    // A pairing card is the same situation: it is a question, and the same icon says so.
    expect(deriveAttention({ pairingPending: true, promptPending: false, panelConnected: false })).toBe(true);
  });

  /**
   * 032 T962 (FR-488, R-486): the mark is on for every kind of question, including the ones only
   * Chrome shows. The runtime derives `promptPending` from `prompts.currentSession()`
   * (agent-runtime.ts `refreshAttention`); this pins that each kind sets it while it stands and
   * clears it when it ends.
   */
  it("is on while a site change, a batch plan, a site plan or a directory question stands", () => {
    const prompts = createAgentPromptController({ panelPresence: () => true });
    const mark = (panelConnected: boolean) =>
      deriveAttention({ pairingPending: false, promptPending: prompts.currentSession() !== undefined, panelConnected });
    const questions: Array<[string, () => void, () => void]> = [
      [
        "transition",
        () =>
          void prompts.ask({
            ...PROMPT,
            kind: "transition",
            transition: { from: "https://a.test", to: "https://agent.test" },
          }),
        () => prompts.decide(prompts.current()?.promptId ?? "", true),
      ],
      [
        "plan",
        () =>
          void prompts.askPlan({
            callId: "call-p",
            sessionId: "session-h1",
            site: "https://agent.test",
            steps: [{ tool: "click", summary: "click a page element" }],
          }),
        () => prompts.decidePlan(prompts.currentPlan()?.planId ?? "", true),
      ],
      [
        "site-plan",
        () =>
          void prompts.askSitePlan({
            callId: "call-s",
            sessionId: "session-h1",
            origins: ["https://a.test", "https://b.test"],
            purpose: "Compare",
          }),
        () => prompts.decideSitePlan(prompts.currentSitePlan()?.proposalId ?? "", false, []),
      ],
      [
        "upload-directory",
        () =>
          void prompts.ask({
            ...PROMPT,
            tool: "file_upload",
            kind: "upload-directory",
            files: [{ path: "C:/x/a.txt", directory: "C:/x" }],
          } as Parameters<typeof prompts.ask>[0]),
        () => prompts.decide(prompts.current()?.promptId ?? "", false),
      ],
    ];
    for (const [kind, raise, answer] of questions) {
      expect(mark(false), `${kind}: before`).toBe(false);
      raise();
      expect(prompts.currentSession(), kind).toBe("session-h1");
      expect(mark(false), `${kind}: panel out of sight`).toBe(true);
      expect(mark(true), `${kind}: panel in sight`).toBe(true);
      expect(answer(), `${kind}: answered`).toBe(true);
      expect(mark(true), `${kind}: after`).toBe(false);
    }
  });
});

/**
 * 011/T290 — the same for the question that comes before every other one.
 *
 * Pairing is the first-run case this feature is named after: the very first call of a session
 * raises it, and on a fresh install nobody has ever opened the panel. The bound is the server's -
 * the tick is what the server adopts, and `panelConnected` is what picks the sentence the person is
 * told - and the worker keeps the *card* to it, so the panel and the icon stop showing a question
 * the agent has already been answered about (review 4b, below).
 */
describe("T290 the ticks while a pairing waits", () => {
  const CLAUDE = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };

  function controllerWith(options: { panelConnected: boolean; initial?: PairingState }) {
    let stored: PairingState = options.initial ?? EMPTY_PAIRING_STATE;
    const ticks: PairingWaitingTick[] = [];
    /** What the panel and the icon are told, in order: the projection follows this and nothing else. */
    const changes: PairingState[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-21T00:00:00.000Z",
      panelPresence: () => options.panelConnected,
      onWaiting: (tick) => ticks.push(tick),
      onChange: (state) => changes.push(state),
    });
    return { controller, ticks, changes };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the server for two minutes when no panel can show the card", async () => {
    const { controller, ticks } = controllerWith({ panelConnected: false });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);

    expect(ticks).toEqual([
      {
        kind: "pairing",
        sessionId: "session-h1",
        waitedMs: PROMPT_WAITING_TICK_MS,
        boundMs: CLOSED_PANEL_TIMEOUT_MS,
        panelConnected: false,
      },
    ]);
    // No call of its own (contracts/prompt-waiting.md): the exchange belongs to the server.
    expect(promptWaitingFrameSchema.safeParse({ type: "prompt-waiting", ...ticks[0] }).success).toBe(true);
  });

  /**
   * 011 review M1 — with a panel open the server is already telling the person about the wait.
   *
   * The exchange's own bound is the server's 45 s and the card is in front of the person, so there
   * is nothing here the server does not know: a tick would only double its progress line and,
   * against an older relay, spend the route the answer needs on a frame that changes nothing.
   */
  it("says nothing about a card the person can see", async () => {
    const { controller, ticks } = controllerWith({ panelConnected: true });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);

    expect(ticks).toEqual([]);
    // The bound the server keeps in that case, and the one the tick would have named.
    expect(PAIRING_BOUND_MS).toBe(45_000);
  });

  it("keeps ticking for the session that raised it, and stops when the pairing settles", async () => {
    for (const settle of ["accept", "decline", "ignore", "abandon"] as const) {
      const { controller, ticks } = controllerWith({ panelConnected: false });
      void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
      await controller.ready();
      await vi.advanceTimersByTimeAsync(2 * PROMPT_WAITING_TICK_MS);
      expect(ticks.map((tick) => tick.waitedMs), `${settle}: two ticks`).toEqual([5_000, 10_000]);

      if (settle === "accept") await controller.decide("agent-1", true);
      else if (settle === "decline") await controller.decide("agent-1", false);
      else if (settle === "ignore") await controller.ignore("agent-1");
      else await controller.abandonPending();

      await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
      expect(ticks, `${settle}: ticks after the card left the panel`).toHaveLength(2);
    }
  });

  /**
   * 011 review M2 — every session waiting on the card hears about the wait.
   *
   * One card, several sessions: two Claude Code windows on one unpaired agent both hold their first
   * tool call on the owner's single answer. The frame is addressed to a session, and each session's
   * own server is the thing that has to be told to keep waiting - so a card that ticked only for
   * the session that raised it left the second one on its 45 s bound, answered `not-paired` while
   * the card was still on screen.
   */
  it("ticks for every session waiting on one card, until each of them leaves", async () => {
    const { controller, ticks } = controllerWith({ panelConnected: false });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h2" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);

    // One card, and one tick per session waiting on it: each names itself, because that is the
    // address the relay routes on and the server that has to hold its call is the session's own.
    expect(ticks).toEqual([
      {
        kind: "pairing",
        sessionId: "session-h1",
        waitedMs: PROMPT_WAITING_TICK_MS,
        boundMs: CLOSED_PANEL_TIMEOUT_MS,
        panelConnected: false,
      },
      {
        kind: "pairing",
        sessionId: "session-h2",
        waitedMs: PROMPT_WAITING_TICK_MS,
        boundMs: CLOSED_PANEL_TIMEOUT_MS,
        panelConnected: false,
      },
    ]);

    // The first window is closed: its server is gone, and a tick for it would be addressed to a
    // session the relay no longer has. The card stands, because the other session is still waiting.
    controller.sessionEnded("session-h1");
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks.slice(2).map((tick) => tick.sessionId)).toEqual(["session-h2"]);

    await controller.decide("agent-1", true);
    const heard = ticks.length;
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
    expect(ticks, "the card is answered: nothing is waiting").toHaveLength(heard);
  });

  /**
   * 011 review L2 — the ticks end where the bound does, and a re-raised card starts again.
   *
   * The worker never expires a pairing card; the server withdraws the request at its own bound and
   * raises a fresh one on the next call. So the ticks have to stop themselves - a tick past the
   * bound would keep re-arming a call the server has already answered - and a re-request has to be
   * read as the new question it is, with the panel presence and the bound of that moment.
   */
  it("stops ticking at the bound and starts afresh when the card is raised again", async () => {
    let panelConnected = false;
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const ticks: PairingWaitingTick[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-21T00:00:00.000Z",
      panelPresence: () => panelConnected,
      onWaiting: (tick) => ticks.push(tick),
    });

    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    // The last tick is the last one that could still buy the call any time: one at the bound itself
    // asks for `boundMs - waitedMs`, which is nothing, and the card is over in that same instant.
    expect(ticks.at(-1)?.waitedMs, "the last tick is the last that buys time").toBe(
      CLOSED_PANEL_TIMEOUT_MS - PROMPT_WAITING_TICK_MS,
    );
    const heard = ticks.length;

    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
    expect(ticks, "nothing is said past the bound the tick itself named").toHaveLength(heard);

    // The server withdrew its request and the next call raised it again - as the worker's own card
    // has gone with the wait (review 4b), this is the fresh question the next call is entitled to.
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks.at(-1)?.waitedMs, "the new question waits from its own start").toBe(PROMPT_WAITING_TICK_MS);

    // And the person opened the panel in the meantime: the card is in front of them now.
    panelConnected = true;
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    const afterOpen = ticks.length;
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
    expect(ticks).toHaveLength(afterOpen);
  });

  it("says nothing for an agent the owner has already paired", async () => {
    const { controller, ticks } = controllerWith({
      panelConnected: false,
      initial: { paired: [{ ...CLAUDE, acceptedAt: "2026-09-20T00:00:00.000Z" }] },
    });

    await expect(controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" })).resolves.toBe("accepted");
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);

    // Nothing is waiting: the owner answered this question once, and SC-020 says they are not
    // asked again. A tick here would hold a call open on a card that will never be shown.
    expect(ticks).toEqual([]);
  });

  /**
   * 011 review 4b — the card goes when the wait it was given runs out (FR-147, FR-059).
   *
   * The server withdraws its pairing request at the bound and tells the worker nothing about it:
   * the agent has been answered `timed-out`, and the next call raises the question afresh. The card
   * used to stand anyway, so the panel kept showing an Accept button for a request nobody is
   * holding and the icon kept its badge until something else happened to change. So the worker
   * keeps the card to the same bound its tick named, per session - which is what expiring *is*
   * here: the owner's Ignore, arrived at by the clock instead of by them.
   *
   * It is deliberately quiet. Nothing is sent: an answer now would reach a server that has already
   * withdrawn, and a `pair-result` of either kind would settle that session as *decided* - the one
   * thing FR-059's withdrawal exists to avoid. The waiting session is dropped rather than resolved,
   * exactly as `ignore` drops it, so the fresh prompt the next call raises gets fresh waiters.
   */
  it("drops the card when the closed-panel wait runs out, and stops saying anything", async () => {
    const { controller, ticks, changes } = controllerWith({ panelConnected: false });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    await controller.ready();

    expect((await controller.state()).pending, "FR-147: the question expired, so the card is over").toBeUndefined();
    const heard = ticks.length;
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
    expect(ticks, "a card that is gone is not waiting").toHaveLength(heard);
    // What the panel was last told is what the icon derives from: nothing is pending, and with no
    // panel connected that is exactly the row of the table where the badge goes off.
    expect(changes.at(-1)?.pending).toBeUndefined();
    expect(
      deriveAttention({ pairingPending: false, promptPending: false, panelConnected: false }),
    ).toBe(false);
  });

  it("drops a card the person could see at the bound that applies to it", async () => {
    const { controller, ticks } = controllerWith({ panelConnected: true });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(PAIRING_BOUND_MS - 1);
    await controller.ready();
    expect((await controller.state()).pending, "the owner is still inside the server's 45 s").toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    await controller.ready();

    // The same rule, on the bound that applies when a panel is open: the server withdrew at 45 s,
    // so the card the person is looking at is an Accept button for a request nobody is holding.
    expect((await controller.state()).pending).toBeUndefined();
    // And still nothing was said about a card the person could see all along (review M1).
    expect(ticks).toEqual([]);
  });

  it("keeps the card while any session is still inside its own wait", async () => {
    const { controller, ticks } = controllerWith({ panelConnected: false });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    // A second window of the same agent, a minute into the first one's wait: same card, own clock.
    await vi.advanceTimersByTimeAsync(60_000);
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h2" });
    await controller.ready();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 60_000);
    await controller.ready();

    // The first session's wait is over; the second is halfway through its own, and it is still
    // being asked, so the card stays and it keeps hearing about it.
    expect((await controller.state()).pending, "one session's clock is not the card's").toBeDefined();
    const beforeLast = ticks.length;
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks.slice(beforeLast).map((tick) => tick.sessionId)).toEqual(["session-h2"]);

    await vi.advanceTimersByTimeAsync(60_000);
    await controller.ready();
    expect((await controller.state()).pending, "the last session's wait ran out too").toBeUndefined();
  });

  it("refuses an answer to a card whose wait already ran out", async () => {
    const { controller } = controllerWith({ panelConnected: false });
    let answered: string = "waiting";
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" }).then((accepted) => {
      answered = accepted;
    });
    await controller.ready();
    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    await controller.ready();

    // The owner walks up a minute later and presses Accept on a card the panel should no longer be
    // showing. Nothing is paired by it - the same rule `prompts.ts` applies to a late Allow: the
    // question it answers no longer exists, so the answer runs nothing.
    await controller.decide("agent-1", true);

    expect((await controller.state()).paired).toEqual([]);
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    // And the withdrawn request is never answered: a `pair-result` now would settle that session as
    // decided, where the server means to ask again on its next call.
    expect(answered).toBe("waiting");
  });
});

/**
 * 015/T421 — the host says it stopped waiting, and the card follows at once (FR-216, FR-217).
 *
 * Until now the card was kept to a mirrored bound the worker could only guess at, so a host that
 * withdrew early - its session closed, or its own clock ran ahead - left an Accept button standing
 * for a request nobody held. `pair-withdraw` is the host saying so, and the worker's answer to it is
 * the same quiet expiry its own clock already ran: that session leaves the waiting list, and the
 * card goes only with the last one.
 */
describe("T421 a pairing request the host withdrew", () => {
  const CLAUDE = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };

  function controllerWith() {
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const ticks: PairingWaitingTick[] = [];
    const changes: PairingState[] = [];
    let waitersChanged = 0;
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-26T00:00:00.000Z",
      panelPresence: () => false,
      onWaiting: (tick) => ticks.push(tick),
      onChange: (state) => changes.push(state),
      onWaitersChange: () => {
        waitersChanged += 1;
      },
    });
    return { controller, ticks, changes, waitersChanged: () => waitersChanged };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the card and clears attention when the only waiting session is withdrawn", async () => {
    const { controller, ticks, changes } = controllerWith();
    let answered = "waiting";
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1", requestId: "req-1" }).then((answer) => {
      answered = answer;
    });
    await controller.ready();
    expect((await controller.state()).pending).toBeDefined();

    controller.withdraw("agent-1", "session-h1", "req-1");
    await controller.ready();

    // Well inside SC-113's two seconds: no clock was advanced at all.
    expect((await controller.state()).pending, "FR-217: nobody is waiting, so the card is over").toBeUndefined();
    expect(changes.at(-1)?.pending, "the panel and the icon are told").toBeUndefined();
    expect(deriveAttention({ pairingPending: false, promptPending: false, panelConnected: false })).toBe(false);
    expect(controller.waitingSessions("agent-1")).toBe(0);
    // Quiet, as the worker's own expiry is: the host has already answered its agent.
    const heard = ticks.length;
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);
    expect(ticks).toHaveLength(heard);
    expect(answered).toBe("waiting");
  });

  it("keeps the card, one connection fewer, while another session still waits", async () => {
    const { controller, ticks, waitersChanged } = controllerWith();
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1", requestId: "req-1" });
    await controller.ready();
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h2", requestId: "req-2" });
    await controller.ready();
    expect(controller.waitingSessions("agent-1")).toBe(2);
    const changedBefore = waitersChanged();

    controller.withdraw("agent-1", "session-h1", "req-1");
    await controller.ready();

    expect((await controller.state()).pending, "session-h2 is still being asked").toBeDefined();
    expect(controller.waitingSessions("agent-1"), "the card counts one connection").toBe(1);
    expect(waitersChanged(), "the count change is announced").toBeGreaterThan(changedBefore);
    const heard = ticks.length;
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks.slice(heard).map((tick) => tick.sessionId)).toEqual(["session-h2"]);
  });

  it("ignores a withdrawal of an earlier exchange once the session has asked again", async () => {
    const { controller } = controllerWith();
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1", requestId: "req-1" });
    await controller.ready();
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1", requestId: "req-2" });
    await controller.ready();

    // The withdrawal names the exchange it ends (FR-218): it must not take the newer question down.
    controller.withdraw("agent-1", "session-h1", "req-1");
    await controller.ready();

    expect((await controller.state()).pending).toBeDefined();
    expect(controller.waitingSessions("agent-1")).toBe(1);
  });
});

/**
 * 011 review H1 — a question raised inside a batch names the call the host is holding.
 *
 * A batch runs each step under a call id derived from its own (`<batch>#<i>`, stop.ts), and that id
 * exists nowhere outside this worker: the relay routes a worker frame by the call id it handed out,
 * and the host's router is holding the batch. So a tick carrying the step's id is dropped on the way
 * and the batch is given up on while the owner is still looking at the card. The question keeps the
 * step's id - it is the step that is being asked about - and says the routable one in its ticks.
 */
describe("H1 a question raised inside a batch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks under the batch's call id rather than the step's", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });

    void controller.ask({ ...PROMPT, callId: "call-1#0", hostCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);

    // The id the relay knows and the router is holding; the step's own id is dropped as unaddressed
    // on the way, and the batch call is answered by a backstop with the card still on screen.
    // 032 R-486: the tick at the raise, and the first five-second one.
    expect(ticks.map((tick) => tick.callId)).toEqual(["call-1", "call-1"]);
  });

  it("ends a step's question when the host gives up on the batch", async () => {
    const controller = createAgentPromptController({ panelPresence: () => false });

    const asked = controller.ask({ ...PROMPT, callId: "call-1#0", hostCallId: "call-1" });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);

    // What `stop {callId: "call-1"}` means: the host has abandoned the batch, and the question one
    // of its steps raised has nowhere left to be answered - exactly as `stops.stop` reads the id.
    controller.cancel("call-1");

    await expect(asked).resolves.toEqual({ decision: "timed-out" });
    expect(controller.current()).toBeUndefined();
  });

  it("leaves a question whose call id merely begins with the stopped one alone (B5)", async () => {
    const controller = createAgentPromptController({ panelPresence: () => false });

    const asked = controller.ask({ ...PROMPT, callId: "call-12#0", hostCallId: "call-12" });
    // A prefix is not the call: only the separator makes an id a step of the call that was stopped.
    controller.cancel("call-1");

    expect(controller.current()).toBeDefined();
    controller.cancel("call-12");
    await expect(asked).resolves.toEqual({ decision: "timed-out" });
  });
});

/**
 * 011 D-011-7 — a question whose panel goes out of sight while it waits.
 *
 * The bound used to be read once, at raise: a card raised while the person was in the panel's
 * window kept its 45 s / 25 s after they moved to another one, so the badge came on and the wait
 * stayed short (observed live 2026-09-24). From the moment the panel stops being visible the
 * question is one raised with no panel visible - ticks, the where-to-click sentence and two minutes
 * counted from the raise. The reverse stays as R-163 says: a panel coming into sight never shortens.
 */
describe("D-011-7 a question whose panel goes out of sight mid-wait", () => {
  const CLAUDE = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * 031/T926 (R-453): with one bound and ticks from every raise, a panel going out of sight has
   * nothing left to extend. The question keeps its one ticker and its two minutes from the raise;
   * only what the ticks say about the panel follows the change.
   */
  it("keeps a consent question's one ticker and two minutes when its panel goes out of sight", async () => {
    let visible = true;
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => visible, onWaiting });

    const asked = controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(10_000);
    // 032 R-486: the first of them at the raise itself, having waited nothing.
    expect(ticks.map((tick) => tick.panelConnected), "ticking from the raise").toEqual([true, true, true]);

    visible = false;
    controller.panelPresenceChanged();
    // Told twice (every focus move and window report announces): still one question, one ticker.
    controller.panelPresenceChanged();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(controller.current(), "the question expired at the old 25 s bound").toBeDefined();
    expect(ticks.map((tick) => tick.waitedMs)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000]);
    expect(ticks.slice(3).every((tick) => !tick.panelConnected && tick.boundMs === CLOSED_PANEL_TIMEOUT_MS)).toBe(true);

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 35_000 - 1);
    expect(controller.current(), "two minutes counted from the raise").toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(asked).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
  });

  it("extends a pairing card to two minutes from the raise and starts ticking at once", async () => {
    let visible = true;
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const ticks: PairingWaitingTick[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-24T00:00:00.000Z",
      panelPresence: () => visible,
      onWaiting: (tick) => ticks.push(tick),
    });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ticks).toEqual([]);

    visible = false;
    controller.panelPresenceChanged();
    controller.panelPresenceChanged();

    expect(ticks).toEqual([
      { kind: "pairing", sessionId: "session-h1", waitedMs: 20_000, boundMs: CLOSED_PANEL_TIMEOUT_MS, panelConnected: false },
    ]);
    await vi.advanceTimersByTimeAsync(PAIRING_BOUND_MS);
    await controller.ready();
    expect((await controller.state()).pending, "the card outlived the open-panel 45 s").toBeDefined();
    expect(ticks.at(-1)?.waitedMs).toBe(65_000);

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 65_000);
    await controller.ready();
    expect((await controller.state()).pending, "and ended at two minutes from the raise").toBeUndefined();
  });

  it("never shortens a running bound when the panel comes back into sight", async () => {
    let visible = true;
    const { ticks, onWaiting } = collector();
    const prompts = createAgentPromptController({ panelPresence: () => visible, onWaiting });
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const pairing = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-24T00:00:00.000Z",
      panelPresence: () => visible,
    });
    void prompts.ask({ ...PROMPT });
    void pairing.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await pairing.ready();

    await vi.advanceTimersByTimeAsync(5_000);
    visible = false;
    prompts.panelPresenceChanged();
    pairing.panelPresenceChanged();
    await vi.advanceTimersByTimeAsync(5_000);
    visible = true;
    prompts.panelPresenceChanged();
    pairing.panelPresenceChanged();

    await vi.advanceTimersByTimeAsync(100_000);
    await pairing.ready();
    expect(prompts.current(), "the consent question kept its two minutes").toBeDefined();
    expect((await pairing.state()).pending, "the pairing card kept its two minutes").toBeDefined();
    // Still said, as for any question raised with nobody looking: it is the host's keep-alive.
    expect(ticks.at(-1)?.waitedMs).toBe(110_000);
  });

  it("stops telling the agent the panel is closed once it is back in sight, and keeps the keep-alive", async () => {
    let visible = true;
    const { ticks, onWaiting } = collector();
    const prompts = createAgentPromptController({ panelPresence: () => visible, onWaiting });
    const pairingTicks: PairingWaitingTick[] = [];
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const pairing = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-24T00:00:00.000Z",
      panelPresence: () => visible,
      onWaiting: (tick) => pairingTicks.push(tick),
    });
    void prompts.ask({ ...PROMPT });
    void pairing.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await pairing.ready();

    await vi.advanceTimersByTimeAsync(5_000);
    visible = false;
    prompts.panelPresenceChanged();
    pairing.panelPresenceChanged();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks.at(-1)?.panelConnected).toBe(false);
    expect(pairingTicks.at(-1)?.panelConnected).toBe(false);

    visible = true;
    prompts.panelPresenceChanged();
    pairing.panelPresenceChanged();
    const before = { prompt: ticks.length, pairing: pairingTicks.length };
    await vi.advanceTimersByTimeAsync(10_000);

    // The card is in front of the person again: the ticks go on (the host's keep-alive for the two
    // minutes already granted) but no longer say the panel is closed.
    expect(ticks.slice(before.prompt).map((tick) => tick.panelConnected)).toEqual([true, true]);
    expect(pairingTicks.slice(before.pairing).map((tick) => tick.panelConnected)).toEqual([true, true]);
    // And the bound stays the two minutes it was given.
    expect(ticks.at(-1)?.boundMs).toBe(CLOSED_PANEL_TIMEOUT_MS);
  });
});

/**
 * 016/T450 — the pairing wait extension, measured (FR-244, R-210, B5).
 *
 * The open item recorded on 2026-09-23 said a pairing card raised with the panel seen kept its short
 * wait when the owner's focus left the panel's window. This pins the measurement the spec asks for:
 * raised with the panel seen, presence lost at 30 s, the bound becomes two minutes counted from the
 * raise and the ticks start at once. Green here means covered by D-011-7.
 */
describe("016/T450 pairing wait extension", () => {
  const CLAUDE = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raised with the panel seen, presence lost at 30 s: bound 120 s from the raise, ticks start", async () => {
    let visible = true;
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const ticks: PairingWaitingTick[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => "2026-09-27T00:00:00.000Z",
      panelPresence: () => visible,
      onWaiting: (tick) => ticks.push(tick),
    });
    void controller.decidePairing({ ...CLAUDE, sessionId: "session-h1" });
    await controller.ready();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks, "nothing is said while the card is in front of the owner").toEqual([]);

    visible = false;
    controller.panelPresenceChanged();

    expect(ticks).toEqual([
      { kind: "pairing", sessionId: "session-h1", waitedMs: 30_000, boundMs: CLOSED_PANEL_TIMEOUT_MS, panelConnected: false },
    ]);
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS * 2);
    expect(ticks.map((tick) => tick.waitedMs)).toEqual([30_000, 35_000, 40_000]);

    // Past the open-panel bound the card still stands.
    await vi.advanceTimersByTimeAsync(PAIRING_BOUND_MS);
    await controller.ready();
    expect((await controller.state()).pending).toBeDefined();

    // It ends exactly at two minutes from the raise, not from the presence change.
    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 40_000 - PAIRING_BOUND_MS - 1);
    await controller.ready();
    expect((await controller.state()).pending).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await controller.ready();
    expect((await controller.state()).pending).toBeUndefined();
  });
});
