import type { AgentNativeRequest, AgentStopReason } from "@hallpass/contracts";

/**
 * The owner's Stop, as the calls that are watching it can read it (003/T048, FR-046, FR-048).
 *
 * Two tools outlive the round trip that started them: a batch is a sequence the worker walks, and a
 * wait is a page it keeps asking about. Both have to be endable *between* whatever they are doing,
 * and neither can be ended by settling a promise from outside without lying about what happened -
 * a batch step already delivered must still report what the page did (FR-046). So Stop is a flag
 * these two read, not an interruption done to them.
 *
 * The one subtlety is the batch's steps. A step runs under a call id derived from the batch's, so a
 * Stop naming the batch has to reach a wait running inside it - otherwise the batch would sit out
 * that wait's whole bound before noticing it had been stopped. That is the only reason the derived
 * id has a shape at all, and it is defined here beside the rule that reads it.
 */

/** Separates a batch's call id from the step's position. Never appears in a host-minted call id. */
export const STEP_SEPARATOR = "#";

/** The call id one step of a batch runs under, derived so an answer can be traced to its step. */
export function batchStepCallId(callId: string, index: number): string {
  return `${callId}${STEP_SEPARATOR}${index}`;
}

/**
 * One tool call as the worker's own dispatch passes it around (011 review H1).
 *
 * The derived step id above is a worker-internal name: the relay routes a worker frame by the call
 * id it handed out and the host's router is holding the batch, so nothing outside this worker can
 * address `<batch>#<i>`. A step therefore carries the batch's own id beside its step id, and the
 * one thing that travels back to the host under an id of its own - the "still waiting" tick - uses
 * that. It is not on the wire frame (`agentNativeRequestSchema`): the host never sends it, and a
 * field a host *could* send would be a way to name a call it is not holding.
 */
export type AgentToolRequest = AgentNativeRequest & {
  hostCallId?: string;
  /**
   * Whether the owner has already ended this call (014 FR-179, T369 review F2).
   *
   * The dispatch point's own handle, travelling the same way `hostCallId` does and for the same
   * kind of reason: it is worker-internal, no host ever sends it, and the runner that raises a
   * question is the only place that can read it at the moment it matters. A runner left running
   * after an interrupt must not put a card in front of the owner for a call already answered.
   */
  stopped?: (() => boolean) | undefined;
};

export type AgentStopHandle = {
  /** Whether Stop has reached this call. Read between steps and between polls, never once. */
  stopped(): boolean;
  /**
   * Which of the owner's two controls ended it (014 FR-180), or nothing while it is still running.
   *
   * A runner answers this word rather than a literal of its own. The two mean opposite things
   * about what is left standing - a stop hands the session's tabs back, an interrupt keeps every
   * one of them - and a runner that guessed would tell an agent the wrong one.
   */
  reason(): AgentStopReason | undefined;
  /**
   * The owner's 中斷, as something a caller can await (014 FR-179, R-185 §2).
   *
   * The flag above is read at a runner's own checkpoints, which is right for a stop: a step that
   * already reached the page must still report what the page did, so nothing settles a runner's
   * promise from outside. But an interrupt has a one-second bound and a runner may have no
   * checkpoint to reach - a `wait` between polls, a page that never answers. So the dispatcher
   * races *this* against the runner and answers for it (T355), while the runner goes on to finish
   * into nothing.
   *
   * It resolves only for an interrupt, never for a stop: FR-184 says the stop behaves exactly as
   * it did, and a race on it would change that.
   */
  interrupted(): Promise<void>;
  /** Ends the registration. A call that has answered is no longer stoppable. */
  end(): void;
};

