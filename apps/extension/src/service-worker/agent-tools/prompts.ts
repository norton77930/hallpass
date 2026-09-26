import {
  ATTENTION_SENTENCES,
  type AgentEffectPrompt,
  type AgentNativeResponse,
  type AgentPlanPrompt,
  type SiteMode,
} from "@hallpass/contracts";
import { STEP_SEPARATOR } from "./stop.js";

/**
 * The questions the owner is asked about something that has not happened yet (FR-042, FR-043,
 * 003 D-M3-1).
 *
 * Two kinds, one queue of exactly one. An `ask` prompt is about a single effect; a plan prompt is a
 * whole `browser_batch` on a site the owner set to `follow-a-plan`, answered once (US3 scenario 5).
 * They share this module because they share every rule that matters: one at a time, the same
 * deadline, and a question that expired is dead rather than merely unanswered.
 *
 * The deadline lives here, in the worker, and not in the host. The host's 30 s is a backstop for a
 * worker that stopped answering at all; this 25 s is the *product* decision about how long an
 * unanswered question holds a tool call, and it sits strictly under the backstop so the agent is
 * told `timed-out` in the tool contract's own words rather than losing the call to a transport
 * bound it cannot interpret.
 *
 * A timed-out prompt is *dead*, not merely unanswered. The call has already been answered
 * `timed-out`, so an owner who presses Allow a minute later is answering a question that no longer
 * exists; running the effect then would be an effect nobody is waiting for, attached to no result.
 * The late answer is refused and logged.
 *
 * One prompt at a time per session, because the owner answers a question, not a queue: a second
 * effect arriving while one is pending is `busy`, which is a word the agent can act on.
 */

export const ASK_TIMEOUT_MS = 25_000;

/**
 * How long a question waits when no side panel is connected to see it (011 FR-147, R-163).
 *
 * The 25 s above is how long a *visible* card may stand unanswered: the person is looking at their
 * browser and not answering, which is close enough to a decision. A card raised into a panel nobody
 * has opened is a different situation - Chrome will not let the worker open one (R-160), so the
 * only route left is the agent's own reply telling the person to click the toolbar icon, and two
 * minutes is how long that takes to read, reach for the mouse and answer.
 *
 * It is chosen when the question is raised and only ever lengthened: a panel that opens mid-wait
 * shows the card (the projection does that already) and must not shorten a bound the person is
 * already inside - re-arming on presence would expire the question exactly as somebody walked up.
 * The one revision is the other way (D-011-7): a panel that goes out of sight while the question
 * waits makes it one raised with nobody looking, two minutes counted from the raise.
 */
export const CLOSED_PANEL_TIMEOUT_MS = 120_000;

/**
 * How often a pending question says it is still pending (011 R-162, contracts/prompt-waiting.md).
 *
 * Five seconds because the tick is two things at once: the keep-alive the host's per-call backstop
 * reads, and the carrier of the sentence the person is told - and the first of them has to arrive
 * inside SC-078's five seconds to be the first thing the person sees.
 */
export const PROMPT_WAITING_TICK_MS = 5_000;

/**
 * One "still waiting", as the worker knows it. The runtime turns it into the link frame; nothing
 * here knows there is a host at the other end.
 */
export type PromptWaitingTick = {
  /** Which question is waiting; `pairing` belongs to the pairing controller, not to this one. */
  kind: "ask" | "plan" | "dialog" | "diagnostics";
  callId: string;
  sessionId: string;
  waitedMs: number;
  boundMs: number;
  panelConnected: boolean;
};

/**
 * The two ways the owner can end a question from the session card without answering it (006
 * FR-087). Neither is "nobody answered": Stop ends the session and the parked call with it, and
 * Release takes back the tab the question was about, so the call is refused as any unheld tab is.
 */
/**
 * 014 FR-179: and a fourth, which is none of the three.
 *
 * The owner interrupted the step the question belonged to. Not `timed-out` - somebody acted, at
 * once. Not `stopped` - the session and its tabs are still there. And emphatically not a decline:
 * a decline is a decision about what was asked, and this is the question ending before one was
 * made, so nothing is recorded about the site, the pair or the directory it was about.
 */
