import {
  CONVERSATION_AGENTS,
  type AgentTestResult,
  type ConversationAgent,
  type ConversationAgentAvailability,
  type SettingsState,
} from "@hallpass/contracts";
import type { TextVars } from "./settings-text.js";

/**
 * 024 R-374 / D-024-14: what the page says about an agent, derived from the overview entry the worker
 * projects and nothing else. The state says how ready the agent is; whether it is on is the Enabled
 * switch alone, so a switched-off agent keeps its state.
 */
export type AgentState = "ready" | "readyWarnings" | "needsDownload" | "downloading" | "notInstalled";

export const AGENT_ORDER: readonly ConversationAgent[] = CONVERSATION_AGENTS;

/**
 * What the owner is told about the size and time of a download; today's figures, shown as estimates (spec "Assumptions").
 * Sizes are per agent, rounded from what was measured on the owner's machine: install folders (T794: Claude Code 60 MB,
 * Codex 17 MB) and the DeepSeek `npm ci` tree (T737: 726 MB). Hermes is installed by the owner; Hallpass downloads nothing for it.
 */
export const DOWNLOAD_SIZE: Partial<Record<ConversationAgent, string>> = {
  "claude-code": "60 MB",
  codex: "20 MB",
  deepseek: "730 MB",
};
export const AGENT_DOWNLOAD_MINUTES = "5–6";

/** DeepSeek is fetched whole; Claude Code and Codex need a small helper next to the program the owner has. */
export function downloadKind(agent: ConversationAgent): "helper" | "agent" {
  return agent === "deepseek" ? "agent" : "helper";
}

/** The agents the owner installs themselves; Hallpass never downloads or updates them (D-021-3). */
export function installedByOwner(agent: ConversationAgent): boolean {
  return agent === "hermes";
}

const RUNNING_PHASES = ["preparing", "downloading", "finishing"] as const;

export function isDownloading(entry: ConversationAgentAvailability): boolean {
  return entry.installing !== undefined || (entry.install !== undefined && (RUNNING_PHASES as readonly string[]).includes(entry.install.phase));
}

/** A warning in the owner's words: the message key and what the card adds to it. */
export type AgentWarning = { key: string; vars: TextVars };

/** FR-378: notes and warnings of a ready agent. The `{agent}` variable is the card's to add. */
export function agentWarnings(entry: ConversationAgentAvailability, name: string): AgentWarning[] {
  if (entry.availability !== "ready") return [];
  const warnings: AgentWarning[] = [];
  for (const note of entry.notes ?? []) {
    warnings.push({ key: note === "git-missing" ? "settings.note.gitMissing" : "settings.note.preRelease", vars: { agent: name } });
  }
  if (entry.agent === "hermes" && entry.setupSteps !== undefined) {
    const found = (step: string): boolean | undefined => entry.setupSteps?.find((item) => item.step === step)?.found;
    if (found("mcp-component") === false) warnings.push({ key: "settings.warning.mcpMissing", vars: { agent: name } });
    // The variable is set in Windows (found) but this browser started before it was (restart not done).
    if (found("key-variable") === true && found("browser-restart") === false) {
      // The name is known only after a Test found it (R-369/R-379); until then the warning says "the key variable".
      const variable = entry.lastTest?.keyHint;
      warnings.push(
        variable === undefined
          ? { key: "settings.warning.keyVariableUnnamed", vars: { agent: name } }
          : { key: "settings.warning.keyVariable", vars: { agent: name, variable } },
      );
    }
  }
  return warnings;
}

export function agentState(entry: ConversationAgentAvailability, name: string): AgentState {
  if (isDownloading(entry)) return "downloading";
  if (entry.availability === "needs-install") return "needsDownload";
  if (entry.availability === "missing" || entry.availability === "version-problem") return "notInstalled";
  return agentWarnings(entry, name).length > 0 ? "readyWarnings" : "ready";
}

export const isReadyState = (state: AgentState): boolean => state === "ready" || state === "readyWarnings";

