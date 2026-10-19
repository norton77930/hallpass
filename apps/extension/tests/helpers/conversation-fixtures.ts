import { act } from "@testing-library/react";
import type { AgentPanelState, ConversationEvent, ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { IDLE, type FakeAgentPort } from "./agent-shell-harness.js";

/**
 * 019 S5 (T543, T545, T548) - projections and events for the side panel's two tabs.
 *
 * The Conversation tab is driven by two things the worker sends: the `conversation` part of the
 * projection (list, agents, consent - no content) and `conversation-event` messages (the content,
 * kept by the panel in memory only, D-019-6). These helpers build both.
 */

export const CONVERSATION_ID = "conv-0123456789abcdef";

export const VIEW: ConversationView = {
  conversationId: CONVERSATION_ID,
  agent: "claude-code",
  title: "Summarise this table",
  folder: { kind: "scratch" },
  mode: "strict",
  createdAt: "2026-10-19T00:00:00.000Z",
  lastUsedAt: "2026-10-19T00:00:01.000Z",
  resumable: true,
  state: "idle",
};

/** Both agents ready, consent given, nothing open: the picker. */
export const CONVERSATION_READY: ConversationPanelState = {
  available: true,
  consent: "granted",
  conversations: [],
  agents: [
    { agent: "claude-code", availability: "ready", version: "2.1.0" },
    { agent: "codex", availability: "ready", version: "0.50.0" },
  ],
  folders: [],
};

/** One conversation open. */
export const CONVERSATION_OPEN: ConversationPanelState = {
  ...CONVERSATION_READY,
  conversations: [VIEW],
  active: CONVERSATION_ID,
};

/** A paired, idle browser that also offers the Conversation tab. */
export function withConversation(conversation: ConversationPanelState, base: AgentPanelState = IDLE): AgentPanelState {
  return { ...base, conversation };
}

/** One broker event as the worker forwards it to the panel (FR-288). */
export function emitEvent(port: FakeAgentPort, seq: number, event: ConversationEvent, conversationId = CONVERSATION_ID): void {
  act(() => {
    port.emit({ type: "conversation-event", payload: { conversationId, seq, event } });
  });
}

/**
 * T547: the owner's commands the panel sent, as the press made them - without the commandId the
 * shell gives each `ui.conversation.*` command and without the shell's own resync on connecting.
 */
export function commandsSent(port: FakeAgentPort): unknown[] {
  return port.sent
    .filter((message) => (message as { type?: string }).type !== "ui.conversation.resync")
    .map((message) => {
      if (typeof message !== "object" || message === null || !("commandId" in message)) return message;
      const { commandId: _commandId, ...rest } = message as Record<string, unknown>;
      return rest;
    });
}

/** The commandId the shell gave the last `ui.conversation.*` command it sent. */
export function lastCommandId(port: FakeAgentPort): string {
  const sent = [...port.sent].reverse().find((message) => typeof (message as { commandId?: unknown }).commandId === "string");
  return (sent as { commandId: string }).commandId;
}

/** The panel's `agentPanelTab` store, faked; `failGet`/`failSet` make the call itself throw. */
export type FakeTabStorage = { stored: unknown; writes: unknown[]; failGet: boolean; failSet: boolean };

export function installTabStorage(stored?: unknown): FakeTabStorage {
  const storage: FakeTabStorage = { stored, writes: [], failGet: false, failSet: false };
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};
  chromeGlobal.storage = {
    local: {
      get: (key: string) => {
        if (storage.failGet) throw new Error("storage unavailable");
        return Promise.resolve(storage.stored === undefined ? {} : { [key]: storage.stored });
      },
      set: (items: Record<string, unknown>) => {
        if (storage.failSet) throw new Error("storage unavailable");
        storage.writes.push(items);
        return Promise.resolve();
      },
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chromeGlobal;
  return storage;
}
