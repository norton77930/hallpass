import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The fake ACP agent (019/T521, R-329) driven the way the broker will drive a real adapter: a
 * spawned child, the SDK's client side over its stdio. These tests are the fake's own contract -
 * what each prompt keyword makes it do - so the broker's tests can lean on it.
 */

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.ts");

type Answer = (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse;

type Running = {
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  updates: acp.SessionNotification["update"][];
  permissions: acp.RequestPermissionRequest[];
  exited: Promise<number | null>;
  answer: { current: Answer };
};

let dir: string;
let running: Running[] = [];
const extraPids: number[] = [];

const selectKind =
  (kind: acp.PermissionOptionKind): Answer =>
  (request) => ({
    outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === kind)!.optionId },
  });

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function start(env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", AGENT], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const updates: Running["updates"] = [];
  const permissions: Running["permissions"] = [];
  const answer = { current: selectKind("allow_once") };
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: (request) => {
        permissions.push(request);
        return answer.current(request);
      },
      sessionUpdate: (notification) => {
        updates.push(notification.update);
      },
    }),
    stream,
  );
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  const entry = { child, connection, updates, permissions, exited, answer };
  running.push(entry);
  return entry;
}

const init = (agent: Running) =>
  agent.connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const newSession = (agent: Running) => agent.connection.newSession({ cwd: dir, mcpServers: [] });
const say = (agent: Running, sessionId: string, text: string) =>
  agent.connection.prompt({ sessionId, prompt: [{ type: "text", text }] });
const chunkText = (updates: Running["updates"]) =>
  updates.flatMap((update) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
  );
const logLines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-acp-"));
});

afterEach(() => {
  for (const agent of running) killTree(agent.child.pid);
  for (const pid of extraPids.splice(0)) killTree(pid);
  running = [];
  rmSync(dir, { recursive: true, force: true });
});

