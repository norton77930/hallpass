import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  CONVERSATION_NOTICES,
  CONVERSATION_RULE_KINDS,
  CONVERSATION_TEXT_MAX_CHARS,
  CONVERSATION_TOOL_KINDS,
  type ConversationAgent,
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
import { AGENT_ADAPTERS, classifyStartFailure, type AdapterLaunchSpec, type StartFailureVersions } from "./agents.js";
import { PANEL_SERVER_NAME, type ConversationBrowserAccess, type PanelServerName } from "./browser-token.js";
import type { ConversationIndex, FolderList } from "./conversation-index.js";
import { ConversationEventLog, type ConversationPage } from "./event-log.js";
import { ensureScratchFolder, isDirectory, scratchFolderPath } from "./folders.js";
import { redact } from "./redact.js";

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
 * R-316: the panel's two modes and the agent mode behind each. An adapter's other modes (Claude's
 * `acceptEdits`, `plan`, `bypassPermissions`; Codex's `agent-full-access`) are never sent and never
 * shown; the panel only ever sees `strict` / `agent-review`.
 */
export const MODE_ALLOW_LIST: Readonly<Record<ConversationAgent, Readonly<Record<ConversationMode, string>>>> = {
  "claude-code": { strict: "default", "agent-review": "auto" },
  codex: { strict: "read-only", "agent-review": "agent" },
};

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
const RENAME_FIRST: Readonly<Record<ConversationAgent, boolean>> = { "claude-code": false, codex: true };

/** T542a: what the `mode` event says after a switch that reloaded the conversation. */
const RELOAD_NOTE: Readonly<Record<ConversationMode, string>> = {
  strict: "Hallpass reloaded the conversation with its strict rules: edits and commands ask you first, whatever your own settings allow.",
  "agent-review": "Hallpass reloaded the conversation without its strict rules: your own agent settings and the agent's review apply.",
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
 * every MCP tool), else its title. `read`, `search`, `think` never get a rule.
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
  return `other:${adapterToolName(toolCall._meta) ?? toolCall.title ?? ""}`;
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

type OwnerAnswer = "allow-once" | "reject" | "allow-conversation";
type Closure = OwnerAnswer | "by-rule" | "cancelled" | "agent-exited";

type Card = {
  requestId: string;
  toolCallId: string;
  ruleKey: string | undefined;
  options: acp.PermissionOption[];
  resolve: (response: acp.RequestPermissionResponse) => void;
};

/** `stopped`: the owner pressed Stop; the conversation says so when the turn ends (US1.4). */
type Turn = { cancelled: boolean; stopped: boolean; rejected: Set<string> };

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
};

export type StartRequest = {
  cwd: string;
  spec: AdapterLaunchSpec;
  versions: StartFailureVersions;
  /** The agent's own session id: resume with `session/load` instead of `session/new`. */
  resume?: string;
  /**
   * T579 (D-019-14, R-331): asked at the hand-out itself - nothing awaits between it and the token's mint -
   * whether no withdrawal came since the caller's consent check began; `false` starts nothing.
   */
  mayHandOut?: () => boolean;
};

export type StartOutcome =
  | { ok: true; agentSessionId: string }
  | { ok: false; error: ConversationError; unknownSession?: boolean };

