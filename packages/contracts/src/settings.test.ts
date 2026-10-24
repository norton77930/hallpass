import { describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "./agent-tools.js";
import * as settings from "./settings.js";
import {
  AGENT_SETTINGS_PORT_NAME,
  agentAppearanceSchema,
  agentChoicesSchema,
  settingsCommandSchema,
  settingsMessageSchema,
} from "./settings.js";

/**
 * 024 T744 - the settings page's port (contracts/frames.md, R-373, R-380, R-382): the closed
 * `settingsCommandSchema`, the worker's `worker.settings.state` / `result` / `toast`, and the two
 * per-browser records AgentChoices and AgentAppearance (data-model.md).
 */

const CONVERSATION = "c0a8f3d2-6b1e-4d7a-9c2f-0d4e5b6a7c81";
const enabled = { "claude-code": true, codex: true, hermes: false, deepseek: true };
const command = (type: string, payload: Record<string, unknown>) => ({ type, payload, commandId: "cmd-1" });

describe("024 settings port", () => {
  it("is named hallpass-settings", () => {
    expect(AGENT_SETTINGS_PORT_NAME).toBe("hallpass-settings");
  });
});

describe("024 AgentChoices", () => {
  it("names every agent and a default that is enabled, or none", () => {
    expect(agentChoicesSchema.safeParse({ enabled, default: "codex" }).success).toBe(true);
    expect(agentChoicesSchema.safeParse({ enabled, default: null }).success).toBe(true);
  });

  it("refuses a missing agent, an unknown agent, a default that is switched off, and extra fields", () => {
    const { deepseek: _deepseek, ...missing } = enabled;
    expect(agentChoicesSchema.safeParse({ enabled: missing, default: null }).success).toBe(false);
    expect(agentChoicesSchema.safeParse({ enabled: { ...enabled, other: true }, default: null }).success).toBe(false);
    expect(agentChoicesSchema.safeParse({ enabled, default: "hermes" }).success).toBe(false);
    expect(agentChoicesSchema.safeParse({ enabled, default: null, last: "codex" }).success).toBe(false);
  });
});

describe("024 AgentAppearance", () => {
  it("takes System / Light / Dark and System / English / Traditional Chinese", () => {
    for (const theme of ["system", "light", "dark"]) {
      for (const language of ["system", "en-US", "zh-TW"]) {
        expect(agentAppearanceSchema.safeParse({ theme, language }).success, `${theme} ${language}`).toBe(true);
      }
    }
    expect(agentAppearanceSchema.safeParse({ theme: "sepia", language: "system" }).success).toBe(false);
    expect(agentAppearanceSchema.safeParse({ theme: "system", language: "fr-FR" }).success).toBe(false);
  });
});

describe("024 settingsCommandSchema", () => {
  const accepted = [
    command("ui.settings.choices-set", { enabled: { hermes: true } }),
    command("ui.settings.choices-set", { default: "codex" }),
    command("ui.settings.choices-set", { default: null }),
    command("ui.settings.appearance-set", { theme: "dark" }),
    command("ui.settings.appearance-set", { language: "zh-TW" }),
    command("ui.agent.site-mode", { site: "https://example.test", mode: "follow-a-plan" }),
    command("ui.agent.site-clear", { site: "https://example.test" }),
    // 004 FR-049: the per-site diagnostics grant, moved from the panel's site row with the row.
    command("ui.agent.set-diagnostics", { site: "https://example.test", granted: true }),
    command("ui.agent.set-diagnostics", { site: "https://example.test", granted: false }),
    command("ui.agent.transition-clear", { from: "https://a.test", to: "https://b.test" }),
    command("ui.agent.unpair", { agentId: "agent-1" }),
    command("ui.agent.upload-root-clear", { root: "C:\\Users\\owner\\Pictures" }),
    command("ui.agent.browser-rename", { name: "Work Chrome" }),
    command("ui.conversation.consent", { granted: true }),
    command("ui.conversation.check-agents", {}),
    command("ui.conversation.check-agents", { agent: "hermes" }),
    command("ui.conversation.install", { agent: "codex" }),
    command("ui.conversation.install-cancel", { agent: "codex" }),
    command("ui.conversation.test", { agent: "deepseek" }),
    command("ui.conversation.diagnostics", { agent: "claude-code" }),
  ];

  it("accepts each command frames.md lists, with its commandId", () => {
    for (const value of accepted) expect(settingsCommandSchema.safeParse(value).success, value.type).toBe(true);
  });

  it("takes exactly the types frames.md lists", () => {
    const types = settingsCommandSchema.options.map((option) => option.shape.type.value).sort();
    expect(types).toEqual([...new Set(accepted.map((value) => value.type))].sort());
  });

  it("needs a commandId on every command", () => {
    for (const { commandId: _id, ...value } of accepted) expect(settingsCommandSchema.safeParse(value).success, value.type).toBe(false);
  });

  it("reuses the panel's payload rules for the commands it shares with the panel", () => {
    expect(settingsCommandSchema.safeParse(command("ui.agent.site-mode", { site: "https://example.test/path", mode: "ask" })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.agent.unpair", { agentId: "a", displayName: "x" })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.agent.browser-rename", { name: "n".repeat(41) })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.agent.upload-root-clear", { root: "Pictures" })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.agent.set-diagnostics", { site: "https://example.test/", granted: true })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.agent.set-diagnostics", { site: "https://example.test", granted: true, mode: "ask" })).success).toBe(false);
  });

  it("refuses session actions, prompt and card answers, and conversation start, send and attach", () => {
    const refused = [
      command("ui.agent.session-stop", { sessionId: "s" }),
      command("ui.agent.session-interrupt", { sessionId: "s" }),
      command("ui.agent.session-release", { sessionId: "s" }),
      command("ui.agent.site-plan-withdraw", { sessionId: "s" }),
      command("ui.agent.site-plan-decide", { proposalId: "p", approve: false, origins: [] }),
      command("ui.agent.effect-decide", { promptId: "p", allow: true }),
      command("ui.agent.plan-decide", { planId: "p", approve: true }),
      command("ui.agent.pair-decide", { agentId: "a", accepted: true }),
      command("ui.agent.pair-ignore", { agentId: "a" }),
      command("ui.agent.browser-choice-decide", { requestId: "r", confirm: true }),
      command("ui.conversation.answer", { conversationId: CONVERSATION, requestId: "r", answer: "allow-once" }),
      command("ui.conversation.start", { agent: "codex", folder: { kind: "scratch" } }),
      command("ui.conversation.send", { conversationId: CONVERSATION, text: "hi" }),
      command("ui.conversation.attach-cancel", { conversationId: CONVERSATION, attachmentId: "a" }),
      command("ui.conversation.stop", { conversationId: CONVERSATION }),
      command("ui.conversation.diagnostics", { conversationId: CONVERSATION }),
      { type: "ui.tab.capture", requestId: "r", payload: { tabId: 1, what: "page" } },
    ];
    for (const value of refused) expect(settingsCommandSchema.safeParse(value).success, value.type).toBe(false);
  });

  it("refuses unknown agents and fields in the page's own commands", () => {
    expect(settingsCommandSchema.safeParse(command("ui.settings.choices-set", { enabled: { other: true } })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.settings.choices-set", { default: "other" })).success).toBe(false);
    expect(settingsCommandSchema.safeParse(command("ui.settings.appearance-set", { theme: "dark", font: "x" })).success).toBe(false);
  });

  it("leaves the panel's own union as it was: the page's commands are not panel commands", () => {
    expect(agentPanelCommandSchema.safeParse(command("ui.settings.choices-set", { default: null })).success).toBe(false);
  });
});

describe("024 worker to settings page", () => {
  const agents = [{ agent: "codex", availability: "ready", checkedAt: "2026-10-24T00:00:00.000Z", browserTools: "available" }];
  const state = {
    bridge: "connected",
    versions: { extension: "0.16.0", host: "0.16.0", match: true },
    browsers: [
      { browserId: "b-12345678", name: "Work", kind: "chrome", self: true },
      { browserId: "b-87654321", name: "Edge", kind: "edge", self: false },
    ],
    paired: [{ agentId: "a", displayName: "Claude Code", origin: "mcp", acceptedAt: "2026-10-24T00:00:00.000Z" }],
    sites: [{ site: "https://example.test", mode: "ask", diagnosticsGranted: false }],
    consent: "granted",
    agents,
    choices: { enabled, default: "codex" },
  };

  it("worker.settings.state carries the settings projection", () => {
    expect(settingsMessageSchema.safeParse({ type: "worker.settings.state", payload: state }).success).toBe(true);
  });

  it("the projection has no prompts, sessions or conversations", () => {
    for (const extra of [
      { prompt: { promptId: "p" } },
      { sessions: [] },
      { conversations: [] },
      { tabs: [] },
    ]) {
      expect(settingsMessageSchema.safeParse({ type: "worker.settings.state", payload: { ...state, ...extra } }).success, Object.keys(extra)[0]).toBe(
        false,
      );
    }
  });

  it("worker.settings.result answers one command, with the error on failure and where the default moved", () => {
    const result = (payload: Record<string, unknown>) => settingsMessageSchema.safeParse({ type: "worker.settings.result", payload }).success;
    expect(result({ commandId: "cmd-1", ok: true })).toBe(true);
    expect(result({ commandId: "cmd-1", ok: true, defaultMovedTo: "claude-code" })).toBe(true);
    expect(result({ commandId: "cmd-1", ok: true, defaultMovedTo: null })).toBe(true);
    expect(result({ commandId: "cmd-1", ok: false, error: { code: "not-ready", detail: "words" } })).toBe(true);
    expect(result({ commandId: "cmd-1", ok: false })).toBe(false);
    expect(result({ commandId: "cmd-1", ok: true, error: { code: "not-ready" } })).toBe(false);
    expect(result({ ok: true })).toBe(false);
  });

  it("worker.settings.toast names its kind and agent", () => {
    const toast = (payload: Record<string, unknown>) => settingsMessageSchema.safeParse({ type: "worker.settings.toast", payload }).success;
    for (const kind of ["install-done", "install-failed", "test-done", "default-moved"]) expect(toast({ kind, agent: "hermes" }), kind).toBe(true);
    expect(toast({ kind: "default-moved", agent: null })).toBe(true);
    expect(toast({ kind: "install-done", agent: null })).toBe(false);
    expect(toast({ kind: "celebrate", agent: "hermes" })).toBe(false);
  });

  it("worker.settings.diagnostics answers the page that asked by agent: the agent, when read, the run's conversation if any, the lines", () => {
    const diagnostics = (payload: Record<string, unknown>) =>
      settingsMessageSchema.safeParse({ type: "worker.settings.diagnostics", payload }).success;
    const readAt = "2026-10-24T00:00:00.000Z";
    expect(diagnostics({ agent: "codex", readAt, lines: ["a", "b"] })).toBe(true);
    expect(diagnostics({ agent: "codex", readAt, conversationId: CONVERSATION, lines: [] })).toBe(true);
    expect(diagnostics({ readAt, lines: [] })).toBe(false);
    expect(diagnostics({ agent: "codex", lines: [] })).toBe(false);
    expect(diagnostics({ agent: "other", readAt, lines: [] })).toBe(false);
    expect(diagnostics({ agent: "codex", readAt, lines: Array.from({ length: 51 }, () => "x") })).toBe(false);
    expect(diagnostics({ agent: "codex", readAt, lines: ["x".repeat(501)] })).toBe(false);
    expect(diagnostics({ agent: "codex", readAt, lines: [], sessionId: "s" })).toBe(false);
  });

  it("exports the page's schemas", () => {
    expect(settings.settingsStateSchema).toBeDefined();
  });
});
