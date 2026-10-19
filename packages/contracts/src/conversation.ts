import { z } from "zod";

/**
 * 019 - a conversation in the side panel: the shapes shared by the broker (the host process that
 * runs the owner's own coding agent), the service worker, and the panel (contracts/
 * conversation-frames.md, data-model.md, R-312, R-318 - R-324).
 *
 * Everything is `strictObject`, and this file imports nothing from `agent-tools.ts`, which imports
 * it: the link union, the panel state, the panel messages and the panel commands are assembled
 * there from the pieces defined here. Link protocol stays 2 (R-323): every shape below is a new
 * frame type, a new panel command, or an optional field on an existing one.
 *
 * Nothing here carries a way to name a full-access mode. `CONVERSATION_MODES` has two entries and
 * every schema that takes a mode takes that enum (FR-292, SC-140).
 */

/** The two connectors 019 ships (D-019-1); a third agent is a spec amendment, not a payload. */
export const CONVERSATION_AGENTS = ["claude-code", "codex"] as const;
export const conversationAgentSchema = z.enum(CONVERSATION_AGENTS);
export type ConversationAgent = z.infer<typeof conversationAgentSchema>;

/**
 * The only two modes a panel conversation can be in (FR-289, FR-292). Every resume starts `strict`
 * again; `agent-review` lets the agent's own review decide inside the allow-list.
 */
export const CONVERSATION_MODES = ["strict", "agent-review"] as const;
export const conversationModeSchema = z.enum(CONVERSATION_MODES);
export type ConversationMode = z.infer<typeof conversationModeSchema>;

/**
 * Where a conversation lives, fixed for its life (FR-303). The scratch path is derived from the
 * conversation id by the broker, so it is not on the wire.
 */
export const conversationFolderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scratch") }),
  z.strictObject({ kind: z.literal("project"), path: z.string().min(3).max(1024) }),
]);
export type ConversationFolder = z.infer<typeof conversationFolderSchema>;

/** The broker mints it; 16-64 of letters, digits and hyphens, so it is safe as a folder name (R-319). */
export const conversationIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, { message: "expected letters, digits and hyphens" });

const isoTimeSchema = z.string().min(1).max(64);

/** The owner's folder list (data-model "Folder list"); at most 30 of them. */
export const CONVERSATION_MAX_FOLDERS = 30;
export const conversationFolderEntrySchema = z.strictObject({
  path: z.string().min(3).max(1024),
  addedAt: isoTimeSchema,
});
export type ConversationFolderEntry = z.infer<typeof conversationFolderEntrySchema>;

/** The index stores at most 50 entries (data-model); the overview carries the same set. */
export const CONVERSATION_MAX_ENTRIES = 50;

/** One entry of the host's conversation index (data-model "Conversation index"). */
export const conversationEntrySchema = z.strictObject({
  conversationId: conversationIdSchema,
  agent: conversationAgentSchema,
  agentSessionId: z.string().min(1).max(200),
  title: z.string().min(1).max(120),
  folder: conversationFolderSchema,
  mode: conversationModeSchema,
  createdAt: isoTimeSchema,
  lastUsedAt: isoTimeSchema,
  resumable: z.boolean(),
  /** Set while an agent runs it; another browser's `open` is refused while `pid` is alive (R-319). */
  lease: z
    .strictObject({
      browserRunId: z.string().min(1).max(64),
      pid: z.number().int().positive(),
      at: isoTimeSchema,
    })
    .optional(),
});
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

/** The broker's states for a conversation (data-model "Runtime state"). */
export const CONVERSATION_STATES = [
  "starting",
  "idle",
  "running",
  "waiting-for-owner",
  "stopped",
  "crashed",
  "gone",
] as const;
export const conversationStateSchema = z.enum(CONVERSATION_STATES);
export type ConversationState = z.infer<typeof conversationStateSchema>;

/**
 * An index entry as the panel sees it: no content, no agent session id (the panel has no use for the
 * agent's own id and nothing here needs to reach it), no lease detail (only whether another browser
 * holds it), plus the live state.
 */
