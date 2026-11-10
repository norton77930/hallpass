import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_SERVER_ENTRY,
  type McpHarnessClient,
  type StartMcpClientOptions,
  type ToolCallOptions,
  type ToolCallResult,
} from "./mcp-client.js";

/**
 * A scripted MCP client that can be asked a question (031 T928, contracts/terminal-consent.md).
 *
 * It drives the real `dist/mcp-server.js` over stdio exactly as `startMcpClient` does, and adds the
 * one thing a coding agent's client has that the plain harness lacks: an `elicitation/create`
 * handler. What the handler answers is a per-test script, so every client-side branch of terminal
 * consent - choose, decline, cancel, never answer, answer after the question was withdrawn, and
 * not being able to be asked at all - runs without a person.
 *
 * Every question it receives is recorded (message, the choices offered, how it ended), because what
 * the host asked is half of the claim and the tool's answer is the other half.
 *
 * **The request id 0 quirk.** SDK 1.32.2's `_oncancel` ignores a cancellation whose `requestId` is
 * falsy, so the first server-to-client request of a session (id 0) could never be seen to be
 * cancelled here. The host's first request to a client that declares `roots` is `roots/list`
 * (mcp-server.ts `deriveSessionLabel`, sent when the session initialises), so this client declares
 * roots by default: the first question then has id >= 1 and a withdrawal reaches the handler as an
 * abort. `waitForElicitation` refuses to hand back a question with id 0 rather than let a test pass
 * on a cancellation the SDK would have dropped.
 */

/** What the scripted owner does with one question. */
export type ElicitationReply =
  /** `action: "accept"` with this value for the form's one field, after `afterMs`. */
  | { kind: "accept"; choice: string; afterMs?: number }
  | { kind: "decline"; afterMs?: number }
  | { kind: "cancel"; afterMs?: number }
  /** Shows the question and never answers; ends only when the server withdraws it. */
  | { kind: "never" };

/** How one received question ended, from the client's side. */
export type ElicitationState = "pending" | "answered" | "declined" | "cancelled" | "aborted";

export type ElicitationRecord = {
  /** The server's JSON-RPC id for the request; never 0 once handed out by `waitForElicitation`. */
  requestId: string | number;
  message: string;
  /** The form's `choice` enum: what the owner could pick. */
  choices: string[];
  choiceNames: string[];
  /** Whether `choice` is required in the form (it must be). */
  choiceRequired: boolean;
  requestedSchema: unknown;
  receivedAt: number;
  state: ElicitationState;
  /** When the state left `pending`. */
  settledAt?: number;
  /** For `aborted`: the reason the server gave in `notifications/cancelled`, if any. */
  abortReason?: string;
  /** The reply the script chose, once it has. */
  reply?: ElicitationReply;
};

/** Called once per received question, with its position (0 for the first). */
export type ElicitationScript = (record: ElicitationRecord, index: number) => ElicitationReply | Promise<ElicitationReply>;

/** What the client says at initialize about being asked. `none` declares no elicitation at all. */
export type ElicitationCapability = "form" | "bare" | "none";

export type StartElicitingClientOptions = Pick<StartMcpClientOptions, "clientName" | "env" | "entry" | "cwd"> & {
  /** Default `form`: `elicitation: { form: {} }`. `bare` is `elicitation: {}`. */
  capability?: ElicitationCapability;
  /** What the owner does with each question. Default: never answers. */
  script?: ElicitationScript;
  /**
   * Whether to declare `roots` (see the quirk above). Default `true`; only a test about the
   * absence of roots has a reason to turn it off.
   */
  declareRoots?: boolean;
};

export type ElicitingMcpClient = McpHarnessClient & {
  /** Every question received so far, in arrival order. */
  elicitations(): readonly ElicitationRecord[];
  /** Resolves with the question at `index` once it has arrived; fails after `timeoutMs`. */
  waitForElicitation(index: number, timeoutMs?: number): Promise<ElicitationRecord>;
  /** Resolves once the question has left `pending` (any state but `pending`); fails after `timeoutMs`. */
  waitForSettled(record: ElicitationRecord, timeoutMs?: number): Promise<ElicitationRecord>;
  /** Replaces the script for questions that arrive from now on. */
  setScript(script: ElicitationScript): void;
  /**
   * Writes an `accept` answer for an already-withdrawn question straight onto the transport.
   *
   * The SDK itself never replies to a request that was cancelled (protocol.js drops the reply when
   * the handler's signal is aborted), so "a client that answers late" cannot be scripted through
   * the handler. This is what such a client puts on the wire; the host must not turn it into a
   * `prompt-answer`.
   */
  sendLateAnswer(record: ElicitationRecord, choice: string): Promise<void>;
};

/** A script that answers every question the same way. */
export function alwaysReply(reply: ElicitationReply): ElicitationScript {
  return () => reply;
}

