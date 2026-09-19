import type { AgentEffectPrompt, AgentPlanPrompt, SiteMode } from "@hallpass/contracts";

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
 * The two ways the owner can end a question from the session card without answering it (006
 * FR-087). Neither is "nobody answered": Stop ends the session and the parked call with it, and
 * Release takes back the tab the question was about, so the call is refused as any unheld tab is.
 */
export type PromptEnding = "timed-out" | "stopped" | "released";

/** Spelt out per ending rather than as `{ decision: PromptEnding }`, so a consumer's checks narrow. */
export type PromptDecision =
  | { decision: "allow"; rememberMode?: SiteMode }
  | { decision: "deny" }
  | { decision: "timed-out" }
  | { decision: "stopped" }
  | { decision: "released" };

export type PlanDecision =
  /** The owner's yes, minus any steps they struck out (US5, the batch approval). */
  | { decision: "approve"; planId: string; excluded: readonly number[] }
  | { decision: "deny" }
  | { decision: "timed-out" }
  | { decision: "stopped" }
  | { decision: "released" };

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
   * The session that raised it (004/T103a). A question outlives the call frame that asked it, so
   * when a session ends this is the only thing that tells its own questions from another agent's.
   */
  sessionId: string;
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
  decide(promptId: string, allow: boolean, rememberMode?: SiteMode): boolean;
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
};

export type AgentPromptDeps = {
  onChange?: () => void;
  reportDiagnostic?: (code: string) => void;
  timeoutMs?: number;
  now?: () => number;
};

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
  end: (ending: PromptEnding) => void;
  settleEffect?: (decision: PromptDecision) => void;
  settlePlan?: (decision: PlanDecision) => void;
};

export function createAgentPromptController(deps: AgentPromptDeps = {}): AgentPromptController {
  const timeoutMs = deps.timeoutMs ?? ASK_TIMEOUT_MS;
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
    settled.add(active.id);
    return active;
  }

  function end(ending: PromptEnding): void {
    const active = close();
    if (!active) return;
    active.end(ending);
    deps.onChange?.();
  }

  function arm(build: (timer: ReturnType<typeof setTimeout>) => PendingPrompt): void {
    const timer = setTimeout(() => end("timed-out"), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    pending = build(timer);
    deps.onChange?.();
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
    ask({ callId, sessionId, ...prompt }) {
      if (pending) {
        // Not queued: a queued prompt would be shown to the owner about a call that may already
        // have timed out at the host, and the agent would have no way to tell.
        return Promise.resolve({ decision: "busy" as const });
      }
      const full: AgentEffectPrompt = { promptId: newId("prompt"), ...prompt, raisedAt: raisedAt() };
      return new Promise<PromptDecision>((resolve) => {
        arm((timer) => ({
          id: full.promptId,
          callId,
          sessionId,
          effect: full,
          timer,
          end: (ending) => resolve({ decision: ending }),
          settleEffect: resolve,
        }));
      });
    },
    askPlan({ callId, sessionId, ...plan }) {
      if (pending) {
        return Promise.resolve({ decision: "busy" as const });
      }
      const full: AgentPlanPrompt = { planId: newId("plan"), ...plan, raisedAt: raisedAt() };
      return new Promise<PlanDecision>((resolve) => {
        arm((timer) => ({
          id: full.planId,
          callId,
          sessionId,
          plan: full,
          timer,
          end: (ending) => resolve({ decision: ending }),
          settlePlan: resolve,
        }));
      });
    },
    decide(promptId, allow, rememberMode) {
      if (pending?.effect?.promptId !== promptId) {
        // Either the owner answered a prompt that has already expired, or the panel is showing one
        // this worker no longer has. Nothing runs either way, and it is said out loud.
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      const settle = pending.settleEffect;
      close();
      settle?.(allow ? { decision: "allow", ...(rememberMode ? { rememberMode } : {}) } : { decision: "deny" });
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
      if (callId !== undefined && pending?.callId !== callId) return;
      end("timed-out");
    },
    cancelSession(sessionId, ending = "timed-out") {
      if (pending?.sessionId !== sessionId) return;
      end(ending);
    },
  };
}
