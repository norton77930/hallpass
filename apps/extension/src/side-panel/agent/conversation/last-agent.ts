import { useEffect, useState } from "react";
import {
  CONVERSATION_AGENTS,
  type ConversationAgent,
  type ConversationAgentAvailability,
} from "@hallpass/contracts";
import { reportTestDiagnostic } from "../../../diagnostics.js";

/**
 * 020 R-335, FR-313: which agent the composer starts on.
 *
 * The agent of the conversation the owner started most recently is a panel preference kept in
 * `chrome.storage.local`, next to the remembered tab (019 FR-284), and wrapped the same way: a
 * storage that throws or is missing only means there is no remembered agent, never a panel that
 * cannot send. It is a convenience for the chip, not a decision - the worker still checks the
 * agent on start.
 */
export const LAST_AGENT_STORAGE_KEY = "conversationLastAgent";

const isAgent = (value: unknown): value is ConversationAgent => CONVERSATION_AGENTS.includes(value as ConversationAgent);

/** The remembered agent (once read) and how to remember a new one. */
export function useLastAgent(): [ConversationAgent | undefined, (agent: ConversationAgent) => void] {
  const [last, setLast] = useState<ConversationAgent | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    try {
      const read = chrome.storage?.local?.get?.(LAST_AGENT_STORAGE_KEY) as Promise<Record<string, unknown>> | undefined;
      void Promise.resolve(read)
        .then((items) => {
          const stored = items?.[LAST_AGENT_STORAGE_KEY];
          if (!disposed && isAgent(stored)) setLast((current) => current ?? stored);
        })
        .catch(() => reportTestDiagnostic("agent.panel.last-agent-unread"));
    } catch {
      reportTestDiagnostic("agent.panel.last-agent-unread");
    }
    return () => {
      disposed = true;
    };
  }, []);
  const remember = (agent: ConversationAgent): void => {
    setLast(agent);
    try {
      const write = chrome.storage?.local?.set?.({ [LAST_AGENT_STORAGE_KEY]: agent }) as Promise<void> | undefined;
      void Promise.resolve(write).catch(() => reportTestDiagnostic("agent.panel.last-agent-unsaved"));
    } catch {
      reportTestDiagnostic("agent.panel.last-agent-unsaved");
    }
  };
  return [last, remember];
}

/**
 * FR-313 / R-335: the agent used last while it is ready, else the first ready agent in the fixed
 * order (the only one, when one is), else the first supported agent.
 */
export function defaultAgent(
  last: ConversationAgent | undefined,
  agents: readonly ConversationAgentAvailability[],
): ConversationAgent {
  const ready = (agent: ConversationAgent) => agents.some((entry) => entry.agent === agent && entry.availability === "ready");
  if (last !== undefined && ready(last)) return last;
  return CONVERSATION_AGENTS.find(ready) ?? CONVERSATION_AGENTS[0];
}