export const conversationViewSchema = z.strictObject({
  conversationId: conversationIdSchema,
  agent: conversationAgentSchema,
  title: z.string().min(1).max(120),
  folder: conversationFolderSchema,
  mode: conversationModeSchema,
  createdAt: isoTimeSchema,
  lastUsedAt: isoTimeSchema,
  resumable: z.boolean(),
  state: conversationStateSchema,
  inUseElsewhere: z.boolean().optional(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;

/** What the broker can say about an agent on this machine (T530: discovery and install state). */
export const CONVERSATION_AVAILABILITIES = ["missing", "needs-install", "ready", "version-problem"] as const;
/**
 * The phases of a connector download (R-314, `install.ts`). npm prints no byte counts to a pipe, so
 * a phase is all there is to say; the broker sends an overview on each change (T547, G2).
 */
export const CONVERSATION_INSTALL_PHASES = ["preparing", "downloading", "finishing"] as const;
export type ConversationInstallPhase = (typeof CONVERSATION_INSTALL_PHASES)[number];
export const conversationAgentAvailabilitySchema = z.strictObject({
  agent: conversationAgentSchema,
  availability: z.enum(CONVERSATION_AVAILABILITIES),
  version: z.string().min(1).max(64).optional(),
  /** Already redacted (R-326). */
  detail: z.string().min(1).max(600).optional(),
  /** T547 (G2): present only while the broker is downloading this agent's connector. */
  installing: z.enum(CONVERSATION_INSTALL_PHASES).optional(),
});
export type ConversationAgentAvailability = z.infer<typeof conversationAgentAvailabilitySchema>;

/**
 * Why a command failed, in words the panel can map to a sentence. `in-use-elsewhere` is the R-319
 * lease: another browser's agent is running this conversation. T547 (G3) adds `not-found` (no such
 * conversation in the index) and `busy` (a message while the agent's turn is still running), which
 * S4 had answered as `cannot-resume` and `broker-unavailable`.
 */
export const CONVERSATION_ERROR_CODES = [
  "agent-missing",
  "agent-version",
  "install-needed",
  "install-failed",
  "folder-missing",
  "cannot-resume",
  "too-many-running",
  "consent-needed",
  "broker-unavailable",
  "agent-exited",
  "in-use-elsewhere",
  "not-found",
  "busy",
  // T563: the folder dialog cannot open here (no desktop to show it on); the panel offers a typed
  // path instead, which the broker checks exactly like a chosen one.
  "path-entry",
] as const;
export const conversationErrorSchema = z.strictObject({
  code: z.enum(CONVERSATION_ERROR_CODES),
  /** Already redacted by the broker (R-326); never stderr, never a URL with credentials. */
  detail: z.string().min(1).max(600),
});
export type ConversationError = z.infer<typeof conversationErrorSchema>;

/**
 * Conversation notices the panel says in the owner's own words (the event's `code`; its `text` is the
 * broker's redacted detail). R-317 / SC-135: `sandbox-permissions-declined` - in strict mode the broker
 * declined Codex's request for wider sandbox permissions, which would have held for the rest of the turn.
 */
export const CONVERSATION_NOTICES = ["sandbox-permissions-declined"] as const;

/** The protocol's tool-call kinds (R-317). */
export const CONVERSATION_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
] as const;
export const conversationToolKindSchema = z.enum(CONVERSATION_TOOL_KINDS);

/**
 * The kinds that can change something, and so the only ones a card is raised for and a "for this
 * conversation" rule can name (R-317). `read`, `search` and `think` never ask and never get rules.
 */
export const CONVERSATION_RULE_KINDS = ["edit", "delete", "move", "execute", "fetch", "other"] as const;
export type ConversationRuleKind = (typeof CONVERSATION_RULE_KINDS)[number];

export const CONVERSATION_TOOL_STATUSES = ["pending", "running", "done", "failed", "refused"] as const;

/** How a permission card ended (contracts "event kinds"). Only some of these are the owner's words. */
export const CONVERSATION_PERMISSION_CLOSURES = [
  "allow-once",
  "reject",
  "allow-conversation",
  "by-rule",
  "cancelled",
  "agent-exited",
] as const;

/** What the owner can answer a card with: the three buttons, nothing the broker decides itself. */
export const CONVERSATION_OWNER_ANSWERS = ["allow-once", "reject", "allow-conversation"] as const;

export const CONVERSATION_TEXT_MAX_CHARS = 16 * 1024;
export const CONVERSATION_MESSAGE_MAX_CHARS = 32 * 1024;
/** One page of a running conversation's log (R-318); the 1 MB link cap leaves room for the frame. */
export const CONVERSATION_PAGE_MAX_BYTES = 256 * 1024;

/**
 * One thing that happened in a conversation. `type` names the kind of event; `kind` on a tool or a
 * permission event is the *tool's* kind, which is why the discriminator is not called `kind`.
 */
export const conversationEventSchema = z.discriminatedUnion("type", [
  /** Coalesced text (R-318): the agent's words, or the owner's own message echoed back. */
  z.strictObject({
    type: z.literal("text"),
    role: z.enum(["agent", "owner"]),
    text: z.string().max(CONVERSATION_TEXT_MAX_CHARS),
  }),
  z.strictObject({
    type: z.literal("tool"),
    toolCallId: z.string().min(1).max(128),
    kind: conversationToolKindSchema,
    title: z.string().max(200),
    inputSummary: z.string().max(400),
    status: z.enum(CONVERSATION_TOOL_STATUSES),
    /** Allowed by the owner's "for this conversation" rule rather than by a card (R-317). */
    byRule: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("permission"),
    requestId: z.string().min(1).max(128),
    toolCallId: z.string().min(1).max(128),
    kind: conversationToolKindSchema,
    title: z.string().max(200),
    detail: z.string().max(2048),
  }),
  z.strictObject({
    type: z.literal("permission-closed"),
    requestId: z.string().min(1).max(128),
    answer: z.enum(CONVERSATION_PERMISSION_CLOSURES),
  }),
  z.strictObject({
    type: z.literal("mode"),
    mode: conversationModeSchema,
    note: z.string().max(400).optional(),
  }),
  z.strictObject({
    type: z.literal("state"),
    state: conversationStateSchema,
  }),
  z.strictObject({
    type: z.literal("notice"),
    code: z.string().min(1).max(64),
    text: z.string().max(2048),
  }),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

/** An event with the number it has in its conversation's log. */
export const conversationLogEntrySchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  event: conversationEventSchema,
});

/**
 * The payload of one forwarded event, on the link (`conversation-event`) and to the panel. `seq`
 * increases per conversation; a gap makes the worker ask for pages from the last seq it forwarded.
 */
export const conversationEventPayloadSchema = z.strictObject({
  conversationId: conversationIdSchema,
  seq: z.number().int().nonnegative(),
  event: conversationEventSchema,
});
export type ConversationEventPayload = z.infer<typeof conversationEventPayloadSchema>;

/* ------------------------------------------------------------------------------------------- */
/* Panel commands: `ui.conversation.*` (contracts "Panel -> worker")                            */
/* ------------------------------------------------------------------------------------------- */

const conversationTarget = z.strictObject({ conversationId: conversationIdSchema });

/*
 * The twelve things the owner can do from the Conversation tab, as shapes, so the two unions below
 * are built from one definition: the panel's (which may name the commandId the panel minted, T547)
 * and the broker's (which never does - the worker strips it and puts it on the frame).
 *
 * `answer` can name only the three buttons; `by-rule`, `cancelled` and `agent-exited` are things
 * the broker records, never things the panel says. `install` is sent only after the consent card's
 * Download (FR-299); the schema cannot tell, so the broker checks its consent record first.
 */
const START = {
  type: z.literal("ui.conversation.start"),
  payload: z.strictObject({ agent: conversationAgentSchema, folder: conversationFolderSchema }),
};
const SEND = {
  type: z.literal("ui.conversation.send"),
  payload: z.strictObject({
    conversationId: conversationIdSchema,
    text: z.string().min(1).max(CONVERSATION_MESSAGE_MAX_CHARS),
    /** The tab the owner is looking at, so the agent's tab group can start there (R-321). */
    activeTabId: z.number().int().nonnegative().optional(),
  }),
};
const STOP = { type: z.literal("ui.conversation.stop"), payload: conversationTarget };
const ANSWER = {
  type: z.literal("ui.conversation.answer"),
  payload: z.strictObject({
    conversationId: conversationIdSchema,
    requestId: z.string().min(1).max(128),
    answer: z.enum(CONVERSATION_OWNER_ANSWERS),
  }),
};
/** `strict` | `agent-review` and nothing else: no field names a full-access mode (FR-292, SC-140). */
const SET_MODE = {
  type: z.literal("ui.conversation.set-mode"),
  payload: z.strictObject({ conversationId: conversationIdSchema, mode: conversationModeSchema }),
};
const OPEN = { type: z.literal("ui.conversation.open"), payload: conversationTarget };
const REMOVE = { type: z.literal("ui.conversation.remove"), payload: conversationTarget };
/** No path opens the folder dialog; a path is the owner's typed answer after `path-entry` (T563). */
const ADD_FOLDER = {
  type: z.literal("ui.conversation.add-folder"),
  payload: z.strictObject({ path: z.string().min(1).max(1024).optional() }),
};
const REMOVE_FOLDER = {
  type: z.literal("ui.conversation.remove-folder"),
  payload: z.strictObject({ path: z.string().min(3).max(1024) }),
};
const OPEN_FOLDER = { type: z.literal("ui.conversation.open-folder"), payload: conversationTarget };
const INSTALL = { type: z.literal("ui.conversation.install"), payload: z.strictObject({ agent: conversationAgentSchema }) };
const CONSENT = { type: z.literal("ui.conversation.consent"), payload: z.strictObject({ granted: z.boolean() }) };

/**
 * The owner's commands as the broker receives them, inside a `conversation-command` frame: the
 * worker validated them at the panel port and forwards `{ type, payload }` unchanged.
 */
export const conversationCommandSchema = z.discriminatedUnion("type", [
  z.strictObject(START),
  z.strictObject(SEND),
  z.strictObject(STOP),
  z.strictObject(ANSWER),
  z.strictObject(SET_MODE),
  z.strictObject(OPEN),
  z.strictObject(REMOVE),
  z.strictObject(ADD_FOLDER),
  z.strictObject(REMOVE_FOLDER),
  z.strictObject(OPEN_FOLDER),
  z.strictObject(INSTALL),
  z.strictObject(CONSENT),
]);
export type ConversationCommand = z.infer<typeof conversationCommandSchema>;

/**
 * T547 (G1): the id the panel gives a command, so the `conversation-result` the worker passes back
 * can be matched to the document that pressed. Optional: a command without one gets an id from the
 * worker, and its result still reaches every panel.
 */
const COMMAND_ID = { commandId: z.string().min(1).max(128).optional() };

/**
 * T547 (G4, R-318): a panel document that (re)connected names, per conversation it shows, the seq it
 * needs next - 0 when it has nothing. Only the worker turns it into a page request; it never travels
 * to the broker as itself, and the panel cannot send the page request.
 */
const RESYNC = {
  type: z.literal("ui.conversation.resync"),
  payload: z.strictObject({ conversationId: conversationIdSchema, fromSeq: z.number().int().nonnegative() }),
};

/** The `ui.conversation.*` commands as the panel port accepts them (spread into `agentPanelCommandSchema`). */
export const conversationPanelCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...START, ...COMMAND_ID }),
  z.strictObject({ ...SEND, ...COMMAND_ID }),
  z.strictObject({ ...STOP, ...COMMAND_ID }),
  z.strictObject({ ...ANSWER, ...COMMAND_ID }),
  z.strictObject({ ...SET_MODE, ...COMMAND_ID }),
  z.strictObject({ ...OPEN, ...COMMAND_ID }),
  z.strictObject({ ...REMOVE, ...COMMAND_ID }),
  z.strictObject({ ...ADD_FOLDER, ...COMMAND_ID }),
  z.strictObject({ ...REMOVE_FOLDER, ...COMMAND_ID }),
  z.strictObject({ ...OPEN_FOLDER, ...COMMAND_ID }),
  z.strictObject({ ...INSTALL, ...COMMAND_ID }),
  z.strictObject({ ...CONSENT, ...COMMAND_ID }),
  z.strictObject(RESYNC),
]);
export type ConversationPanelCommand = z.infer<typeof conversationPanelCommandSchema>;

