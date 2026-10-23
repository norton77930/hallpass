import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * A stand-in for the owner's coding agent, speaking the ACP subset the broker uses (019/T521,
 * R-329): initialize, session/new, session/load, session/set_mode, session/prompt, session/cancel,
 * session/request_permission, session/update, mode drift and a crash.
 *
 * Run it as a stdio process, the way the broker spawns a real adapter:
 *
 *     node --experimental-strip-types tests/harness/fake-acp-agent.ts
 *
 * or import `serveFakeAcpAgent` to serve it over any pair of web streams. It imports only `node:`
 * modules and the SDK, so it runs under `--experimental-strip-types` with no build.
 *
 * It is deliberately not a model: every behaviour is selected by a keyword in the prompt text (or
 * by an environment variable) and a test can only assert what the *client* did with it.
 *
 * Environment
 * - FAKE_ACP_SCENARIO     `claude` (default): modes default / acceptEdits / plan / auto /
 *                         bypassPermissions, current `auto`. `codex`: read-only / agent /
 *                         agent-full-access, current `agent`.
 *                         021 (T653), shaped like the measured agents:
 *                         `hermes`: loadSession, image yes / embedded context no, modes default /
 *                         accept_edits / dont_ask (current `default`); a tool is announced, then
 *                         its permission request carries title and kind, options `allow_once`
 *                         (allow_once) and `deny` (reject_once).
 *                         `deepseek`: no modes, no loadSession, `sessionCapabilities` list / resume /
 *                         close (`session/resume` continues a session without replaying it), image
 *                         yes / embedded context no; every tool is announced as kind `other` with
 *                         `rawInput { command, justification }` and its permission request carries
 *                         only the `toolCallId`, options `allow-once` (allow_once) and `reject-once`
 *                         (reject_once).
 *                         The `start` log line names every environment variable the process got
 *                         (`envNames`, names only) and the values of Hallpass's own launch settings
 *                         (`launch`: HERMES_MANAGED_DIR, DSH_PERMISSION_MODE, DSH_TELEMETRY_MODE).
 * - FAKE_ACP_HANG_AT=initialize|new   never answer that request (a start that takes forever, T658).
 * - FAKE_ACP_RESET_ERROR  (021) after a `drift:`, refuse the session/set_mode that puts the mode back
 *                         with this text; `{env:NAME}` in it is replaced by that variable's value.
 * - FAKE_ACP_TURN_ERROR   the message `fail:turn` fails the turn with (T660); `{env:NAME}` in it
 *                         becomes the value of that variable.
 * - FAKE_ACP_LOG=<path>   append one JSON line per received request:
 *                         `{ method, params }` with a summary of the params (session/new and
 *                         session/load include the `_meta` they received as `meta`, null when
 *                         absent - T542a, D-019-12 - and the `mcpServers` entries whole as
 *                         `servers`, T552), plus
 *                         `{ event: "permission-answer", ... }` for what the client chose,
 *                         `{ event: "start" | "child", pid, ... }` for processes.
 * - FAKE_ACP_STORE=<path> keep the transcripts in a JSON file, so `session/load` works across
 *                         processes (without it they live in this process only).
 * - FAKE_ACP_SPAWN_CHILD=1     at start, spawn a long-lived child node process (pid in the log).
 * - FAKE_ACP_SPAWN_DETACHED=1  at start, spawn a detached long-lived node process (pid in the log).
 * - FAKE_ACP_CHUNK_DELAY_MS    pause between chunks (default 0).
 * - FAKE_ACP_FAIL_AT=initialize|new   refuse that request with a JSON-RPC internal error (-32603),
 *                         the way an adapter that cannot start does (T534); `new` lets initialize
 *                         succeed and fails session/new.
 * - FAKE_ACP_FAIL_MESSAGE the error text for FAKE_ACP_FAIL_AT (default `fake agent failed at <step>`).
 * - FAKE_ACP_EXIT_AT=initialize   (021 R-358) exit with code 1 on `initialize` without answering, so the
 *                         connection closes - an agent that crashes at boot (dsh without its bindings).
 * - FAKE_ACP_NEW_DELAY_MS (023) pause before answering session/new (after logging
 *                         `session/new-received`): a server that greets before the session exists.
 * - FAKE_ACP_STDERR_BYTES (023) at start, write about this many bytes to stderr first, as lines of
 *                         1000 `x` (an agent that says a lot about itself).
 * - FAKE_ACP_STDERR_LINES (023) at start, then write this many lines to stderr, each
 *                         FAKE_ACP_STDERR_LINE (default `stderr line {n}`) with `{n}` the line number
 *                         and `{env:NAME}` that variable's value; then log `{ event: "stderr-written" }`.
 *
 * Prompt keywords (whitespace-separated, executed left to right; text with none is echoed)
 * - chunks:N          N `agent_message_chunk` updates, text `part-1;` ... `part-N;`.
 * - think:N           (023) N `agent_thought_chunk` updates, text `thought-1;` ... `thought-N;`.
 * - tool:edit         tool_call (kind edit) -> session/request_permission -> tool_call_update
 *                     completed (+ chunk `done:<id>`) when allowed, or failed (+ chunk
 *                     `refused:<id>`) when the client rejected.
 * - tool:execute      the same with kind execute.
 * - tool:mcp          the same with kind other, titled like an MCP tool ("hallpass - read_page (MCP)").
 *                     The permission request offers allow_once, allow_always, reject_once and
 *                     reject_always, option ids `allow-once` ... `reject-always`.
 * - grant:permissions a request for wider sandbox permissions shaped as the Codex adapter sends it
 *                     (no tool_call before it; toolCall `name` "request_permissions", kind other,
 *                     title "Additional sandbox permissions"; request `_meta.permission.title`
 *                     "Grant permissions?"), with options `allow_permissions_turn` and
 *                     `allow_permissions_turn_strict_auto_review` (allow_once),
 *                     `allow_permissions_session` (allow_always) and `reject_permissions`
 *                     (reject_once). Then one chunk `granted:<id>` or `declined:<id>`.
 * - drift:<modeId>    the agent itself emits `current_mode_update` to <modeId> mid-turn.
 * - tool:unannounced  (021) a permission request for an id no `tool_call` announced, carrying only
 *                     that id, with the scenario's options; then one chunk `done:<id>` or `refused:<id>`.
 * - fail:turn         (021) the turn fails with a JSON-RPC internal error, text FAKE_ACP_TURN_ERROR.
 * - crash             the process exits with code 3 mid-turn.
 * - hang              the turn never ends until `session/cancel` (then stopReason `cancelled`).
 * - /rename <title>   (the whole prompt) answered locally: one chunk `renamed:<title>`, no tool
 *                     calls; the request is in the log as the session/prompt that came first.
 * - mcp:<tool>[:<json>]  calls <tool> on the session's `hallpass` MCP server - the stdio entry the
 *                     client handed over in `session/new` / `session/load` `mcpServers` - the way a
 *                     real agent uses a browser tool (019 T557): a tool_call (kind other, titled
 *                     "hallpass - <tool> (MCP)") that ends completed or failed, then one chunk
 *                     `mcp:<tool>:ok:<text>` or `mcp:<tool>:error:<text>` (text cut to 1000 chars).
 *                     No permission is asked: the browser's own site rules decide (FR-289). In the
 *                     JSON (no spaces: tokens split on whitespace), the string "$this" becomes the
 *                     first tab `tabs_context` lists as held by this session, and "$ref:<query>" the
 *                     first ref `find` returns for <query> (URI-encoded, so `%20` for a space) on
 *                     that tab. The server is started once per session (again after a
 *                     `session/load`, which carries a new token). Every call to the server, these
 *                     included, is in the log as `{ event: "mcp-call", tool, args, isError, text }`.
 */

