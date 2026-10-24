import {
  CONVERSATION_AGENTS,
  type AgentChoices,
  type ConversationAgent,
  type ConversationAgentAvailability,
} from "@hallpass/contracts";

/**
 * 024 FR-384, D-024-2, D-024-3, R-380: which agents the picker offers and which one a new conversation
 * starts on.
 *
 * Both come from the worker's `conversation.choices` (AgentChoices, kept per browser and set on the
 * settings page); the panel remembers nothing of its own any more (the 020 "agent used last" is gone,
 * the worker seeded the default from it once). A projection without `choices` - a worker from before
 * 024 - offers every agent, so the picker never goes empty on an older pair.
 */

/** The enabled agents, in the contract's order. */
export function enabledAgents(choices: AgentChoices | undefined): ConversationAgent[] {
  return CONVERSATION_AGENTS.filter((agent) => choices === undefined || choices.enabled[agent] === true);
}

/**
 * The agent a new conversation starts on: the owner's default; with no default, the first enabled agent
 * that is ready, else the first enabled one, else the first supported agent (nothing is enabled, and the
 * composer says so). A default whose agent has stopped being ready is kept, not replaced - the composer
 * then says why it cannot send (data-model "Readiness changes later").
 */
export function startingAgent(
  choices: AgentChoices | undefined,
  agents: readonly ConversationAgentAvailability[],
): ConversationAgent {
  if (choices?.default != null) return choices.default;
  const enabled = enabledAgents(choices);
  const ready = (agent: ConversationAgent) => agents.some((entry) => entry.agent === agent && entry.availability === "ready");
  return enabled.find(ready) ?? enabled[0] ?? CONVERSATION_AGENTS[0];
}
