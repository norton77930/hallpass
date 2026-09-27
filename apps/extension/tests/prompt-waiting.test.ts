import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTENTION_SENTENCES, promptWaitingFrameSchema } from "@hallpass/contracts";
import {
  ASK_TIMEOUT_MS,
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

  it("holds an unanswerable question for two minutes and a visible one for twenty-five seconds", async () => {
    const closed = createAgentPromptController({ panelPresence: () => false });
    const open = createAgentPromptController({ panelPresence: () => true });

    const unseen = closed.ask({ ...PROMPT });
    const seen = open.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    await expect(seen).resolves.toEqual({ decision: "timed-out" });
    // Still standing: nobody has had a chance to see it yet, which is the whole point of the bound.
    expect(closed.current(), "the closed-panel question expired at the open-panel bound").toBeDefined();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - ASK_TIMEOUT_MS);
    await expect(unseen).resolves.toEqual({ decision: "timed-out", hint: ATTENTION_SENTENCES.consent });
  });

  it("keeps the bound it was raised with when a panel connects mid-wait", async () => {
    let connected = false;
    const controller = createAgentPromptController({ panelPresence: () => connected });

    const asked = controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    connected = true;

    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    expect(controller.current(), "the running bound was shortened under the person answering it").toBeDefined();

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS);
    await expect(asked).resolves.toEqual({ decision: "timed-out", hint: ATTENTION_SENTENCES.consent });
  });

  it("says where to click only for a question nobody could see", async () => {
    const open = createAgentPromptController({ panelPresence: () => true });

    const asked = open.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    // A card the person is looking at and does not answer is a decision, not a card nobody saw:
    // there is no instruction that would have helped, so none is sent.
    await expect(asked).resolves.toEqual({ decision: "timed-out" });
  });
});

describe("T290 the ticks while a question waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says it is still waiting every five seconds, with the wait and the bound it was given", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });

    void controller.ask({ ...PROMPT });

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks).toEqual([
      {
        kind: "ask",
        callId: "call-1",
        sessionId: "session-h1",
        waitedMs: PROMPT_WAITING_TICK_MS,
        boundMs: CLOSED_PANEL_TIMEOUT_MS,
        panelConnected: false,
      },
    ]);

    await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
    expect(ticks[1]).toEqual({ ...ticks[0], waitedMs: 2 * PROMPT_WAITING_TICK_MS });
    // The host reads the arithmetic and nothing else, so each tick has to stand on its own.
    expect(promptWaitingFrameSchema.safeParse({ type: "prompt-waiting", ...ticks[1] }).success).toBe(true);
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

    expect(ticks.map((tick) => tick.kind)).toEqual(["dialog", "plan"]);
    expect(ticks[1]?.callId).toBe("call-2");
  });

  it("stops the moment the question ends, whichever way it ends", async () => {
    for (const ending of ["answered", "timed-out", "stopped", "released"] as const) {
      const { ticks, onWaiting } = collector();
      const controller = createAgentPromptController({ panelPresence: () => false, onWaiting });
      const asked = controller.ask({ ...PROMPT });
      await vi.advanceTimersByTimeAsync(PROMPT_WAITING_TICK_MS);
      expect(ticks, `${ending}: the first tick`).toHaveLength(1);

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
  it("says nothing while a panel is open to show the card", async () => {
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => true, onWaiting });

    void controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(4 * PROMPT_WAITING_TICK_MS);

    expect(ticks).toEqual([]);
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
  const rows: Array<{ pairingPending: boolean; promptPending: boolean; panelConnected: boolean; on: boolean }> = [
    { pairingPending: false, promptPending: false, panelConnected: false, on: false },
    { pairingPending: false, promptPending: false, panelConnected: true, on: false },
    { pairingPending: false, promptPending: true, panelConnected: false, on: true },
    { pairingPending: false, promptPending: true, panelConnected: true, on: false },
    { pairingPending: true, promptPending: false, panelConnected: false, on: true },
    { pairingPending: true, promptPending: false, panelConnected: true, on: false },
    { pairingPending: true, promptPending: true, panelConnected: false, on: true },
    { pairingPending: true, promptPending: true, panelConnected: true, on: false },
  ];

  it("marks the icon exactly when something is waiting where nobody can see it", () => {
    for (const row of rows) {
      const { on, ...input } = row;
      expect(deriveAttention(input), JSON.stringify(input)).toBe(on);
    }
  });

  it("follows each of the four things that can change under it", () => {
    const waiting = { pairingPending: false, promptPending: true, panelConnected: true };

    // The person closes the panel while the card is up.
    expect(deriveAttention({ ...waiting, panelConnected: false })).toBe(true);
    // They open it again: the card is in front of them, so the icon has nothing to add.
    expect(deriveAttention(waiting)).toBe(false);
    // The question ends - answered, expired, stopped - with the panel still closed.
    expect(deriveAttention({ ...waiting, promptPending: false, panelConnected: false })).toBe(false);
    // A pairing card is the same situation: it is a question, and the same icon says so.
    expect(deriveAttention({ pairingPending: true, promptPending: false, panelConnected: false })).toBe(true);
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
    expect(ticks.map((tick) => tick.callId)).toEqual(["call-1"]);
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

  it("extends a consent question to two minutes from the raise and starts ticking at once", async () => {
    let visible = true;
    const { ticks, onWaiting } = collector();
    const controller = createAgentPromptController({ panelPresence: () => visible, onWaiting });

    const asked = controller.ask({ ...PROMPT });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks, "nothing is said about a card in front of the person").toEqual([]);

    visible = false;
    controller.panelPresenceChanged();
    // Told twice (every focus move and window report announces): still one question, one ticker.
    controller.panelPresenceChanged();

    // At once, not five seconds later: the server's bound may be about to pass.
    expect(ticks).toEqual([
      { kind: "ask", callId: "call-1", sessionId: "session-h1", waitedMs: 10_000, boundMs: CLOSED_PANEL_TIMEOUT_MS, panelConnected: false },
    ]);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    expect(controller.current(), "the question expired at the bound it was raised with").toBeDefined();
    expect(ticks.at(-1)?.waitedMs).toBe(35_000);
    expect(ticks.map((tick) => tick.waitedMs)).toEqual([10_000, 15_000, 20_000, 25_000, 30_000, 35_000]);

    await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS - 35_000 - 1);
    expect(controller.current(), "two minutes counted from the raise, not from the move").toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(asked).resolves.toEqual({ decision: "timed-out", hint: ATTENTION_SENTENCES.consent });
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