export type PromptEnding = "timed-out" | "stopped" | "released" | "interrupted";

/** Spelt out per ending rather than as `{ decision: PromptEnding }`, so a consumer's checks narrow. */
export type PromptDecision =
  /**
   * 014 FR-188: `rememberTransition` is the transition card's 一律允許, and it is a flag of its own
   * rather than a second spelling of `rememberMode` because the two remember different things - a
   * mode is a decision about one site, and this is a decision about one *ordered pair* of them.
   */
  /**
   * 014 FR-193: `rememberDirectory` is the directory card's 這些資料夾以後都可以, and it is a third
   * flag for the same reason the second one exists - a mode is about a site, a pair is about two
   * origins, and this is about a directory on the owner's own disk. One flag for three would let a
   * yes meant for one of them be read as another.
   */
  | { decision: "allow"; rememberMode?: SiteMode; rememberTransition?: boolean; rememberDirectory?: boolean }
  | { decision: "deny" }
  /**
   * `hint` is where the person has to click, present only when this question expired with no panel
   * connected to show it (011 FR-146). The caller puts it on the `timed-out` answer beside the
   * stable `reason`; an agent that cannot read it still branches on the reason exactly as before.
   */
  | { decision: "timed-out"; hint?: string }
  | { decision: "stopped" }
  | { decision: "released" }
  /** 014 FR-179: the owner ended the step this question belonged to; nothing was decided. */
  | { decision: "interrupted" };

export type PlanDecision =
  /** The owner's yes, minus any steps they struck out (US5, the batch approval). */
  | { decision: "approve"; planId: string; excluded: readonly number[] }
  | { decision: "deny" }
  /** The same hint a single question's expiry carries (011 FR-146). */
  | { decision: "timed-out"; hint?: string }
  | { decision: "stopped" }
  | { decision: "released" }
  /** 014 FR-179: the same ending for a whole batch's question. */
  | { decision: "interrupted" };

/**
 * Which call a question belongs to (003/B5).
 *
 * It is carried beside the prompt rather than inside it because it is not something the owner is
 * shown: it is how the worker knows whose question this is when the host says it has given up on
 * one particular call.
 */
export type PromptOwner = {
  callId: string;
  /**
   * The same call as the host and the relay know it, when the two differ (011 review H1).
   *
   * They differ for one thing: a batch step runs under `<batch>#<i>`, an id minted in this worker
   * and known nowhere else. The question is still *about* the step - that is the id a `stop` for
   * the step names and the id the answer is traced to - but the tick that says it is still waiting
   * has to travel, so it names this one. Absent means the two are the same, which is every call
   * that is not a batch step.
   */
  hostCallId?: string | undefined;
  /**
   * The session that raised it (004/T103a). A question outlives the call frame that asked it, so
   * when a session ends this is the only thing that tells its own questions from another agent's.
   */
  sessionId: string;
  /**
   * Whether the call this question belongs to has already been ended (014 FR-179, T369 review F2).
   *
   * The dispatch point's own stop handle, handed down. The interrupt can land in the window between
   * a call being registered and its runner getting as far as asking: the call has been answered
   * `owner-interrupted` by then, and a card raised afterwards belongs to nobody - the owner's 繼續
   * on it would deliver input, or record a decision about a site, for a call the agent was told was
   * over. Read once, at the moment the question is raised; after that the existing cancellations
   * are what take a standing card down.
   */
  stopped?: (() => boolean) | undefined;
  /**
   * Which of the person's questions this is, for the "still waiting" ticks alone (011 R-162).
   *
   * It is not `AgentEffectPrompt["kind"]`, which is the panel's wording for two page-raised cards:
   * this one is the contract's `AgentPromptKind` minus `pairing`, and the tools that have a word of
   * their own - the dialog gate, the diagnostics grant - pass it. Everything else is an `ask`.
   */
  promptKind?: PromptWaitingTick["kind"];
};

