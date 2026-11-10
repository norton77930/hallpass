import {
  AGENT_SITE_PLAN_COVERED_TOOLS,
  CONSENT_TIMEOUT_HINT,
  type AgentEffectPrompt,
  type AgentNativeResponse,
  type AgentPlanPrompt,
  type AgentSitePlanPrompt,
  type AgentToolName,
  type PromptChoice,
  type SiteMode,
} from "@hallpass/contracts";
import { STEP_SEPARATOR } from "./stop.js";
import { shownOptional, shownText } from "../shown-text.js";

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
 * worker that stopped answering at all; this bound is the *product* decision about how long an
 * unanswered question holds a tool call, and the "still waiting" ticks keep the backstop off the
 * call for as long as it runs, so the agent is told `timed-out` in the tool contract's own words
 * rather than losing the call to a transport bound it cannot interpret.
 *
 * 031 (R-450): a question about an effect is also offered to the agent's own client (`onRaised`),
 * and the client's answer comes back by call (`decideByCall`). The first answer from either place
 * settles it; the other is late and changes nothing (D-031-4). The client can only say once,
 * session or deny (D-031-2) - never a remembered mode, pair or directory.
 *
 * A timed-out prompt is *dead*, not merely unanswered. The call has already been answered
 * `timed-out`, so an owner who presses Allow a minute later is answering a question that no longer
 * exists; running the effect then would be an effect nobody is waiting for, attached to no result.
 * The late answer is refused and logged.
 *
 * One prompt at a time per session, because the owner answers a question, not a queue: a second
 * effect arriving while one is pending is `busy`, which is a word the agent can act on.
 */

/**
 * How long every question waits for an answer (011 FR-147, 031 D-031-6, FR-473, R-453).
 *
 * Until 031 this was the bound for a card raised into a panel nobody had open, and a *visible*
 * card got 25 s. One bound now: "visible" is a panel in the focused window, not the owner's eyes on
 * it, and the owner may be reading the question in their terminal - two minutes is how long it
 * takes to read, reach Chrome or the client, and answer. The name is kept because the pairing
 * controller's closed-panel wait is the same two minutes.
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
  /**
   * 031 R-456: `session` is "allow on this site for this session" - the runner records a session
   * grant, and only for a covered page action. `answeredFrom` says where the answer was given
   * (R-458): the card (`browser`) or the agent's client (`client`). The controller always sets it;
   * it is optional only so a test's stand-in controller need not.
   */
  | {
      decision: "allow";
      rememberMode?: SiteMode;
      rememberTransition?: boolean;
      rememberDirectory?: boolean;
      session?: true;
      /**
       * 031 R-461: the diagnostics card's Always on this site - the runner sets the site's
       * diagnostics grant, as the checkbox does. Only ever on a yes to a diagnostics question, and
       * only from the card: the client has no word for it (D-031-9).
       */
      grantDiagnostics?: true;
      answeredFrom?: PromptAnswerSource;
    }
  | { decision: "deny"; answeredFrom?: PromptAnswerSource }
  /**
   * `hint` is what the agent is told to do about it (011 FR-146, 031 R-455): present whenever the
   * question expired on its own bound. The caller puts it on the `timed-out` answer beside the
   * stable `reason`; an agent that cannot read it still branches on the reason exactly as before.
   */
  | { decision: "timed-out"; hint?: string }
  | { decision: "stopped" }
  | { decision: "released" }
  /** 014 FR-179: the owner ended the step this question belonged to; nothing was decided. */
  | { decision: "interrupted" };

/** Where an answer was given (031 R-458): the side-panel card, or the agent's own client. */
export type PromptAnswerSource = "client" | "browser";