export const FAKE_ACP_EXIT_CRASH = 3;

type Mode = { id: string; name: string };

const MODE_SETS: Record<string, { modes: Mode[]; current: string }> = {
  claude: {
    modes: [
      { id: "default", name: "Default" },
      { id: "acceptEdits", name: "Accept Edits" },
      { id: "plan", name: "Plan" },
      { id: "auto", name: "Auto" },
      { id: "bypassPermissions", name: "Bypass Permissions" },
    ],
    current: "auto",
  },
  codex: {
    modes: [
      { id: "read-only", name: "Read Only" },
      { id: "agent", name: "Agent" },
      { id: "agent-full-access", name: "Agent (full access)" },
    ],
    current: "agent",
  },
  hermes: {
    modes: [
      { id: "default", name: "Default" },
      { id: "accept_edits", name: "Accept edits" },
      { id: "dont_ask", name: "Don't ask" },
    ],
    current: "default",
  },
};

type Scenario = "claude" | "codex" | "hermes" | "deepseek";
const SCENARIOS: readonly Scenario[] = ["claude", "codex", "hermes", "deepseek"];

/** Hallpass's own launch settings (021): logged with their values, unlike every other variable. */
const LAUNCH_VARIABLES = ["HERMES_MANAGED_DIR", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_MODE"];

type TranscriptEntry = { role: "user" | "agent"; text: string };
type StoredSession = { cwd: string; scenario: string; modeId: string; transcript: TranscriptEntry[] };

export type FakeAcpAgentOptions = {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Called with the code instead of `process.exit` (tests that serve the fake in-process). */
  exit?: (code: number) => void;
};

class Cancelled extends Error {}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Serve the fake agent on `stream`; resolves when the connection closes. */
export function serveFakeAcpAgent(stream: acp.Stream, options: FakeAcpAgentOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const scenario: Scenario = SCENARIOS.find((name) => name === env.FAKE_ACP_SCENARIO) ?? "claude";
  const logPath = env.FAKE_ACP_LOG;
  const storePath = env.FAKE_ACP_STORE;
  const chunkDelay = Number(env.FAKE_ACP_CHUNK_DELAY_MS ?? 0);

  const log = (entry: Record<string, unknown>) => {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };

  const sessions = new Map<string, StoredSession>();
  /** Sessions whose agent switched its own mode (`drift:`), for FAKE_ACP_RESET_ERROR. */
  const drifted = new Set<string>();
  const aborts = new Map<string, AbortController>();
  /** The `hallpass` stdio entry each session was handed, and its client once started (T557). */
  const browserServers = new Map<string, acp.McpServer>();
  const browserClients = new Map<string, Promise<McpClient>>();
  let toolCounter = 0;

  const readStore = (): Record<string, StoredSession> =>
    storePath && existsSync(storePath)
      ? (JSON.parse(readFileSync(storePath, "utf8")) as Record<string, StoredSession>)
      : {};
  const save = (id: string) => {
    if (!storePath) return;
    const all = readStore();
    const session = sessions.get(id);
    if (session) all[id] = session;
    writeFileSync(storePath, JSON.stringify(all));
  };

  const modeState = (session: StoredSession) => ({
    currentModeId: session.modeId,
    availableModes: (MODE_SETS[session.scenario] ?? MODE_SETS.claude!).modes.map((mode) => ({
      id: mode.id,
      name: mode.name,
    })),
  });
  /** DeepSeek has no ACP modes: nothing about modes in its answers. */
  const modesOf = (session: StoredSession) => (scenario === "deepseek" ? {} : { modes: modeState(session) });

  const launch: Record<string, string> = {};
  for (const name of LAUNCH_VARIABLES) if (env[name] !== undefined) launch[name] = env[name]!;
  log({ event: "start", pid: process.pid, scenario, envNames: Object.keys(env).sort(), launch });
  if (env.FAKE_ACP_SPAWN_CHILD === "1" || env.FAKE_ACP_SPAWN_DETACHED === "1") {
    const idle = ["-e", "setInterval(() => {}, 1000)"];
    if (env.FAKE_ACP_SPAWN_CHILD === "1") {
      const child = spawn(process.execPath, idle, { stdio: "ignore", windowsHide: true });
      log({ event: "child", pid: child.pid, detached: false });
    }
    if (env.FAKE_ACP_SPAWN_DETACHED === "1") {
      const child = spawn(process.execPath, idle, { stdio: "ignore", windowsHide: true, detached: true });
      child.unref();
      log({ event: "child", pid: child.pid, detached: true });
    }
  }

  let connection!: acp.AgentSideConnection;

  const update = (sessionId: string, update: acp.SessionNotification["update"]) =>
    connection.sessionUpdate({ sessionId, update });

  const chunk = async (sessionId: string, text: string) => {
    await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const session = sessions.get(sessionId);
    if (session) {
      const last = session.transcript[session.transcript.length - 1];
      if (last?.role === "agent") last.text += text;
      else session.transcript.push({ role: "agent", text });
      save(sessionId);
    }
    if (chunkDelay > 0) await sleep(chunkDelay);
  };

  const aborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new Cancelled();
  };
  /** Resolves with `work`, or rejects `Cancelled` as soon as the turn is cancelled. */
  const unlessCancelled = <T>(signal: AbortSignal, work: Promise<T>): Promise<T> =>
    new Promise<T>((resolveWork, rejectWork) => {
      if (signal.aborted) return rejectWork(new Cancelled());
      signal.addEventListener("abort", () => rejectWork(new Cancelled()), { once: true });
      work.then(resolveWork, rejectWork);
    });

  const TOOLS: Record<string, { kind: acp.ToolKind; title: string; rawInput: unknown }> = {
    edit: { kind: "edit", title: "Edit src/app.ts", rawInput: { path: "src/app.ts" } },
    execute: { kind: "execute", title: "Run `npm test`", rawInput: { command: "npm test" } },
    mcp: {
      kind: "other",
      title: "hallpass - read_page (MCP)",
      rawInput: { server: "hallpass", tool: "read_page" },
    },
  };

  /** The permission options each scenario offers (021: Hermes' and DeepSeek's as measured). */
  const permissionOptions = (): acp.PermissionOption[] => {
    switch (scenario) {
      case "hermes":
        return [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ];
      case "deepseek":
        return [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
        ];
      default:
        return [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
          { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
        ];
    }
  };

  /** DeepSeek announces every action as `other` with the command and its reason (021, measured). */
  const DEEPSEEK_INPUT: Record<string, { command: string; justification: string }> = {
    edit: { command: "write_file src/app.ts", justification: "Update the greeting in src/app.ts" },
    execute: { command: "npm test", justification: "Run the tests to check the change" },
    mcp: { command: "hallpass read_page", justification: "Read the page" },
  };

  const runTool = async (sessionId: string, name: string, signal: AbortSignal) => {
    const tool = TOOLS[name]!;
    const toolCallId = `call-${++toolCounter}`;
    const deepseek = scenario === "deepseek";
    const announced = deepseek
      ? { title: "", kind: "other" as const, rawInput: DEEPSEEK_INPUT[name] }
      : { title: tool.title, kind: tool.kind, rawInput: tool.rawInput };
    await update(sessionId, { sessionUpdate: "tool_call", toolCallId, status: "pending", ...announced });
    const options = permissionOptions();
    // What the request itself carries: everything (Claude, Codex), title and kind (Hermes), the id only (DeepSeek).
    const toolCall: acp.ToolCallUpdate =
      scenario === "hermes"
        ? { toolCallId, title: tool.title, kind: tool.kind }
        : deepseek
          ? { toolCallId }
          : { toolCallId, title: tool.title, kind: tool.kind, status: "pending", rawInput: tool.rawInput };
    const answer = await unlessCancelled(signal, connection.requestPermission({ sessionId, toolCall, options }));
    const outcome = answer.outcome;
    const chosen =
      outcome.outcome === "selected" ? options.find((option) => option.optionId === outcome.optionId) : undefined;
    log({
      event: "permission-answer",
      sessionId,
      toolCallId,
      kind: announced.kind,
      outcome: outcome.outcome,
      optionId: chosen?.optionId ?? null,
      optionKind: chosen?.kind ?? null,
    });
    if (outcome.outcome === "cancelled") throw new Cancelled();
    if (chosen?.kind === "allow_once" || chosen?.kind === "allow_always") {
      await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
      await update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      });
      await chunk(sessionId, `done:${toolCallId}`);
    } else {
      await update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "refused by the owner" } }],
      });
      await chunk(sessionId, `refused:${toolCallId}`);
    }
  };

  /** `tool:unannounced` (021): a request for an id no `tool_call` named, carrying only that id. */
  const askUnannounced = async (sessionId: string, signal: AbortSignal) => {
    const toolCallId = `call-${++toolCounter}`;
    const options = permissionOptions();
    const answer = await unlessCancelled(signal, connection.requestPermission({ sessionId, toolCall: { toolCallId }, options }));
    const outcome = answer.outcome;
    const chosen =
      outcome.outcome === "selected" ? options.find((option) => option.optionId === outcome.optionId) : undefined;
    log({
      event: "permission-answer",
      sessionId,
      toolCallId,
      kind: null,
      outcome: outcome.outcome,
      optionId: chosen?.optionId ?? null,
      optionKind: chosen?.kind ?? null,
    });
    if (outcome.outcome === "cancelled") throw new Cancelled();
    await chunk(sessionId, `${chosen?.kind === "allow_once" ? "done" : "refused"}:${toolCallId}`);
  };

  /** `grant:permissions`: the Codex adapter's request for wider sandbox permissions (019 R-317). */
  const askForPermissions = async (sessionId: string, signal: AbortSignal) => {
    const toolCallId = `call-${++toolCounter}`;
    const options: acp.PermissionOption[] = [
      { optionId: "allow_permissions_turn", name: "For this turn", kind: "allow_once" },
      { optionId: "allow_permissions_turn_strict_auto_review", name: "For this turn, reviewed", kind: "allow_once" },
      { optionId: "allow_permissions_session", name: "For this session", kind: "allow_always" },
      { optionId: "reject_permissions", name: "No", kind: "reject_once" },
    ];
    const toolCall = {
      toolCallId,
      name: "request_permissions",
      kind: "other",
      status: "pending",
      title: "Additional sandbox permissions",
      rawInput: { permissions: { fileSystem: { write: ["C:\\work\\out"] } }, cwd: "C:\\work" },
    } as acp.ToolCallUpdate;
    const answer = await unlessCancelled(
      signal,
      connection.requestPermission({
        sessionId,
        toolCall,
        options,
        _meta: { permission: { version: 1, title: "Grant permissions?" } },
      }),
    );
    const outcome = answer.outcome;
    const chosen =
      outcome.outcome === "selected" ? options.find((option) => option.optionId === outcome.optionId) : undefined;
    log({
      event: "permission-answer",
      sessionId,
      toolCallId,
      kind: "other",
      outcome: outcome.outcome,
      optionId: chosen?.optionId ?? null,
      optionKind: chosen?.kind ?? null,
    });
    if (outcome.outcome === "cancelled") throw new Cancelled();
    await chunk(sessionId, `${chosen?.kind === "reject_once" ? "declined" : "granted"}:${toolCallId}`);
  };

  /** The session's `hallpass` server, started on first use and kept (T557). */
  const browserClient = (sessionId: string): Promise<McpClient> => {
    const existing = browserClients.get(sessionId);
    if (existing) return existing;
    const started = (async () => {
      const entry = browserServers.get(sessionId);
      if (!entry || !("command" in entry)) throw new Error("no hallpass stdio server was handed to this session");
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
      for (const variable of entry.env) env[variable.name] = variable.value;
      const transport = new StdioClientTransport({ command: entry.command, args: [...entry.args], env, stderr: "ignore" });
      const client = new McpClient({ name: "fake-acp-agent", version: "0.0.0" });
      await client.connect(transport);
      log({ event: "mcp-connected", sessionId });
      return client;
    })();
    browserClients.set(sessionId, started);
    started.catch(() => browserClients.delete(sessionId));
    return started;
  };

  const callBrowser = async (sessionId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const client = await unlessCancelled(signal, browserClient(sessionId));
    const result = (await unlessCancelled(
      signal,
      client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 }),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = (result.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
    log({ event: "mcp-call", sessionId, tool, args, isError: result.isError === true, text: text.slice(0, 2000) });
    return { isError: result.isError === true, text };
  };

  /** "$this" and "$ref:<query>" in the arguments, resolved against this session's own tab (T557). */
  const resolveBrowserArgs = async (sessionId: string, raw: string | undefined, signal: AbortSignal) => {
    const args = (raw === undefined ? {} : JSON.parse(raw)) as Record<string, unknown>;
    let tabId: number | undefined;
    const thisTab = async (): Promise<number> => {
      if (tabId !== undefined) return tabId;
      const listed = await callBrowser(sessionId, "tabs_context", {}, signal);
      if (listed.isError) throw new Error(`tabs_context: ${listed.text}`);
      const tabs = JSON.parse(listed.text) as Array<{ tabId: number; holder: unknown }>;
      const held = tabs.find((tab) => tab.holder === "this");
      if (!held) throw new Error(`no tab held by this session: ${listed.text}`);
      tabId = held.tabId;
      return tabId;
    };
    for (const [key, value] of Object.entries(args)) {
      if (value === "$this") args[key] = await thisTab();
      else if (typeof value === "string" && value.startsWith("$ref:")) {
        const query = decodeURIComponent(value.slice(5));
        const found = await callBrowser(sessionId, "find", { tabId: await thisTab(), query }, signal);
        if (found.isError) throw new Error(`find: ${found.text}`);
        const ref = (JSON.parse(found.text) as { matches?: Array<{ ref?: string }> }).matches?.[0]?.ref;
        if (!ref) throw new Error(`find returned no ref: ${found.text}`);
        args[key] = { ref };
      }
    }
    return args;
  };

  const runBrowserTool = async (sessionId: string, tool: string, rawArgs: string | undefined, signal: AbortSignal) => {
    const toolCallId = `call-${++toolCounter}`;
    const title = `hallpass - ${tool} (MCP)`;
    const rawInput = { server: "hallpass", tool };
    await update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "pending", rawInput });
    await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    let outcome: { isError: boolean; text: string };
    try {
      outcome = await callBrowser(sessionId, tool, await resolveBrowserArgs(sessionId, rawArgs, signal), signal);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      outcome = { isError: true, text: error instanceof Error ? error.message : String(error) };
      log({ event: "mcp-call", sessionId, tool, isError: true, thrown: true, text: outcome.text.slice(0, 2000) });
    }
    await update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: outcome.isError ? "failed" : "completed",
      content: [{ type: "content", content: { type: "text", text: outcome.text.slice(0, 300) } }],
    });
    await chunk(sessionId, `mcp:${tool}:${outcome.isError ? "error" : "ok"}:${outcome.text.slice(0, 1000)}`);
  };

  /** A new or reloaded session's `hallpass` entry; a reload (new token) drops the old client. */
  const rememberBrowserServer = (sessionId: string, servers: acp.McpServer[]) => {
    const previous = browserClients.get(sessionId);
    browserClients.delete(sessionId);
    void previous?.then((client) => client.close()).catch(() => undefined);
    const entry = servers.find((server) => server.name === "hallpass");
    if (entry) browserServers.set(sessionId, entry);
    else browserServers.delete(sessionId);
  };

  const runTurn = async (sessionId: string, text: string, signal: AbortSignal) => {
    const session = sessions.get(sessionId)!;
    const rename = /^\/rename(?:\s+(.*))?$/.exec(text.trim());
    if (rename) {
      await chunk(sessionId, `renamed:${(rename[1] ?? "").trim()}`);
      return;
    }
    let matched = false;
    for (const token of text.split(/\s+/)) {
      aborted(signal);
      const chunks = /^chunks:(\d+)$/.exec(token);
      const think = /^think:(\d+)$/.exec(token);
      const tool = /^tool:(edit|execute|mcp)$/.exec(token);
      const drift = /^drift:(.+)$/.exec(token);
      const mcp = /^mcp:([a-z_]+)(?::(.+))?$/.exec(token);
      if (chunks) {
        matched = true;
        for (let index = 1; index <= Number(chunks[1]); index++) {
          aborted(signal);
          await chunk(sessionId, `part-${index};`);
        }
      } else if (think) {
        matched = true;
        for (let index = 1; index <= Number(think[1]); index++) {
          aborted(signal);
          await update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thought-${index};` } });
        }
      } else if (tool) {
        matched = true;
        await runTool(sessionId, tool[1]!, signal);
      } else if (token === "tool:unannounced") {
        matched = true;
        await askUnannounced(sessionId, signal);
      } else if (token === "fail:turn") {
        // `{env:NAME}` in the text becomes that variable's value, the way an agent's error may quote it.
        const message = (env.FAKE_ACP_TURN_ERROR ?? "fake agent turn failed").replace(/\{env:([A-Za-z0-9_]+)\}/g, (_all, name: string) => env[name] ?? "");
        throw new acp.RequestError(-32603, message);
      } else if (token === "grant:permissions") {
        matched = true;
        await askForPermissions(sessionId, signal);
      } else if (mcp) {
        matched = true;
        await runBrowserTool(sessionId, mcp[1]!, mcp[2], signal);
      } else if (drift) {
        matched = true;
        session.modeId = drift[1]!;
        drifted.add(sessionId);
        save(sessionId);
        await update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: drift[1]! });
      } else if (token === "crash") {
        await chunk(sessionId, "crashing");
        await sleep(20);
        exit(FAKE_ACP_EXIT_CRASH);
        return;
      } else if (token === "hang") {
        matched = true;
        await unlessCancelled(signal, new Promise<never>(() => {}));
      }
    }
    if (!matched) await chunk(sessionId, `echo:${text}`);
  };

  const textOf = (prompt: acp.ContentBlock[]) =>
    prompt.map((block) => (block.type === "text" ? block.text : "")).join("");

  /** FAKE_ACP_FAIL_AT: refuse that request the way a mismatched adapter does (T534, R-315). */
  const failIfAsked = (step: "initialize" | "new") => {
    if (env.FAKE_ACP_FAIL_AT !== step) return;
    const message = env.FAKE_ACP_FAIL_MESSAGE ?? `fake agent failed at ${step === "new" ? "session/new" : "initialize"}`;
    log({ event: "fail", step, message });
    throw new acp.RequestError(-32603, message);
  };

  /** FAKE_ACP_HANG_AT: that request is never answered (T658: a start that never ends). */
  const hangIfAsked = async (step: "initialize" | "new") => {
    if (env.FAKE_ACP_HANG_AT !== step) return;
    log({ event: "hang", step });
    await new Promise<never>(() => {});
  };

  /** 021: what each scenario says at `initialize` (Hermes and DeepSeek as measured). */
  const capabilities = (): acp.AgentCapabilities => {
    switch (scenario) {
      case "hermes":
        return { loadSession: true, promptCapabilities: { image: true, embeddedContext: false } };
      case "deepseek":
        return {
          promptCapabilities: { image: true, embeddedContext: false },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        };
      default:
        return { loadSession: true };
    }
  };

  const findSession = (sessionId: string): StoredSession => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = readStore()[sessionId];
      if (session) sessions.set(sessionId, session);
    }
    if (!session) throw new acp.RequestError(-32002, `Session not found: ${sessionId}`);
    return session;
  };

  const agent: acp.Agent = {
    async initialize(params) {
      log({ method: "initialize", params: { protocolVersion: params.protocolVersion } });
      await hangIfAsked("initialize");
      if (env.FAKE_ACP_EXIT_AT === "initialize") {
        log({ event: "exit", step: "initialize" });
        exit(1);
      }
      failIfAsked("initialize");
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: capabilities(),
        agentInfo: { name: `fake-acp-agent-${scenario}`, version: "0.0.0" },
      };
    },
    authenticate() {
      return {};
    },
    async newSession(params) {
      log({ event: "session/new-received" });
      await hangIfAsked("new");
      const newDelay = Number(env.FAKE_ACP_NEW_DELAY_MS ?? 0);
      if (newDelay > 0) await sleep(newDelay);
      failIfAsked("new");
      const sessionId = `fake-${scenario}-${randomBytes(6).toString("hex")}`;
      const set = MODE_SETS[scenario];
      const session: StoredSession = { cwd: params.cwd, scenario, modeId: set?.current ?? "", transcript: [] };
      sessions.set(sessionId, session);
      save(sessionId);
      rememberBrowserServer(sessionId, params.mcpServers);
      log({
        method: "session/new",
        params: {
          cwd: params.cwd,
          mcpServers: params.mcpServers.map((server) => server.name),
          servers: params.mcpServers,
          sessionId,
          meta: params._meta ?? null,
        },
      });
      return { sessionId, ...modesOf(session) };
    },
    async loadSession(params) {
      log({
        method: "session/load",
        params: { sessionId: params.sessionId, cwd: params.cwd, servers: params.mcpServers, meta: params._meta ?? null },
      });
      // DeepSeek does not offer `session/load` (no `loadSession` at initialize).
      if (scenario === "deepseek") throw acp.RequestError.methodNotFound("session/load");
      const session = findSession(params.sessionId);
      rememberBrowserServer(params.sessionId, params.mcpServers);
      for (const entry of session.transcript) {
        await update(params.sessionId, {
          sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: entry.text },
        });
      }
      return { ...modesOf(session) };
    },
    /** 021: DeepSeek continues a session without replaying it; the other scenarios do not offer it. */
    async resumeSession(params) {
      log({ method: "session/resume", params: { sessionId: params.sessionId, cwd: params.cwd, servers: params.mcpServers ?? [] } });
      if (scenario !== "deepseek") throw acp.RequestError.methodNotFound("session/resume");
      findSession(params.sessionId);
      rememberBrowserServer(params.sessionId, params.mcpServers ?? []);
      return {};
    },
    async setSessionMode(params) {
      log({ method: "session/set_mode", params: { sessionId: params.sessionId, modeId: params.modeId } });
      if (scenario === "deepseek") throw acp.RequestError.methodNotFound("session/set_mode");
      const session = sessions.get(params.sessionId);
      if (!session) throw new acp.RequestError(-32002, `Session not found: ${params.sessionId}`);
      if (env.FAKE_ACP_RESET_ERROR !== undefined && drifted.has(params.sessionId)) {
        throw acp.RequestError.internalError(undefined, env.FAKE_ACP_RESET_ERROR.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_all, name: string) => env[name] ?? ""));
      }
      if (!modeState(session).availableModes.some((mode) => mode.id === params.modeId)) {
        throw acp.RequestError.invalidParams({ modeId: params.modeId }, "Unknown mode");
      }
      session.modeId = params.modeId;
      save(params.sessionId);
      await update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
      return {};
    },
    async prompt(params) {
      const text = textOf(params.prompt);
      log({ method: "session/prompt", params: { sessionId: params.sessionId, text } });
      const session = sessions.get(params.sessionId);
      if (!session) throw new acp.RequestError(-32002, `Session not found: ${params.sessionId}`);
      session.transcript.push({ role: "user", text });
      save(params.sessionId);
      const abort = new AbortController();
      aborts.set(params.sessionId, abort);
      try {
        await runTurn(params.sessionId, text, abort.signal);
        return { stopReason: "end_turn" };
      } catch (error) {
        if (error instanceof Cancelled) return { stopReason: "cancelled" };
        throw error;
      } finally {
        aborts.delete(params.sessionId);
      }
    },
    cancel(params) {
      log({ method: "session/cancel", params: { sessionId: params.sessionId } });
      aborts.get(params.sessionId)?.abort();
    },
  };

  connection = new acp.AgentSideConnection(() => agent, stream);
  return connection.closed;
}

/** 023 (R-367): FAKE_ACP_STDERR_BYTES / FAKE_ACP_STDERR_LINES - what the agent says about itself. */
async function writeStderr(env: Record<string, string | undefined>): Promise<void> {
  const bytes = Number(env.FAKE_ACP_STDERR_BYTES ?? 0);
  const lines = Number(env.FAKE_ACP_STDERR_LINES ?? 0);
  if (bytes <= 0 && lines <= 0) return;
  const write = (text: string) => new Promise<void>((done) => process.stderr.write(text, () => done()));
  const filler = `${"x".repeat(1000)}\n`;
  for (let written = 0; written < bytes; written += filler.length) await write(filler);
  const template = env.FAKE_ACP_STDERR_LINE ?? "stderr line {n}";
  for (let n = 1; n <= lines; n += 1) {
    await write(`${template.replace(/\{n\}/g, String(n)).replace(/\{env:([A-Za-z0-9_]+)\}/g, (_all, name: string) => env[name] ?? "")}\n`);
  }
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify({ event: "stderr-written" })}\n`);
}

/** The process entry: serve on stdio and leave when the client closes it. */
export async function main(): Promise<void> {
  await writeStderr(process.env);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  await serveFakeAcpAgent(stream);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
