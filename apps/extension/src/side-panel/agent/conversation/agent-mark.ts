import type { ConversationAgent } from "@hallpass/contracts";

/**
 * T605, T606: each agent's badge mark - decoration, distinct per agent (two names can share an
 * initial), in the agent menu and on the drawer's rows. Typed over every supported agent, so one
 * added to the contract needs a mark here.
 */
export const AGENT_MARK: Record<ConversationAgent, string> = { "claude-code": "C", codex: "X" };