/**
 * A question offered to the agent's client as well as to the card (031 R-450, contracts
 * terminal-consent.md `prompt-raised`). The runtime addresses it to the session's host.
 *
 * `callId` is the call the *host* knows (a batch step's question names its batch), which is the id
 * the client's answer comes back with; `promptId` is the card's own id, which the answer must echo,
 * because a batch's questions all share that call (T929 I1). `choices` offers `session` only for a
 * covered page action on a known site (R-457, 030 FR-458); `action` is the worker's own summary,
 * never page text.
 *
 * 032 R-484, R-485: a tab that moved (`transition`, with `from`; `site` is where it went) and a site
 * plan (`site-plan`, with `sites`; `site` is the first) are raised too, offering `session` and `deny`.
 */
export type PromptRaised = {
  promptId: string;
  callId: string;
  sessionId: string;
  /** 031 R-460: `diagnostics` for the diagnostics grant's own question, `effect` for a plain one. */
  kind: "effect" | "diagnostics" | "transition" | "site-plan";
  site: string;
  /** 032: the site a moved tab came from; only for `transition`. */
  from?: string;
  /** 032: every site the plan proposes, in its order; only for `site-plan`. */
  sites?: string[];
  action: string;
  choices: PromptChoice[];
  boundMs: number;
};

/** The question left `pending` (contracts `prompt-settled`); `none` for every ending that is not an answer. */
export type PromptSettled = {
  promptId: string;
  callId: string;
  sessionId: string;
  answeredFrom: PromptAnswerSource | "none";
};

/**
 * A question that ended by an answer or by its own timeout (032 R-488), for the session card's
 * activity line. Never reported for a stop, an interrupt, a release, a session ending or a question
 * refused as busy: those have their own line or end the session.
 *
 * `site` is the one the question decided: a frame's own when the frame decides, where a tab went for
 * a transition, the first proposed site for a site plan. `channel` is `none` only for a timeout.
 */
export type PromptConclusion = {
  sessionId: string;
  question: "effect" | "diagnostics" | "transition" | "site-plan" | "plan" | "upload-directory" | "dialog";
  site: string;
  channel: PromptAnswerSource | "none";
  answer: "once" | "session" | "always" | "deny" | "timed-out";
};

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
 * The owner's answer to a session site plan (017 R-247, FR-252).
 *
 * `approved` is never wider than the proposal and never empty; `leftOut` is the rest of the
 * proposal, both in the proposal's own order. Every ending that is not the owner's press grants
 * nothing - the same endings the other two kinds have.
 */
export type SitePlanDecision =
  | { decision: "approve"; approved: string[]; leftOut: string[] }
  | { decision: "declined" }
  | { decision: "timed-out"; hint?: string }
  | { decision: "stopped" }
  | { decision: "released" }
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
  /** 017: the site-plan proposal the panel should be showing, if any. */
  currentSitePlan(): AgentSitePlanPrompt | undefined;
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
  /**
   * The panel's answer. Returns whether it settled a prompt that was still alive. `session` is the
   * card's "this session" (031 R-456), carried only with a yes. `grantDiagnostics` is the diagnostics
   * card's "always on this site" (R-461), carried only with a yes to a diagnostics question.
   */
  decide(
    promptId: string,
    allow: boolean,
    rememberMode?: SiteMode,
    rememberTransition?: boolean,
    rememberDirectory?: boolean,
    session?: boolean,
    grantDiagnostics?: boolean,
  ): boolean;
  /**
   * 031 R-450: an answer given in the agent's client, by the call and the question the host was told
   * about in `onRaised`. Settles only the question that is open under `promptId`, offered to the
   * client for that call, and - when `sessionId` is given - raised by that session; `choice` must be
   * one the question offered. A question already settled, or an earlier question of the same call
   * (a batch's steps share the host's call id, T929 I1), is a late answer: logged, and nothing
   * changes. Returns whether it settled the question.
   */
  decideByCall(
    callId: string,
    promptId: string,
    choice: PromptChoice,
    from: PromptAnswerSource,
    sessionId?: string,
  ): boolean;
  /** The panel's answer to a plan. Returns whether it settled a plan that was still alive. */
  decidePlan(planId: string, approve: boolean, excludedIndexes?: readonly number[]): boolean;
  /**
   * 017 R-247: one question about the sites a session asks to work across. `alreadyApproved` is the
   * session's active plan, carried so a replacing proposal can mark it (FR-260); the caller reads it.
   */
  askSitePlan(
    proposal: Omit<AgentSitePlanPrompt, "proposalId" | "raisedAt"> & PromptOwner,
  ): Promise<SitePlanDecision | { decision: "busy" }>;
  /**
   * The panel's answer to a site plan (017 FR-252, FR-253). An approval must name at least one
   * origin and only origins of the proposal - the panel can narrow it, never widen it; anything else
   * settles nothing, leaves the question up and is reported. `origins` is ignored on a decline.
   */
  decideSitePlan(proposalId: string, approve: boolean, origins: readonly string[]): boolean;
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
   * The panel's visibility may have changed (011 D-011-7). Since 031 every question already runs on
   * the one bound and ticks from its raise (R-453), and each tick reads the presence it reports, so
   * there is nothing left to revise; kept so the runtime's presence wiring needs no special case.
   */
  panelPresenceChanged(): void;
};

