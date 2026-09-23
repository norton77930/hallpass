import { transitionNoticeText, type SiteMode } from "@hallpass/contracts";

/**
 * When a tab moving to another site is something the owner has to be told about (014 US2,
 * FR-185..FR-189, R-186).
 *
 * The whole module is one ordered table. That is not a style choice: every rule below exempts an
 * arrival that the rule under it would hold, so the order *is* the policy, and a version of this
 * written as five early returns scattered through the runtime would be a policy nobody could read
 * or test. Here it is six lines in one function, over lookups the caller injects - which is what
 * lets the gate turn rule (a) off and the owner's remembered pair turn rule (d) on without either
 * of them being a second code path.
 *
 * Identity is the origin (`scheme://host[:port]`), as `siteOfUrl` mints it and as the owner's site
 * decisions are keyed. Not the host: `https://pay.example` and `http://pay.example` are two
 * different places to be, and a decision about one is not a decision about the other.
 *
 * Nothing here knows about tabs, sessions, prompts or storage. It answers one question - does this
 * arrival owe the owner a question - and the runtime decides what to do about the answer.
 */

/** One tab's transition state, as the session knows it (data-model TabTransitionState). */
export type TabTransitionState = {
  /** Every origin this session has seen this tab on; seeded when the tab is claimed or created. */
  known: readonly string[];
  /** The origin the session last treated as current; absent for a tab that has had none yet. */
  lastKnown?: string;
  /**
   * The move the owner has not answered yet (rule f). `from` is where the tab was when the chain
   * of moves began, so a redirect through three origins still asks one question (FR-189).
   */
  pending?: { from: string; to: string; since: number };
  /** The origin a `navigate` in flight asked for; rule (e) reads it (set and cleared by the tool). */
  expectedNavigate?: string;
};

/**
 * Which rule decided, in the spec's own order. Returned rather than kept private because it is what
 * the tests pin and what a diagnostic line says: "this arrival was exempt" is not a useful fact
 * without "by which rule".
 */
export const TRANSITION_RULES = [
  "loopback",
  "known",
  "site-mode",
  "allowed-pair",
  "expected-navigate",
  "pending",
] as const;

export type TransitionRule = (typeof TRANSITION_RULES)[number];

export type TransitionLookups = {
  /** The owner's stored decision about the destination, defaulted to `ask` as the store defaults it. */
  siteMode: (origin: string) => Promise<SiteMode>;
  /**
   * Whether this ordered pair is already allowed - for this session or for good. The caller's
   * lookup is also where the persisted record's `lastUsedAt` is touched (FR-190): the touch belongs
   * to the moment the pair is *used*, which is here and nowhere else.
   */
  allowedPair: (from: string, to: string) => Promise<boolean>;
  /**
   * Whether rule (a) applies at all. False only while the gate's switch is set, which widens
   * prompting and never narrows it (contracts/transitions.md, R-186 §6).
   */
  loopbackExempt: () => Promise<boolean>;
  now?: () => number;
};

/** The state of a tab the session has just taken, on the origin it is on (or none yet). */
export function beginTransitionState(origin: string | undefined): TabTransitionState {
  return origin === undefined ? { known: [] } : { known: [origin], lastKnown: origin };
}

/**
 * The session knows this tab is on this origin, and nobody needs to be asked about it.
 *
 * Used for the seeds - a claim, a create - where the arrival is the session's own doing. A pending
 * question is left standing: a seed is not an answer to it.
 */
export function noteKnownOrigin(state: TabTransitionState, origin: string): TabTransitionState {
  return {
    ...state,
    known: state.known.includes(origin) ? state.known : [...state.known, origin],
    lastKnown: origin,
  };
}

/** The owner said 繼續 (FR-188): the question is answered and the tab is on the new origin. */
export function clearPending(state: TabTransitionState): TabTransitionState {
  if (!state.pending) return state;
  const { pending, ...rest } = state;
  return noteKnownOrigin(rest, pending.to);
}

/**
 * What `hint` may say about a move, given what it already says (FR-186, T369 review F7).
 *
 * The bound is the reason this is a function rather than two `${}` at two call sites. `hint` is
 * `z.string().max(400)` on a strict frame: a sentence one character over does not arrive
 * truncated, it makes the whole answer fail to parse and the agent is told nothing at all. Two
 * origins long enough to overflow it are unusual and perfectly legal, so the notice is what gives
 * way - never the runner's own sentence, and never the answer.
 *
 * Returns the hint to use, which is the one it was given when the notice does not fit or is
 * already in it, and `undefined` when there was neither.
 */
export const TRANSITION_HINT_MAX_CHARS = 400;

export function hintWithTransitionNotice(from: string, to: string, hint?: string): string | undefined {
  const notice = transitionNoticeText(from, to);
  if (hint?.includes(notice)) return hint;
  const composed = hint === undefined ? notice : `${hint} ${notice}`;
  return composed.length > TRANSITION_HINT_MAX_CHARS ? hint : composed;
}

/** The ordered pair, as the session set and the panel's rows spell it. */
export function transitionPair(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * The machine itself, by any of its three spellings (FR-185).
 *
 * Read off the parsed hostname rather than matched in the origin string, because `localhost` and
 * `127.0.0.1` are *prefixes* of names anybody can register: a rule written as "starts with
 * localhost" would exempt `https://localhost.attacker.test` from every question this feature asks.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  // The whole of 127.0.0.0/8, which is what a browser treats as this machine.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * One arrival, decided by the first rule that matches (data-model "Transition rules").
 *
 * The five exempting rules all end the same way - the origin becomes known and current - and only
 * rule (b) also clears a standing question, because only a return to somewhere the session has
 * already been says the move it was about is over.
 *
 * Rule (f) deliberately records *nothing* as known: leaving `lastKnown` where it was is what makes
 * a second move collapse into the same question (FR-189), and marking an unanswered destination as
 * known would answer the question by arriving at it twice.
 */
export async function applyTransition(
  state: TabTransitionState,
  to: string,
  lookups: TransitionLookups,
): Promise<{ state: TabTransitionState; rule: TransitionRule }> {
  const returning = state.known.includes(to);
  const exempt = (rule: TransitionRule): { state: TabTransitionState; rule: TransitionRule } => ({
    // Whichever rule exempted it, an arrival somewhere the session has already been ends the
    // question that was standing (FR-189): the tab is back where the owner last saw it.
    state: noteKnownOrigin(returning ? stripPending(state) : state, to),
    rule,
  });

  // A tab with no origin yet is a tab that has not moved from anywhere: its first is simply known.
  if (state.lastKnown === undefined) return exempt("known");
  if (isLoopbackOrigin(to) && (await lookups.loopbackExempt())) return exempt("loopback");
  if (returning) return exempt("known");
  if ((await lookups.siteMode(to)) !== "ask") return exempt("site-mode");
  if (await lookups.allowedPair(state.lastKnown, to)) return exempt("allowed-pair");
  if (state.expectedNavigate === to) return exempt("expected-navigate");
  return {
    rule: "pending",
    state: {
      ...state,
      pending: {
        // FR-189: where the tab was before this chain began, kept across every further move.
        from: state.pending?.from ?? state.lastKnown,
        to,
        since: state.pending?.since ?? (lookups.now?.() ?? Date.now()),
      },
    },
  };
}

function stripPending(state: TabTransitionState): TabTransitionState {
  if (!state.pending) return state;
  const { pending: _pending, ...rest } = state;
  return rest;
}
