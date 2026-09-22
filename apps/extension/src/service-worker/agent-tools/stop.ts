import type { AgentNativeRequest } from "@hallpass/contracts";

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
export type AgentToolRequest = AgentNativeRequest & { hostCallId?: string };

export type AgentStopHandle = {
  /** Whether Stop has reached this call. Read between steps and between polls, never once. */
  stopped(): boolean;
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
};

export function createAgentStopSignals(): AgentStopSignals {
  const live = new Map<string, { stopped: boolean; sessionId: string }>();

  return {
    begin(callId, sessionId) {
      const entry = { stopped: false, sessionId };
      live.set(callId, entry);
      return {
        stopped: () => entry.stopped,
        end: () => {
          if (live.get(callId) === entry) live.delete(callId);
        },
      };
    },
    stop(callId) {
      for (const [id, entry] of live) {
        if (callId === undefined || id === callId || id.startsWith(`${callId}${STEP_SEPARATOR}`)) {
          entry.stopped = true;
        }
      }
    },
    stopSession(sessionId) {
      for (const entry of live.values()) {
        if (entry.sessionId === sessionId) entry.stopped = true;
      }
    },
  };
}
