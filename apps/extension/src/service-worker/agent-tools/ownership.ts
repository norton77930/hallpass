import type { AgentNativeResponse } from "@hallpass/contracts";
import type { TabOwnership } from "../agent-tab-manager.js";

/**
 * The one place a `TabOwnership` becomes a tool outcome, shared by every runner that names a tab
 * (004/T104, contracts README section 2).
 *
 * 003 answered all three refusals with one word, `tab-not-owned`, because a tab was either the one
 * session's or nothing to do with the agent. 004 has several sessions and the owner's own tabs, so
 * the same refusal now carries which of two facts it is - *that* session holds it, or nobody does -
 * and they lead to two different next moves: wait, or `tabs_claim`. The holder rides in `refusal`
 * beside the stable `reason`, because a refusal an agent cannot act on is one it simply repeats.
 */
export function ownershipRefusal(
  callId: string,
  ownership: Exclude<TabOwnership, { state: "this" }>,
): AgentNativeResponse {
  if (ownership.state === "gone") {
    // FR-044: the owner closed it by hand. The session had it; it does not have it now.
    return { callId, outcome: "stale", reason: "tab-gone" };
  }
  if (ownership.state === "held-by-session") {
    return {
      callId,
      outcome: "denied",
      reason: "held-by-session",
      refusal: { reason: "held-by-session", sessionId: ownership.sessionId },
    };
  }
  // Nobody holds it - the owner's own tab, or one every session has let go of. Never touched
  // (SC-024), and the agent is told the move that would change that.
  return { callId, outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } };
}

/** What a runner needs to answer "may this session touch that tab", per call (004/T103a). */
export type TabOwnershipLookup = (sessionId: string, tabId: number) => Promise<TabOwnership>;