export type AgentPromptController = {
  /** The prompt the panel should be showing, if any. */
  current(): AgentEffectPrompt | undefined;
  /** The plan the panel should be showing, if any. */
  currentPlan(): AgentPlanPrompt | undefined;
  /**
   * Whose question is up (006 R-127): the session that raised the pending prompt or plan, so the
   * panel can say "waiting for you" on that session's card and on no other. `undefined` when
   * nothing is pending.
   */
  currentSession(): string | undefined;
  /**
   * Raises one prompt and resolves with the owner's answer, or with `timed-out`. Resolves
   * `busy` immediately when another prompt is already up.
   */
  ask(
    prompt: Omit<AgentEffectPrompt, "promptId"> & PromptOwner,
  ): Promise<PromptDecision | { decision: "busy" }>;
  /** The same, for a whole batch the owner answers once. */
  askPlan(plan: Omit<AgentPlanPrompt, "planId"> & PromptOwner): Promise<PlanDecision | { decision: "busy" }>;
  /** The panel's answer. Returns whether it settled a prompt that was still alive. */
  decide(
    promptId: string,
    allow: boolean,
    rememberMode?: SiteMode,
    rememberTransition?: boolean,
    rememberDirectory?: boolean,
  ): boolean;
  /** The panel's answer to a plan. Returns whether it settled a plan that was still alive. */
  decidePlan(planId: string, approve: boolean, excludedIndexes?: readonly number[]): boolean;
  /**
   * Ends a pending prompt without an answer - the owner's Stop, the link going away, or the host
   * abandoning one call.
   *
   * With a `callId` it ends only the question that call raised (003/B5): the host's backstop is
   * about one call, and a second call's owner is still sitting in front of a question that is
   * perfectly alive. With no `callId` it ends whatever is pending, which is what the session going
   * away means.
   */
  cancel(callId?: string): void;
  /**
   * Ends a pending question only if the session that raised it is the one that is over.
   *
   * A session ending is not the owner pressing Stop: the other agents are still running and their
   * questions are still answerable, so this cancels one session's and leaves the rest standing.
   * The `ending` is the word the parked call is answered with (006 FR-087): `stopped` for the
   * card's Stop, `released` for its Release tabs, and `timed-out` - the default - for a session
   * that simply ended, whose call has nowhere to be answered anyway.
   */
  cancelSession(sessionId: string, ending?: PromptEnding): void;
  /**
   * The panel's visibility may have changed (011 D-011-7): re-reads `panelPresence`, and a question
   * raised in sight that nobody can see any more becomes one raised with nobody looking - the ticks
   * start at once, the hint is attached, and the bound becomes the closed-panel one counted from the
   * raise. Idempotent; a panel coming into sight changes nothing.
   */
  panelPresenceChanged(): void;
};

export type AgentPromptDeps = {
  onChange?: () => void;
  reportDiagnostic?: (code: string) => void;
  timeoutMs?: number;
  /**
   * The closed-panel bound, overridden the way `timeoutMs` overrides the open-panel one.
   *
   * Two levers rather than one because the two bounds are the thing under test: a suite that wants
   * a question to expire in milliseconds still has to be able to say *which* bound it expired on.
   */
  closedPanelTimeoutMs?: number;
  now?: () => number;
  /**
   * Whether the owner can see a panel, asked once per question (011 R-163): since the fix of
   * 2026-09-23 (panel in another window) that is a connected panel in the last-focused window, not
   * any panel document anywhere - the runtime hands in the panel port's `isVisible`.
   *
   * Absent means "assume somebody is looking": the controllers composed by a test that says nothing
   * about panels keep the 25 s they have always had, and only the runtime - which knows about the
   * panel port - hands in the real answer.
   */
  panelPresence?: () => boolean;
  /**
   * Called every `PROMPT_WAITING_TICK_MS` while a question stands that nobody could see when it was
   * raised, for as long as it stands (011 FR-148, review M1).
   *
   * The controller does not know what becomes of it. The runtime turns it into the link frame the
   * host reads as a keep-alive and the server reads as the person's progress message - both of
   * which are about the closed-panel case alone: a card in front of the person waits the ordinary
   * bound, which the host already allows for.
   */
  onWaiting?: (tick: PromptWaitingTick) => void;
};