/**
 * T547 (G4, R-318): the worker's own request for a running conversation's log from a seq - after a
 * panel's resync, after a gap in the seqs it forwarded, or after the broker greets a new relay. The
 * broker answers with a `conversation-result` and the pages. Not a panel command.
 */
export const conversationPageRequestSchema = z.strictObject({
  type: z.literal("worker.conversation.page"),
  payload: z.strictObject({ conversationId: conversationIdSchema, fromSeq: z.number().int().nonnegative() }),
});

/** What a `conversation-command` frame can carry: the owner's commands and the worker's page request. */
export const conversationLinkCommandSchema = z.discriminatedUnion("type", [
  ...conversationCommandSchema.options,
  conversationPageRequestSchema,
]);
export type ConversationLinkCommand = z.infer<typeof conversationLinkCommandSchema>;

/* ------------------------------------------------------------------------------------------- */
/* Link frames (contracts "Worker <-> broker"); each names the broker's session, as other routed */
/* frames do, so the relay forwards them unchanged (R-323).                                       */
/* ------------------------------------------------------------------------------------------- */

const brokerSessionId = z.string().min(1).max(128);

/**
 * Relay to broker, when the relay's stdin ended: the broker redials for 15 s and keeps running only
 * if a relay of the same `browserRunId` admits it (R-312). It names the broker's session like every
 * frame the relay routes, and carries nothing else.
 */
