import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  CONVERSATION_AGENTS,
  CONVERSATION_DIAGNOSTIC_LINES_MAX,
  CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS,
  CONVERSATION_MAX_ATTACHMENTS,
  CONVERSATION_MODES,
  CONVERSATION_NOTICES,
  CONVERSATION_RULE_KINDS,
  CONVERSATION_TEXT_MAX_CHARS,
  CONVERSATION_TOOL_KINDS,
  type ConversationAccepts,
  type ConversationAgent,
  type ConversationAttachmentKind,
  type ConversationAttachmentSummary,
  type ConversationEntry,
  type ConversationError,
  type ConversationEvent,
  type ConversationEventPayload,
  type ConversationFolder,
  type ConversationMode,
  type ConversationState,
  type ConversationView,
} from "@hallpass/contracts";
import { isProcessAlive } from "../bridge-link.js";
import {
  AGENT_ADAPTERS,
  AGENT_DESCRIPTIONS,
  classifyStartFailure,
  type AdapterLaunchSpec,
  type AgentDescription,
  type StartFailureVersions,
} from "./agents.js";
import { ATTACHMENT_IDLE_MS, AttachmentStore, type AttachPiece, type ReadyAttachment } from "./attachments.js";
import { PANEL_SERVER_NAME, type ConversationBrowserAccess, type PanelServerName } from "./browser-token.js";
import type { ConversationIndex, FolderList } from "./conversation-index.js";
import { ConversationEventLog, type ConversationPage } from "./event-log.js";
import { ensureScratchFolder, isDirectory, scratchFolderPath } from "./folders.js";
import { redact, withoutEnvironmentValues, withoutUserProfile } from "./redact.js";
import { killTree } from "./run-command.js";
import { defaultUserEnvironmentPorts, keyNameOnlyInUserSettings, type UserEnvironmentPorts } from "./user-environment.js";

/**
 * One conversation with the owner's own coding agent, and the broker's pool of them (019 T539;
 * R-316 modes, R-317 permissions, R-318 the live log, R-319 lease, FR-289 - FR-298, FR-311).
 *
 * A `Conversation` owns one agent process at a time - the pinned ACP adapter, or under test the fake
 * agent - started as a child of the broker, so it sits inside the broker's kill-on-close job (R-313).
 * It speaks ACP as the client over the agent's stdio, through the SDK's `client()` builder.
 *
 * Its rules, each cited where it is enforced:
 * - strict is set *and confirmed* after every `session/new` and `session/load` before anything else
 *   is sent (R-316, FR-289); the panel's two modes map to an allow-list per agent and nothing else is
 *   ever sent or shown (FR-292, SC-140);
 * - a mode change the owner did not make cancels the turn, puts the owner's mode back and says so;
 * - permission answers are the adapter's *once* options; "for this conversation" is a broker rule
 *   (R-317); no answer means the agent waits, with no timer (FR-294);
 * - text is coalesced to at most one frame per 50 ms; every event goes into a 256 KB log (R-318);
 * - an unexpected exit is `crashed` plus an `agent-exited` notice, never a retry (FR-298).
 *
 * Everything shown to the owner - text, titles, summaries, notes, notices - passes `redact()` (R-326).
 *
 * The `ConversationPool` holds them: the cap of three live agents with idle-longest eviction
 * (FR-311), the 10-minute idle stop and resume through `session/load` (FR-297), the index entry and
 * its lease across browsers (R-319). The index and folder list are the seams of
 * `conversation-index.ts`, host files since S7 (`index-store.ts`, `folders.ts`).
 *
 * The browser connection (S6, T552; R-321, R-322; `browser-token.ts`) belongs to the agent run: a
 * token minted when the agent is spawned and handed to the worker before `initialize`, the same token
 * in the `hallpass` entry of every `session/new` / `session/load` of that run (a mode reload too),
 * handed again with each message's start tab, revoked when the agent ends however it ends.
 */

export const CONVERSATION_IDLE_MS = 10 * 60_000;
export const CONVERSATION_RUNNING_CAP = 3;
/** R-318: at most one text frame per conversation per 50 ms. */
export const TEXT_FRAME_INTERVAL_MS = 50;
/** How long an agent gets to leave after its stdin closes before it is killed (R-312's 3 s). */
const AGENT_STOP_BOUND_MS = 3_000;
/** T577: how often a conversation listed as in use in another browser is looked at again. */
const LEASE_RECHECK_MS = 1_000;
/**
 * 023 R-367: how much of one line of the agent's error output is read before it is scrubbed and cut to
 * 500 characters - room for a variable's value that starts just before the 500th character to be
 * recognised whole. A value the read limit itself cuts is dropped with the cut (`withoutCutValue`).
 */
const OUTPUT_LINE_READ_MAX = 16 * 1024;
/** `withoutEnvironmentValues` replaces values of at least this many characters (SC-161). */
const SCRUBBED_VALUE_MIN = 8;

/**
 * 023 R-367: `text`, cut short at a read limit, without its longest ending that a value of `env` (one
 * `withoutEnvironmentValues` would replace) begins with - what is left of a value the cut went through.
 * A value the cut did not touch stays whole and is scrubbed as before.
 */
function withoutCutValue(text: string, env: Readonly<Record<string, string | undefined>>): string {
  let drop = 0;
  for (const value of Object.values(env)) {
    if (typeof value !== "string" || value.length < SCRUBBED_VALUE_MIN) continue;
    // Only endings shorter than the value: a whole value is found by the scrub.
    const from = Math.max(text.length - value.length + 1, 0);
    for (let at = text.indexOf(value[0]!, from); at >= 0 && text.length - at > drop; at = text.indexOf(value[0]!, at + 1)) {
      if (value.startsWith(text.slice(at))) {
        drop = text.length - at;
        break;
      }
    }
  }
  return text.slice(0, text.length - drop);
}
/** 023 R-365: how long after `session/new` / `session/load` a checked agent's `hallpass` server has to greet. */
export const BROWSER_CHECK_MS = 10_000;
/** 023 R-365 (D-023-2): what each agent's `browser-tools-missing` says; the panel words it in its own locale. */
const BROWSER_TOOLS_MISSING: Readonly<Record<ConversationAgent, string>> = {
  "claude-code": "Claude Code did not take Hallpass's browser tools.",
  codex: "Codex did not take Hallpass's browser tools.",
  hermes:
    "Hermes did not take Hallpass's browser tools, so it cannot use this browser. Hermes needs its optional MCP component for them: add it to your Hermes installation, then start a new conversation.",
  deepseek: "DeepSeek cannot use Hallpass's browser tools. To show it a page, attach a screenshot or the current tab.",
};
const NEW_TITLE = "New conversation";

export type ClockTimer = { cancel(): void };
/** Injected so tests can skip the idle limit (T538) while coalescing still runs on real time. */
export type Clock = { now(): number; setTimer(fn: () => void, ms: number): ClockTimer };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * R-316 / R-351 (T657): the panel's two modes and the agent mode behind each, from the agent
 * descriptions. An agent's other modes (Claude's `acceptEdits`, `plan`, `bypassPermissions`; Codex's
 * `agent-full-access`; Hermes' `dont_ask`) are never sent and never shown; the panel only ever sees
 * `strict` / `agent-review`. An agent without ACP modes (DeepSeek) has none here: its mode is the
 * launch environment alone, and nothing is ever sent as `session/set_mode` to it.
 */
export const MODE_ALLOW_LIST: Readonly<Record<ConversationAgent, Readonly<Partial<Record<ConversationMode, string>>>>> =
  Object.fromEntries(
    CONVERSATION_AGENTS.map((agent) => [
      agent,
      Object.fromEntries(
        CONVERSATION_MODES.flatMap((mode) => {
          const id = (AGENT_DESCRIPTIONS[agent] as AgentDescription).modes[mode].agentMode;
          return id === undefined ? [] : [[mode, id]];
        }),
      ),
    ]),
  ) as Record<ConversationAgent, Partial<Record<ConversationMode, string>>>;

/** The agent's own mode id behind a panel mode, if the agent has ACP modes. */
const agentModeId = (agent: ConversationAgent, mode: ConversationMode): string | undefined => MODE_ALLOW_LIST[agent][mode];

/**
 * R-351: Hermes' tools are fixed when it starts, so this mode change restarts it. A fixed-mode agent
 * (DeepSeek, D-021-16) is refused `mode-fixed` before this is asked, and is never restarted for a mode.
 */
export function restartsForMode(agent: ConversationAgent, from: ConversationMode, to: ConversationMode): boolean {
  if (from === to) return false;
  const modes = AGENT_DESCRIPTIONS[agent].modes;
  return modes[from].atLaunch || modes[to].atLaunch;
}

/**
 * D-021-16 (R-359): the agent keeps the mode its session was created with (DeepSeek), so the mode is
 * chosen with the start, a resume continues in it, and a change is refused - never a restart.
 */
export function modeFixedOnceStarted(agent: ConversationAgent): boolean {
  return AGENT_DESCRIPTIONS[agent].modeFixedOnceStarted;
}

const modeFixed = (agent: ConversationAgent): { ok: false; error: ConversationError } =>
  failure("mode-fixed", `${AGENT_DESCRIPTIONS[agent].label} keeps the mode its conversation started with; start a new conversation for another mode.`);

/**
 * D-019-12 (T542a; R-317 "Measured in S4"): the tools Claude must ask about in strict mode, whatever
 * the owner's own `permissions.allow` says. Passed as conversation-scoped settings on `session/new`
 * and `session/load`; the owner's MCP servers, hooks and instructions still load. Never in the
 * agent-review mode (the same rules make `auto` ask for edits too), never for Codex: its adapter's
 * `read-only` mode alone does not ask (it sends a writable `workspaceWrite` sandbox on every turn;
 * measured with codex-cli 0.163.0 / codex-acp 1.13.1, and the earlier "it asks" card was a Windows
 * sandbox failure of 0.162.1). Codex strict is enforced by Hallpass's app-server shim behind
 * `CODEX_PATH` instead, which makes those turns read-only (`codex-strict.ts`; D-019-12, R-317).
 */
export const CLAUDE_STRICT_ASK_RULES: readonly string[] = ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell"];

/** The `_meta` a `session/new` / `session/load` carries for this agent in this mode (D-019-12), if any. */
export function sessionMeta(agent: ConversationAgent, mode: ConversationMode): { _meta: Record<string, unknown> } | undefined {
  if (agent !== "claude-code" || mode !== "strict") return undefined;
  return { _meta: { claudeCode: { options: { settings: { permissions: { ask: [...CLAUDE_STRICT_ASK_RULES] } } } } } };
}

/**
 * R-322 (T566): agents whose adapter starts a title-generation thread after a new session's first
 * turn - without the session's servers, so with the owner's own `hallpass`. A title set first stops
 * it: the first message of a new session goes after `/rename <title>`, which the Codex adapter
 * answers itself (no model call). A loaded session never generates one, so a resume needs none.
 */
const RENAME_FIRST: Readonly<Record<ConversationAgent, boolean>> = { "claude-code": false, codex: true, hermes: false, deepseek: false };

/** T542a: what the `mode` event says after a switch that reloaded the conversation. */
const RELOAD_NOTE: Readonly<Record<ConversationMode, string>> = {
  strict: "Hallpass reloaded the conversation with its strict rules: edits and commands ask you first, whatever your own settings allow.",
  "agent-review": "Hallpass reloaded the conversation without its strict rules: your own agent settings and the agent's review apply.",
};

/** 021 R-351: what the `mode` event says after a switch that restarted a launch-time agent. */
const RESTART_NOTE: Readonly<Record<ConversationMode, string>> = {
  strict: "Hallpass restarted the agent with its strict settings: edits and commands ask you first.",
  "agent-review": "Hallpass restarted the agent with its automatic settings: the agent's own review applies.",
};

export type CommandOutcome<T = undefined> = { ok: true; value?: T } | { ok: false; error: ConversationError };
/** Whether an agent run may start - a new conversation's, or a stopped one's again (the broker's consent check, FR-299). */
export type ResumeGate = () => Promise<CommandOutcome>;
export type LaunchResolution =
  | { ok: true; spec: AdapterLaunchSpec; versions: StartFailureVersions }
  | { ok: false; error: ConversationError };