describe("fake ACP agent (T521)", () => {
  it("initializes, creates a claude-shaped session, sets a mode and streams chunks", async () => {
    const agent = start();
    const initialized = await init(agent);
    expect(initialized.agentCapabilities?.loadSession).toBe(true);

    const session = await newSession(agent);
    expect(session.modes?.currentModeId).toBe("auto");
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "bypassPermissions",
    ]);

    await agent.connection.setSessionMode({ sessionId: session.sessionId, modeId: "default" });
    expect(agent.updates).toContainEqual({ sessionUpdate: "current_mode_update", currentModeId: "default" });
    await expect(
      agent.connection.setSessionMode({ sessionId: session.sessionId, modeId: "nonsense" }),
    ).rejects.toMatchObject({ code: -32602 });

    const result = await say(agent, session.sessionId, "chunks:3");
    expect(result.stopReason).toBe("end_turn");
    expect(chunkText(agent.updates)).toEqual(["part-1;", "part-2;", "part-3;"]);
  });

  it("offers the codex mode set with agent current", async () => {
    const agent = start({ FAKE_ACP_SCENARIO: "codex" });
    await init(agent);
    const session = await newSession(agent);
    expect(session.modes?.currentModeId).toBe("agent");
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual(["read-only", "agent", "agent-full-access"]);
  });

  it("reports a rejected edit as refused, and never completes it", async () => {
    const log = join(dir, "log.jsonl");
    const agent = start({ FAKE_ACP_LOG: log });
    await init(agent);
    const session = await newSession(agent);
    agent.answer.current = selectKind("reject_once");

    const result = await say(agent, session.sessionId, "tool:edit");
    expect(result.stopReason).toBe("end_turn");
    expect(agent.permissions).toHaveLength(1);
    expect(agent.permissions[0]!.toolCall.kind).toBe("edit");
    expect(agent.permissions[0]!.options.map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);
    const statuses = agent.updates.flatMap((update) =>
      update.sessionUpdate === "tool_call_update" ? [update.status] : [],
    );
    expect(statuses).toEqual(["failed"]);
    expect(chunkText(agent.updates)).toEqual(["refused:call-1"]);
    expect(logLines(log).find((line) => line.event === "permission-answer")).toMatchObject({
      kind: "edit",
      optionKind: "reject_once",
    });
  });

  it("completes an allowed execute and an mcp-titled tool of kind other", async () => {
    const log = join(dir, "log.jsonl");
    const agent = start({ FAKE_ACP_LOG: log });
    await init(agent);
    const session = await newSession(agent);

    await say(agent, session.sessionId, "tool:execute tool:mcp");
    expect(agent.permissions.map((request) => request.toolCall.kind)).toEqual(["execute", "other"]);
    expect(agent.permissions[1]!.toolCall.title).toContain("(MCP)");
    const statuses = agent.updates.flatMap((update) =>
      update.sessionUpdate === "tool_call_update" ? [update.status] : [],
    );
    expect(statuses).toEqual(["in_progress", "completed", "in_progress", "completed"]);
    expect(chunkText(agent.updates)).toEqual(["done:call-1", "done:call-2"]);
    const answers = logLines(log).filter((line) => line.event === "permission-answer");
    expect(answers.map((line) => line.optionKind)).toEqual(["allow_once", "allow_once"]);
  });

  it("emits a mode drift of its own mid-turn", async () => {
    const agent = start();
    await init(agent);
    const session = await newSession(agent);

    await say(agent, session.sessionId, "chunks:1 drift:bypassPermissions chunks:1");
    const order = agent.updates.map((update) =>
      update.sessionUpdate === "current_mode_update" ? `mode:${update.currentModeId}` : update.sessionUpdate,
    );
    expect(order).toEqual(["agent_message_chunk", "mode:bypassPermissions", "agent_message_chunk"]);
  });

  it("answers /rename locally with no tool calls, the request first in the log", async () => {
    const log = join(dir, "log.jsonl");
    const agent = start({ FAKE_ACP_LOG: log });
    await init(agent);
    const session = await newSession(agent);

    await say(agent, session.sessionId, "/rename Release notes");
    expect(chunkText(agent.updates)).toEqual(["renamed:Release notes"]);
    expect(agent.updates.some((update) => update.sessionUpdate === "tool_call")).toBe(false);
    expect(agent.permissions).toEqual([]);
    const methods = logLines(log)
      .filter((line) => line.method)
      .map((line) => line.method);
    expect(methods).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(logLines(log).find((line) => line.method === "session/prompt")?.params.text).toBe("/rename Release notes");
  });

  it("replays the transcript on session/load, in this process and from the store, and refuses an unknown id", async () => {
    const store = join(dir, "store.json");
    const first = start({ FAKE_ACP_STORE: store });
    await init(first);
    const session = await newSession(first);
    await say(first, session.sessionId, "chunks:2");

    first.updates.length = 0;
    const loaded = await first.connection.loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("auto");
    expect(first.updates.map((update) => update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
    expect(chunkText(first.updates)).toEqual(["part-1;part-2;"]);

    // A second process with the same store resumes the same conversation.
    killTree(first.child.pid);
    const second = start({ FAKE_ACP_STORE: store });
    await init(second);
    await second.connection.loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] });
    expect(chunkText(second.updates)).toEqual(["part-1;part-2;"]);

    await expect(
      second.connection.loadSession({ sessionId: "no-such-session", cwd: dir, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("exits with code 3 mid-turn on crash", async () => {
    const agent = start();
    await init(agent);
    const session = await newSession(agent);

    const turn = say(agent, session.sessionId, "crash").catch(() => "closed");
    expect(await agent.exited).toBe(3);
    expect(chunkText(agent.updates)).toEqual(["crashing"]);
    await turn;
  });

  it("holds a hanging turn until cancelled", async () => {
    const log = join(dir, "log.jsonl");
    const agent = start({ FAKE_ACP_LOG: log });
    await init(agent);
    const session = await newSession(agent);

    let settled = false;
    const turn = say(agent, session.sessionId, "hang").then((result) => {
      settled = true;
      return result;
    });
    await new Promise((done) => setTimeout(done, 300));
    expect(settled).toBe(false);
    await agent.connection.cancel({ sessionId: session.sessionId });
    expect((await turn).stopReason).toBe("cancelled");
    expect(logLines(log).map((line) => line.method)).toContain("session/cancel");
  });

  it("starts the long-lived and detached children it is asked to, and logs their pids", async () => {
    const log = join(dir, "log.jsonl");
    const agent = start({ FAKE_ACP_LOG: log, FAKE_ACP_SPAWN_CHILD: "1", FAKE_ACP_SPAWN_DETACHED: "1" });
    await init(agent);

    const children = logLines(log).filter((line) => line.event === "child");
    expect(children.map((line) => line.detached)).toEqual([false, true]);
    for (const line of children) {
      extraPids.push(line.pid);
      expect(() => process.kill(line.pid, 0)).not.toThrow();
    }
  });

  it("fails at initialize or at session/new when told to, with its own message (T534)", async () => {
    const atInitialize = start({ FAKE_ACP_FAIL_AT: "initialize" });
    await expect(init(atInitialize)).rejects.toMatchObject({ code: -32603, message: expect.stringContaining("initialize") });

    const atNew = start({ FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: "native binary not found" });
    await init(atNew);
    await expect(newSession(atNew)).rejects.toMatchObject({ code: -32603, message: expect.stringContaining("native binary not found") });
  });

  it("logs the _meta it received on session/new and session/load, null when there was none (T542a)", async () => {
    const log = join(dir, "fake.log");
    const agent = start({ FAKE_ACP_LOG: log });
    await init(agent);
    const meta = { claudeCode: { options: { settings: { permissions: { ask: ["Edit", "Bash"] } } } } };
    const session = await agent.connection.newSession({ cwd: dir, mcpServers: [], _meta: meta });
    await agent.connection.loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] });
    await agent.connection.loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [], _meta: meta });

    const received = logLines(log)
      .filter((line) => line.method === "session/new" || line.method === "session/load")
      .map((line) => [line.method, line.params.meta]);
    expect(received).toEqual([
      ["session/new", meta],
      ["session/load", null],
      ["session/load", meta],
    ]);
  });
});