export const relayGoneFrameSchema = z.strictObject({
  type: z.literal("relay-gone"),
  sessionId: brokerSessionId,
});

export const conversationCommandFrameSchema = z.strictObject({
  type: z.literal("conversation-command"),
  sessionId: brokerSessionId,
  commandId: z.string().min(1).max(128),
  /** An owner's command, or the worker's page request (T547, G4). */
  command: conversationLinkCommandSchema,
});

/** The one-time consent as the broker records it (FR-299); "unknown" until the owner answered. */
export const CONVERSATION_CONSENT_STATES = ["unknown", "granted", "withdrawn"] as const;

const resultValueSchema = z.strictObject({ conversationId: conversationIdSchema.optional() }).optional();

/**
 * The broker's answer to one command. `value` is what the command produced, if anything: today
 * only `start` has something to say (the id it minted).
 */
export const conversationResultFrameSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("conversation-result"),
    sessionId: brokerSessionId,
    commandId: z.string().min(1).max(128),
    ok: z.literal(true),
    value: resultValueSchema,
  }),
  z.strictObject({
    type: z.literal("conversation-result"),
    sessionId: brokerSessionId,
    commandId: z.string().min(1).max(128),
    ok: z.literal(false),
    error: conversationErrorSchema,
  }),
]);