/** The broker's own process tree: a plain child, stdio piped, stderr never read (R-326). */
export function spawnAgentProcess(spec: AdapterLaunchSpec, cwd: string): ChildProcess {
  return spawn(spec.command, spec.args, {
    cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

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
  /** The agent's mode id the owner chose (through `mode`); anything else reported is drift. */
  private ownerModeId: string;
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
  private closing: { target: "stopped" | "gone" } | undefined;
  private turn: Turn | undefined;
  private readonly cards = new Map<string, Card>();
  private cardCounter = 0;
  /** R-317: "for this conversation" rules, memory only and not resumed. */
  private readonly rules = new Set<string>();
  private readonly tools = new Map<string, ToolView>();
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

  constructor(
    readonly conversationId: string,
    readonly agent: ConversationAgent,
    private readonly deps: ConversationDeps,
  ) {
    this.ownerModeId = MODE_ALLOW_LIST[agent].strict;
    this.lastActivity = deps.clock.now();
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
    if (request.mayHandOut?.() === false) {
      this.setState(request.resume ? "stopped" : "gone");
      return failure("consent-needed", "You withdrew the side-panel agent's access to this browser; the agent was not started.");
    }
    this.closing = undefined;
    this.rules.clear();
    this.watchingMode = false;
    this.reloading = false;
    this.cwd = request.cwd;
    this.modeValue = "strict";
    this.ownerModeId = MODE_ALLOW_LIST[this.agent].strict;
    this.renamePending = false;
    this.muted = false;
    this.inertToken = undefined;
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
      return { ok: false, error: classifyStartFailure("initialize", error, request.versions) };
    }
    this.child = child;
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

    let step: "initialize" | "session/new" | "session/load" | "session/set_mode" = "initialize";
    try {
      const init = await this.request(() =>
        connection.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "hallpass", version: "0.0.0" },
        }),
      );
      this.serverName = await naming;
      const mcpServers = this.mcpServers();
      let modes: acp.SessionModeState | null | undefined;
      if (request.resume !== undefined) {
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
            ...sessionMeta(this.agent, "strict"),
          }),
        );
        await settle();
        this.flushText();
        this.replay = "off";
        modes = loaded.modes;
      } else {
        step = "session/new";
        const created = await this.request(() =>
          connection.agent.request("session/new", { cwd: request.cwd, mcpServers, ...sessionMeta(this.agent, "strict") }),
        );
        this.sessionId = created.sessionId;
        modes = created.modes;
        this.renamePending = RENAME_FIRST[this.agent];
      }

      // R-316 / FR-289: strict, set and confirmed, before anything of the owner's goes out.
      step = "session/set_mode";
      const strictId = MODE_ALLOW_LIST[this.agent].strict;
      if (!modes?.availableModes.some((mode) => mode.id === strictId)) {
        throw new Error(`the agent does not offer its "${strictId}" mode`);
      }
      this.reportedModeId = undefined;
      await this.request(() => connection.agent.request("session/set_mode", { sessionId: this.sessionId!, modeId: strictId }));
      await settle();
      if (this.reportedModeId !== undefined && this.reportedModeId !== strictId) {
        throw new Error(`the agent reported "${this.reportedModeId}" after being set to "${strictId}"`);
      }
      this.watchingMode = true;
    } catch (error) {
      this.replay = "off";
      await this.kill();
      if (request.resume !== undefined) {
        this.setState("stopped");
        if (step === "session/load") {
          const unknownSession = isUnknownSession(error);
          return {
            ok: false,
            unknownSession,
            error: failure(
              "cannot-resume",
              unknownSession
                ? `${AGENT_ADAPTERS[this.agent].label} no longer has this conversation.`
                : `${AGENT_ADAPTERS[this.agent].label} could not continue this conversation: ${errorMessage(error)}`,
            ).error,
          };
        }
      } else {
        this.setState("gone");
      }
      if (error instanceof AgentExited && step !== "initialize" && step !== "session/new") {
        return failure("agent-exited", `${AGENT_ADAPTERS[this.agent].label} ${error.message} while starting.`);
      }
      return {
        ok: false,
        error: classifyStartFailure(step === "initialize" ? "initialize" : "session/new", error, request.versions),
      };
    }

    this.enqueue({ type: "mode", mode: "strict" });
    this.touch();
    this.setState("idle");
    this.armIdle();
    return { ok: true, agentSessionId: this.sessionId! };
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
    this.deps.browser?.grant({ conversationId: this.conversationId, token: null });
    // A reload with no entry would let the owner's own `hallpass` load for this session (R-322).
    this.inertToken = this.deps.browser?.mint();
  }

  /** The pool's admission holds the slot from here until `start` settles (FR-311). */
  reserve(): void {
    this.setState("starting");
  }

  /** A request that fails as soon as the agent exits, rather than whenever the stream notices. */
  private request<T>(send: () => Promise<T>): Promise<T> {
    return Promise.race([send(), this.exited ?? Promise.reject(new AgentExited(null))]);
  }

  /* ----------------------------------------------------------------------------------------- */
  /* The owner's commands                                                                        */
  /* ----------------------------------------------------------------------------------------- */

  /** `startTabId`: the tab the owner was viewing, the turn's first browser target (FR-306). */
  send(text: string, startTabId?: number): CommandOutcome {
    const connection = this.connection;
    if (connection === undefined || this.sessionId === undefined || !this.live) {
      return failure("agent-exited", "The agent is not running.");
    }
    if (this.stateValue !== "idle" || this.turn !== undefined || this.reloading) {
      // T547 (G3): its own code, so the panel can say "wait or stop" rather than "the helper is gone".
      return failure("busy", "The agent is still answering; stop it or wait for the end of its turn.");
    }
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
    this.enqueue({ type: "text", role: "owner", text });
    const turn: Turn = { cancelled: false, stopped: false, rejected: new Set() };
    this.turn = turn;
    this.setState("running");
    const sessionId = this.sessionId;
    const prompt = (body: string) => connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] });
    // R-322: a new session's title first - the list's own title for it (data-model) - then the message.
    const rename = this.renamePending ? `/rename ${titleOf(text) ?? NEW_TITLE}` : undefined;
    this.renamePending = false;
    (rename === undefined ? Promise.resolve() : this.renameFirst(connection, sessionId, rename))
      .then((): Promise<acp.PromptResponse> => (turn.cancelled ? Promise.resolve({ stopReason: "cancelled" }) : prompt(text)))
      .then(
        async (response) => {
          await settle();
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
          this.enqueue({ type: "notice", code: "turn-failed", text: shown(`The agent's turn failed: ${errorMessage(error)}`, 2048) });
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

  /** `true` when a card was answered; `false` when it was not open (already answered elsewhere, FR-288). */
  answer(requestId: string, answer: OwnerAnswer): boolean {
    const card = this.cards.get(requestId);
    if (card === undefined) return false;
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
    return true;
  }

  async setMode(mode: ConversationMode): Promise<CommandOutcome> {
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
    const previous = { mode: this.modeValue, id: this.ownerModeId };
    // Owner-caused: set before the request, so the agent's own echo of it is not drift.
    this.modeValue = mode;
    this.ownerModeId = MODE_ALLOW_LIST[this.agent][mode];
    try {
      await this.request(() => connection.agent.request("session/set_mode", { sessionId: this.sessionId!, modeId: this.ownerModeId }));
    } catch (error) {
      this.modeValue = previous.mode;
      this.ownerModeId = previous.id;
      return failure(
        error instanceof AgentExited ? "agent-exited" : "agent-version",
        `The agent did not change its mode: ${errorMessage(error)}`,
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
    const targetId = MODE_ALLOW_LIST[this.agent][mode];
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
          text: shown(`Hallpass could not reload the conversation in the new mode (${errorMessage(error)}); the agent was stopped.`, 2048),
        });
        await this.close("stopped");
      }
      return failure(
        error instanceof AgentExited ? "agent-exited" : "agent-version",
        `The agent did not change its mode: ${errorMessage(error)}`,
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
        this.showTool(update);
        return;
      }
      case "current_mode_update": {
        this.reportedModeId = update.currentModeId;
        if (this.watchingMode && update.currentModeId !== this.ownerModeId) this.onDrift(update.currentModeId);
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

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const { toolCall, options } = params;
    // A request outside a live turn, or after the owner (or a drift) cancelled it, is answered cancelled.
    if (this.turn === undefined || this.turn.cancelled) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const known = this.tools.get(clip(toolCall.toolCallId, 128));
    const kind = toolCall.kind ? toolKind(toolCall.kind) : (known?.kind ?? "other");
    const title = toolCall.title ?? known?.title ?? "";
    const sandboxGrant = this.agent === "codex" && isCodexSandboxPermissionsRequest(params);
    if (sandboxGrant && this.modeValue === "strict") {
      // R-317 / SC-135: a grant for the rest of the turn is not one action; Codex asks for each instead.
      this.enqueue({ type: "notice", code: SANDBOX_PERMISSIONS_DECLINED, text: shown(permissionDetail(toolCall), 2048) });
      const reject = options.find((option) => option.kind === "reject_once");
      return Promise.resolve(
        reject === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: reject.optionId } },
      );
    }
    const ruleKey = sandboxGrant ? undefined : permissionRuleKey({ kind, title, _meta: toolCall._meta });

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
      this.cards.set(requestId, { requestId, toolCallId: toolCall.toolCallId, ruleKey, options, resolve });
      this.enqueue({
        type: "permission",
        requestId,
        toolCallId: clip(toolCall.toolCallId, 128),
        kind,
        title: shown(title, 200),
        detail: shown(permissionDetail(toolCall), 2048),
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
    if (connection === undefined || sessionId === undefined) return;
    const reset: Promise<void> = connection.agent.request("session/set_mode", { sessionId, modeId: this.ownerModeId }).then(
      () => undefined,
      (error: unknown) => {
        if (!this.live) return;
        // An agent left in a mode the owner did not choose is not left running.
        this.enqueue({
          type: "notice",
          code: "mode-reset-failed",
          text: shown(`Hallpass could not set the mode back (${errorMessage(error)}); the agent was stopped.`, 2048),
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
    this.turn = undefined;
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

  private setState(state: ConversationState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    if (state !== "idle") this.cancelIdle();
    this.enqueue({ type: "state", state });
    this.deps.onStateChange?.(this);
  }

  private touch(): void {
    this.lastActivity = this.deps.clock.now();
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
    if (event.type === "text" && event.text.length === 0) return;
    if (event.type === "text" || event.type === "tool") this.contentShown = true;
    if (event.type === "text") {
      const last = this.outbox.at(-1);
      if (last?.type === "text" && last.role === event.role && last.text.length + event.text.length <= CONVERSATION_TEXT_MAX_CHARS) {
        this.outbox[this.outbox.length - 1] = { ...last, text: last.text + event.text };
      } else {
        for (let start = 0; start < event.text.length; start += CONVERSATION_TEXT_MAX_CHARS) {
          this.outbox.push({ type: "text", role: event.role, text: event.text.slice(start, start + CONVERSATION_TEXT_MAX_CHARS) });
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
  resolveLaunch: (agent: ConversationAgent) => Promise<LaunchResolution>;
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
   */
  async start(
    agent: ConversationAgent,
    folder: ConversationFolder,
    mayStart?: ResumeGate,
  ): Promise<CommandOutcome<{ conversationId: string }>> {
    if (this.shuttingDown) return failure("broker-unavailable", "Hallpass is shutting down.");
    const mayHandOut = this.noWithdrawalSinceNow();
    if (folder.kind === "project") {
      if (!(await this.options.folders.has(folder.path))) return failure("folder-missing", "That folder is not in your folder list.");
      if (!(await this.folderExists(folder.path))) return failure("folder-missing", `The folder ${folder.path} does not exist any more.`);
    }
    const launch = await this.options.resolveLaunch(agent);
    if (!launch.ok) return launch;

    const conversationId = (this.options.newConversationId ?? randomUUID)();
    const conversation = this.create(conversationId, agent);
    const admitted = await this.admit(conversation);
    if (!admitted.ok) {
      this.conversations.delete(conversationId);
      return admitted;
    }
    const cwd = await this.prepareFolder(conversationId, folder);
    if (cwd === undefined) {
      this.conversations.delete(conversationId);
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
    const started = await conversation.start({ cwd, spec: launch.spec, versions: launch.versions, mayHandOut });
    if (!started.ok) {
      this.conversations.delete(conversationId);
      this.options.onChange?.();
      return { ok: false, error: started.error };
    }
    const at = this.iso();
    await this.write(async () =>
      this.options.index.put({
        conversationId,
        agent,
        agentSessionId: started.agentSessionId,
        title: NEW_TITLE,
        folder,
        mode: "strict",
        createdAt: at,
        lastUsedAt: at,
        resumable: true,
        lease: this.lease(),
      }),
    );
    this.options.onChange?.();
    return { ok: true, value: { conversationId } };
  }

  /** `mayResume`: asked before a stopped conversation's agent is started again (the consent, FR-299). */
  async send(conversationId: string, text: string, activeTabId?: number, mayResume?: ResumeGate): Promise<CommandOutcome> {
    let conversation = this.conversations.get(conversationId);
    if (conversation === undefined || !conversation.live) {
      const resumed = await this.resume(conversationId, "send", mayResume);
      if (!resumed.ok) return resumed;
      conversation = resumed.value!;
    }
    const sent = conversation.send(text, activeTabId);
    if (!sent.ok) return sent;
    const title = titleOf(text);
    await this.update(conversationId, (entry) => ({
      ...entry,
      lastUsedAt: this.iso(),
      ...(entry.title === NEW_TITLE && title !== undefined ? { title } : {}),
    }));
    return { ok: true };
  }

  async stop(conversationId: string): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined) return (await this.known(conversationId)) ? { ok: true } : unknown();
    return conversation.stop();
  }

  async answer(conversationId: string, requestId: string, answer: OwnerAnswer): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined && !(await this.known(conversationId))) return unknown();
    if (conversation === undefined || !conversation.live) {
      return failure("agent-exited", "The agent that asked is no longer running.");
    }
    // Not open any more (answered in another panel, FR-288) is not an error: the card is gone either way.
    conversation.answer(requestId, answer);
    return { ok: true };
  }

  async setMode(conversationId: string, mode: ConversationMode): Promise<CommandOutcome> {
    const conversation = this.conversations.get(conversationId);
    if (conversation === undefined && !(await this.known(conversationId))) return unknown();
    if (conversation === undefined || !conversation.live) {
      return failure("agent-exited", "The agent is not running; it starts in strict mode when the conversation continues.");
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
    return entries.map((entry) => {
      const conversation = this.conversations.get(entry.conversationId);
      const { agentSessionId: _session, lease: _lease, ...shownEntry } = entry;
      return {
        ...shownEntry,
        mode: conversation?.live ? conversation.mode : entry.mode,
        state: conversation?.state ?? "stopped",
        ...(this.foreign(entry) ? { inUseElsewhere: true } : {}),
      };
    });
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
    await this.writes.catch(() => undefined);
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
    });
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  private onStateChange(conversation: Conversation): void {
    const state = conversation.state;
    if (state === "stopped" || state === "crashed" || state === "gone") {
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
    const launch = await this.options.resolveLaunch(entry.agent);
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
        mayHandOut,
      });
      if (!started.ok) {
        if (started.unknownSession) await this.update(conversationId, (current) => ({ ...current, resumable: false }));
        this.options.onChange?.();
        outcome = { ok: false, error: started.error };
        return outcome;
      }
      // FR-289: every resume starts strict again.
      await this.update(conversationId, (current) => ({ ...current, mode: "strict", lastUsedAt: this.iso(), lease: this.lease() }));
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
        const victim = live.filter((other) => other.evictable).sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
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
