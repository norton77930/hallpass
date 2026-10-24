import { z } from "zod";
import {
  AGENT_BROWSER_LIST_MAX,
  agentBrowserSummarySchema,
  agentBridgeStatusSchema,
  agentPanelCommandSchema,
  agentPanelStateSchema,
} from "./agent-tools.js";
import {
  CONVERSATION_AGENTS,
  CONVERSATION_CONSENT_STATES,
  CONVERSATION_UNAVAILABLE_REASONS,
  agentChoicesSchema,
  conversationAgentAvailabilitySchema,
  conversationAgentSchema,
  conversationCheckAgentsCommandSchema,
  conversationDiagnosticsFrameSchema,
  conversationIdSchema,
  conversationInstallCancelCommandSchema,
  conversationPanelDiagnosticsMessageSchema,
  conversationTestCommandSchema,
} from "./conversation.js";

/**
 * 024 - the settings page (contracts/frames.md, data-model.md, R-373, R-380, R-382): its own port,
 * the closed set of commands it may send, and what the worker tells it.
 *
 * The page sends a subset of what the panel sends, plus its own two record commands and the agent
 * commands the broker answers. Every member it shares with the panel is the panel's own member
 * schema with a required `commandId`, so the payload rules cannot drift between the two ports.
 * Session actions, prompt and card answers and conversation start / send / attach are not in the
 * union, so the page cannot send them (R-373).
 */

/** R-373: the settings page's port; a page in a tab never connects as the panel. */
export const AGENT_SETTINGS_PORT_NAME = "hallpass-settings";

export { agentChoicesSchema };
export type { AgentChoices } from "./conversation.js";

/** R-382 / D-024-20 (data-model "AgentAppearance"): one appearance for the side panel and the page. */
export const AGENT_APPEARANCE_THEMES = ["system", "light", "dark"] as const;
export const AGENT_APPEARANCE_LANGUAGES = ["system", "en-US", "zh-TW"] as const;
export const agentAppearanceSchema = z.strictObject({
  theme: z.enum(AGENT_APPEARANCE_THEMES),
  language: z.enum(AGENT_APPEARANCE_LANGUAGES),
});
export type AgentAppearance = z.infer<typeof agentAppearanceSchema>;

/** Every settings command names the id the page minted, so its `worker.settings.result` finds it. */
const commandId = z.string().min(1).max(128);

type PanelMember = (typeof agentPanelCommandSchema.options)[number];
type PanelMemberOf<T extends string> = Extract<PanelMember, { shape: { type: z.ZodLiteral<T> } }>;

/** The panel's own member for `type`: the same payload schema, not a copy of it. */
function panelMember<T extends PanelMember["shape"]["type"]["value"]>(type: T): PanelMemberOf<T> {
  const member = agentPanelCommandSchema.options.find((option) => option.shape.type.value === type);
  if (member === undefined) throw new Error(`no panel command ${type}`);
  return member as PanelMemberOf<T>;
}

/** frames.md `ui.settings.choices-set`: switch agents on or off and set the default; the worker applies D-024-15. */
const choicesSetCommandSchema = z.strictObject({
  type: z.literal("ui.settings.choices-set"),
  payload: z.strictObject({
    enabled: z.partialRecord(conversationAgentSchema, z.boolean()).optional(),
    default: conversationAgentSchema.nullable().optional(),
  }),
});

/** frames.md `ui.settings.appearance-set`: the top bar's theme and language (D-024-20). */
const appearanceSetCommandSchema = z.strictObject({
  type: z.literal("ui.settings.appearance-set"),
  payload: z.strictObject({
    theme: z.enum(AGENT_APPEARANCE_THEMES).optional(),
    language: z.enum(AGENT_APPEARANCE_LANGUAGES).optional(),
  }),
});

/**
 * R-387: the page asks for an agent's last output by agent only; by conversation is the panel's form.
 * The panel's member with its payload narrowed to the `{ agent }` alternative.
 */
const diagnosticsByAgentCommandSchema = panelMember("ui.conversation.diagnostics").extend({
  payload: z.strictObject({ agent: conversationAgentSchema }),
});

/** frames.md "Settings page -> worker": the closed union; anything else is refused and logged. */
export const settingsCommandSchema = z.discriminatedUnion("type", [
  choicesSetCommandSchema.extend({ commandId }),
  appearanceSetCommandSchema.extend({ commandId }),
  panelMember("ui.agent.site-mode").extend({ commandId }),
  panelMember("ui.agent.site-clear").extend({ commandId }),
  // 004 FR-049 (added 2026-10-24): the per-site diagnostics grant, which moved with the site row.
  panelMember("ui.agent.set-diagnostics").extend({ commandId }),
  panelMember("ui.agent.transition-clear").extend({ commandId }),
  panelMember("ui.agent.unpair").extend({ commandId }),
  panelMember("ui.agent.upload-root-clear").extend({ commandId }),
  panelMember("ui.agent.browser-rename").extend({ commandId }),
  panelMember("ui.conversation.consent").extend({ commandId }),
  conversationCheckAgentsCommandSchema.extend({ commandId }),
  panelMember("ui.conversation.install").extend({ commandId }),
  conversationInstallCancelCommandSchema.extend({ commandId }),
  conversationTestCommandSchema.extend({ commandId }),
  diagnosticsByAgentCommandSchema.extend({ commandId }),
]);
export type SettingsCommand = z.infer<typeof settingsCommandSchema>;