export const conversationEventFrameSchema = z.strictObject({
  type: z.literal("conversation-event"),
  sessionId: brokerSessionId,
  ...conversationEventPayloadSchema.shape,
});

/**
 * T563: what the broker could not keep of the list. A code only - the panel says it in the owner's
 * language - so no broker text (and no path of the file kept aside) reaches the panel.
 */
export const CONVERSATION_LIST_NOTICES = ["index-unreadable"] as const;

/** The list without content: index fields and state, the agents' availability, the owner's folders. */
export const conversationOverviewFrameSchema = z.strictObject({
  type: z.literal("conversation-overview"),
  sessionId: brokerSessionId,
  conversations: z.array(conversationViewSchema).max(CONVERSATION_MAX_ENTRIES),
  agents: z.array(conversationAgentAvailabilitySchema).max(CONVERSATION_AGENTS.length),
  folders: z.array(conversationFolderEntrySchema).max(CONVERSATION_MAX_FOLDERS),
  /**
   * T547: the broker's consent record, so a worker that restarted (and so remembers nothing) shows
   * the owner's answer rather than asking again. Optional, as every 019 addition is (R-323).
   */
  consent: z.enum(CONVERSATION_CONSENT_STATES).optional(),
  notice: z.enum(CONVERSATION_LIST_NOTICES).optional(),
});

