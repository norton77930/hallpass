import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Issue #17 research probe: how does each side-panel agent ask the owner a question?
 *
 * One agent process, spoken to over ACP as Hallpass speaks to it, except that this client also says it
 * shows form elicitations. It opens a session (in the mode given), sends one prompt that asks the agent
 * to put a two-choice question to the user, and records everything the agent sends back in order: a form
 * or URL elicitation (with its fields and choices), a permission request, a tool call, its text. Nothing
 * is allowed: an elicitation is answered with `answer` (decline by default), a permission request is
 * cancelled, a file or terminal request is never offered. The record holds what the agent asked and
 * said - the owner's own data, for a private report - and nothing of the owner's environment.
 *
 * It imports only `node:` modules and the ACP SDK, so `run.ts` loads it under `--experimental-strip-types`
 * and the unit test imports it through Vite.
 */

/** The probe's one prompt (a model call): ask, and do nothing else. */
export const QUESTION_PROMPT = [
  "This is a test from Hallpass, the app you are running in.",
  "Before anything else, ask me which colour I prefer: red or blue.",
  "Ask it the way you normally ask the user a question with choices (for example with your own question tool, if you have one), then wait for my answer.",
  "Do not run commands, edit files or do anything else.",
].join(" ");

export type ProbeField = { name: string; type: string; choices?: string[]; required: boolean };

export type ProbeEvent =
  | { kind: "elicitation"; mode: string; message: string; scope: "session" | "tool-call" | "request"; fields?: ProbeField[]; hasUrl?: true }
  | { kind: "permission"; title?: string; toolKind?: string; options: Array<{ kind: string; name: string }> }
  | { kind: "tool"; title?: string; toolKind?: string; status?: string }
  | { kind: "text"; text: string }
  | { kind: "update"; sessionUpdate: string }
  | { kind: "ext"; method: string };

export type ProbeRecord = {
  started: boolean;
  agent?: { name?: string; version?: string };
  /** The capability names the agent declared at `initialize`. */
  capabilities: string[];
  events: ProbeEvent[];
  stopReason?: string;
  error?: string;
  durationMs: number;
};

export type ProbeOptions = {
  child: ChildProcess;
  cwd: string;
  prompt?: string;
  /** `session/set_mode` before the prompt (Hallpass's strict mode for agents that have one). */
  modeId?: string;
  /** How an elicitation is answered (default `decline`: the agent is told the user did not answer). */
  answer?: "decline" | "cancel";
  /** The whole probe, start to the end of the turn (default 180 s). */
  boundMs?: number;
};

const TEXT_MAX = 4000;

/** A form's fields as names, types, choices and whether each is required. */
function fieldsOf(schema: unknown): ProbeField[] {
  const object = schema as { properties?: Record<string, Record<string, unknown>>; required?: unknown };
  const required = new Set(Array.isArray(object?.required) ? (object.required as string[]) : []);
  return Object.entries(object?.properties ?? {}).map(([name, property]) => {
    const choices = Array.isArray(property.enum)
      ? (property.enum as unknown[]).map(String)
      : Array.isArray(property.oneOf)
        ? (property.oneOf as Array<{ const?: unknown; title?: unknown }>).map((option) => String(option.title ?? option.const))
        : Array.isArray((property.items as { enum?: unknown } | undefined)?.enum)
          ? ((property.items as { enum: unknown[] }).enum).map(String)
          : undefined;
    return { name, type: String(property.type ?? "unknown"), ...(choices === undefined ? {} : { choices }), required: required.has(name) };
  });
}

