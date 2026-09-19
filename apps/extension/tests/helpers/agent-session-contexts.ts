import {
  createAgentSessionContext,
  type AgentSessionContext,
  type AgentSessionContexts,
} from "../../src/service-worker/agent-tools/context.js";

/**
 * The worker's per-session bindings as a test double (004/T103a).
 *
 * One context per session id, minted on first sight, exactly as the runtime keeps them - so a
 * runner under test reaches a binding only through the id the call it is answering carries.
 */
export function testSessionContexts(): AgentSessionContexts {
  const bySession = new Map<string, AgentSessionContext>();
  return {
    forCall(sessionId, callId) {
      let session = bySession.get(sessionId);
      if (!session) {
        session = createAgentSessionContext(sessionId);
        bySession.set(sessionId, session);
      }
      return session.forCall(callId);
    },
  };
}