/**
 * One page of a running conversation's log (R-318). Each event keeps its own `seq`, because the
 * broker coalesces old text and the numbers need not be contiguous. A page stays under 256 KB so
 * the frame stays far under the 1 MB link cap.
 */
export const conversationPageFrameSchema = z.strictObject({
  type: z.literal("conversation-page"),
  sessionId: brokerSessionId,
  conversationId: conversationIdSchema,
  fromSeq: z.number().int().nonnegative(),
  events: z
    .array(conversationLogEntrySchema)
    .max(4096)
    .refine((events) => JSON.stringify(events).length <= CONVERSATION_PAGE_MAX_BYTES, {
      message: "a page of the log is at most 256 KB",
    }),
  more: z.boolean(),
});

/**
 * The broker handing the worker the token for a conversation's browser connection (R-321), or
 * `token: null` to revoke it. A start tab goes only with a token.
 */
export const conversationBrowserTokenFrameSchema = z
  .strictObject({
    type: z.literal("conversation-browser-token"),
    sessionId: brokerSessionId,
    conversationId: conversationIdSchema,
    token: z.string().min(32).max(128).nullable(),
    startTabId: z.number().int().nonnegative().optional(),
  })
  .refine((frame) => frame.token !== null || frame.startTabId === undefined, {
    message: "a revocation names no start tab",
    path: ["startTabId"],
  });

/* ------------------------------------------------------------------------------------------- */
/* Panel state and message (contracts "Worker -> panel")                                         */
/* ------------------------------------------------------------------------------------------- */

/** Why the Conversation tab has nothing to offer: the host is too old, or its broker is not there. */
export const CONVERSATION_UNAVAILABLE_REASONS = ["host-outdated", "broker-unavailable"] as const;

/**
 * The panel's picture of the feature: the one-time consent (FR-299), the list, the open
 * conversation, the agents and the owner's folders. No conversation content - that arrives as
 * `conversation-event` messages and pages (D-019-6).
 */
export const conversationPanelStateSchema = z.strictObject({
  available: z.boolean(),
  reason: z.enum(CONVERSATION_UNAVAILABLE_REASONS).optional(),
  consent: z.enum(CONVERSATION_CONSENT_STATES),
  conversations: z.array(conversationViewSchema).max(CONVERSATION_MAX_ENTRIES),
  active: conversationIdSchema.optional(),
  agents: z.array(conversationAgentAvailabilitySchema).max(CONVERSATION_AGENTS.length),
  folders: z.array(conversationFolderEntrySchema).max(CONVERSATION_MAX_FOLDERS),
  notice: z.enum(CONVERSATION_LIST_NOTICES).optional(),
  /**
   * T572: the session of the broker whose events the panel shows. A new broker restarts every seq,
   * so a panel that sees this change drops what it holds and pages again from 0.
   */
  epoch: z.string().min(1).max(128).optional(),
});
export type ConversationPanelState = z.infer<typeof conversationPanelStateSchema>;

/** A broker event forwarded to every open panel document (FR-288). */
export const conversationPanelEventMessageSchema = z.strictObject({
  type: z.literal("conversation-event"),
  payload: conversationEventPayloadSchema,
});

/**
 * T547 (G1): the broker's answer to one of the owner's commands, passed to every panel document
 * under the commandId the panel gave it (or the worker's, for a command that named none). A failure
 * no broker could answer - none attached, or it left with the command in flight - is the worker's
 * own `broker-unavailable`.
 */
export const conversationPanelResultMessageSchema = z.strictObject({
  type: z.literal("conversation-result"),
  payload: z.discriminatedUnion("ok", [
    z.strictObject({ commandId: z.string().min(1).max(128), ok: z.literal(true), value: resultValueSchema }),
    z.strictObject({ commandId: z.string().min(1).max(128), ok: z.literal(false), error: conversationErrorSchema }),
  ]),
});
export type ConversationPanelResult = z.infer<typeof conversationPanelResultMessageSchema>["payload"];