const panelShape = agentPanelStateSchema.shape;

/**
 * data-model "Settings projection": the bridge and versions, the browsers, this browser's name, the
 * paired outside agents, sites and transitions, upload folders, the side-panel-agent consent, each
 * agent's readiness and the owner's choices. No prompts, consent cards, session details or
 * conversation contents. The pieces it shares with the panel projection are the panel's own schemas.
 */
export const settingsStateSchema = z.strictObject({
  bridge: agentBridgeStatusSchema,
  diagnostics: panelShape.diagnostics,
  /** R-386: `host` absent while no host has greeted; `match` false when the pair needs updating. */
  versions: z.strictObject({
    extension: z.string().min(1).max(64),
    host: z.string().min(1).max(64).optional(),
    match: z.boolean(),
  }),
  /** 018 peers, this browser marked `self`; absent until the relay reported them. */
  browsers: z
    .array(agentBrowserSummarySchema.extend({ self: z.boolean() }))
    .max(AGENT_BROWSER_LIST_MAX)
    .optional(),
  browser: panelShape.browser,
  paired: panelShape.paired,
  sites: panelShape.sites,
  transitions: panelShape.transitions,
  uploadRoots: panelShape.uploadRoots,
  consent: z.enum(CONVERSATION_CONSENT_STATES),
  agents: z.array(conversationAgentAvailabilitySchema).max(CONVERSATION_AGENTS.length),
  /** Why `agents` has nothing to say: the host is too old, or its broker is not there. */
  agentsUnavailable: z.enum(CONVERSATION_UNAVAILABLE_REASONS).optional(),
  choices: agentChoicesSchema,
});
export type SettingsState = z.infer<typeof settingsStateSchema>;

/** A refusal in words the page maps to a sentence; a broker's error passes through with its code. */
const settingsErrorSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/u, { message: "expected a kebab-case code" }),
  /** Already redacted (R-326). */
  detail: z.string().min(1).max(600).optional(),
});

/** frames.md `worker.settings.result`: one per command; `defaultMovedTo` when D-024-15 moved the default. */
const settingsResultSchema = z
  .strictObject({
    commandId,
    ok: z.boolean(),
    error: settingsErrorSchema.optional(),
    defaultMovedTo: conversationAgentSchema.nullable().optional(),
  })
  .refine((result) => result.ok === (result.error === undefined), {
    message: "a failure, and only a failure, carries its error",
    path: ["error"],
  });
export type SettingsResult = z.infer<typeof settingsResultSchema>;

/** frames.md `worker.settings.toast`: told once to every open settings page (FR-379). */
export const SETTINGS_TOAST_KINDS = ["install-done", "install-failed", "test-done", "default-moved"] as const;
const settingsToastSchema = z
  .strictObject({
    kind: z.enum(SETTINGS_TOAST_KINDS),
    /** For `default-moved`, the new default; `null` when no agent could take it. */
    agent: conversationAgentSchema.nullable(),
  })
  .refine((toast) => toast.agent !== null || toast.kind === "default-moved", {
    message: "only a moved default may name no agent",
    path: ["agent"],
  });
export type SettingsToast = z.infer<typeof settingsToastSchema>;

/**
 * frames.md `worker.settings.diagnostics` (added 2026-10-24, R-387): the broker's reply to the page's
 * `ui.conversation.diagnostics { agent }`, to that page only - the agent, when the lines were read, the
 * run's conversation when that run was one (a test's run has none), and the lines, already scrubbed by
 * the broker. The pieces are the link frame's and the panel message's own schemas.
 */
const settingsDiagnosticsSchema = z.strictObject({
  agent: conversationAgentSchema,
  readAt: conversationDiagnosticsFrameSchema.shape.readAt.unwrap(),
  conversationId: conversationIdSchema.optional(),
  lines: conversationPanelDiagnosticsMessageSchema.shape.payload.shape.lines,
});
export type SettingsDiagnostics = z.infer<typeof settingsDiagnosticsSchema>;

/** frames.md "Worker -> settings page". */
export const settingsMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("worker.settings.state"), payload: settingsStateSchema }),
  z.strictObject({ type: z.literal("worker.settings.result"), payload: settingsResultSchema }),
  z.strictObject({ type: z.literal("worker.settings.toast"), payload: settingsToastSchema }),
  z.strictObject({ type: z.literal("worker.settings.diagnostics"), payload: settingsDiagnosticsSchema }),
]);
export type SettingsMessage = z.infer<typeof settingsMessageSchema>;