export type AgentPromptDeps = {
  onChange?: () => void;
  reportDiagnostic?: (code: string) => void;
  /** Overrides the one bound every question waits (`CLOSED_PANEL_TIMEOUT_MS`), for tests. */
  timeoutMs?: number;
  /** The same lever under its pre-031 name, kept for the suites that still say it. */
  closedPanelTimeoutMs?: number;
  now?: () => number;
  /**
   * Whether the owner can see a panel (011 R-163): a connected panel in the last-focused window -
   * the runtime hands in the panel port's `isVisible`. Since 031 it changes neither the bound nor
   * whether the ticks run; each tick carries it, and it picks the sentence the host relays.
   * Absent means "assume somebody is looking".
   */
  panelPresence?: () => boolean;
  /**
   * Called every `PROMPT_WAITING_TICK_MS` while a question stands, from its raise (011 FR-148,
   * 031 R-453). The runtime turns it into the link frame the host reads as a keep-alive and the
   * server reads as the person's progress message.
   */
  onWaiting?: (tick: PromptWaitingTick) => void;
  /**
   * 031 R-450: a question about an effect was raised, and may be asked in the agent's client too.
   * Called once per such question, after the card is up. Since 032 (R-484) a transition and a site
   * plan are offered too; a directory and a batch plan never are (FR-487).
   */
  onRaised?: (question: PromptRaised) => void;
  /** 031: a question `onRaised` announced left `pending`, for whatever reason. Called exactly once. */
  onSettled?: (settlement: PromptSettled) => void;
  /**
   * 032 R-488: a question ended by an answer or by its own timeout, once, for any kind of question
   * (an upload directory and a batch plan included). The runtime turns it into an activity line.
   */
  onConcluded?: (conclusion: PromptConclusion) => void;
};

/**
 * The answer to a call whose question nobody answered in time (FR-043), with the person's
 * instruction attached when there is one (011 FR-146).
 *
 * One helper for all six tools that can raise a question, because the shape is the claim: the
 * agent branches on `reason`, which does not move, and `hint` is beside it - since 031 on every
 * expiry (R-455), because a visible panel is no evidence that anybody saw the card.
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

/**
 * What an effect question's decision is called on an activity line (032 R-488). `always` is anything
 * remembered beyond this session - a mode, a transition pair, a directory, the diagnostics grant; a
 * transition's yes is already session-bounded, so it reads as `session` unless the pair is remembered.
 */