const failure = (code: ConversationError["code"], detail: string): { ok: false; error: ConversationError } => ({
  ok: false,
  error: { code, detail: clip(redact(detail), 600) },
});

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(max - 3, 0))}...`;
}

const shown = (text: string, max: number) => clip(redact(text), max);

type ToolKind = (typeof CONVERSATION_TOOL_KINDS)[number];

function toolKind(kind: unknown): ToolKind {
  return typeof kind === "string" && (CONVERSATION_TOOL_KINDS as readonly string[]).includes(kind) ? (kind as ToolKind) : "other";
}

/** The adapter's own name for the tool, when it gives one (the Claude adapter's `_meta.claudeCode.toolName`). */
function adapterToolName(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const value of Object.values(meta as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const name = (value as { toolName?: unknown }).toolName;
      if (typeof name === "string" && name.length > 0) return name;
    }
  }
  return undefined;
}

/**
 * R-317: what an "allow for this conversation" rule is keyed by. The tool's kind for the kinds that
 * change something; for `other` the tool's own name (finding 7: one MCP tool allowed must not allow
 * every MCP tool), else its title. `read`, `search`, `think` never get a rule. An `other` with neither
 * a name nor a title (DeepSeek announces every action so) gets none either: one key for all of them
 * would let one answer allow every later action, so "for this conversation" acts as allow-once (T668).
 */
export function permissionRuleKey(toolCall: {
  toolCallId?: string;
  kind?: string | null;
  title?: string | null;
  _meta?: unknown;
}): string | undefined {
  const kind = toolKind(toolCall.kind);
  if (!(CONVERSATION_RULE_KINDS as readonly string[]).includes(kind)) return undefined;
  if (kind !== "other") return kind;
  const name = adapterToolName(toolCall._meta) ?? (toolCall.title?.trim() ? toolCall.title : undefined);
  return name === undefined ? undefined : `other:${name}`;
}

/**
 * R-317 / SC-135: Codex's request for wider sandbox permissions - codex-acp 1.13.1 sends it with the
 * tool name `request_permissions` and `_meta.permission.title` "Grant permissions?". Each of its
 * allow options grants for the rest of the turn or the session, never for one action, so in strict
 * mode the broker declines it itself, and in no mode does it become a conversation rule.
 */
export function isCodexSandboxPermissionsRequest(params: {
  toolCall: unknown;
  _meta?: { [key: string]: unknown } | null;
}): boolean {
  const name = params.toolCall && typeof params.toolCall === "object" ? (params.toolCall as { name?: unknown }).name : undefined;
  const permission = params._meta?.permission;
  const title = permission && typeof permission === "object" ? (permission as { title?: unknown }).title : undefined;
  return name === "request_permissions" || title === "Grant permissions?";
}

/** The notice of a declined sandbox-permissions request; the panel says it in the owner's language. */
const SANDBOX_PERMISSIONS_DECLINED: (typeof CONVERSATION_NOTICES)[number] = "sandbox-permissions-declined";

/** A short description of a tool's input: the command, the path, the URL, or its JSON (FR-287). */
function summarizeInput(rawInput: unknown, locations?: ReadonlyArray<{ path: string }> | null): string {
  if (rawInput && typeof rawInput === "object") {
    const input = rawInput as Record<string, unknown>;
    for (const key of ["command", "cmd", "file_path", "filePath", "path", "notebook_path", "url", "pattern", "query"]) {
      const value = input[key];
      if (typeof value === "string" && value) return value;
      if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
    }
    try {
      return JSON.stringify(rawInput);
    } catch {
      return "";
    }
  }
  if (typeof rawInput === "string") return rawInput;
  return locations?.map((location) => location.path).join(", ") ?? "";
}

/** What a card says beyond its title: the input, and for an edit the file and the start of the change (FR-290). */
function permissionDetail(toolCall: acp.ToolCallUpdate): string {
  const parts = [summarizeInput(toolCall.rawInput, toolCall.locations)];
  for (const item of toolCall.content ?? []) {
    if (item.type === "diff") parts.push(`${item.path}\n${item.newText.slice(0, 1_500)}`);
    else if (item.type === "content" && item.content.type === "text") parts.push(item.content.text.slice(0, 1_500));
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * R-353 / FR-353: what an announced action says for a card that names only its id - the input, the
 * change, and the agent's own reason for it (DeepSeek's `rawInput.justification`).
 */
function announcedDetail(update: acp.ToolCallUpdate): string {
  const input = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Record<string, unknown>) : undefined;
  const reason = [input?.justification, input?.reason].find((value): value is string => typeof value === "string" && value.length > 0);
  return [permissionDetail(update), reason ?? ""].filter(Boolean).join("\n");
}

const TOOL_STATUS: Record<string, "pending" | "running" | "done" | "failed"> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

/**
 * T572: the notice code of a turn the agent ended for another reason than `end_turn` / `cancelled`
 * (ACP `StopReason`). Fixed codes only: an agent's own reason can outgrow the contract's code bound.
 */
const STOP_NOTICE_CODES: Readonly<Partial<Record<string, string>>> = {
  max_tokens: "stop-max_tokens",
  max_turn_requests: "stop-max_turn_requests",
  refusal: "stop-refusal",
};

/**
 * 022 R-336 / FR-333: a message's prompt - its text (if any), each picture as an image, the tab as
 * one text resource (its title, a blank line, its text), and one text block naming each file with
 * its path. A message without attachments is the one text block it always was. 023 R-366: a tab
 * written to a file (an agent without page context) is named in that block like a file instead.
 */
export function promptBlocks(text: string, attachments: readonly ReadyAttachment[]): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];
  if (text.length > 0 || attachments.length === 0) blocks.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment.kind === "image") blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
  }
  for (const attachment of attachments) {
    if (attachment.kind === "tab" && attachment.file === undefined) {
      blocks.push({
        type: "resource",
        resource: { uri: attachment.url, mimeType: "text/plain", text: `${attachment.title}\n\n${attachment.text}` },
      });
    }
  }
  const files = attachments.flatMap((attachment) =>
    attachment.kind === "file"
      ? [`- ${attachment.name}: ${attachment.path}`]
      : attachment.kind === "tab" && attachment.file !== undefined
        ? [`- ${attachment.file.name}: ${attachment.file.path}`]
        : [],
  );
  if (files.length > 0) blocks.push({ type: "text", text: files.join("\n") });
  return blocks;
}

/**
 * R-343: the owner's bubble's attachments, in the order the owner added them (the send's ids), as
 * the composer showed them - not the prompt's order; a thumbnail only for a picture.
 */
function attachmentSummaries(attachments: readonly ReadyAttachment[]): ConversationAttachmentSummary[] {
  return attachments.map((attachment): ConversationAttachmentSummary => {
    switch (attachment.kind) {
      case "image":
        return {
          kind: "image",
          name: attachment.name,
          size: attachment.size,
          ...(attachment.thumbnail === undefined ? {} : { thumbnail: attachment.thumbnail }),
        };
      case "tab":
        return { kind: "tab", name: attachment.name, ...(attachment.cut ? { cut: true } : {}) };
      case "file":
        return { kind: "file", name: attachment.name, size: attachment.size, path: attachment.path };
    }
  });
}

/** R-343: a picture the agent replays of the owner's earlier message; the broker cannot shrink it. */
const REPLAYED_IMAGE: ConversationAttachmentSummary = { kind: "image", name: "image" };

type OwnerAnswer = "allow-once" | "reject" | "allow-conversation";
type Closure = OwnerAnswer | "by-rule" | "cancelled" | "agent-exited";

type Card = {
  requestId: string;
  toolCallId: string;
  ruleKey: string | undefined;
  options: acp.PermissionOption[];
  /** R-353: neither the request nor an announced action says what it is - only Reject may answer it. */
  rejectOnly: boolean;
  resolve: (response: acp.RequestPermissionResponse) => void;
};

/** R-353: what the agent announced about an action (`tool_call` / `tool_call_update`) during this turn. */
type Announced = { title?: string; kind?: ToolKind; detail?: string };

/** What an owner's answer did (`Conversation.answer`). */
export type AnswerResult = "answered" | "not-open" | "reject-only";

/** `stopped`: the owner pressed Stop; the conversation says so when the turn ends (US1.4). */
type Turn = { cancelled: boolean; stopped: boolean; rejected: Set<string>; thinkingSaid?: true };

type ToolView = {
  kind: ToolKind;
  title: string;
  inputSummary: string;
  status: "pending" | "running" | "done" | "failed" | "refused";
  byRule?: true;
};

export type ConversationDeps = {
  clock: Clock;
  onEvent: (payload: ConversationEventPayload) => void;
  /** Every state change (the pool clears the lease and refreshes the overview). */
  onStateChange?: (conversation: Conversation) => void;
  /** The idle limit passed with no turn and no card (FR-297). */
  onIdle?: (conversation: Conversation) => void;
  idleMs?: number;
  spawnAgent?: (spec: AdapterLaunchSpec, cwd: string) => ChildProcess;
  /** S6 (T552, R-321/R-322): the browser connection handed to each agent run. None: no `mcpServers`. */
  browser?: ConversationBrowserAccess;
  log?: (code: string, detail?: string) => void;
  /** 023 R-369: what the key-name check reads; the machine's own by default. */
  userEnvironment?: UserEnvironmentPorts;
};

export type StartRequest = {
  cwd: string;
  spec: AdapterLaunchSpec;
  versions: StartFailureVersions;
  /**
   * The agent's own session id: continue it instead of `session/new` - with `session/load` (replayed),
   * or with `session/resume` (not replayed, R-352) when that is all the agent offers.
   */
  resume?: string;
  /** 021 R-351: the panel mode this run starts in - strict unless a restart for a launch-time mode. */
  mode?: ConversationMode;
  /** 021 R-351: this run replaces a live one of the same conversation for a mode change; its rules stay. */
  restart?: true;
  /**
   * T579 (D-019-14, R-331): asked at the hand-out itself - nothing awaits between it and the token's mint -
   * whether no withdrawal came since the caller's consent check began; `false` starts nothing.
   */
  mayHandOut?: () => boolean;
};

export type StartOutcome =
  | { ok: true; agentSessionId: string }
  | { ok: false; error: ConversationError; unknownSession?: boolean };

/**
 * The broker's own process tree: a plain child, stdio piped. 023 R-367 (replaces R-326's ignored
 * stderr): its error output is piped too and always read, into the run's scrubbed diagnostic lines.
 */
export function spawnAgentProcess(spec: AdapterLaunchSpec, cwd: string): ChildProcess {
  return spawn(spec.command, spec.args, {
    cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // 021: a batch-file agent (Hermes' hermes-acp.cmd) comes as one command line quoted for cmd.exe.
    ...(spec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
  });
}

/** 024 R-387: agent runs of this broker in the order they started - a conversation's or a test's. */
let runSerials = 0;
export const nextRunSerial = (): number => ++runSerials;

/** Lets SDK notification handlers that were dispatched before a response settle (they run on microtasks). */
const settle = () => new Promise<void>((done) => setImmediate(done));

class AgentExited extends Error {
  constructor(readonly code: number | null) {
    super(`the agent exited${code === null ? "" : ` (exit ${code})`}`);
  }
}

export class Conversation {
  readonly log = new ConversationEventLog();
  private stateValue: ConversationState = "stopped";
  private modeValue: ConversationMode = "strict";
  /**
   * The agent's mode id the owner chose (through `mode`); anything else reported is drift. None for
   * an agent without ACP modes (DeepSeek): its mode is its launch environment (R-351).
   */
  private ownerModeId: string | undefined;
  /** R-316: drift is watched only once strict has been confirmed. */
  private watchingMode = false;
  /** The last mode the agent reported since it was last set, for the confirmation. */
  private reportedModeId: string | undefined;
  private sessionId: string | undefined;
  private child: ChildProcess | undefined;
  /** R-321: this agent run's browser token; minted at spawn, revoked at its exit. Never logged. */
  private browserToken: string | undefined;
  /**
   * T558 + R-322: after a withdrawal, the token a mode reload's entry carries instead - minted, never
   * handed to the worker, so that server is refused `not-admitted` while the entry still keeps the
   * owner's own `hallpass` out of the reloaded session. Never logged; gone with the run.
   */
  private inertToken: string | undefined;
  /** R-322: this run's entry name, decided before `session/new` and kept for a mode reload. */
  private serverName: PanelServerName = PANEL_SERVER_NAME;
  /** R-322: this run began with `session/new` and has not had its first message yet (RENAME_FIRST). */
  private renamePending = false;
  /** The broker's own `/rename` is in flight: what the agent says to it is not the owner's to see. */
  private muted = false;
  private connection: acp.ClientConnection | undefined;
  private exited: Promise<never> | undefined;
  /** `starting`: closed for a restart (R-351) - the next run of the same conversation follows at once. */
  private closing: { target: "stopped" | "gone" | "starting" } | undefined;
  private turn: Turn | undefined;
  private readonly cards = new Map<string, Card>();
  private cardCounter = 0;
  /** R-317: "for this conversation" rules, memory only and not resumed. */
  private readonly rules = new Set<string>();
  private readonly tools = new Map<string, ToolView>();
  /** R-353: this turn's announced actions by `toolCallId`, for a card whose request names only the id. */
  private readonly announced = new Map<string, Announced>();
  /** R-354: the owner stopped this conversation while it was starting; the start ends `start-cancelled`. */
  private cancelRequested = false;
  /**
   * R-352: this broker continued the conversation with `session/resume` before showing any of it, so
   * the agent replayed none of its earlier turns (the projection's `replay: "none"`).
   */
  private replayNoneValue = false;
  /** SC-161: the environment Hallpass added for this run; its values never reach a log or the panel. */
  private launchEnv: Readonly<Record<string, string>> = {};
  /** `session/load` replay: shown when this broker has no log of it yet, dropped when it has. */
  private replay: "off" | "show" | "drop" = "off";
  /**
   * SC-137: this broker has shown some of the conversation itself (text or a tool). Its own state,
   * mode and notice entries do not count: a new broker's resume has logged `starting` by then.
   */
  private contentShown = false;
  /** R-322: where a shown replay is in the broker's own `/rename` exchange (`isRenameReplay`). */
  private renameReplay: "off" | "first" | "reply" = "off";
  /** The folder the agent runs in; a mode reload loads the session there again (T542a). */
  private cwd: string | undefined;
  /** T542a: a mode switch that reloads the session is in flight; nothing else is sent meanwhile. */
  private reloading = false;
  /** A drift's `session/set_mode` back to the owner's mode, while it is in flight (R-316). */
  private modeReset: Promise<void> | undefined;
  private readonly outbox: ConversationEvent[] = [];
  private lastTextAt = Number.NEGATIVE_INFINITY;
  private flushTimer: ClockTimer | undefined;
  private idleTimer: ClockTimer | undefined;
  private lastActivity: number;
  /** 022 R-336: what this run's agent said at `initialize` it takes besides text. */
  private acceptsValue: ConversationAccepts | undefined;
  /** 023 R-365: this run's `hallpass` server greeted (the worker's `conversation-browser-attached`). */
  private browserAttachedRun = false;
  /** 023 R-365: the 10 s after session creation or load within which that greeting is expected. */
  private browserCheck: ClockTimer | undefined;
  /** 023 R-365 (data-model `browserNoticeSent`): one `browser-tools-missing` per conversation, restarts included. */
  private browserNoticeSent = false;
  /** 023 R-369: a turn of this run went through - a later failure is not the "first message" any more. */
  private turnWentThrough = false;
  /** 023 R-369: this run already looked for a key the browser cannot see. */
  private keyNameChecked = false;
  /** 024 R-379: that look, once begun: resolves with the variable it named, if any. */
  private keyNameCheck: Promise<string | undefined> | undefined;
  /**
   * 023 R-367 (FR-371/372): the last lines the latest run printed about itself, scrubbed and cut.
   * Memory only - never logged, never written; a new run starts a new list, removal drops it.
   */
  private outputLines: string[] = [];
  /** 024 R-387: when this conversation's latest run started, among every run of this broker; 0 before one. */
  private runSerialValue = 0;

  constructor(
    readonly conversationId: string,
    readonly agent: ConversationAgent,
    private readonly deps: ConversationDeps,
  ) {
    this.ownerModeId = agentModeId(agent, "strict");
    this.lastActivity = deps.clock.now();
  }

  /** R-352: the agent continued this conversation without replaying its earlier turns here. */
  get replayNone(): boolean {
    return this.replayNoneValue;
  }

  get state(): ConversationState {
    return this.stateValue;
  }

  get mode(): ConversationMode {
    return this.modeValue;
  }

  get agentSessionId(): string | undefined {
    return this.sessionId;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** When it last did something; the cap evicts the live one with the oldest (FR-311). */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** 022 R-336 / R-344: pictures and page context, as the agent's last `initialize` said; unknown before one. */
  get accepts(): ConversationAccepts | undefined {
    return this.acceptsValue;
  }

  /** Has an agent process (starting, idle, running or waiting). */
  get live(): boolean {
    return this.child !== undefined;
  }

  /** Idle for the cap: no turn and no card (data-model: only `idle` counts). */
  get evictable(): boolean {
    return this.stateValue === "idle" && this.turn === undefined && this.cards.size === 0 && !this.reloading;
  }

  /* ----------------------------------------------------------------------------------------- */
  /* Start and resume                                                                           */
  /* ----------------------------------------------------------------------------------------- */

  async start(request: StartRequest): Promise<StartOutcome> {
    // T572: one agent process per conversation; a second would be orphaned and write into this log.
    if (this.child !== undefined) return failure("busy", "The agent of this conversation is already running.");
    // R-354: stopped while it waited for its slot, its folder or the consent check - nothing is spawned.
    if (this.cancelRequested) return this.startCancelled();
    if (request.mayHandOut?.() === false) {
      this.setState(request.resume ? "stopped" : "gone");
      return failure("consent-needed", "You withdrew the side-panel agent's access to this browser; the agent was not started.");
    }
    // FR-289: every resume is strict; a first start is in the mode chosen before its first message
    // (FR-361), a restart in its launch-time mode, and (D-021-16) a fixed-mode agent resumes in its own.
    const mode = request.mode ?? "strict";
    this.closing = undefined;
    if (request.restart === undefined) this.rules.clear();
    this.watchingMode = false;
    this.reloading = false;
    this.cwd = request.cwd;
    this.modeValue = mode;
    this.ownerModeId = agentModeId(this.agent, mode);
    this.announced.clear();
    this.launchEnv = request.spec.env;
    this.renamePending = false;
    this.muted = false;
    this.inertToken = undefined;
    // 023 R-365: a new run, a new greeting to wait for (it may come before `session/new` answers).
    this.browserAttachedRun = false;
    this.cancelBrowserCheck();
    this.turnWentThrough = false;
    this.keyNameChecked = false;
    this.keyNameCheck = undefined;
    this.setState("starting");
    // R-322: decided once per run (the owner's Codex config may have changed since the last one),
    // read while the agent initialises.
    const naming: Promise<PanelServerName> = (this.deps.browser?.serverName(this.agent) ?? Promise.resolve(PANEL_SERVER_NAME)).catch(
      (): PanelServerName => PANEL_SERVER_NAME,
    );

    let child: ChildProcess;
    try {
      child = (this.deps.spawnAgent ?? spawnAgentProcess)(request.spec, request.cwd);
    } catch (error) {
      this.setState(request.resume ? "stopped" : "gone");
      return { ok: false, error: classifyStartFailure("initialize", error, request.versions, this.runEnv()) };
    }
    this.child = child;
    this.readOutput(child);
    this.exited = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code) => reject(new AgentExited(code)));
      child.once("error", (error) => reject(error));
    });
    this.exited.catch(() => undefined);
    child.once("exit", (code) => this.onExit(child, code));
    child.once("error", () => this.onExit(child, null));
    child.stdin?.on("error", () => undefined);
    // R-321: a new run, a new token - with the worker before the agent can start the mcp-server.
    const browser = this.deps.browser;
    if (browser !== undefined) {
      this.browserToken = browser.mint();
      browser.grant({ conversationId: this.conversationId, token: this.browserToken });
    }
    const connection = acp
      .client({ name: "hallpass" })
      .onRequest("session/request_permission", ({ params }) => this.onPermission(params))
      .onNotification("session/update", ({ params }) => this.onUpdate(params))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        ),
      );
    this.connection = connection;

    let step: "initialize" | "session/new" | "session/load" | "session/resume" | "session/set_mode" = "initialize";
    try {
      const init = await this.request(() =>
        connection.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "hallpass", version: "0.0.0" },
        }),
      );
      // 022 R-336: ACP's baseline is text only; pictures and embedded context are what it says it takes.
      const promptCapabilities = init.agentCapabilities?.promptCapabilities;
      this.acceptsValue = { image: promptCapabilities?.image === true, context: promptCapabilities?.embeddedContext === true };
      this.serverName = await naming;
      const mcpServers = this.mcpServers();
      let modes: acp.SessionModeState | null | undefined;
      if (request.resume !== undefined && init.agentCapabilities?.loadSession !== true && init.agentCapabilities?.sessionCapabilities?.resume != null) {
        // R-352 (T666): an agent without `session/load` that resumes (DeepSeek) continues the session
        // without replaying it; what this broker never showed of it, the panel cannot show either.
        step = "session/resume";
        this.sessionId = request.resume;
        const resumed = await this.request(() =>
          connection.agent.request("session/resume", { sessionId: request.resume!, cwd: request.cwd, mcpServers }),
        );
        await settle();
        if (!this.contentShown) this.replayNoneValue = true;
        modes = resumed.modes;
      } else if (request.resume !== undefined) {
        step = "session/load";
        if (init.agentCapabilities?.loadSession !== true) throw new Error("the agent cannot load a conversation");
        this.sessionId = request.resume;
        this.replay = this.contentShown ? "drop" : "show";
        this.renameReplay = RENAME_FIRST[this.agent] ? "first" : "off";
        // D-019-12: every resume starts strict, so it loads with the strict ask rules (Claude).
        const loaded = await this.request(() =>
          connection.agent.request("session/load", {
            sessionId: request.resume!,
            cwd: request.cwd,
            mcpServers,
            ...sessionMeta(this.agent, mode),
          }),
        );
        await settle();
        this.flushText();
        this.replay = "off";
        modes = loaded.modes;
      } else {
        step = "session/new";
        const created = await this.request(() =>
          connection.agent.request("session/new", { cwd: request.cwd, mcpServers, ...sessionMeta(this.agent, mode) }),
        );
        this.sessionId = created.sessionId;
        modes = created.modes;
        this.renamePending = RENAME_FIRST[this.agent];
      }

      // R-316 / FR-289: the agent's mode, set and confirmed, before anything of the owner's goes out.
      // R-351: an agent without ACP modes (DeepSeek) runs in its launch environment's mode; nothing is set.
      const targetId = this.ownerModeId;
      if (targetId !== undefined) {
        step = "session/set_mode";
        if (!modes?.availableModes.some((mode) => mode.id === targetId)) {
          throw new Error(`the agent does not offer its "${targetId}" mode`);
        }
        this.reportedModeId = undefined;
        await this.request(() => connection.agent.request("session/set_mode", { sessionId: this.sessionId!, modeId: targetId }));
        await settle();
        if (this.reportedModeId !== undefined && this.reportedModeId !== targetId) {
          throw new Error(`the agent reported "${this.reportedModeId}" after being set to "${targetId}"`);
        }
      }
      this.watchingMode = true;
    } catch (error) {
      this.replay = "off";
      await this.kill();
      if (this.cancelRequested) return this.startCancelled();
      if (request.resume !== undefined) {
        this.setState("stopped");
        if (step === "session/load" || step === "session/resume") {
          const unknownSession = isUnknownSession(error);
          return {
            ok: false,
            unknownSession,
            error: failure(
              "cannot-resume",
              unknownSession
                ? `${AGENT_ADAPTERS[this.agent].label} no longer has this conversation.`
                : `${AGENT_ADAPTERS[this.agent].label} could not continue this conversation: ${this.scrubbed(errorMessage(error))}`,
            ).error,
          };
        }
      } else {
        this.setState("gone");
      }
      if (error instanceof AgentExited && step !== "initialize" && step !== "session/new") {
        return failure("agent-exited", `${AGENT_ADAPTERS[this.agent].label} ${this.scrubbed(error.message)} while starting.`);
      }
      const failedAt = step === "initialize" || step === "session/set_mode" ? step : "session/new";
      const refused = startFailure(this.agent, failedAt, error, request.versions, this.runEnv());
      if (refused.code === MODEL_UNREACHABLE_NOTICE) {
        this.deps.log?.("conversation.model-unreachable", `${this.conversationId} ${refused.detail}`);
        // 023 R-369: said before the start's own failure goes back, so it is in the conversation's log first.
        const variable = await this.sayKeyOnlyInUserSettings();
        // 023 R-369 (FR-369): a first start's conversation is dropped with its failure, so the notice
        // never reaches the panel; the same hint goes in the failure the panel does show. Name only.
        if (variable !== undefined && request.resume === undefined) {
          return { ok: false, error: startFailure(this.agent, failedAt, error, request.versions, this.runEnv(), keyEnvHint(this.agent, variable)) };
        }
      }
      return { ok: false, error: refused };
    }

    // R-354: stopped just as the start finished - the agent is already being killed.
    if (this.cancelRequested) {
      this.replay = "off";
      await this.kill();
      return this.startCancelled();
    }
    this.enqueue({ type: "mode", mode, ...(request.restart === undefined ? {} : { note: RESTART_NOTE[mode] }) });
    this.touch();
    this.setState("idle");
    this.armIdle();
    this.checkBrowserTools();
    return { ok: true, agentSessionId: this.sessionId! };
  }

  /**
   * 023 R-365 (D-023-2, FR-364): after the session was created or loaded, whether this run took the
   * browser tools. An agent that takes no MCP servers (DeepSeek) is told at once; one that starts them
   * before answering (Hermes) has 10 s for its server to greet; others are not checked (FR-374). Only
   * a run that was offered the tools - a browser connection, a token not withdrawn - is checked.
   */
  private checkBrowserTools(): void {
    if (this.browserNoticeSent || this.deps.browser === undefined) return;
    const description = AGENT_ADAPTERS[this.agent];
    if (!description.takesBrowserTools) {
      this.sayBrowserToolsMissing();
      return;
    }
    if (!description.checksBrowserTools || this.browserToken === undefined || this.browserAttachedRun) return;
    this.browserCheck = this.deps.clock.setTimer(() => {
      this.browserCheck = undefined;
      if (this.live && this.browserToken !== undefined && !this.browserAttachedRun) this.sayBrowserToolsMissing();
    }, BROWSER_CHECK_MS);
  }

  /**
   * 023 R-369 (D-023-6, FR-369/370): after a start or first turn failed for the agent's model or key,
   * whether the variable its settings name as its key source is in the owner's user settings but not in
   * what this run got (nor in the agent's own `.env`) - the browser started before it was set. Once per
   * run, only for an agent whose description says where that name is. Names only: no value is read
   * into Hallpass, and nothing of it goes to the broker log. Gives the variable's name when it said so.
   */
  private sayKeyOnlyInUserSettings(): Promise<string | undefined> {
    if (this.keyNameChecked || (AGENT_ADAPTERS[this.agent] as AgentDescription).keyNameSource !== "hermes-config") return Promise.resolve(undefined);
    this.keyNameChecked = true;
    this.keyNameCheck = (async () => {
      const variable = await keyNameOnlyInUserSettings(this.runEnv(), this.deps.userEnvironment ?? defaultUserEnvironmentPorts).catch(
        () => undefined,
      );
      if (variable === undefined) return undefined;
      this.enqueue({ type: "notice", code: "key-env-not-in-browser", agent: this.agent, variable, text: keyEnvHint(this.agent, variable) });
      return variable;
    })();
    return this.keyNameCheck;
  }

  /**
   * 024 R-379: this run's key-name check (023 R-369) once a failure began it - its notice said when it
   * resolves, with the variable's name if it found one; none when no check began.
   */
  get keyNameCheckDone(): Promise<string | undefined> | undefined {
    return this.keyNameCheck;
  }

  private sayBrowserToolsMissing(): void {
    if (this.browserNoticeSent) return;
    this.browserNoticeSent = true;
    this.enqueue({ type: "notice", code: "browser-tools-missing", agent: this.agent, text: BROWSER_TOOLS_MISSING[this.agent] });
  }

  private cancelBrowserCheck(): void {
    this.browserCheck?.cancel();
    this.browserCheck = undefined;
  }

  /**
   * 023 R-367: this run's error output, always read (the agent never blocks on a full pipe), kept as
   * its last 50 lines. Each line loses every value of the environment the run got, then the user's
   * profile folder (024 R-387), then key-shaped text, and only then is cut to 500 characters - so no beginning of a value is left at the cut. A
   * line is read up to `OUTPUT_LINE_READ_MAX` characters; the rest of a longer one is dropped unread,
   * and so is the end of what was read that a value could begin with (`withoutCutValue`) - the text
   * before it may shrink below 500 characters once scrubbed.
   */
  private readOutput(child: ChildProcess): void {
    const lines: string[] = [];
    this.outputLines = lines;
    this.runSerialValue = nextRunSerial();
    const stream = child.stderr;
    if (stream === null || stream === undefined) return;
    const env = this.runEnv();
    const keep = (raw: string): void => {
      const text = raw.replace(/\r$/u, "");
      if (text.trim().length === 0) return;
      // 024 R-387: the profile folder in any case or slash, here where the line is kept, so a reply
      // by conversation and one by agent hand out the same line.
      const scrubbed = withoutUserProfile(withoutEnvironmentValues(text, env), env.USERPROFILE);
      lines.push(redact(scrubbed).slice(0, CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS));
      if (lines.length > CONVERSATION_DIAGNOSTIC_LINES_MAX) lines.shift();
    };
    let partial = "";
    // Once a line is cut, the rest of it is not read: joined to the cut, it would hide a cut value.
    let cut = false;
    const add = (piece: string): void => {
      if (cut) return;
      partial += piece;
      if (partial.length <= OUTPUT_LINE_READ_MAX) return;
      partial = withoutCutValue(partial.slice(0, OUTPUT_LINE_READ_MAX), env);
      cut = true;
    };
    const endLine = (): void => {
      keep(partial);
      partial = "";
      cut = false;
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const [first, ...rest] = chunk.split("\n");
      add(first!);
      for (const part of rest) {
        endLine();
        add(part);
      }
    });
    stream.once("end", endLine);
    stream.on("error", () => undefined);
  }

  /** 023 R-367 (FR-372): the latest run's lines, for the panel's conversation details. */
  diagnostics(): string[] {
    return [...this.outputLines];
  }

  /** 024 R-387: the order of this conversation's latest run among the broker's runs (`nextRunSerial`); 0 before one. */
  get runSerial(): number {
    return this.runSerialValue;
  }

  /** 023 R-365: the worker accepted this conversation's `hallpass` server greeting - this run has the tools. */
  browserAttached(): void {
    if (!this.live) return;
    this.browserAttachedRun = true;
    this.cancelBrowserCheck();
  }

  /** SC-161: everything this run's agent was started with - the broker's environment and the launch's own. */
  private runEnv(): Readonly<Record<string, string | undefined>> {
    return { ...process.env, ...this.launchEnv };
  }

  /** SC-161 (T692): the agent's own words with no value of any variable it ran with, on every path that shows them. */
  private scrubbed(text: string): string {
    return withoutEnvironmentValues(text, this.runEnv());
  }

  /** R-322: this run's `hallpass` entry, or nothing without a browser connection. */
  private mcpServers(): acp.McpServer[] {
    const browser = this.deps.browser;
    const token = this.browserToken ?? this.inertToken;
    return browser === undefined || token === undefined ? [] : browser.servers(this.conversationId, token, this.serverName);
  }

  /** The run's token, handed to the worker again (a new relay's worker holds none); a revoked run has none. */
  regrant(): void {
    if (this.browserToken === undefined || !this.live) return;
    this.deps.browser?.grant({ conversationId: this.conversationId, token: this.browserToken });
  }

  /**
   * T558: the owner withdrew consent - this run loses browser access for good. The agent keeps
   * running; only its next agent process (a start or resume) is minted a token again.
   */
  revokeBrowserToken(): void {
    if (this.browserToken === undefined) return;
    this.browserToken = undefined;
    // 023 R-365: a run without access is not asked whether it took the tools.
    this.cancelBrowserCheck();
    this.deps.browser?.grant({ conversationId: this.conversationId, token: null });
    // A reload with no entry would let the owner's own `hallpass` load for this session (R-322).
    this.inertToken = this.deps.browser?.mint();
  }

  /**
   * The pool's admission holds the slot from here until `start` settles (FR-311). A Stop already
   * recorded stays: `start` ends with it (T668) - only `startCancelled` clears it.
   */
  reserve(): void {
    this.setState("starting");
  }

  /**
   * R-354 (T659): Stop on a conversation that is still starting ends the start - the agent's process
   * tree is killed (the broker sets no timeout of its own on a start, which may take minutes), and
   * `start` ends `stopped` with `start-cancelled`. Before the agent is spawned, `start` sees the
   * request and spawns nothing. `listed` (T668): a first start the pool lists, Stopped while it still
   * waits for its slot - not `starting` yet, the Stop is recorded all the same.
   */
  async cancelStart(listed = false): Promise<void> {
    if (this.stateValue !== "starting" && !(listed && this.child === undefined)) return;
    this.cancelRequested = true;
    const child = this.child;
    if (child === undefined) return;
    const gone = new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("exit", () => done());
    });
    killTree(child.pid);
    child.kill();
    await gone;
  }

  /** R-354: the start the owner stopped ends here: not started, said with `start-cancelled`. */
  private startCancelled(): StartOutcome {
    this.cancelRequested = false;
    this.setState("stopped", "start-cancelled");
    return failure("start-cancelled", `You stopped ${AGENT_ADAPTERS[this.agent].label} while it was starting.`);
  }

  /** A request that fails as soon as the agent exits, rather than whenever the stream notices. */
  private request<T>(send: () => Promise<T>): Promise<T> {
    return Promise.race([send(), this.exited ?? Promise.reject(new AgentExited(null))]);
  }

  /* ----------------------------------------------------------------------------------------- */
  /* The owner's commands                                                                        */
  /* ----------------------------------------------------------------------------------------- */

  /** Whether a message could go now: a running agent, idle, no turn and no mode reload. */
  canSend(): CommandOutcome {
    if (this.connection === undefined || this.sessionId === undefined || !this.live) {
      return failure("agent-exited", "The agent is not running.");
    }
    if (this.stateValue !== "idle" || this.turn !== undefined || this.reloading) {
      // T547 (G3): its own code, so the panel can say "wait or stop" rather than "the helper is gone".
      return failure("busy", "The agent is still answering; stop it or wait for the end of its turn.");
    }
    return { ok: true };
  }

  /**
   * `startTabId`: the tab the owner was viewing, the turn's first browser target (FR-306).
   * `attachments` (022): ready, files already in place; the pool checked them against `accepts`.
   */
  send(text: string, startTabId?: number, attachments: readonly ReadyAttachment[] = []): CommandOutcome {
    const ready = this.canSend();
    if (!ready.ok) return ready;
    const connection = this.connection!;
    this.cancelIdle();
    this.touch();
    // R-321 / FR-306: the token again with this turn's start tab, before the prompt can use it.
    // Without one, the grant still replaces a start tab an earlier turn left unused.
    if (this.browserToken !== undefined) {
      this.deps.browser?.grant({
        conversationId: this.conversationId,
        token: this.browserToken,
        ...(startTabId === undefined ? {} : { startTabId }),
      });
    }
    const summaries = attachmentSummaries(attachments);
    this.enqueue({ type: "text", role: "owner", text, ...(summaries.length === 0 ? {} : { attachments: summaries }) });
    const turn: Turn = { cancelled: false, stopped: false, rejected: new Set() };
    this.turn = turn;
    this.setState("running");
    const sessionId = this.sessionId!;
    const blocks = promptBlocks(text, attachments);
    const prompt = () => connection.agent.request("session/prompt", { sessionId, prompt: blocks });
    // R-322: a new session's title first - the list's own title for it (data-model) - then the message.
    const rename = this.renamePending ? `/rename ${titleOf(text) ?? NEW_TITLE}` : undefined;
    this.renamePending = false;
    (rename === undefined ? Promise.resolve() : this.renameFirst(connection, sessionId, rename))
      .then((): Promise<acp.PromptResponse> => (turn.cancelled ? Promise.resolve({ stopReason: "cancelled" }) : prompt()))
      .then(
        async (response) => {
          await settle();
          this.turnWentThrough = true;
          // R-316: the turn is over only once a drifted mode is set back.
          await this.modeReset;
          if (response.stopReason !== "end_turn" && response.stopReason !== "cancelled") {
            this.enqueue({
              type: "notice",
              code: STOP_NOTICE_CODES[response.stopReason] ?? "stop-other",
              text: shown(`The agent ended its turn: ${String(response.stopReason)}.`, 2048),
            });
          }
          this.endTurn(turn);
        },
        async (error: unknown) => {
          await settle();
          if (this.turn !== turn || !this.live) return;
          if (connection.signal.aborted) {
            // The agent's output closed under the turn: it is leaving. Its exit is the crash
            // (FR-298, cards closed `agent-exited`); one that lingers without a voice is ended.
            this.child?.kill();
            return;
          }
          const said = errorMessage(error);
          // SC-161: no value of any variable the agent ran with, whichever notice says it.
          const clean = redact(this.scrubbed(said));
          if (isModelUnreachable(said)) {
            // R-356 / FR-355: where the agent's own setting lives.
            this.deps.log?.("conversation.model-unreachable", `${this.conversationId} ${clip(clean, 600)}`);
            this.enqueue({ type: "notice", code: MODEL_UNREACHABLE_NOTICE, text: shown(`${modelSetupHint(this.agent)} The agent said: ${clean}`, 2048) });
            // 023 R-369: the first message of the run - said when the check is done, the turn ends now.
            if (!this.turnWentThrough) void this.sayKeyOnlyInUserSettings();
          } else {
            this.enqueue({ type: "notice", code: "turn-failed", text: shown(`The agent's turn failed: ${clean}`, 2048) });
          }
          this.endTurn(turn);
        },
      );
    return { ok: true };
  }

  /**
   * R-322 (T566): the broker's own `/rename <title>` as the session's first input, before the
   * owner's first message, so the adapter starts no title thread with the owner's own servers. What
   * the agent says to it is not shown. A refusal is logged and the message still goes (the
   * conversation works; a title thread may then start the owner's servers, which pair on their own);
   * an agent that is leaving fails the turn as any prompt would.
   */
  private async renameFirst(connection: acp.ClientConnection, sessionId: string, command: string): Promise<void> {
    this.muted = true;
    try {
      await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: command }] });
      await settle();
    } catch (error) {
      if (connection.signal.aborted) throw error;
      this.deps.log?.("conversation.rename-failed", this.conversationId);
    } finally {
      this.muted = false;
    }
  }

  /** Stop the current turn: `session/cancel`, open cards closed as cancelled (FR-285). */
  stop(): CommandOutcome {
    if (this.turn === undefined) return { ok: true };
    this.turn.stopped = true;
    this.cancelTurn();
    return { ok: true };
  }

  /**
   * `answered`; `not-open` when the card was not open (already answered elsewhere, FR-288);
   * `reject-only` when an allow answers a card whose action nobody described (R-353) - it stays open.
   */
  answer(requestId: string, answer: OwnerAnswer): AnswerResult {
    const card = this.cards.get(requestId);
    if (card === undefined) return "not-open";
    if (card.rejectOnly && answer !== "reject") return "reject-only";
    const wanted = answer === "reject" ? "reject_once" : "allow_once";
    // R-317: only *once* options are ever sent. An adapter without an allow-once option is declined.
    const once = card.options.find((option) => option.kind === wanted) ?? card.options.find((option) => option.kind === "reject_once");
    if (once === undefined || once.kind !== wanted) {
      this.enqueue({
        type: "notice",
        code: "no-once-option",
        text: "The agent offered no one-time answer for this; Hallpass declined rather than answer for always.",
      });
    }
    const allowed = once?.kind === "allow_once";
    if (answer === "allow-conversation" && allowed && card.ruleKey !== undefined) this.rules.add(card.ruleKey);
    if (!allowed) this.turn?.rejected.add(card.toolCallId);
    this.closeCard(
      card,
      answer,
      once === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: once.optionId } },
    );
    return "answered";
  }

  /**
   * R-351 (T664): whether a restart for a launch-time mode may begin now - only between turns: a
   * running agent, idle, no turn, no card, no mode switch under way (refused `busy` as a reload is).
   */
  canRestart(): CommandOutcome {
    if (this.reloading) return failure("busy", "The conversation is already switching its mode; try again in a moment.");
    if (this.connection === undefined || this.sessionId === undefined || !this.live || !this.watchingMode) {
      return failure("agent-exited", "The agent is not running; it starts in strict mode when the conversation continues.");
    }
    if (this.stateValue !== "idle" || this.turn !== undefined || this.cards.size > 0 || this.modeReset !== undefined) {
      return failure("busy", "The agent is still answering; stop it or wait for the end of its turn, then switch the mode.");
    }
    return { ok: true };
  }

  /**
   * R-351 (T664): a mode fixed when Hermes starts (its tool set) changes by closing the agent and
   * starting it again with the new launch settings, then continuing the same session with
   * `session/load` (its replay is not shown again). The owner's "for this conversation" rules stay.
   * A failed start leaves the conversation stopped; the next message resumes it strict (FR-289).
   * DeepSeek is never restarted for a mode (D-021-16, FR-360): its resumed session keeps the mode of
   * its `session/new`, so a change is refused `mode-fixed` here as well as in the pool.
   */
  async restart(
    mode: ConversationMode,
    launch: { spec: AdapterLaunchSpec; versions: StartFailureVersions; mayHandOut?: () => boolean },
  ): Promise<CommandOutcome> {
    if (this.modeFixedAgainst(mode)) return modeFixed(this.agent);
    const ready = this.canRestart();
    if (!ready.ok) return ready;
    const sessionId = this.sessionId!;
    const cwd = this.cwd!;
    // Nothing else is sent meanwhile (`canSend` refuses `busy`).
    this.reloading = true;
    this.watchingMode = false;
    await this.end("starting");
    const started = await this.start({
      cwd,
      spec: launch.spec,
      versions: launch.versions,
      resume: sessionId,
      mode,
      restart: true,
      ...(launch.mayHandOut === undefined ? {} : { mayHandOut: launch.mayHandOut }),
    });
    return started.ok ? { ok: true } : { ok: false, error: started.error };
  }

  /**
   * D-021-16 (FR-360): an agent that keeps its session's first mode (DeepSeek) refuses another one
   * once it has a session or is starting - whoever asks, not only through the pool's own check.
   */
  private modeFixedAgainst(mode: ConversationMode): boolean {
    return modeFixedOnceStarted(this.agent) && mode !== this.modeValue && (this.sessionId !== undefined || this.live);
  }

  async setMode(mode: ConversationMode): Promise<CommandOutcome> {
    if (this.modeFixedAgainst(mode)) return modeFixed(this.agent);
    const connection = this.connection;
    if (this.reloading) return failure("busy", "The conversation is already switching its mode; try again in a moment.");
    if (connection === undefined || this.sessionId === undefined || !this.live || !this.watchingMode) {
      return failure("agent-exited", "The agent is not running; it starts in strict mode when the conversation continues.");
    }
    // D-019-12: Claude's strict rules ride on the session itself, so changing its mode reloads it.
    const hasRules = (which: ConversationMode) => sessionMeta(this.agent, which) !== undefined;
    if (mode !== this.modeValue && hasRules(mode) !== hasRules(this.modeValue)) {
      return this.reload(connection, this.sessionId, mode);
    }
    const targetId = agentModeId(this.agent, mode);
    if (targetId === undefined) return failure("agent-version", "The agent has no mode Hallpass could set.");
    const previous = { mode: this.modeValue, id: this.ownerModeId };
    // Owner-caused: set before the request, so the agent's own echo of it is not drift.
    this.modeValue = mode;
    this.ownerModeId = targetId;
    try {
      await this.request(() => connection.agent.request("session/set_mode", { sessionId: this.sessionId!, modeId: targetId }));
    } catch (error) {
      this.modeValue = previous.mode;
      this.ownerModeId = previous.id;
      return failure(
        error instanceof AgentExited ? "agent-exited" : "agent-version",
        `The agent did not change its mode: ${this.scrubbed(errorMessage(error))}`,
      );
    }
    this.enqueue({ type: "mode", mode });
    this.touch();
    return { ok: true };
  }

  /**
   * T542a / D-019-12: switch a Claude conversation's mode by loading its session again with (strict)
   * or without (agent-review) the ask rules, then setting and confirming the mode before anything of
   * the owner's goes out (R-316). Refused `busy` while a turn runs or a card is open: the reload
   * replaces the agent's query under the turn, and a switch queued for the turn's end would change
   * the mode at a moment the owner did not pick, with the panel showing the old one meanwhile. A
   * failed reload leaves the agent's rules unknown, so it is stopped; the next message resumes it
   * strict (FR-289).
   */
  private async reload(connection: acp.ClientConnection, sessionId: string, mode: ConversationMode): Promise<CommandOutcome> {
    if (this.stateValue !== "idle" || this.turn !== undefined || this.cards.size > 0 || this.modeReset !== undefined) {
      return failure("busy", "The agent is still answering; stop it or wait for the end of its turn, then switch the mode.");
    }
    const targetId = agentModeId(this.agent, mode);
    if (targetId === undefined) return failure("agent-version", "The agent has no mode Hallpass could set.");
    this.reloading = true;
    this.cancelIdle();
    this.watchingMode = false;
    try {
      // The agent replays the conversation on load; this broker already shows it.
      this.replay = "drop";
      await this.request(() =>
        connection.agent.request("session/load", {
          sessionId,
          cwd: this.cwd!,
          // The same agent run: the same token (R-321).
          mcpServers: this.mcpServers(),
          ...sessionMeta(this.agent, mode),
        }),
      );
      await settle();
      this.replay = "off";
      this.reportedModeId = undefined;
      await this.request(() => connection.agent.request("session/set_mode", { sessionId, modeId: targetId }));
      await settle();
      if (this.reportedModeId !== undefined && this.reportedModeId !== targetId) {
        throw new Error(`the agent reported "${this.reportedModeId}" after being set to "${targetId}"`);
      }
    } catch (error) {
      this.replay = "off";
      this.reloading = false;
      if (this.live && this.closing === undefined) {
        this.enqueue({
          type: "notice",
          code: "mode-reload-failed",
          text: shown(`Hallpass could not reload the conversation in the new mode (${this.scrubbed(errorMessage(error))}); the agent was stopped.`, 2048),
        });
        await this.close("stopped");
      }
      return failure(
        error instanceof AgentExited ? "agent-exited" : "agent-version",
        `The agent did not change its mode: ${this.scrubbed(errorMessage(error))}`,
      );
    }
    this.reloading = false;
    this.modeValue = mode;
    this.ownerModeId = targetId;
    this.watchingMode = true;
    this.enqueue({ type: "mode", mode, note: RELOAD_NOTE[mode] });
    this.touch();
    this.armIdle();
    return { ok: true };
  }

  /**
   * Ends the agent on purpose: idle limit or eviction (`stopped`, resumable), removal or broker
   * shutdown (`gone`). Its stdin closes first (an ACP agent ends with its input), then it is killed
   * after the bound; the job is the backstop either way.
   */
  async close(target: "stopped" | "gone"): Promise<void> {
    return this.end(target);
  }

  /** `close`, or for a restart (R-351) `starting`: the conversation shows that it is starting again. */
  private async end(target: "stopped" | "gone" | "starting"): Promise<void> {
    this.cancelIdle();
    const child = this.child;
    if (child === undefined) {
      if (this.stateValue !== "crashed" || target === "gone") this.setState(target);
      return;
    }
    this.closing = { target };
    const gone = new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("exit", () => done());
    });
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), AGENT_STOP_BOUND_MS);
    await gone;
    clearTimeout(timer);
  }

  page(fromSeq: number): ConversationPage {
    return this.log.page(fromSeq);
  }

  /* ----------------------------------------------------------------------------------------- */
  /* What the agent sends                                                                       */
  /* ----------------------------------------------------------------------------------------- */

  private onUpdate(params: acp.SessionNotification): void {
    if (this.sessionId !== undefined && params.sessionId !== this.sessionId) return;
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk": {
        if (this.replay === "drop" || this.muted) return;
        // Outside a replay the owner's words are the broker's own echo (`send`), not the agent's.
        if (update.sessionUpdate === "user_message_chunk" && this.replay !== "show") return;
        if (update.sessionUpdate === "user_message_chunk" && update.content.type === "image") {
          // 022 R-343: a picture of the owner's earlier message, shown as a chip without a thumbnail.
          if (this.isRenameReplay(update.sessionUpdate, "")) return;
          this.enqueue({ type: "text", role: "owner", text: "", attachments: [REPLAYED_IMAGE] });
          return;
        }
        if (update.content.type !== "text") return;
        if (this.replay === "show" && this.isRenameReplay(update.sessionUpdate, update.content.text)) return;
        this.enqueue({ type: "text", role: update.sessionUpdate === "agent_message_chunk" ? "agent" : "owner", text: update.content.text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (this.replay === "drop" || this.muted) return;
        // FR-285 / T537: after stop, nothing more of that turn's tools is shown.
        if (this.turn?.cancelled) return;
        this.announce(update);
        this.showTool(update);
        return;
      }
      case "agent_thought_chunk": {
        // 023 R-371: that the agent thinks, once per live turn - never the thought itself.
        const turn = this.turn;
        if (this.replay !== "off" || this.muted || turn === undefined || turn.cancelled || turn.thinkingSaid) return;
        turn.thinkingSaid = true;
        this.enqueue({ type: "activity", activity: "thinking" });
        return;
      }
      case "current_mode_update": {
        this.reportedModeId = update.currentModeId;
        // An agent without ACP modes (R-351) has no mode of the owner's to drift from or to set back.
        if (this.watchingMode && this.ownerModeId !== undefined && update.currentModeId !== this.ownerModeId) {
          this.onDrift(update.currentModeId);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * R-322: in a shown replay of a Codex conversation, the broker's own `/rename <title>` - the agent's
   * record begins with it, hidden while the conversation was live - and what the agent said to it.
   * Narrow on purpose: only a first owner chunk that starts with `/rename `, and only the agent's text
   * before the next owner chunk, so no later message of the owner's can be hidden.
   */
  private isRenameReplay(update: "agent_message_chunk" | "user_message_chunk", text: string): boolean {
    if (this.renameReplay === "off") return false;
    if (update === "user_message_chunk") {
      if (this.renameReplay === "first" && text.startsWith("/rename ")) {
        this.renameReplay = "reply";
        return true;
      }
      this.renameReplay = "off";
      return false;
    }
    if (this.renameReplay === "reply") return true;
    this.renameReplay = "off";
    return false;
  }

  private showTool(update: acp.ToolCallUpdate & { kind?: acp.ToolKind | null }, byRule?: true): void {
    const id = clip(update.toolCallId, 128);
    const known = this.tools.get(id);
    const mapped = update.status ? TOOL_STATUS[update.status] : undefined;
    const status =
      mapped === "failed" && this.turn?.rejected.has(update.toolCallId) ? "refused" : (mapped ?? known?.status ?? "pending");
    const view: ToolView = {
      kind: update.kind ? toolKind(update.kind) : (known?.kind ?? "other"),
      title: typeof update.title === "string" ? shown(update.title, 200) : (known?.title ?? ""),
      inputSummary:
        update.rawInput !== undefined || update.locations
          ? shown(summarizeInput(update.rawInput, update.locations), 400)
          : (known?.inputSummary ?? ""),
      status,
      ...(byRule || known?.byRule ? { byRule: true as const } : {}),
    };
    this.tools.set(id, view);
    this.enqueue({ type: "tool", toolCallId: id, ...view });
  }

  /** R-353: what this turn's `tool_call` / `tool_call_update` said of an action, merged per id. */
  private announce(update: acp.ToolCallUpdate & { kind?: acp.ToolKind | null }): void {
    const before = this.announced.get(update.toolCallId);
    const detail = announcedDetail(update);
    this.announced.set(update.toolCallId, {
      ...before,
      ...(typeof update.title === "string" && update.title.length > 0 ? { title: update.title } : {}),
      ...(update.kind ? { kind: toolKind(update.kind) } : {}),
      ...(detail.length > 0 ? { detail } : {}),
    });
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const { toolCall, options } = params;
    // A request outside a live turn, or after the owner (or a drift) cancelled it, is answered cancelled.
    if (this.turn === undefined || this.turn.cancelled) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const known = this.tools.get(clip(toolCall.toolCallId, 128));
    const announced = this.announced.get(toolCall.toolCallId);
    const kind = toolCall.kind ? toolKind(toolCall.kind) : (announced?.kind ?? known?.kind ?? "other");
    const title = toolCall.title ?? announced?.title ?? known?.title ?? "";
    // R-353 / FR-353: the card's detail is the request's own, else the action announced with its id
    // this turn (DeepSeek asks with the id alone). With neither, nobody knows what Allow would allow.
    const requestDetail = permissionDetail(toolCall);
    const detail = requestDetail.length > 0 ? requestDetail : (announced?.detail ?? "");
    const rejectOnly =
      !(typeof toolCall.title === "string" && toolCall.title.length > 0) &&
      requestDetail.length === 0 &&
      announced?.title === undefined &&
      announced?.detail === undefined;
    const sandboxGrant = this.agent === "codex" && isCodexSandboxPermissionsRequest(params);
    if (sandboxGrant && this.modeValue === "strict") {
      // R-317 / SC-135: a grant for the rest of the turn is not one action; Codex asks for each instead.
      this.enqueue({ type: "notice", code: SANDBOX_PERMISSIONS_DECLINED, text: shown(permissionDetail(toolCall), 2048) });
      const reject = options.find((option) => option.kind === "reject_once");
      return Promise.resolve(
        reject === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: reject.optionId } },
      );
    }
    // R-353: a reject-only card is never answered by an "allow for this conversation" rule, nor makes one.
    const ruleKey = sandboxGrant || rejectOnly ? undefined : permissionRuleKey({ kind, title, _meta: toolCall._meta });

    if (ruleKey !== undefined && this.rules.has(ruleKey)) {
      const once = options.find((option) => option.kind === "allow_once");
      if (once !== undefined) {
        // R-317: answered by the owner's rule, allow-once to the agent, listed as such.
        this.showTool({ ...toolCall, kind, title }, true);
        return Promise.resolve({ outcome: { outcome: "selected", optionId: once.optionId } });
      }
    }

    const requestId = `perm-${++this.cardCounter}`;
    return new Promise((resolve) => {
      this.cards.set(requestId, { requestId, toolCallId: toolCall.toolCallId, ruleKey, options, rejectOnly, resolve });
      this.enqueue({
        type: "permission",
        requestId,
        toolCallId: clip(toolCall.toolCallId, 128),
        kind,
        title: shown(title, 200),
        detail: shown(detail, 2048),
        ...(rejectOnly ? { rejectOnly: true as const } : {}),
      });
      this.setState("waiting-for-owner");
    });
  }

  private closeCard(card: Card, closure: Closure, response: acp.RequestPermissionResponse): void {
    if (!this.cards.delete(card.requestId)) return;
    this.enqueue({ type: "permission-closed", requestId: card.requestId, answer: closure });
    card.resolve(response);
    if (this.cards.size === 0 && this.stateValue === "waiting-for-owner") this.setState("running");
  }

  /** R-316: the agent changed its own mode. Cancel what is pending, put the owner's mode back, say so. */
  private onDrift(modeId: string): void {
    const label = this.modeValue === "strict" ? "strict mode" : "the agent's own review";
    if (this.turn !== undefined && !this.turn.cancelled) this.cancelTurn();
    this.enqueue({
      type: "mode",
      mode: this.modeValue,
      note: shown(`The agent switched itself to its "${modeId}" mode; Hallpass stopped the turn and set ${label} back.`, 400),
    });
    const connection = this.connection;
    const sessionId = this.sessionId;
    const ownerModeId = this.ownerModeId;
    if (connection === undefined || sessionId === undefined || ownerModeId === undefined) return;
    const reset: Promise<void> = connection.agent.request("session/set_mode", { sessionId, modeId: ownerModeId }).then(
      () => undefined,
      (error: unknown) => {
        if (!this.live) return;
        // An agent left in a mode the owner did not choose is not left running.
        this.enqueue({
          type: "notice",
          code: "mode-reset-failed",
          text: shown(`Hallpass could not set the mode back (${this.scrubbed(errorMessage(error))}); the agent was stopped.`, 2048),
        });
        void this.close("stopped");
      },
    );
    this.modeReset = reset;
    void reset.finally(() => {
      if (this.modeReset === reset) this.modeReset = undefined;
    });
  }

  private cancelTurn(): void {
    const turn = this.turn;
    if (turn === undefined) return;
    turn.cancelled = true;
    // ACP: a client that cancels answers its open permission requests `cancelled`.
    for (const card of [...this.cards.values()]) this.closeCard(card, "cancelled", { outcome: { outcome: "cancelled" } });
    const connection = this.connection;
    if (connection !== undefined && this.sessionId !== undefined) {
      connection.agent.notify("session/cancel", { sessionId: this.sessionId }).catch(() => undefined);
    }
  }

  private endTurn(turn: Turn): void {
    if (this.turn !== turn) return;
    this.turn = undefined;
    this.announced.clear();
    if (turn.stopped) {
      this.enqueue({ type: "notice", code: "turn-stopped", text: "Stopped. Nothing more from that turn will run." });
    }
    for (const card of [...this.cards.values()]) this.closeCard(card, "cancelled", { outcome: { outcome: "cancelled" } });
    this.touch();
    if (this.live && (this.stateValue === "running" || this.stateValue === "waiting-for-owner")) {
      this.setState("idle");
      this.armIdle();
    }
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    // R-321: the token dies with the run, however it ended (stop, idle, eviction, crash, failed start).
    if (this.browserToken !== undefined) {
      this.browserToken = undefined;
      this.deps.browser?.grant({ conversationId: this.conversationId, token: null });
    }
    this.inertToken = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.watchingMode = false;
    this.cancelIdle();
    this.cancelBrowserCheck();
    this.turn = undefined;
    this.announced.clear();
    for (const card of [...this.cards.values()]) this.closeCard(card, "agent-exited", { outcome: { outcome: "cancelled" } });
    const closing = this.closing;
    this.closing = undefined;
    if (closing !== undefined) {
      this.setState(closing.target);
      return;
    }
    // An exit during start is the start's to report.
    if (this.stateValue === "starting") return;
    // FR-298: say so, offer "continue" (the next message resumes), never retry on its own.
    this.enqueue({
      type: "notice",
      code: "agent-exited",
      text: `${AGENT_ADAPTERS[this.agent].label} ended unexpectedly${code === null ? "" : ` (exit ${code})`}. Send a message to continue.`,
    });
    this.deps.log?.("conversation.agent-exited", `${this.conversationId} ${code ?? "signal"}`);
    this.setState("crashed");
  }

  private async kill(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.closing = { target: "gone" };
    const gone = new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("exit", () => done());
    });
    child.kill();
    await gone;
    this.closing = undefined;
  }

  /* ----------------------------------------------------------------------------------------- */
  /* State, idle and the outgoing events                                                        */
  /* ----------------------------------------------------------------------------------------- */

  /** `code`: R-354's `start-cancelled`, on the `stopped` that ends a start the owner stopped. */
  private setState(state: ConversationState, code?: "start-cancelled"): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    if (state !== "idle") this.cancelIdle();
    this.enqueue({ type: "state", state, ...(code === undefined ? {} : { code }) });
    this.deps.onStateChange?.(this);
  }

  private touch(): void {
    this.lastActivity = this.deps.clock.now();
  }

  /**
   * 022 T618: a piece of an attachment for its next message arrived - activity like a message: the
   * idle stop counts from now, and eviction sees it as recently used.
   */
  noteActivity(): void {
    this.touch();
    if (this.idleTimer !== undefined) this.armIdle();
  }

  /** FR-297: only an idle conversation with no card counts down; a waiting card never expires (FR-294). */
  private armIdle(): void {
    this.cancelIdle();
    if (!this.evictable) return;
    this.idleTimer = this.deps.clock.setTimer(() => {
      this.idleTimer = undefined;
      if (this.evictable && this.live) this.deps.onIdle?.(this);
    }, this.deps.idleMs ?? CONVERSATION_IDLE_MS);
  }

  private cancelIdle(): void {
    this.idleTimer?.cancel();
    this.idleTimer = undefined;
  }

  /**
   * In order, with text held to one frame per 50 ms (R-318): a text chunk joins the text still
   * waiting at the end of the outbox; anything else waits behind it, so order is never changed.
   */
  private enqueue(event: ConversationEvent): void {
    if (event.type === "text" && event.text.length === 0 && event.attachments === undefined) return;
    if (event.type === "text" || event.type === "tool") this.contentShown = true;
    if (event.type === "text") {
      const last = this.outbox.at(-1);
      // 022: the owner's attachments stay with the words they came with, at most 11 to one event.
      const attachments = [...(last?.type === "text" ? (last.attachments ?? []) : []), ...(event.attachments ?? [])];
      if (
        last?.type === "text" &&
        last.role === event.role &&
        last.text.length + event.text.length <= CONVERSATION_TEXT_MAX_CHARS &&
        attachments.length <= CONVERSATION_MAX_ATTACHMENTS
      ) {
        this.outbox[this.outbox.length - 1] = {
          ...last,
          text: last.text + event.text,
          ...(attachments.length === 0 ? {} : { attachments }),
        };
      } else if (event.text.length === 0) {
        this.outbox.push(event);
      } else {
        for (let start = 0; start < event.text.length; start += CONVERSATION_TEXT_MAX_CHARS) {
          this.outbox.push({
            type: "text",
            role: event.role,
            text: event.text.slice(start, start + CONVERSATION_TEXT_MAX_CHARS),
            ...(start === 0 && event.attachments !== undefined ? { attachments: event.attachments } : {}),
          });
        }
      }
    } else {
      this.outbox.push(event);
    }
    this.drain();
  }

  private drain(): void {
    while (this.outbox.length > 0) {
      const head = this.outbox[0]!;
      if (head.type === "text") {
        const wait = this.lastTextAt + TEXT_FRAME_INTERVAL_MS - this.deps.clock.now();
        if (wait > 0) {
          this.flushTimer ??= this.deps.clock.setTimer(() => {
            this.flushTimer = undefined;
            this.drain();
          }, wait);
          return;
        }
        this.lastTextAt = this.deps.clock.now();
      }
      this.outbox.shift();
      this.emit(head);
    }
  }

  /** Lets text that arrived before a response settle into the outbox (replay); the rate still holds. */
  private flushText(): void {
    this.drain();
  }

  private emit(event: ConversationEvent): void {
    const shownEvent: ConversationEvent = event.type === "text" ? { ...event, text: redact(event.text) } : event;
    const seq = this.log.append(shownEvent);
    this.deps.onEvent({ conversationId: this.conversationId, seq, event: shownEvent });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** R-356: the notice code of a turn the agent could not run because its model was out of reach. */
const MODEL_UNREACHABLE_NOTICE: ConversationError["code"] = "agent-model-unreachable";

/**
 * R-356: an agent's error that names its model endpoint or its key - the connection refused or not
 * made, 401 / 403, or a key variable that is missing. Not a key prompt: the hint names where the
 * agent's own setting lives (FR-355).
 */
const MODEL_UNREACHABLE: readonly RegExp[] = [
  /\bECONNREFUSED\b|connection refused|\bENOTFOUND\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|could not connect|failed to connect|fetch failed/iu,
  /\b40[13]\b|unauthori[sz]ed|forbidden|authentication failed|invalid[ _-]?api[ _-]?key|incorrect api key/iu,
  /\b[A-Z][A-Z0-9_]*_(?:API_KEY|KEY|TOKEN)\b[^\n]{0,40}\b(?:not set|missing|unset|required|empty)\b/u,
  /\b(?:missing|no)\b[^\n]{0,20}\bapi[ _-]?key\b/iu,
  // R-358: Hermes with no model chosen yet ("not connected to any AI provider yet. Run `hermes model`").
  /not connected to any (?:ai )?provider|\bno (?:ai |model )?provider\b|\bhermes model\b/iu,
];

export function isModelUnreachable(text: string): boolean {
  return MODEL_UNREACHABLE.some((pattern) => pattern.test(text));
}

/** FR-355: where each agent keeps its model and key - its own configuration, never Hallpass. */
function modelSetupHint(agent: ConversationAgent): string {
  const label = AGENT_ADAPTERS[agent].label;
  const where: Record<ConversationAgent, string> = {
    "claude-code": "Claude Code's own sign-in and model settings",
    codex: "Codex's own sign-in and model settings",
    hermes: "Hermes' own settings (run `hermes model` in a terminal; they live in %LOCALAPPDATA%\\hermes, or HERMES_HOME if set)",
    deepseek: "DeepSeek's own settings or the environment variable it reads its key from",
  };
  return `${label} could not reach its model. Check ${where[agent]}; Hallpass never asks for or keeps a key.`;
}

export { withoutEnvironmentValues };

/**
 * T692 (R-356, FR-355): a start the agent refused because its model is out of reach (a 401, a refused
 * connection, R-358: no provider chosen yet) says where the agent's own setting lives, as a turn does;
 * any other refusal is `classifyStartFailure`'s - a version problem only when another version than the
 * tested one was found, or the modes it offers do not fit (`session/set_mode`, said as `session/new`).
 * `env` is everything the agent ran with: no value of it is said (SC-161). 023 R-369: `keyHint`, when
 * given, follows the setup hint - before the agent's own words, so the 600-character cut never reaches it.
 */
function startFailure(
  agent: ConversationAgent,
  step: "initialize" | "session/new" | "session/set_mode",
  error: unknown,
  versions: StartFailureVersions,
  env: Readonly<Record<string, string | undefined>>,
  keyHint?: string,
): ConversationError {
  const shownStep = step === "initialize" ? "initialize" : "session/new";
  const classified = classifyStartFailure(shownStep, error, versions, env, step === "session/set_mode");
  const said = errorMessage(error);
  if (classified.code === "agent-missing" || !isModelUnreachable(said)) return classified;
  const hints = keyHint === undefined ? modelSetupHint(agent) : `${modelSetupHint(agent)} ${keyHint}`;
  return failure(MODEL_UNREACHABLE_NOTICE, `${hints} The agent said (${shownStep}): ${withoutEnvironmentValues(said, env)}`).error;
}

/**
 * 023 R-369 (D-023-6, FR-369/370): the variable named as the agent's key source is in the owner's user
 * settings, but this browser started before it was. `variable` is a name (`conversationEnvNameSchema`),
 * never a value.
 */
function keyEnvHint(agent: ConversationAgent, variable: string): string {
  return `${variable} is set in your Windows user settings, but this browser started before it was, so ${AGENT_ADAPTERS[agent].label} did not get it. Quit the browser completely (also when it keeps running in the background), then open it again.`;
}

/** R-319: a `session/load` refused for an unknown session marks the entry "cannot continue" (FR-304). */
function isUnknownSession(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === -32002 || /not found|unknown session|no such session/iu.test(errorMessage(error));
}

/* ------------------------------------------------------------------------------------------- */
/* The pool                                                                                     */
/* ------------------------------------------------------------------------------------------- */

export type ConversationPoolOptions = {
  /** `%LOCALAPPDATA%\hallpass`; scratch folders live under `scratch\<conversationId>` (D-019-8). */
  dataDir: string;
  browserRunId: string;
  /** The lease's pid: the broker's own. */
  brokerPid?: number;
  index: ConversationIndex;
  folders: FolderList;
  /** 021 R-351: the launch for a panel mode (default strict) - a launch-time agent starts differently per mode. */
  resolveLaunch: (agent: ConversationAgent, mode?: ConversationMode) => Promise<LaunchResolution>;
  onEvent: (payload: ConversationEventPayload) => void;
  /** Something the overview shows changed (a state, the list). */
  onChange?: () => void;
  clock?: Clock;
  cap?: number;
  idleMs?: number;
  isAlive?: (pid: number) => boolean;
  spawnAgent?: (spec: AdapterLaunchSpec, cwd: string) => ChildProcess;
  /** S6 (T552): each agent run's browser token and `hallpass` entry (`browser-token.ts`). */
  browser?: ConversationBrowserAccess;
  folderExists?: (path: string) => Promise<boolean>;
  newConversationId?: () => string;
  log?: (code: string, detail?: string) => void;
  /** 023 R-369: what the key-name check reads (Hermes' files, the user's variable names); the machine's own by default. */
  userEnvironment?: UserEnvironmentPorts;
};

/**
 * What an admission gave (T572): the slot, reserved for `conversation` (`settle` ends a resume's
 * wait for any `open` that joins it), or an outcome to join instead of starting another agent.
 */
type Admission =
  | { kind: "reserved"; conversation: Conversation; settle: (outcome: CommandOutcome<Conversation>) => void }
  | { kind: "joined"; outcome: Promise<CommandOutcome<Conversation>> };

/** The first line of the first message, trimmed, as the list's title (data-model). */
function titleOf(text: string): string | undefined {
  const line = text.split(/\r?\n/u).find((part) => part.trim().length > 0)?.trim();
  return line === undefined ? undefined : clip(redact(line), 120);
}

export class ConversationPool {
  private readonly conversations = new Map<string, Conversation>();
  private readonly clock: Clock;
  private readonly cap: number;
  private readonly brokerPid: number;
  private readonly isAlive: (pid: number) => boolean;
  /** Admission (cap check + reservation) is one at a time, so two starts cannot both take the last slot. */
  private admission: Promise<unknown> = Promise.resolve();
  /** T572: each resume in flight, from its reservation until its start settles; an `open` joins it. */
  private readonly resuming = new Map<string, Promise<CommandOutcome<Conversation>>>();
  /** Index read-modify-writes, one at a time (file writes since S7, T560). */
  private writes: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  /** T577: listed as in use in another browser, and the next look at whether that is still so. */
  private heldElsewhere = new Set<string>();
  private releaseCheck: ClockTimer | undefined;
  /**
   * T579 (D-019-14, R-331): how many withdrawals there have been. A start or resume notes it before its
   * consent check and hands out a token only while it is unchanged, so a withdrawal that lands while
   * that check is under way (a file read, then seconds of discovery) is never answered by a token.
   */
  private revocations = 0;
  /** 022 R-340: each conversation's staged attachments, until its message is sent or they are dropped. */
  private readonly attachments = new Map<string, AttachmentStore>();
  /** T618: drops of staged attachments still removing their part files; `shutdown` waits for them. */
  private readonly clearing = new Set<Promise<void>>();
  /** 022 R-344: what each agent said it accepts at its last `initialize` in this broker. */
  private readonly lastAccepts = new Map<ConversationAgent, ConversationAccepts>();
  /**
   * R-354: new conversations whose first start is under way. They have no index entry until the agent
   * has a session, so the list shows them from here (state `starting`, not resumable); a cancelled or
   * failed first start leaves nothing behind.
   */
  private readonly firstStarts = new Map<string, { agent: ConversationAgent; folder: ConversationFolder; mode: ConversationMode; at: string }>();

  constructor(private readonly options: ConversationPoolOptions) {
    this.clock = options.clock ?? systemClock;
    this.cap = options.cap ?? CONVERSATION_RUNNING_CAP;
    this.brokerPid = options.brokerPid ?? process.pid;
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  state(conversationId: string): ConversationState | undefined {
    return this.conversations.get(conversationId)?.state;
  }

  agentPid(conversationId: string): number | undefined {
    return this.conversations.get(conversationId)?.pid;
  }

  /**
   * `mayStart`: the consent (FR-299), asked again once the agent is found and right before it is
   * launched - discovery takes seconds, and a withdrawal meanwhile must start nothing (T572).
   *
   * `mode` (FR-361): the mode the owner chose before the first message; the agent is started in it
   * and confirms it as on any start (R-316). For an agent whose mode is fixed once started (D-021-16)
   * it is the conversation's mode for good.
   */
  async start(
    agent: ConversationAgent,
    folder: ConversationFolder,
    mayStart?: ResumeGate,
    mode: ConversationMode = "strict",
  ): Promise<CommandOutcome<{ conversationId: string }>> {
    if (this.shuttingDown) return failure("broker-unavailable", "Hallpass is shutting down.");
    const mayHandOut = this.noWithdrawalSinceNow();
    if (folder.kind === "project") {
      if (!(await this.options.folders.has(folder.path))) return failure("folder-missing", "That folder is not in your folder list.");
      if (!(await this.folderExists(folder.path))) return failure("folder-missing", `The folder ${folder.path} does not exist any more.`);
    }
    const launch = await this.options.resolveLaunch(agent, mode);
    if (!launch.ok) return launch;

    const conversationId = (this.options.newConversationId ?? randomUUID)();
    const conversation = this.create(conversationId, agent);
    // R-354: listed from here while it is starting, so the panel can stop the start by its id.
    this.firstStarts.set(conversationId, { agent, folder, mode, at: this.iso() });
    this.options.onChange?.();
    try {
      return await this.startNew(conversation, folder, mode, launch, mayStart, mayHandOut);
    } finally {
      // The list follows: the entry is now in the index, or gone with a failed or cancelled start.
      this.firstStarts.delete(conversationId);
      this.options.onChange?.();
    }
  }

  private async startNew(
    conversation: Conversation,
    folder: ConversationFolder,
    mode: ConversationMode,
    launch: Extract<LaunchResolution, { ok: true }>,
    mayStart: ResumeGate | undefined,
    mayHandOut: () => boolean,
  ): Promise<CommandOutcome<{ conversationId: string }>> {
    const { conversationId, agent } = conversation;
    const admitted = await this.admit(conversation);
    if (!admitted.ok) {
      this.conversations.delete(conversationId);
      return admitted;
    }
    const cwd = await this.prepareFolder(conversationId, folder);
    if (cwd === undefined) {
      this.conversations.delete(conversationId);
      this.options.onChange?.();
      return failure("folder-missing", "The conversation's scratch folder could not be created.");
    }
    if (mayStart !== undefined) {
      const allowed = await mayStart();
      if (!allowed.ok) {
        this.conversations.delete(conversationId);
        this.options.onChange?.();
        return allowed;
      }
    }
    // Nothing awaits between the consent above and the spawn (and the token's mint) inside `start`.
    const started = await conversation.start({ cwd, spec: launch.spec, versions: launch.versions, mode, mayHandOut });
    if (!started.ok) {
      this.conversations.delete(conversationId);
      this.options.onChange?.();
      return { ok: false, error: started.error };
    }
    this.noteAccepts(conversation);
    const at = this.iso();
    await this.write(async () =>
      this.options.index.put({
        conversationId,
        agent,
        agentSessionId: started.agentSessionId,
        title: NEW_TITLE,
        folder,
        mode,
        createdAt: at,
        lastUsedAt: at,
        resumable: true,
        lease: this.lease(),
      }),
    );
    this.options.onChange?.();
    return { ok: true, value: { conversationId } };
  }

  /**
   * `mayResume`: asked before a stopped conversation's agent is started again (the consent, FR-299).
   * `attachmentIds` (022): attachments staged by `attach`, checked before an agent is resumed for
   * them, against what the agent accepts once it runs (R-344), and only then given their place; a
   * refused or failed send drops the attachments it named and removes any file it placed (R-340,
   * FR-332). T618: nothing else staged goes with them, and a `busy` refusal keeps them all - the
   * owner sends again once the turn ends, and the 10-minute expiry bounds what waits.
   */
  async send(
    conversationId: string,
    text: string,
    activeTabId?: number,
    mayResume?: ResumeGate,
    attachmentIds: readonly string[] = [],
  ): Promise<CommandOutcome> {
    const withAttachments = attachmentIds.length > 0;
    const refuse = async (outcome: { ok: false; error: ConversationError }): Promise<CommandOutcome> => {
      if (withAttachments && outcome.error.code !== "busy") await this.attachments.get(conversationId)?.cancelMany(attachmentIds);
      return outcome;
    };
    let kinds: ConversationAttachmentKind[] = [];
    if (withAttachments) {
      const checked = (await this.attachments.get(conversationId)?.check(attachmentIds)) ?? unknownAttachment();
      if (!checked.ok) return refuse(checked);
      kinds = checked.value!;
    }
    let conversation = this.conversations.get(conversationId);
    if (conversation === undefined || !conversation.live) {
      const resumed = await this.resume(conversationId, "send", mayResume);
      if (!resumed.ok) return refuse(resumed);
      conversation = resumed.value!;
    }
    let ready: ReadyAttachment[] = [];
    const store = this.attachments.get(conversationId);
    if (withAttachments) {
      const accepts = conversation.accepts;
      if (accepts !== undefined && !accepts.image && kinds.includes("image")) {
        return refuse(failure("attachment-not-accepted", `${AGENT_ADAPTERS[conversation.agent].label} does not take pictures.`));
      }
      const can = conversation.canSend();
      if (!can.ok) return refuse(can);
      if (store === undefined) return refuse(unknownAttachment());
      // 023 R-366 (D-023-3): an agent that takes no page context gets the tab as a text file, not a refusal.
      const taken = await store.take(attachmentIds, { tabAsFile: accepts !== undefined && !accepts.context });
      if (!taken.ok) return taken;
      ready = taken.value;
    }
    const sent = conversation.send(text, activeTabId, ready);
    if (!sent.ok) {
      if (store !== undefined) await store.discard(ready);
      return refuse(sent);
    }
    const title = titleOf(text);
    await this.update(conversationId, (entry) => ({
      ...entry,
      lastUsedAt: this.iso(),
      ...(entry.title === NEW_TITLE && title !== undefined ? { title } : {}),
    }));
    return { ok: true };
  }

  /**
   * 022 R-337: one piece of an attachment for the conversation's next message, staged in its folder
   * (files) or in memory. The conversation need not be running: its folder is the index entry's.
   */
  async attach(conversationId: string, piece: AttachPiece): Promise<CommandOutcome> {
    if (this.shuttingDown) return failure("broker-unavailable", "Hallpass is shutting down.");
    const entry = await this.options.index.get(conversationId);
    if (entry === undefined) return unknown();
    if (this.foreign(entry)) return inUseElsewhere();
    let store = this.attachments.get(conversationId);
    if (store === undefined) {
      store = new AttachmentStore({
        folder: this.folderOf(entry),
        clock: this.clock,
        ...(this.options.log === undefined ? {} : { log: this.options.log }),
      });
      this.attachments.set(conversationId, store);
    }
    // T618: a transfer under way keeps its conversation from the idle stop (and, below, eviction).
    this.conversations.get(conversationId)?.noteActivity();
    return store.receive(piece);
  }

  /** T618: a piece reached this conversation within the attachment idle limit (a transfer under way). */
  private receivingAttachment(conversationId: string): boolean {
    const at = this.attachments.get(conversationId)?.lastPieceAt;
    return at !== undefined && this.clock.now() - at < ATTACHMENT_IDLE_MS;
  }

  /** 022 R-340: the owner removed an attachment, or the panel gave its transfer up; ok when unknown. */
  async cancelAttachment(conversationId: string, attachmentId: string): Promise<CommandOutcome> {
    await this.attachments.get(conversationId)?.cancel(attachmentId);
    return { ok: true };
  }

  /** 022 R-344: what this agent said it accepts at its last start in this broker, if it has started. */
  agentAccepts(agent: ConversationAgent): ConversationAccepts | undefined {
    return this.lastAccepts.get(agent);
  }

  async stop(conversationId: string): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) return (await this.known(conversationId)) ? { ok: true } : unknown();
    // R-354 (T659): a start is stopped by ending it; its own result says `start-cancelled`. A first
    // start is listed before its admission (T668): Stopped while it waits for its slot, it ends too.
    const listed = this.firstStarts.has(conversationId) && !conversation.live;
    if (conversation.state === "starting" || listed) {
      await conversation.cancelStart(listed);
      return { ok: true };
    }
    return conversation.stop();
  }

  async answer(conversationId: string, requestId: string, answer: OwnerAnswer): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined && !(await this.known(conversationId))) return unknown();
    if (conversation === undefined || !conversation.live) {
      return failure("agent-exited", "The agent that asked is no longer running.");
    }
    // Not open any more (answered in another panel, FR-288) is not an error: the card is gone either way.
    if (conversation.answer(requestId, answer) === "reject-only") {
      // R-353: the panel offered only Reject; an allow here is a command the card never offered.
      return failure("invalid-command", "Hallpass cannot tell what this action is, so it can only be rejected.");
    }
    return { ok: true };
  }

  /**
   * `mayRestart`: the consent (FR-299), asked before a launch-time mode change starts a new agent run
   * (R-351) - that run is minted a browser token like any start or resume.
   */
  async setMode(conversationId: string, mode: ConversationMode, mayRestart?: ResumeGate): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    const entry = conversation?.live ? undefined : await this.options.index.get(conversationId);
    if (conversation === undefined && entry === undefined) return unknown();
    const agent = conversation?.agent ?? entry!.agent;
    if (modeFixedOnceStarted(agent)) {
      // D-021-16: running, starting or stopped - its session has (or is getting) its mode for good;
      // a first start not spawned yet has no entry, and its mode is the one it carries (FR-361).
      const current = conversation?.live ? conversation.mode : (entry?.mode ?? this.firstStarts.get(conversationId)?.mode);
      return mode === current ? { ok: true } : modeFixed(agent);
    }
    if (conversation === undefined || !conversation.live) {
      return failure("agent-exited", "The agent is not running; it starts in strict mode when the conversation continues.");
    }
    if (restartsForMode(conversation.agent, conversation.mode, mode)) {
      const restarted = await this.restart(conversation, mode, mayRestart);
      if (restarted.ok) await this.update(conversationId, (entry) => ({ ...entry, mode, lastUsedAt: this.iso() }));
      this.options.onChange?.();
      return restarted;
    }
    const changed = await conversation.setMode(mode);
    if (changed.ok) await this.update(conversationId, (entry) => ({ ...entry, mode }));
    return changed;
  }

  /** FR-304: opening an entry replays it from the agent's own record (a resume); a live one is just there. */
  async open(conversationId: string, mayResume?: ResumeGate): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation?.live) return { ok: true };
    const resumed = await this.resume(conversationId, "open", mayResume);
    return resumed.ok ? { ok: true } : resumed;
  }

  /** Removes the entry only (FR-304: nothing else is deleted - not the scratch folder, not the agent's record). */
  async remove(conversationId: string): Promise<CommandOutcome> {
    const entry = await this.options.index.get(conversationId);
    const conversation = this.conversations.get(conversationId);
    if (entry === undefined && conversation === undefined) return unknown();
    if (entry !== undefined && this.foreign(entry)) return inUseElsewhere();
    if (conversation !== undefined) await conversation.close("gone");
    this.conversations.delete(conversationId);
    // 022 R-340 / FR-340: what was staged goes; files already sent stay in the owner's folder.
    await this.dropAttachments(conversationId);
    await this.write(() => this.options.index.remove(conversationId));
    this.options.onChange?.();
    return { ok: true };
  }

  /** The live log's pages (R-318); a conversation this broker has not run has an empty one. */
  page(conversationId: string, fromSeq: number): { ok: true; value: ConversationPage } | { ok: false; error: ConversationError } {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) return { ok: true, value: { fromSeq, events: [], more: false } };
    return { ok: true, value: conversation.page(fromSeq) };
  }

  async views(): Promise<ConversationView[]> {
    const entries = await this.options.index.list();
    this.watchReleases(entries.filter((entry) => this.foreign(entry)).map((entry) => entry.conversationId));
    // R-354: a first start under way, listed (newest first, as the index lists) until it ends.
    const listed = new Set(entries.map((entry) => entry.conversationId));
    const starting: ConversationView[] = [...this.firstStarts]
      .filter(([conversationId]) => !listed.has(conversationId))
      .reverse()
      .map(([conversationId, pending]) => ({
        conversationId,
        agent: pending.agent,
        title: NEW_TITLE,
        folder: pending.folder,
        mode: pending.mode,
        createdAt: pending.at,
        lastUsedAt: pending.at,
        resumable: false,
        state: "starting",
      }));
    return [...starting, ...entries.map((entry) => {
      const conversation = this.conversations.get(entry.conversationId);
      const { agentSessionId: _session, lease: _lease, ...shownEntry } = entry;
      return {
        ...shownEntry,
        mode: conversation?.live ? conversation.mode : entry.mode,
        state: conversation?.state ?? "stopped",
        ...(this.foreign(entry) ? { inUseElsewhere: true } : {}),
        // 022 R-344: a running agent's own answer; otherwise the panel falls back to the agent's.
        ...(conversation?.live && conversation.accepts !== undefined ? { accepts: conversation.accepts } : {}),
        // 021 R-352 (T666): continued without a replay, so the earlier turns are not in the panel's log.
        ...(conversation?.replayNone ? { replay: "none" as const } : {}),
      };
    })];
  }

  folderOf(entry: ConversationEntry): string {
    return entry.folder.kind === "scratch" ? scratchFolderPath(this.options.dataDir, entry.conversationId) : entry.folder.path;
  }

  /**
   * R-321: every live run's token, handed to the worker again. A worker revokes them all when the
   * broker's link goes or a new relay starts, so the broker calls this on each attach.
   */
  regrantBrowserTokens(): void {
    for (const conversation of this.conversations.values()) conversation.regrant();
  }

  /** T558: consent withdrawn - every live run's token is revoked and not handed again (FR-299). */
  /** 023 R-367 (FR-372): what the conversation's latest run printed about itself; none for one this pool does not hold. */
  /**
   * 024 R-387: the agent's conversation whose run started last in this broker, with that run's lines;
   * none when no conversation of it has run here (a removed one is gone with its lines).
   */
  latestRun(agent: ConversationAgent): { conversationId: string; serial: number; lines: string[] } | undefined {
    let latest: Conversation | undefined;
    for (const conversation of this.conversations.values()) {
      if (conversation.agent !== agent || conversation.runSerial === 0) continue;
      if (latest === undefined || conversation.runSerial > latest.runSerial) latest = conversation;
    }
    return latest === undefined ? undefined : { conversationId: latest.conversationId, serial: latest.runSerial, lines: latest.diagnostics() };
  }

  diagnostics(conversationId: string): string[] {
    return this.conversations.get(conversationId)?.diagnostics() ?? [];
  }

  /** 023 R-365: the worker's `conversation-browser-attached` - that conversation's server greeted. */
  browserAttached(conversationId: string): void {
    this.conversations.get(conversationId)?.browserAttached();
  }

  revokeBrowserTokens(): void {
    // T579: first, so a start whose consent check is under way hands nothing out after this.
    this.revocations += 1;
    for (const conversation of this.conversations.values()) conversation.revokeBrowserToken();
  }

  /** T579: whether no withdrawal has come since this call (`revokeBrowserTokens`). */
  private noWithdrawalSinceNow(): () => boolean {
    const seen = this.revocations;
    return () => this.revocations === seen;
  }

  /** Every agent ended, every lease of this broker cleared (R-319). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.releaseCheck?.cancel();
    this.releaseCheck = undefined;
    await Promise.all([...this.conversations.values()].map((conversation) => conversation.close("gone")));
    await Promise.all([...this.attachments.keys()].map((conversationId) => this.dropAttachments(conversationId)));
    // T618: drops begun by the agents' own ending (their state change) are awaited too.
    await Promise.all([...this.clearing]);
    await this.writes.catch(() => undefined);
  }

  /** 022 R-340: a conversation's staged attachments, part files included, are dropped. */
  private async dropAttachments(conversationId: string): Promise<void> {
    const store = this.attachments.get(conversationId);
    if (store === undefined) return;
    this.attachments.delete(conversationId);
    const cleared = store.clear().catch(() => undefined);
    this.clearing.add(cleared);
    try {
      await cleared;
    } finally {
      this.clearing.delete(cleared);
    }
  }

  /**
   * R-351 (T664): checked between turns before anything is asked, then the consent and the mode's
   * launch (Hermes' managed layer written); the conversation checks again before it closes the agent.
   */
  private async restart(conversation: Conversation, mode: ConversationMode, mayRestart?: ResumeGate): Promise<CommandOutcome> {
    const ready = conversation.canRestart();
    if (!ready.ok) return ready;
    const mayHandOut = this.noWithdrawalSinceNow();
    if (mayRestart !== undefined) {
      const allowed = await mayRestart();
      if (!allowed.ok) return allowed;
    }
    const launch = await this.options.resolveLaunch(conversation.agent, mode);
    if (!launch.ok) return launch;
    const restarted = await conversation.restart(mode, { spec: launch.spec, versions: launch.versions, mayHandOut });
    if (restarted.ok) this.noteAccepts(conversation);
    return restarted;
  }

  /** 022 R-344: the agent's answer at this start, remembered as its last seen; the overview follows. */
  private noteAccepts(conversation: Conversation): void {
    if (conversation.accepts !== undefined) this.lastAccepts.set(conversation.agent, conversation.accepts);
  }

  /* ----------------------------------------------------------------------------------------- */

  private create(conversationId: string, agent: ConversationAgent): Conversation {
    const conversation = new Conversation(conversationId, agent, {
      clock: this.clock,
      onEvent: this.options.onEvent,
      onStateChange: (changed) => this.onStateChange(changed),
      onIdle: (idle) => void idle.close("stopped"),
      ...(this.options.idleMs === undefined ? {} : { idleMs: this.options.idleMs }),
      ...(this.options.spawnAgent === undefined ? {} : { spawnAgent: this.options.spawnAgent }),
      ...(this.options.browser === undefined ? {} : { browser: this.options.browser }),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.userEnvironment === undefined ? {} : { userEnvironment: this.options.userEnvironment }),
    });
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  private onStateChange(conversation: Conversation): void {
    const state = conversation.state;
    if (state === "stopped" || state === "crashed" || state === "gone") {
      // 022 R-340: what was staged for its next message goes with the agent's run.
      void this.dropAttachments(conversation.conversationId);
      // R-319: the lease goes with the agent (idle stop, eviction, crash, shutdown).
      void this.update(conversation.conversationId, (entry) => {
        if (entry.lease === undefined || !this.mine(entry.lease)) return entry;
        const { lease: _lease, ...rest } = entry;
        return rest;
      });
    }
    this.options.onChange?.();
  }

  private async resume(conversationId: string, how: "open" | "send", mayResume?: ResumeGate): Promise<CommandOutcome<Conversation>> {
    if (this.shuttingDown) return failure("broker-unavailable", "Hallpass is shutting down.");
    const mayHandOut = this.noWithdrawalSinceNow();
    const entry = await this.options.index.get(conversationId);
    if (entry === undefined) return unknown();
    if (this.foreign(entry)) return inUseElsewhere();
    if (!entry.resumable) return failure("cannot-resume", "The agent can no longer continue this conversation.");
    // A resume starts an agent run and mints it a browser token: the same consent as a start.
    if (mayResume !== undefined) {
      const allowed = await mayResume();
      if (!allowed.ok) return allowed;
    }
    const cwd = this.folderOf(entry);
    if (!(await this.folderExists(cwd))) {
      return failure(
        "folder-missing",
        entry.folder.kind === "scratch"
          ? "This conversation's scratch folder was deleted, so it cannot continue."
          : `The folder ${cwd} does not exist any more, so this conversation cannot continue.`,
      );
    }
    // FR-289: every resume starts strict - except (D-021-16) an agent whose session keeps its first mode.
    const mode: ConversationMode = modeFixedOnceStarted(entry.agent) ? entry.mode : "strict";
    const launch = await this.options.resolveLaunch(entry.agent, mode);
    if (!launch.ok) return launch;
    const existing = this.conversations.get(conversationId);
    const created = existing ?? this.create(conversationId, entry.agent);
    const admitted = await this.admit(created, how);
    if (!admitted.ok) {
      // Not if another caller's resume holds it now (it is starting or live under that caller).
      if (existing === undefined && this.conversations.get(conversationId) === created && !created.live && created.state !== "starting") {
        this.conversations.delete(conversationId);
      }
      return admitted;
    }
    const admission = admitted.value!;
    // T572: the conversation was already starting (an open joins that start) or live.
    if (admission.kind === "joined") return admission.outcome;
    const conversation = admission.conversation;
    let outcome: CommandOutcome<Conversation> = failure("broker-unavailable", "Hallpass could not continue this conversation.");
    try {
      const started = await conversation.start({
        cwd,
        spec: launch.spec,
        versions: launch.versions,
        resume: entry.agentSessionId,
        mode,
        mayHandOut,
      });
      if (!started.ok) {
        if (started.unknownSession) await this.update(conversationId, (current) => ({ ...current, resumable: false }));
        this.options.onChange?.();
        outcome = { ok: false, error: started.error };
        return outcome;
      }
      this.noteAccepts(conversation);
      await this.update(conversationId, (current) => ({ ...current, mode, lastUsedAt: this.iso(), lease: this.lease() }));
      this.options.onChange?.();
      outcome = { ok: true, value: conversation };
      return outcome;
    } finally {
      this.resuming.delete(conversationId);
      admission.settle(outcome);
    }
  }

  /**
   * FR-311: room for one more live agent. At the cap the live one idle longest is stopped (it
   * resumes on its next message); a running turn or an open card is never stopped. `starting` marks
   * the reservation, so the slot is held while the agent comes up.
   *
   * T572: a resume (`join`) is admitted once per conversation. The check is here, inside the
   * serialised section and with the reservation, because a caller's own `live` check comes before
   * the seconds of index read, consent and discovery: a conversation already starting is joined by
   * an `open` (it settles with that start) and refused `busy` to a `send`; one already live is
   * handed back as it is. Neither starts a second agent.
   */
  private admit(conversation: Conversation, join?: "open" | "send"): Promise<CommandOutcome<Admission>> {
    const run = async (): Promise<CommandOutcome<Admission>> => {
      const id = conversation.conversationId;
      let target = conversation;
      if (join !== undefined) {
        const current = this.conversations.get(id);
        // Dropped by another caller whose admission failed meanwhile: this one keeps it listed.
        if (current === undefined) this.conversations.set(id, conversation);
        else target = current;
        if (target.state === "starting") {
          if (join === "send") return failure("busy", "The agent of this conversation is still starting; send again in a moment.");
          return { ok: true, value: { kind: "joined", outcome: this.resuming.get(id) ?? Promise.resolve({ ok: true, value: target }) } };
        }
        if (target.live) return { ok: true, value: { kind: "joined", outcome: Promise.resolve({ ok: true, value: target }) } };
      }
      const live = [...this.conversations.values()].filter(
        (other) => other !== target && (other.live || other.state === "starting"),
      );
      if (live.length >= this.cap) {
        // T618: nor one an attachment is on its way to (a piece within the attachment idle limit).
        const victim = live
          .filter((other) => other.evictable && !this.receivingAttachment(other.conversationId))
          .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
        if (victim === undefined) {
          return failure(
            "too-many-running",
            `${this.cap} conversations are already running or waiting for you; stop one or answer its card first.`,
          );
        }
        this.options.log?.("conversation.evicted", victim.conversationId);
        await victim.close("stopped");
      }
      target.reserve();
      let settle: (outcome: CommandOutcome<Conversation>) => void = () => undefined;
      if (join !== undefined) this.resuming.set(id, new Promise((done) => (settle = done)));
      return { ok: true, value: { kind: "reserved", conversation: target, settle } };
    };
    const result = this.admission.then(run, run);
    this.admission = result.catch(() => undefined);
    return result;
  }

  private async prepareFolder(conversationId: string, folder: ConversationFolder): Promise<string | undefined> {
    if (folder.kind === "project") return folder.path;
    // D-019-8 / T562: `<data>\scratch\<conversationId>`, made here, never deleted by Hallpass.
    return ensureScratchFolder(this.options.dataDir, conversationId);
  }

  private folderExists(path: string): Promise<boolean> {
    return (this.options.folderExists ?? isDirectory)(path);
  }

  private async known(conversationId: string): Promise<boolean> {
    return (await this.options.index.get(conversationId)) !== undefined;
  }

  private lease(): NonNullable<ConversationEntry["lease"]> {
    return { browserRunId: this.options.browserRunId, pid: this.brokerPid, at: this.iso() };
  }

  private mine(lease: NonNullable<ConversationEntry["lease"]>): boolean {
    return lease.browserRunId === this.options.browserRunId && lease.pid === this.brokerPid;
  }

  /** R-319: held by another broker whose process is alive. A dead holder's lease is ignored. */
  private foreign(entry: ConversationEntry): boolean {
    return entry.lease !== undefined && !this.mine(entry.lease) && this.isAlive(entry.lease.pid);
  }

  /**
   * T577 (D-019-14): the conversations last listed as in use in another browser. Another broker's
   * release reaches only the file, so while any is listed the index is looked at again every
   * `LEASE_RECHECK_MS`; one that is free now - released, removed, or its holder dead - makes the
   * list go out again (`onChange`). Nothing is looked at while none is listed.
   */
  private watchReleases(heldElsewhere: string[]): void {
    this.heldElsewhere = new Set(heldElsewhere);
    if (this.heldElsewhere.size === 0 || this.shuttingDown) {
      this.releaseCheck?.cancel();
      this.releaseCheck = undefined;
      return;
    }
    this.releaseCheck ??= this.clock.setTimer(() => {
      this.releaseCheck = undefined;
      void this.checkReleases();
    }, LEASE_RECHECK_MS);
  }

  private async checkReleases(): Promise<void> {
    if (this.shuttingDown) return;
    const entries = await this.options.index.list().catch(() => undefined);
    if (entries === undefined) {
      this.watchReleases([...this.heldElsewhere]);
      return;
    }
    const before = this.heldElsewhere.size;
    const still = entries
      .filter((entry) => this.heldElsewhere.has(entry.conversationId) && this.foreign(entry))
      .map((entry) => entry.conversationId);
    this.watchReleases(still);
    if (still.length < before) this.options.onChange?.();
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private write<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task, task);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private update(conversationId: string, change: (entry: ConversationEntry) => ConversationEntry): Promise<void> {
    return this.write(async () => {
      const entry = await this.options.index.get(conversationId);
      if (entry === undefined) return;
      const next = change(entry);
      if (next !== entry) await this.options.index.put(next);
    });
  }
}

const unknown = (): { ok: false; error: ConversationError } =>
  // T547 (G3): `not-found`, not `cannot-resume` - nothing about the conversation failed, there is none.
  failure("not-found", "This conversation is not in the list any more.");
const inUseElsewhere = (): { ok: false; error: ConversationError } =>
  failure("in-use-elsewhere", "This conversation is running in another browser.");
const unknownAttachment = (): { ok: false; error: ConversationError } =>
  failure("attachment-unknown", "An attachment of this message is no longer held; add it again.");