export async function probeQuestions(options: ProbeOptions): Promise<ProbeRecord> {
  const started = Date.now();
  const events: ProbeEvent[] = [];
  const record: ProbeRecord = { started: false, capabilities: [], events, durationMs: 0 };
  const push = (event: ProbeEvent): void => {
    const last = events.at(-1);
    // Text arrives in chunks: one event per run of text.
    if (event.kind === "text" && last?.kind === "text") {
      last.text = (last.text + event.text).slice(0, TEXT_MAX);
      return;
    }
    events.push(event);
  };

  const client: acp.Client = {
    async requestPermission(params) {
      push({
        kind: "permission",
        ...(params.toolCall.title == null ? {} : { title: params.toolCall.title }),
        ...(params.toolCall.kind == null ? {} : { toolKind: params.toolCall.kind }),
        options: params.options.map((option) => ({ kind: option.kind, name: option.name })),
      });
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "text") push({ kind: "text", text: update.content.text });
        return;
      }
      if (update.sessionUpdate === "tool_call") {
        push({
          kind: "tool",
          ...(update.title == null ? {} : { title: update.title }),
          ...(update.kind == null ? {} : { toolKind: update.kind }),
          ...(update.status == null ? {} : { status: update.status }),
        });
        return;
      }
      push({ kind: "update", sessionUpdate: update.sessionUpdate });
    },
    async createElicitation(params) {
      const raw = params as Record<string, unknown>;
      const scope = typeof raw.toolCallId === "string" ? "tool-call" : typeof raw.sessionId === "string" ? "session" : "request";
      push({
        kind: "elicitation",
        mode: String(raw.mode),
        message: String(raw.message ?? "").slice(0, TEXT_MAX),
        scope,
        ...(raw.mode === "form" ? { fields: fieldsOf(raw.requestedSchema) } : {}),
        ...(typeof raw.url === "string" ? { hasUrl: true as const } : {}),
      });
      return { action: options.answer ?? "decline" };
    },
    async completeElicitation() {
      push({ kind: "ext", method: "elicitation/complete" });
    },
    async extMethod(method) {
      push({ kind: "ext", method });
      return {};
    },
    async extNotification(method) {
      push({ kind: "ext", method });
    },
  };

  const child = options.child;
  const exited = new Promise<string>((done) => {
    child.once("exit", (code) => done(`The agent exited (code ${code ?? "none"}).`));
    child.once("error", (error) => done(`The agent could not start: ${error.message}`));
  });
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>),
  );

  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<string>((done) => {
    timer = setTimeout(() => done(`The probe ended at its bound of ${Math.round((options.boundMs ?? 180_000) / 1000)} s.`), options.boundMs ?? 180_000);
  });
  let sessionId: string | undefined;
  const run = async (): Promise<void> => {
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: "hallpass-probe-017", version: "0.0.0" },
    });
    record.started = true;
    const info = init.agentInfo;
    if (info != null) record.agent = { ...(info.name == null ? {} : { name: info.name }), ...(info.version == null ? {} : { version: info.version }) };
    record.capabilities = Object.keys(init.agentCapabilities ?? {}).sort();
    const session = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = session.sessionId;
    if (options.modeId !== undefined) await connection.setSessionMode({ sessionId, modeId: options.modeId });
    const answer = await connection.prompt({ sessionId, prompt: [{ type: "text", text: options.prompt ?? QUESTION_PROMPT }] });
    record.stopReason = answer.stopReason;
  };
  try {
    const outcome = await Promise.race([run().then(() => undefined), exited, bound]);
    if (outcome !== undefined) {
      record.error = outcome;
      if (sessionId !== undefined) await connection.cancel({ sessionId }).catch(() => undefined);
    }
  } catch (error) {
    record.error = (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 600);
  } finally {
    clearTimeout(timer);
    record.durationMs = Date.now() - started;
  }
  return record;
}

/** A record in a few lines, for the report's summary table. */
export function summarize(record: ProbeRecord): string {
  if (!record.started) return `did not start${record.error === undefined ? "" : `: ${record.error}`}`;
  const kinds = record.events.filter((event) => event.kind !== "update").map((event) => event.kind);
  const asked = record.events.find((event) => event.kind === "elicitation");
  const how =
    asked !== undefined
      ? `asked by elicitation (${asked.mode})`
      : record.events.some((event) => event.kind === "permission")
        ? "asked through a permission request"
        : record.events.some((event) => event.kind === "text" && /red|blue/iu.test(event.text))
          ? "asked in plain text"
          : "did not ask";
  return `${how}; events: ${kinds.join(", ") || "none"}; stop: ${record.stopReason ?? record.error ?? "?"}`;
}