function effectAnswer(decision: PromptDecision, kind: AgentEffectPrompt["kind"]): PromptConclusion["answer"] {
  if (decision.decision !== "allow") return "deny";
  if (
    decision.rememberMode !== undefined ||
    decision.rememberTransition === true ||
    decision.rememberDirectory === true ||
    decision.grantDiagnostics === true
  ) {
    return "always";
  }
  return decision.session === true || kind === "transition" ? "session" : "once";
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
  sitePlan?: AgentSitePlanPrompt;
  timer: ReturnType<typeof setTimeout>;
  /** The five-second "still waiting", running for exactly as long as this question does (011). */
  ticker?: ReturnType<typeof setInterval>;
  /** What the ticks need: the raise's addressing and the bound it runs under. */
  clock?: { raise: { kind: PromptWaitingTick["kind"]; callId: string; sessionId: string }; boundMs: number };
  /**
   * 031 R-450: present when this question was offered to the agent's client - the host's call id
   * it was offered under and the choices it offered. Absent, nothing the client says can settle it.
   */
  terminal?: { callId: string; choices: readonly PromptChoice[] };
  end: (ending: PromptEnding, hint?: string) => void;
  settleEffect?: (decision: PromptDecision) => void;
  settlePlan?: (decision: PlanDecision) => void;
  settleSitePlan?: (decision: SitePlanDecision) => void;
};

/**
 * The owner's own files (`upload-directory`) are not offered to the agent's client (031 R-450,
 * 032 FR-487): the decision is about a directory on the owner's disk, and its answer remembers
 * something the client must never be able to remember (D-031-2). A plain effect, a dialog's OK, a
 * forced leave and the diagnostics grant are; since 032 (R-484) so is a tab that moved, with only
 * the card's session-bounded Continue and a deny.
 */
const CLIENT_ASKABLE_KINDS: ReadonlyArray<AgentEffectPrompt["kind"]> = [
  undefined,
  "dialog-accept",
  "beforeunload-force",
  // 031 R-460, D-031-9: the diagnostics grant's question, with its own three short answers.
  "diagnostics",
  "transition",
];

/** 032 D-032-1: a site change and a site plan offer only "for this session" and "deny". */
const SESSION_OR_DENY: readonly PromptChoice[] = ["session", "deny"];

/**
 * What the client may answer (031 R-457, D-031-8): `session` only for a page action a session grant
 * can cover, on a site that is known - a frame whose site could not be established has nothing to
 * hold a grant for (030 FR-458). Everything else is once or deny.
 */
function clientChoicesFor(
  tool: AgentToolName,
  frame: AgentEffectPrompt["frame"],
  kind: AgentEffectPrompt["kind"],
): PromptChoice[] {
  // 032 FR-485: the transition card has no "once"; its Continue is already session-bounded.
  if (kind === "transition") return [...SESSION_OR_DENY];
  // D-031-9: a diagnostics question is about debugging access to one known site, which a session
  // grant of its own kind can hold - whichever of the three tools asked it.
  if (kind === "diagnostics") return ["once", "session", "deny"];
  const covered = (AGENT_SITE_PLAN_COVERED_TOOLS as readonly AgentToolName[]).includes(tool);
  return covered && !(frame !== undefined && "unknown" in frame) ? ["once", "session", "deny"] : ["once", "deny"];
}

/** The action as the client's form says it: the worker's own summary, bounded by the frame (≤ 200). */
function clientAction(prompt: AgentEffectPrompt): string {
  const summary = prompt.argsSummary.trim();
  return (summary.length > 0 ? summary : prompt.tool).slice(0, 200);
}

