import { mintChannelNonce } from "../content-broker.js";

/**
 * The one owner of the remote-shaped identifiers the agent path has to fabricate (003 D-M3-2).
 *
 * The shared content runtime was built for a caller that has a task, an operation and a granted
 * page read behind every frame. The local agent has none of those: it has an owner who set a mode
 * for a site, and that is the *whole* of its authority. So four values are made up here, and only
 * here, so that a reader can see all four at once and see that none of them is a permission:
 *
 * - `taskId` is the session. There is no task; the session is the longest-lived thing the agent has.
 * - `operationId` is the call id. One call is one operation, which is exactly true.
 * - `nonce` is one channel nonce per session, which is what binds this worker's conversation with a
 *   document (a frame from any other binding does not match it).
 * - `generalPageReadGrantId` is a *synthetic* value the runtime requires in a payload field. It
 *   grants nothing. The consent that lets the agent read or act on a page is the site's mode, and
 *   it is checked in the gate before anything reaches here.
 *
 * These are a **binding**, not consent. Nothing outside this module may invent one: a second place
 * that fabricated a grant id would be a second place a reader has to check before believing that
 * the site mode is the only thing deciding.
 */

export type AgentToolContext = {
  /** The agent session (`taskId` on the wire). */
  sessionId: string;
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  generalPageReadGrantId: string;
};

export type AgentSessionContext = {
  sessionId: string;
  /** The per-call view of the session, with the call's own operation id. */
  forCall(callId: string): AgentToolContext;
};

/**
 * Every live session's binding, read by the id the call carries (004/T103a).
 *
 * The runners used to be handed one `AgentSessionContext` that a single mutable variable pointed at
 * the calling session. That is right only while calls are sequential: a runner that reads it *after*
 * an await gets whichever session's frame arrived in the meantime, and binds its page with another
 * session's channel nonce, runtime epoch and grant id. So the session travels with the call instead,
 * and this is the only way a runner can reach a binding at all.
 */
export type AgentSessionContexts = {
  forCall(sessionId: string, callId: string): AgentToolContext;
};

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createAgentSessionContext(sessionId: string): AgentSessionContext {
  // One nonce and one epoch for the life of the session: every frame of this conversation repeats
  // them, which is what lets the content runtime recognise a later frame as belonging to the same
  // binding rather than to a replay of an earlier one.
  const nonce = mintChannelNonce();
  const runtimeEpochId = `agent-${randomHex(8)}`;
  const generalPageReadGrantId = `agent-session-${randomHex(8)}`;
  return {
    sessionId,
    forCall(callId: string): AgentToolContext {
      return {
        sessionId,
        taskId: sessionId,
        operationId: callId,
        runtimeEpochId,
        nonce,
        generalPageReadGrantId,
      };
    },
  };
}
