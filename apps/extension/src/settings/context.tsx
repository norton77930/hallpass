import { createContext, useContext } from "react";
import type { AgentAppearance, ConversationAgent, SettingsCommand, SettingsResult, SettingsState } from "@hallpass/contracts";
import type { AppLocale } from "../locales/catalog.js";
import type { Translate } from "./settings-text.js";

/** A command as the view builds it: the connector gives it its `commandId` (frames.md). */
export type SettingsCommandInput = SettingsCommand extends infer Member
  ? Member extends { commandId: string }
    ? Omit<Member, "commandId">
    : never
  : never;

/** Sends one command and answers with its `worker.settings.result`; a command that got none answers `ok: false`. */
export type SendSettingsCommand = (command: SettingsCommandInput) => Promise<SettingsResult>;

/** What `worker.settings.diagnostics` carried for an agent: when the lines were read, and the lines (already scrubbed). */
export type AgentOutput = { readAt: string; lines: string[]; conversationId?: string };

export type NoticeOptions = {
  /** An action offered with the notice for a few seconds (Undo, FR-385). */
  action?: { label: string; run: () => void };
};

export type SettingsContextValue = {
  state: SettingsState;
  appearance: AgentAppearance;
  locale: AppLocale;
  t: Translate;
  send: SendSettingsCommand;
  /** Sends a command; a refusal or a lost command is told to the owner, a success runs `onOk`. */
  run: (command: SettingsCommandInput, onOk?: (result: SettingsResult) => void) => Promise<boolean>;
  notify: (text: string, options?: NoticeOptions) => void;
  /** The newest projection, for an answer that arrives after the render that asked. */
  latest: () => SettingsState;
  nameOf: (agent: ConversationAgent) => string;
  output: Partial<Record<ConversationAgent, AgentOutput>>;
  now: () => Date;
};

export const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === undefined) throw new Error("useSettings outside SettingsView");
  return value;
}