export function createAgentPromptController(deps: AgentPromptDeps = {}): AgentPromptController {
  const boundMs = deps.timeoutMs ?? deps.closedPanelTimeoutMs ?? CLOSED_PANEL_TIMEOUT_MS;
  /** When a question was raised (006 FR-085): the panel orders the questions it holds by this. */
  const raisedAt = (): string => new Date(deps.now?.() ?? Date.now()).toISOString();
  let pending: PendingPrompt | undefined;
  /**
   * Prompts that have been answered or have expired. The set is what makes a late answer a refusal
   * rather than an effect: without it, a promptId the panel still has on screen would look like a
   * fresh question the moment a new one was raised.
   */
  const settled = new Set<string>();

  /** 031: the host is told once that a question it was offered is over, however it ended. */
  function announceSettled(active: PendingPrompt, answeredFrom: PromptSettled["answeredFrom"]): void {
    if (active.terminal === undefined) return;
    deps.onSettled?.({ promptId: active.id, callId: active.terminal.callId, sessionId: active.sessionId, answeredFrom });
  }

  /**
   * 032 R-488: reports how a question that was answered, or ran out its own bound, ended. Called
   * beside `close` by exactly those routes - the endings that are not answers never come here.
   */
  function conclude(active: PendingPrompt, channel: PromptConclusion["channel"], answer: PromptConclusion["answer"]): void {
    if (!deps.onConcluded) return;
    const effect = active.effect;
    let question: PromptConclusion["question"];
    let site: string;
    if (effect !== undefined) {
      question =
        effect.kind === undefined
          ? "effect"
          : effect.kind === "dialog-accept" || effect.kind === "beforeunload-force"
            ? "dialog"
            : effect.kind;
      site =
        effect.kind === "transition" && effect.transition !== undefined
          ? effect.transition.to
          : effect.frame !== undefined && "site" in effect.frame
            ? effect.frame.site
            : effect.site;
    } else if (active.plan !== undefined) {
      question = "plan";
      site = active.plan.site;
    } else if (active.sitePlan !== undefined) {
      question = "site-plan";
      site = active.sitePlan.origins[0] ?? "";
    } else {
      return;
    }
    deps.onConcluded({ sessionId: active.sessionId, question, site, channel, answer });
  }

  function close(answeredFrom: PromptSettled["answeredFrom"]): PendingPrompt | undefined {
    const active = pending;
    if (!active) return undefined;
    pending = undefined;
    clearTimeout(active.timer);
    // Whatever ended the question ends the ticks with it: a tick for a question that is over would
    // re-arm the host's backstop on a call that has already been answered (011 R-162).
    if (active.ticker !== undefined) clearInterval(active.ticker);
    settled.add(active.id);
    announceSettled(active, answeredFrom);
    return active;
  }

  /**
   * Ends the pending question. `expired` separates the question's own deadline from every other
   * route out - a stop, a link that went away, the owner's Stop - because only the first of them is
   * "nobody answered in time", which is the only ending the agent's instruction belongs on (011,
   * 031 R-455: on every expiry, panel or not).
   */
  function end(ending: PromptEnding, expired = false): void {
    const active = close("none");
    if (!active) return;
    // Only the question's own deadline is "nobody answered"; a stop, release or cancel is not (R-488).
    if (expired) conclude(active, "none", "timed-out");
    active.end(ending, expired ? CONSENT_TIMEOUT_HINT : undefined);
    deps.onChange?.();
  }

  function arm(
    raise: { kind: PromptWaitingTick["kind"]; callId: string; sessionId: string },
    build: (timer: ReturnType<typeof setTimeout>) => PendingPrompt,
  ): PendingPrompt {
    // 031 R-453: one bound and ticks from the raise, whoever can see the card.
    const timer = setTimeout(() => end("timed-out", true), boundMs);
    (timer as { unref?: () => void }).unref?.();
    const active = build(timer);
    active.clock = { raise, boundMs };
    pending = active;
    startTicks(active);
    deps.onChange?.();
    return active;
  }

  /**
   * For as long as the question stands (011 FR-148, 031 R-453).
   *
   * The tick is two things: the keep-alive the host's per-call backstop reads, which every
   * question needs now that every question waits two minutes, and the carrier of the sentence the
   * person is told - which `panelConnected`, read at each tick, picks.
   */
  function startTicks(active: PendingPrompt): void {
    const clock = active.clock;
    if (!deps.onWaiting || !clock) return;
    const say = (waitedMs: number): void => {
      // A tick at the bound buys nothing; the question is over in that same instant.
      if (waitedMs >= clock.boundMs) return;
      const panelConnected = deps.panelPresence?.() ?? true;
      deps.onWaiting?.({ ...clock.raise, waitedMs, boundMs: clock.boundMs, panelConnected });
    };
    let waitedMs = 0;
    const ticker = setInterval(() => {
      waitedMs += PROMPT_WAITING_TICK_MS;
      say(waitedMs);
    }, PROMPT_WAITING_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
    active.ticker = ticker;
    // 032 R-486: and once at once, having waited nothing. The host reads `now - waitedMs` as when
    // this question was shown, which is the only word it gets about one only Chrome shows, and there
    // is no five-second gap in which its backstop could fire first.
    say(0);
  }

  return {
    current() {
      return pending?.effect;
    },
    currentPlan() {
      return pending?.plan;
    },
    currentSitePlan() {
      return pending?.sitePlan;
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
      // S27: what the page or the agent wrote, with the characters that would restyle the card's own
      // sentence (bidi overrides, format and control characters) removed before the panel sees it.
      const full: AgentEffectPrompt = {
        promptId: newId("prompt"),
        ...prompt,
        argsSummary: shownText(prompt.argsSummary),
        ...(prompt.targetLabel === undefined ? {} : { targetLabel: shownOptional(prompt.targetLabel) ?? "" }),
        ...(prompt.dialogText === undefined ? {} : { dialogText: shownOptional(prompt.dialogText) ?? "" }),
        raisedAt: raisedAt(),
      };
      // 031 R-450: the call the host knows, which is what the client's answer comes back by.
      const routableCallId = hostCallId ?? callId;
      // A transition the card cannot name both ends of is not one the client can be asked about.
      const askable =
        CLIENT_ASKABLE_KINDS.includes(full.kind) && (full.kind !== "transition" || full.transition !== undefined);
      const terminal = askable
        ? { callId: routableCallId, choices: clientChoicesFor(full.tool, full.frame, full.kind) }
        : undefined;
      return new Promise<PromptDecision>((resolve) => {
        const active = arm({ kind: promptKind ?? "ask", callId: routableCallId, sessionId }, (timer) => ({
          id: full.promptId,
          callId,
          sessionId,
          effect: full,
          timer,
          ...(terminal === undefined ? {} : { terminal }),
          end: (ending, hint) =>
            resolve(ending === "timed-out" && hint !== undefined ? { decision: ending, hint } : { decision: ending }),
          settleEffect: resolve,
        }));
        // After the card is up, so an answer given synchronously by whoever hears this finds it.
        if (terminal !== undefined) {
          const base = {
            promptId: active.id,
            callId: terminal.callId,
            sessionId,
            action: clientAction(full),
            choices: [...terminal.choices],
            boundMs,
          };
          deps.onRaised?.(
            full.kind === "transition" && full.transition !== undefined
              ? // 032 R-485: both ends of the move; the card is about the destination.
                { ...base, kind: "transition", site: full.transition.to, from: full.transition.from }
              : {
                  ...base,
                  kind: full.kind === "diagnostics" ? "diagnostics" : "effect",
                  // The site the card decides: a frame's own when the frame decides (030 R-445).
                  site: full.frame !== undefined && "site" in full.frame ? full.frame.site : full.site,
                },
          );
        }
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
    askSitePlan({ callId, hostCallId, sessionId, promptKind: _promptKind, stopped, alreadyApproved, ...proposal }) {
      if (stopped?.()) return Promise.resolve({ decision: "interrupted" as const });
      if (pending) {
        return Promise.resolve({ decision: "busy" as const });
      }
      const full: AgentSitePlanPrompt = {
        proposalId: newId("site-plan"),
        sessionId,
        ...proposal,
        // An empty active plan marks nothing; the field is left out rather than sent empty.
        ...(alreadyApproved === undefined || alreadyApproved.length === 0 ? {} : { alreadyApproved }),
        raisedAt: raisedAt(),
      };
      // 032 R-484: asked in the client too, under the call the host knows, with "allow these sites
      // for this session" and "deny" only - narrowing the list stays the card's (FR-486).
      const terminal = { callId: hostCallId ?? callId, choices: [...SESSION_OR_DENY] };
      return new Promise<SitePlanDecision>((resolve) => {
        // Ticked as `plan`: a site plan is one answer about a whole piece of work, like a batch's,
        // and the host's prompt-waiting enum has no other word for it (contracts AgentPromptKind).
        const active = arm({ kind: "plan", callId: terminal.callId, sessionId }, (timer) => ({
          id: full.proposalId,
          callId,
          sessionId,
          sitePlan: full,
          timer,
          terminal,
          end: (ending, hint) =>
            resolve(ending === "timed-out" && hint !== undefined ? { decision: ending, hint } : { decision: ending }),
          settleSitePlan: resolve,
        }));
        // The agent's own words, cleaned as a card's summary is (S27), and bounded by the frame.
        const purpose = shownText(full.purpose).trim();
        deps.onRaised?.({
          promptId: active.id,
          callId: terminal.callId,
          sessionId,
          kind: "site-plan",
          site: full.origins[0] ?? "",
          sites: [...full.origins],
          action: (purpose.length > 0 ? purpose : "propose_sites").slice(0, 200),
          choices: [...terminal.choices],
          boundMs,
        });
      });
    },
    decide(promptId, allow, rememberMode, rememberTransition, rememberDirectory, session, grantDiagnostics) {
      if (pending?.effect?.promptId !== promptId) {
        // Either the owner answered a prompt that has already expired, or the panel is showing one
        // this worker no longer has. Nothing runs either way, and it is said out loud.
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      const settle = pending.settleEffect;
      /**
       * 031 R-461: each card remembers its own thing. A diagnostics question's yes may carry the
       * site's diagnostics grant and nothing another card remembers - a mode, a pair, a directory -
       * and no other question's yes may carry the grant. A flag meant for a different card is
       * dropped and said, and the answer stands as the plain yes it otherwise is.
       */
      const diagnosticsQuestion = pending.effect.kind === "diagnostics";
      if (
        allow &&
        (diagnosticsQuestion
          ? rememberMode !== undefined || rememberTransition === true || rememberDirectory === true
          : grantDiagnostics === true)
      ) {
        deps.reportDiagnostic?.("agent.prompt.flag-not-offered");
      }
      const decision: PromptDecision = allow
        ? {
            decision: "allow",
            ...(rememberMode && !diagnosticsQuestion ? { rememberMode } : {}),
            // Only ever with a yes: "remember this pair" is part of allowing it, and a decline
            // that carried it would be the owner saying no and yes to the same move.
            ...(rememberTransition && !diagnosticsQuestion ? { rememberTransition: true } : {}),
            // The same rule for the directory card's "from now on" (014 FR-193): it is the yes
            // that widens the host's list, and a no never widens anything.
            ...(rememberDirectory && !diagnosticsQuestion ? { rememberDirectory: true } : {}),
            ...(grantDiagnostics === true && diagnosticsQuestion ? { grantDiagnostics: true as const } : {}),
            // 031 R-456: and for "this session". Whether it may become a grant is the runner's
            // call - only a covered page action on a known site can hold one.
            ...(session ? { session: true as const } : {}),
            answeredFrom: "browser" as const,
          }
        : { decision: "deny", answeredFrom: "browser" };
      const active = close("browser");
      if (active !== undefined) conclude(active, "browser", effectAnswer(decision, active.effect?.kind));
      settle?.(decision);
      deps.onChange?.();
      return true;
    },
    decideByCall(callId, promptId, choice, from, sessionId) {
      const active = pending;
      const terminal = active?.terminal;
      if (
        (active?.effect === undefined && active?.sitePlan === undefined) ||
        terminal === undefined ||
        terminal.callId !== callId ||
        active.id !== promptId
      ) {
        // Settled already (the card answered first, it expired, it was withdrawn), a question the
        // client was never offered, or an earlier question of this call - a batch step's answer that
        // lost the race to the card and arrived after the next step's question was raised (T929 I1):
        // the same late answer the card's own gets (D-M3-1).
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      if (sessionId !== undefined && active.sessionId !== sessionId) {
        // Another session's host naming this call: never its question to answer.
        deps.reportDiagnostic?.("agent.prompt.other-session");
        return false;
      }
      if (!terminal.choices.includes(choice)) {
        // contracts/terminal-consent.md: a choice the question did not offer is ignored, and the
        // card keeps waiting. A `session` for page JavaScript is never read as a grant (R-457).
        deps.reportDiagnostic?.("agent.prompt.choice-not-offered");
        return false;
      }
      const proposal = active.sitePlan;
      if (proposal !== undefined) {
        // 032 FR-486: the client's yes approves exactly what the card's yes to the whole list does -
        // every proposed site, for this session; narrowing it is the card's alone.
        const settlePlan = active.settleSitePlan;
        close(from);
        conclude(active, from, choice === "session" ? "session" : "deny");
        settlePlan?.(
          choice === "session"
            ? { decision: "approve", approved: [...proposal.origins], leftOut: [] }
            : { decision: "declined" },
        );
        deps.onChange?.();
        return true;
      }
      const settle = active.settleEffect;
      // 032 FR-485: a transition's `session` is the card's Continue - a plain yes, which the
      // runtime records for this from-to pair and this session only. No session flag, no pair
      // remembered.
      const transition = active.effect?.kind === "transition";
      close(from);
      // D-031-2: the client's answers are the short-lived three, and nothing here can carry a
      // mode, a remembered pair or a remembered directory - those are given in Chrome only.
      const decision: PromptDecision =
        choice === "deny"
          ? { decision: "deny", answeredFrom: from }
          : {
              decision: "allow",
              ...(choice === "session" && !transition ? { session: true as const } : {}),
              answeredFrom: from,
            };
      conclude(active, from, effectAnswer(decision, active.effect?.kind));
      settle?.(decision);
      deps.onChange?.();
      return true;
    },
    decidePlan(planId, approve, excludedIndexes) {
      if (pending?.plan?.planId !== planId) {
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      const settle = pending.settlePlan;
      const active = close("browser");
      if (active !== undefined) conclude(active, "browser", approve ? "once" : "deny");
      settle?.(
        approve ? { decision: "approve", planId, excluded: excludedIndexes ?? [] } : { decision: "deny" },
      );
      deps.onChange?.();
      return true;
    },
    decideSitePlan(proposalId, approve, origins) {
      const proposal = pending?.sitePlan;
      if (proposal?.proposalId !== proposalId) {
        deps.reportDiagnostic?.("agent.prompt.late-answer");
        return false;
      }
      let decision: SitePlanDecision = { decision: "declined" };
      if (approve) {
        /**
         * FR-253: the panel narrows the agent's list and never adds to it. An answer that names a
         * site the owner was not shown, or approves nothing, is not an answer to this card: it is
         * refused, the card stays where the owner can answer it, and the refusal is said.
         */
        const chosen = new Set(origins);
        const outside = [...chosen].some((origin) => !proposal.origins.includes(origin));
        if (outside || chosen.size === 0) {
          deps.reportDiagnostic?.("agent.site-plan.outside-proposal");
          return false;
        }
        decision = {
          decision: "approve",
          approved: proposal.origins.filter((origin) => chosen.has(origin)),
          leftOut: proposal.origins.filter((origin) => !chosen.has(origin)),
        };
      }
      const settle = pending?.settleSitePlan;
      const active = close("browser");
      if (active !== undefined) conclude(active, "browser", approve ? "session" : "deny");
      settle?.(decision);
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
      // 031 R-453: nothing to revise - every question already has the one bound and its ticks, and
      // each tick reads the presence it reports. A panel going out of sight (D-011-7) or coming
      // back into it (R-163) changes only what the next tick says.
    },
  };
}
