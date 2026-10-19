/**
 * 019 R-321, T553, T554: the panel conversations' browser tokens, as the worker holds them.
 *
 * The broker mints one random token per agent run of a conversation and hands it to the worker in a
 * `conversation-browser-token` frame (from the broker session only - `conversation-relay.ts` drops
 * the frame from anyone else); the mcp-server it starts for that conversation presents it in its
 * `hello`. A greeting whose token is held here, under the agent id `panel:<conversationId>` of the
 * conversation it was issued for, is a panel session.
 *
 * Memory only, never stored and never logged: a token outlives neither the broker's session nor the
 * relay run it was issued in, and a worker restart is a new relay run. One token per conversation -
 * a new one replaces the old, which dies with it.
 *
 * The start tab (FR-306) rides on the same frame: the tab the owner was viewing when they sent the
 * message. It is handed out once, to the first browser call of the turn.
 */

const PANEL_AGENT_PREFIX = "panel:";

/** The agent id a panel conversation's mcp-server greets with (R-321). */
export function panelAgentId(conversationId: string): string {
  return `${PANEL_AGENT_PREFIX}${conversationId}`;
}

/**
 * Whether an agent id is in the panel namespace. No external pairing is ever made under one: an
 * external greeting that names it is refused rather than shown to the owner as an agent.
 */
export function isPanelAgentId(agentId: string): boolean {
  return agentId.startsWith(PANEL_AGENT_PREFIX);
}

export type PanelTokens = {
  /** A token for a conversation (replacing its earlier one), or `null` to revoke it. */
  set: (conversationId: string, token: string | null, startTabId?: number) => void;
  /** The conversation a live token was issued for. */
  conversationOf: (token: string) => string | undefined;
  /** The start tab of the conversation's current turn, handed out once. */
  takeStartTab: (conversationId: string) => number | undefined;
  /** Every token goes: the broker left, a new relay started, or the owner withdrew the consent. */
  revokeAll: () => void;
};

export function createPanelTokens(): PanelTokens {
  const byConversation = new Map<string, { token: string; startTabId?: number }>();
  const byToken = new Map<string, string>();
  return {
    set(conversationId, token, startTabId) {
      // A token already issued to another conversation is not moved: the broker mints one per run.
      const holder = token === null ? undefined : byToken.get(token);
      if (holder !== undefined && holder !== conversationId) return;
      const earlier = byConversation.get(conversationId);
      if (earlier !== undefined && earlier.token !== token) byToken.delete(earlier.token);
      if (token === null) {
        byConversation.delete(conversationId);
        return;
      }
      byToken.set(token, conversationId);
      byConversation.set(conversationId, {
        token,
        ...(startTabId === undefined ? {} : { startTabId }),
      });
    },
    conversationOf(token) {
      return byToken.get(token);
    },
    takeStartTab(conversationId) {
      const entry = byConversation.get(conversationId);
      if (entry?.startTabId === undefined) return undefined;
      const { startTabId } = entry;
      byConversation.set(conversationId, { token: entry.token });
      return startTabId;
    },
    revokeAll() {
      byConversation.clear();
      byToken.clear();
    },
  };
}