/**
 * The answer to a call whose question nobody answered in time (FR-043), with the person's
 * instruction attached when there is one (011 FR-146).
 *
 * One helper for all six tools that can raise a question, because the shape is the claim: the
 * agent branches on `reason`, which does not move, and `hint` is beside it only when the question
 * was raised into a panel nobody had open - a card that was never seen is a different fact from a
 * card that was ignored, and only the first has an instruction that would have helped.
 */
export function noAnswerResponse(callId: string, decision: { hint?: string }): AgentNativeResponse {
  return {
    callId,
    outcome: "timed-out",
    reason: "no-answer",
    ...(decision.hint === undefined ? {} : { hint: decision.hint }),
  };
}

/**
 * Whether a pending question belongs to the call the host has given up on (011 review H1).
 *
 * The same rule `stop.ts` applies to the calls it is watching, for the same reason: a batch step's
 * question was raised under `<batch>#<i>`, and the host only ever names the batch. Without this the
 * card would stand after its call was abandoned, and the owner's Allow would run an effect for a
 * call nobody is waiting on. The separator is what makes it a step - a call id that merely begins
 * with another's is a different call (B5).
 */
function isCall(pendingCallId: string | undefined, callId: string): boolean {
  if (pendingCallId === undefined) return false;
  return pendingCallId === callId || pendingCallId.startsWith(`${callId}${STEP_SEPARATOR}`);
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The one question in flight.
 *
 * `expire` is what the deadline and a cancel both call, so neither has to know which kind of
 * question it is ending: each kind supplies its own word for "nobody answered", and there is no
 * place where one kind's answer could be handed to the other's caller.
 */
type PendingPrompt = {
  id: string;
  /** The call this question was raised for; a `stop` naming a different one leaves it alone (B5). */
  callId: string;
  /** The session that raised it; the session ending is what cancels it (004/T103a). */
  sessionId: string;
  effect?: AgentEffectPrompt;
  plan?: AgentPlanPrompt;
  timer: ReturnType<typeof setTimeout>;
  /** The five-second "still waiting", running for exactly as long as this question does (011). */
  ticker?: ReturnType<typeof setInterval>;
  /**
   * Where the person has to click, if this question was raised into a panel nobody had open. It is
   * fixed at raise like the bound is, and it travels only with the question's *own* expiry.
   */
  hint?: string;
  /**
   * What the ticks need, and what going out of sight mid-wait re-arms from (D-011-7): the raise's
   * addressing, when it was raised, and the bound it is running under now.
   */
  clock?: { raise: { kind: PromptWaitingTick["kind"]; callId: string; sessionId: string }; raisedAtMs: number; boundMs: number };
  end: (ending: PromptEnding, hint?: string) => void;
  settleEffect?: (decision: PromptDecision) => void;
  settlePlan?: (decision: PlanDecision) => void;
};

export function createAgentPromptController(deps: AgentPromptDeps = {}): AgentPromptController {
  const timeoutMs = deps.timeoutMs ?? ASK_TIMEOUT_MS;
  const closedPanelTimeoutMs = deps.closedPanelTimeoutMs ?? CLOSED_PANEL_TIMEOUT_MS;
  /** When a question was raised (006 FR-085): the panel orders the questions it holds by this. */
  const raisedAt = (): string => new Date(deps.now?.() ?? Date.now()).toISOString();
  let pending: PendingPrompt | undefined;
  /**
   * Prompts that have been answered or have expired. The set is what makes a late answer a refusal
   * rather than an effect: without it, a promptId the panel still has on screen would look like a
   * fresh question the moment a new one was raised.
   */
  const settled = new Set<string>();

  function close(): PendingPrompt | undefined {
    const active = pending;
    if (!active) return undefined;
    pending = undefined;
    clearTimeout(active.timer);
    // Whatever ended the question ends the ticks with it: a tick for a question that is over would
    // re-arm the host's backstop on a call that has already been answered (011 R-162).
    if (active.ticker !== undefined) clearInterval(active.ticker);
    settled.add(active.id);
    return active;
  }

  /**
   * Ends the pending question. `expired` separates the question's own deadline from every other
   * route out - a stop, a link that went away, the owner's Stop - because only the first of them is
   * "nobody answered in time", which is the only ending the person's instruction belongs on (011).
   */
  function end(ending: PromptEnding, expired = false): void {
    const active = close();
    if (!active) return;
    active.end(ending, expired ? active.hint : undefined);
    deps.onChange?.();
  }

  function arm(
    raise: { kind: PromptWaitingTick["kind"]; callId: string; sessionId: string },
    build: (timer: ReturnType<typeof setTimeout>) => PendingPrompt,
  ): void {
    // Read here (R-163): the bound and the hint are facts about the moment the question was raised,
    // and a panel that opens while it stands changes neither. Only a panel going out of sight
    // revises them, and only upwards (`panelPresenceChanged`, D-011-7).
    const raisedAtMs = Date.now();
    const panelConnected = deps.panelPresence?.() ?? true;
    const boundMs = panelConnected ? timeoutMs : closedPanelTimeoutMs;
    const timer = setTimeout(() => end("timed-out", true), boundMs);
    (timer as { unref?: () => void }).unref?.();
    const active = build(timer);
    active.clock = { raise, raisedAtMs, boundMs };
    if (!panelConnected) {
      active.hint = ATTENTION_SENTENCES.consent;
      startTicks(active, 0);
    }
    pending = active;
    deps.onChange?.();
  }

  /**
   * Only while nobody can see the card (011 FR-148, review M1).
   *
   * The tick is the notice for a person who has not opened the panel their question is in, and
   * the keep-alive for the longer bound that situation buys. With a panel open neither applies:
   * the card is in front of them, the bound is the ordinary one the host already allows for, and
   * a tick would be one more frame on the link saying what the card on screen says.
   *
   * `fromMs` is how long the question has already waited: zero at a raise, and the time since the
   * raise when the panel went out of sight mid-wait - then the first tick goes at once (D-011-7),
   * because the host's own open-panel bound may be about to pass.
   */
  function startTicks(active: PendingPrompt, fromMs: number): void {
    const clock = active.clock;
    if (!deps.onWaiting || !clock) return;
    const say = (waitedMs: number): void => {
      // A tick at the bound buys nothing; the question is over in that same instant.
      if (waitedMs >= clock.boundMs) return;
      // Read at each tick: a panel back in sight still ticks (the host's keep-alive for the bound
      // already granted) but must not have the agent told to open it.
      const panelConnected = deps.panelPresence?.() ?? false;
      deps.onWaiting?.({ ...clock.raise, waitedMs, boundMs: clock.boundMs, panelConnected });
    };
    let waitedMs = fromMs;
    if (fromMs > 0) say(fromMs);
    const ticker = setInterval(() => {
      waitedMs += PROMPT_WAITING_TICK_MS;
      say(waitedMs);
    }, PROMPT_WAITING_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
    active.ticker = ticker;
  }

  return {
    current() {
      return pending?.effect;
    },
    currentPlan() {
      return pending?.plan;
    },
    currentSession() {
      return pending?.sessionId;
    },
    ask({ callId, hostCallId, sessionId, promptKind, stopped, ...prompt }) {
      // Before anything is built, and before `busy` (014 FR-179): a call that is already over is
      // not waiting for an answer, and the panel must not be given a card nobody can act on.
      if (stopped?.()) return Promise.resolve({ decision: "interrupted" as const });
      if (pending) {
        // Not queued: a queued prompt would be shown to the owner about a call that may already
        // have timed out at the host, and the agent would have no way to tell.
        return Promise.resolve({ decision: "busy" as const });
      }
      const full: AgentEffectPrompt = { promptId: newId("prompt"), ...prompt, raisedAt: raisedAt() };
      return new Promise<PromptDecision>((resolve) => {
        arm({ kind: promptKind ?? "ask", callId: hostCallId ?? callId, sessionId }, (timer) => ({
          id: full.promptId,
          callId,
          sessionId,
          effect: full,
          timer,
          end: (ending, hint) =>
            resolve(ending === "timed-out" && hint !== undefined ? { decision: ending, hint } : { decision: ending }),
          settleEffect: resolve,
        }));
      });
    },
    askPlan({ callId, hostCallId, sessionId, promptKind: _promptKind, stopped, ...plan }) {
      if (stopped?.()) return Promise.resolve({ decision: "interrupted" as const });
      if (pending) {
        return Promise.resolve({ decision: "busy" as const });
      }
      const full: AgentPlanPrompt = { planId: newId("plan"), ...plan, raisedAt: raisedAt() };
      return new Promise<PlanDecision>((resolve) => {
        // A whole batch is its own kind, whatever the caller said: the person is answering one
        // question about a sequence, and the sentence they are told is the consent one either way.
        arm({ kind: "plan", callId: hostCallId ?? callId, sessionId }, (timer) => ({
          id: full.planId,
          callId,
          sessionId,
          plan: full,
          timer,
          end: (ending, hint) =>
            resolve(ending === "timed-out" && hint !== undefined ? { decision: ending, hint } : { decision: ending }),
          settlePlan: resolve,
        }));
      });
    },
    decide(promptId, allow, rememberMode, rememberTransition, rememberDirectory) {
      if (pending?.effect?.promptId !== promptId) {
        // Either the owner answered a prompt that has already expired, or the panel is showing one
        // this worker no longer has. Nothing runs either way, and it is said out loud.
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      const settle = pending.settleEffect;
      close();
      settle?.(
        allow
          ? {
              decision: "allow",
              ...(rememberMode ? { rememberMode } : {}),
              // Only ever with a yes: "remember this pair" is part of allowing it, and a decline
              // that carried it would be the owner saying no and yes to the same move.
              ...(rememberTransition ? { rememberTransition: true } : {}),
              // The same rule for the directory card's "from now on" (014 FR-193): it is the yes
              // that widens the host's list, and a no never widens anything.
              ...(rememberDirectory ? { rememberDirectory: true } : {}),
            }
          : { decision: "deny" },
      );
      deps.onChange?.();
      return true;
    },
    decidePlan(planId, approve, excludedIndexes) {
      if (pending?.plan?.planId !== planId) {
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      const settle = pending.settlePlan;
      close();
      settle?.(
        approve ? { decision: "approve", planId, excluded: excludedIndexes ?? [] } : { decision: "deny" },
      );
      deps.onChange?.();
      return true;
    },
    cancel(callId) {
      if (callId !== undefined && !isCall(pending?.callId, callId)) return;
      end("timed-out");
    },
    cancelSession(sessionId, ending = "timed-out") {
      if (pending?.sessionId !== sessionId) return;
      end(ending);
    },
    panelPresenceChanged() {
      const active = pending;
      const clock = active?.clock;
      // Already a question nobody could see (the hint marks it), or none at all: nothing to revise.
      if (!active || !clock || active.hint !== undefined) return;
      // Coming into sight never shortens anything (R-163).
      if (deps.panelPresence?.() ?? true) return;
      const waitedMs = Math.max(0, Date.now() - clock.raisedAtMs);
      // Only ever longer, and counted from the raise, as the host counts it.
      clock.boundMs = Math.max(clock.boundMs, closedPanelTimeoutMs);
      clearTimeout(active.timer);
      active.timer = setTimeout(() => end("timed-out", true), Math.max(0, clock.boundMs - waitedMs));
      (active.timer as { unref?: () => void }).unref?.();
      active.hint = ATTENTION_SENTENCES.consent;
      startTicks(active, waitedMs);
    },
  };
}