/** Only a ready, enabled agent can be the default (FR-382). */
export function canBeDefault(state: AgentState, enabled: boolean): boolean {
  return enabled && isReadyState(state);
}

/** FR-377: cards needing a download (or a reinstall) or carrying warnings start open. */
export function needsAttention(state: AgentState, enabled: boolean): boolean {
  return enabled && (state === "needsDownload" || state === "notInstalled" || state === "readyWarnings");
}

export type AgentSummary = { ready: number; total: number; downloading: number; attention: number; warnings: number };

/** FR-376: the counts in the navigation; an agent that is switched off counts in the total and nowhere else. */
export function summarize(state: SettingsState, nameOf: (agent: ConversationAgent) => string): AgentSummary {
  const summary: AgentSummary = { ready: 0, total: state.agents.length, downloading: 0, attention: 0, warnings: 0 };
  for (const entry of state.agents) {
    if (!state.choices.enabled[entry.agent]) continue;
    const kind = agentState(entry, nameOf(entry.agent));
    // "1 of 4 ready" with Hermes ready-with-warnings counted under warnings (spec US1 scenario 2).
    if (kind === "ready") summary.ready += 1;
    if (kind === "readyWarnings") summary.warnings += 1;
    if (kind === "downloading") summary.downloading += 1;
    if (kind === "needsDownload" || kind === "notInstalled") summary.attention += 1;
  }
  return summary;
}

/** FR-386: the status of an agent's browser tools; `needs-helper` and the other three, from the local check. */
export type ToolsStatus = "available" | "needsComponent" | "notSupported" | "afterHelper" | "unknown";

export function toolsStatus(entry: ConversationAgentAvailability): ToolsStatus {
  switch (entry.browserTools) {
    case "available":
      return "available";
    case "needs-helper":
      return "afterHelper";
    case "missing-component":
      return "needsComponent";
    case "not-supported":
      return "notSupported";
    default:
      break;
  }
  if (entry.agent === "deepseek") return "notSupported";
  if (entry.agent === "hermes") return "needsComponent";
  return entry.availability === "ready" ? "available" : "afterHelper";
}

/** The message key of a test's failure, in the owner's words (FR-381), and what it needs. */
export type TestLine =
  | { kind: "passed"; key: string; vars: TextVars }
  | { kind: "partial"; key: "settings.test.partial"; vars: TextVars }
  | { kind: "failed"; key: string; vars: TextVars };

/** The bound a test is held to (R-379), told when a test timed out. */
export const TEST_TIMEOUT_SECONDS = 90;

export function describeTest(result: AgentTestResult, t: (key: string) => string): TestLine {
  const ms = result.model.answered ? result.model.ms : 0;
  if (result.outcome === "passed") {
    const key =
      result.browserTools === "available"
        ? "settings.test.passedTools"
        : result.browserTools === "not-supported"
          ? "settings.test.passedNoTools"
          : "settings.test.passed";
    return { kind: "passed", key, vars: { ms } };
  }
  if (result.outcome === "partial") {
    const component = result.browserTools === "missing-component" ? t("settings.test.component.mcp") : t("settings.test.component.browserTools");
    return { kind: "partial", key: "settings.test.partial", vars: { ms, component } };
  }
  if (result.start !== "ok") return { kind: "failed", key: "settings.test.failed.start", vars: {} };
  if (result.keyHint !== undefined) return { kind: "failed", key: "settings.test.failed.key", vars: { variable: result.keyHint } };
  if (!result.model.answered) {
    const timedOut = /time.?out|timed out|no answer within/iu.test(result.model.reason);
    return timedOut
      ? { kind: "failed", key: "settings.test.failed.timeout", vars: { seconds: TEST_TIMEOUT_SECONDS } }
      : { kind: "failed", key: "settings.test.failed.model", vars: {} };
  }
  return { kind: "failed", key: "settings.test.failed.other", vars: {} };
}