/** A script that gives the replies in order and then never answers again. */
export function repliesInOrder(...replies: ElicitationReply[]): ElicitationScript {
  return (_record, index) => replies[index] ?? { kind: "never" };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startElicitingClient(options: StartElicitingClientOptions = {}): Promise<ElicitingMcpClient> {
  const capability = options.capability ?? "form";
  const declareRoots = options.declareRoots ?? true;
  let script: ElicitationScript = options.script ?? alwaysReply({ kind: "never" });
  let stderrText = "";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.entry ?? MCP_SERVER_ENTRY],
    stderr: "pipe",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...(process.env as Record<string, string>),
      // Same short dial cadence as `startMcpClient`: see the note there.
      HALLPASS_AGENT_DIAL_RETRY_MS: "100",
      ...options.env,
    },
  });

  const capabilities: Record<string, unknown> = {};
  if (declareRoots) capabilities.roots = { listChanged: false };
  if (capability === "form") capabilities.elicitation = { form: {} };
  if (capability === "bare") capabilities.elicitation = {};
  const client = new Client({ name: options.clientName ?? "claude-code", version: "0.0.0" }, { capabilities });

  if (declareRoots) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(process.cwd()).href, name: "hallpass-test" }],
    }));
  }

  const records: ElicitationRecord[] = [];

  if (capability !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const params = request.params as {
        message?: string;
        requestedSchema?: { required?: string[]; properties?: { choice?: { enum?: string[]; enumNames?: string[] } } };
      };
      const choiceField = params.requestedSchema?.properties?.choice;
      const record: ElicitationRecord = {
        requestId: extra.requestId,
        message: params.message ?? "",
        choices: [...(choiceField?.enum ?? [])],
        choiceNames: [...(choiceField?.enumNames ?? [])],
        choiceRequired: params.requestedSchema?.required?.includes("choice") === true,
        requestedSchema: params.requestedSchema,
        receivedAt: Date.now(),
        state: "pending",
      };
      const index = records.length;
      records.push(record);

      const settle = (state: ElicitationState): void => {
        if (record.state !== "pending") return;
        record.state = state;
        record.settledAt = Date.now();
      };
      const aborted = new Promise<"aborted">((resolve) => {
        const onAbort = (): void => {
          const reason: unknown = extra.signal.reason;
          if (record.state === "pending") {
            if (reason !== undefined) record.abortReason = typeof reason === "string" ? reason : String(reason);
          }
          settle("aborted");
          resolve("aborted");
        };
        if (extra.signal.aborted) onAbort();
        else extra.signal.addEventListener("abort", onAbort, { once: true });
      });

      const reply = await script(record, index);
      record.reply = reply;
      if (reply.kind === "never") {
        await aborted;
        return { action: "cancel" as const };
      }
      if (reply.afterMs !== undefined && reply.afterMs > 0) {
        const outcome = await Promise.race([sleep(reply.afterMs).then(() => "waited" as const), aborted]);
        if (outcome === "aborted") return { action: "cancel" as const };
      }
      if (record.state !== "pending") return { action: "cancel" as const };
      if (reply.kind === "accept") {
        settle("answered");
        return { action: "accept" as const, content: { choice: reply.choice } };
      }
      if (reply.kind === "decline") {
        settle("declined");
        return { action: "decline" as const };
      }
      settle("cancelled");
      return { action: "cancel" as const };
    });
  }

  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });

  return {
    async callTool(name, args = {}, callOptions: ToolCallOptions = {}): Promise<ToolCallResult> {
      const requestOptions: RequestOptions = {
        ...(callOptions.onProgress === undefined
          ? {}
          : {
              onprogress: (progress) =>
                callOptions.onProgress?.({
                  progress: progress.progress,
                  ...(progress.total === undefined ? {} : { total: progress.total }),
                  ...(typeof progress.message === "string" ? { message: progress.message } : {}),
                }),
            }),
        ...(callOptions.timeoutMs === undefined ? {} : { timeout: callOptions.timeoutMs }),
        ...(callOptions.resetTimeoutOnProgress === undefined
          ? {}
          : { resetTimeoutOnProgress: callOptions.resetTimeoutOnProgress }),
      };
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        Object.keys(requestOptions).length === 0 ? undefined : requestOptions,
      )) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      const textBlocks = (result.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "");
      const text = textBlocks.join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const images = (result.content ?? [])
        .filter((block) => block.type === "image")
        .map((block) => ({ data: block.data ?? "", mimeType: block.mimeType ?? "" }));
      return { isError: result.isError === true, text, textBlocks, json, images };
    },
    async listToolNames() {
      const listed = (await client.listTools()) as { tools: Array<{ name: string }> };
      return listed.tools.map((tool) => tool.name);
    },
    stderr() {
      return stderrText;
    },
    instructions() {
      return client.getInstructions();
    },
    async close() {
      await client.close();
    },
    elicitations() {
      return records;
    },
    async waitForElicitation(index, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = records[index];
        if (found !== undefined) {
          if (found.requestId === 0) {
            throw new Error(
              "elicitation-request-id-0: the SDK ignores a cancellation for request 0, so a withdrawal could not be observed; " +
                "the client must declare roots so roots/list takes id 0",
            );
          }
          return found;
        }
        await sleep(50);
      }
      throw new Error(`elicitation-${index}-not-received after ${timeoutMs} ms\nmcp-server stderr:\n${stderrText}`);
    },
    async waitForSettled(record, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (record.state !== "pending") return record;
        await sleep(50);
      }
      throw new Error(`elicitation ${String(record.requestId)} still pending after ${timeoutMs} ms`);
    },
    setScript(next) {
      script = next;
    },
    async sendLateAnswer(record, choice) {
      const live = client.transport;
      if (live === undefined) throw new Error("elicitation-late-answer: the client is closed");
      await live.send({
        jsonrpc: "2.0",
        id: record.requestId,
        result: { action: "accept", content: { choice } },
      });
    },
  };
}