export type AgentStopSignals = {
  /**
   * Registers a call, under the session that made it (004/T105a).
   *
   * The session is carried because a stop can now name one: with only call ids here, "stop this
   * session" had to be spelled as "stop everything in flight", which is a different sentence when
   * another agent is running a batch of its own.
   */
  begin(callId: string, sessionId: string): AgentStopHandle;
  /**
   * Stops one call and anything running inside it, or - with no call named - everything in flight,
   * which is what the owner pressing Stop means.
   */
  stop(callId?: string): void;
  /**
   * Stops every call of one session and nothing else - the mirror of the prompt controller's
   * `cancelSession`, for the same reason: one agent's session ending is not the owner's Stop.
   */
  stopSession(sessionId: string): void;
  /**
   * Ends every call one session has in flight, and ends nothing else (014 FR-179).
   *
   * The same reach as `stopSession` and a different word, because that word is the whole of the
   * difference the agent is told about: the session, its tabs, its group marking, its attachment
   * and its decisions are all still there, and the call may simply be sent again. Nothing here
   * releases anything - that is not an omission to be fixed later but the requirement.
   *
   * It answers how many calls it reached, which is what the panel needs to say "nothing was
   * running" without asking a second question (FR-178).
   */
  interruptSession(sessionId: string): { interrupted: number };
  /** How many of one session's calls are registered right now; the 中斷 control is enabled by it. */
  inFlight(sessionId: string): number;
};

export function createAgentStopSignals(): AgentStopSignals {
  /**
   * A set of registrations rather than a map keyed by call id (014/T353).
   *
   * One call is registered more than once: the dispatcher registers every call so it can race the
   * interrupt, and `wait` and `browser_batch` register their own so they can poll between steps.
   * Keyed by id, the second `begin` would evict the first and the first handle's `end()` would
   * then never remove anything - a registration that outlived its call, which is a call the owner
   * could interrupt after it had answered.
   */
  type Registration = {
    callId: string;
    sessionId: string;
    stopped: boolean;
    reason?: AgentStopReason;
    /** Created on demand: only the dispatcher awaits one, and only for calls that are raced. */
    interruption?: { promise: Promise<void>; resolve: () => void };
  };
  const live = new Set<Registration>();

  /**
   * The call an id belongs to, as anything outside this worker knows it.
   *
   * One call is registered more than once - by the dispatcher and by the runner that polls - and a
   * batch's steps run under ids derived from the batch's. Counting registrations would tell the
   * owner three things are running when the agent sent one, so both counts below are of *calls*.
   */
  const callOf = (id: string): string => {
    const separator = id.indexOf(STEP_SEPARATOR);
    return separator === -1 ? id : id.slice(0, separator);
  };

  function flag(entry: Registration, reason: AgentStopReason): void {
    // The first word wins. A stop that arrives after an interrupt has nothing left to end, and
    // rewriting the reason would change the answer a runner is already composing.
    if (entry.stopped) return;
    entry.stopped = true;
    entry.reason = reason;
    if (reason === "owner-interrupted") entry.interruption?.resolve();
  }

  return {
    begin(callId, sessionId) {
      const entry: Registration = { callId, sessionId, stopped: false };
      live.add(entry);
      return {
        stopped: () => entry.stopped,
        reason: () => entry.reason,
        interrupted: () => {
          if (entry.interruption === undefined) {
            let settle = (): void => {};
            const promise = new Promise<void>((resolve) => {
              settle = resolve;
            });
            entry.interruption = { promise, resolve: settle };
            // Asked about after the fact: the interrupt has already happened, and a promise
            // nobody will ever resolve is how a dispatcher's race stops being a race.
            if (entry.reason === "owner-interrupted") settle();
          }
          return entry.interruption.promise;
        },
        end: () => {
          live.delete(entry);
        },
      };
    },
    stop(callId) {
      for (const entry of live) {
        if (
          callId === undefined ||
          entry.callId === callId ||
          entry.callId.startsWith(`${callId}${STEP_SEPARATOR}`)
        ) {
          flag(entry, "owner-stopped");
        }
      }
    },
    stopSession(sessionId) {
      for (const entry of live) {
        if (entry.sessionId === sessionId) flag(entry, "owner-stopped");
      }
    },
    interruptSession(sessionId) {
      const interrupted = new Set<string>();
      for (const entry of live) {
        if (entry.sessionId !== sessionId || entry.stopped) continue;
        interrupted.add(callOf(entry.callId));
        flag(entry, "owner-interrupted");
      }
      return { interrupted: interrupted.size };
    },
    inFlight(sessionId) {
      const calls = new Set<string>();
      for (const entry of live) if (entry.sessionId === sessionId) calls.add(callOf(entry.callId));
      return calls.size;
    },
  };
}
