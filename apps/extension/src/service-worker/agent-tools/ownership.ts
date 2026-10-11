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
  return {
    callId,
    outcome: "denied",
    reason: "not-yours",
    refusal: { reason: "not-yours" },
    // The owner moved it out of the session's group just now (004 change log 2026-10-11): the code
    // alone reads like a tab the session never had, so the answer says what happened.
    ...(ownership.takenBack ? { hint: TAKEN_BACK_HINT } : {}),
  };
}

/** The tools' next move when they have no tab left, said the same way in every hint below. */
const GET_A_TAB_AGAIN = "To get a working tab again, open one with tabs_create, or take one back with tabs_claim.";

/**
 * A tab the owner moved out of the session's group (004 change log 2026-10-11). Moving it out is
 * the owner taking it back, so the tab may well still be open - it is just not the agent's.
 */
export const TAKEN_BACK_HINT =
  "The owner moved this tab out of your tab group, which hands it back to them: it may still be open in " +
  `the browser, but it is no longer yours. ${GET_A_TAB_AGAIN}`;

/** `tabs_close` on a tab the session no longer holds: whatever else is said, nothing was closed. */
export function nothingClosed(response: AgentNativeResponse): AgentNativeResponse {
  const said =
    response.hint ??
    (response.reason === "tab-gone" ? "That tab is no longer open in the browser." : undefined);
  return { ...response, hint: said === undefined ? "Nothing was closed." : `Nothing was closed. ${said}` };
}

/** Bound of the response's `hint` (contracts `agentNativeResponseSchema`). */
const HINT_MAX = 400;

function tabList(tabIds: number[]): string {
  const shown = tabIds.slice(0, 8).join(", ");
  return tabIds.length > 8 ? `${shown} and ${tabIds.length - 8} more` : shown;
}

/**
 * What `tabs_context` says when it let go of tabs the owner took back (004 change log 2026-10-11):
 * the whole group gone, or some tabs moved out of it. Nothing when neither happened - a tab the
 * owner closed was already reported as the tab being missing from the list.
 */
export function tabsContextHint(context: { takenBack?: number[]; groupGone?: true }): string | undefined {
  const back = context.takenBack ?? [];
  let hint: string;
  if (context.groupGone) {
    hint =
      "Your tab group is gone: the owner closed or ungrouped it, or moved your tabs out of it. " +
      (back.length > 0
        ? `Tab${back.length === 1 ? "" : "s"} ${tabList(back)} may still be open in the browser, but `
        : "Any of its tabs that may still be open in the browser ") +
      `${back.length === 1 ? "it is" : "are"} no longer yours. ${GET_A_TAB_AGAIN}`;
  } else if (back.length > 0) {
    hint =
      `The owner moved tab${back.length === 1 ? "" : "s"} ${tabList(back)} out of your tab group, which hands ` +
      `${back.length === 1 ? "it" : "them"} back: ${back.length === 1 ? "it" : "they"} may still be open in the ` +
      `browser, but ${back.length === 1 ? "is" : "are"} no longer yours. ${GET_A_TAB_AGAIN}`;
  } else {
    return undefined;
  }
  return hint.length > HINT_MAX ? `${hint.slice(0, HINT_MAX - 3)}...` : hint;
}

/** What a runner needs to answer "may this session touch that tab", per call (004/T103a). */
export type TabOwnershipLookup = (sessionId: string, tabId: number) => Promise<TabOwnership>;
