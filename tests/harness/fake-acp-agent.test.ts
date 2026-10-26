import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_INSTALL_DONE_MARKER, fakeLockfileInstall, fakeSlowInstall, lockfileSeconds } from "./fake-acp-agent-install.js";

/**
 * The fake ACP agent (019/T521, R-329) driven the way the broker will drive a real adapter: a
 * spawned child, the SDK's client side over its stdio. These tests are the fake's own contract -
 * what each prompt keyword makes it do - so the broker's tests can lean on it.
 */

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.ts");
const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent-install.ts");

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

describe("fake ACP agent knobs (024 T741)", () => {
  const runVersion = (env: Record<string, string>) =>
    spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", AGENT, "--version"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

  it("answers --version with one line and exits 0", async () => {
    const child = runVersion({ FAKE_ACP_VERSION: "1.2.3 (fake)" });
    let out = "";
    child.stdout!.on("data", (data: Buffer) => (out += data.toString()));
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    expect(code).toBe(0);
    expect(out.trim()).toBe("1.2.3 (fake)");
  });

  it("FAKE_ACP_VERSION_HANG keeps --version alive and silent until it is killed", async () => {
    const child = runVersion({ FAKE_ACP_VERSION_HANG: "1" });
    extraPids.push(child.pid!);
    let out = "";
    child.stdout!.on("data", (data: Buffer) => (out += data.toString()));
    let exited = false;
    child.once("exit", () => (exited = true));
    await new Promise((done) => setTimeout(done, 1500));
    expect(exited).toBe(false);
    expect(out).toBe("");
  });

  it("FAKE_ACP_COUNT_PROMPTS gets one line per session/prompt", async () => {
    const counter = join(dir, "prompts.txt");
    const agent = start({ FAKE_ACP_COUNT_PROMPTS: counter });
    await init(agent);
    const session = await newSession(agent);
    await say(agent, session.sessionId, "one");
    await say(agent, session.sessionId, "two");
    expect(readFileSync(counter, "utf8").split("\n").filter(Boolean)).toEqual([session.sessionId, session.sessionId]);
  });
});

describe("fake ACP agent models (025 T802, FAKE_ACP_MODELS)", () => {
  type Option = { id: string; type: string; category?: string; currentValue: unknown; options?: unknown[] };
  const optionsOf = (answer: unknown) => ((answer as { configOptions?: Option[] }).configOptions ?? []) as Option[];
  const current = (answer: unknown, category: string) => optionsOf(answer).find((option) => option.category === category)?.currentValue;
  const requestLog = (path: string) => logLines(path).map((line) => line.method as string);

  it("reports nothing about models without FAKE_ACP_MODELS, and `none` is the same", async () => {
    for (const env of [{}, { FAKE_ACP_MODELS: "none" }]) {
      const agent = start(env);
      await init(agent);
      const session = (await newSession(agent)) as Record<string, unknown>;
      expect(session.configOptions).toBeUndefined();
      expect(session.models).toBeUndefined();
    }
  });

  it("`config`: a model and an effort select with a default entry, beside a mode select and a boolean; set answers the full options", async () => {
    const agent = start({ FAKE_ACP_MODELS: "config" });
    await init(agent);
    const session = await newSession(agent);
    const options = optionsOf(session);
    expect(options.map((option) => [option.id, option.type, option.category ?? null])).toEqual([
      ["mode", "select", "mode"],
      ["model", "select", "model"],
      ["effort", "select", "thought_level"],
      ["fast", "boolean", null],
    ]);
    expect(current(session, "model")).toBe("default");
    expect(current(session, "thought_level")).toBe("default");

    const answer = await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-beta" });
    expect(current(answer, "model")).toBe("model-beta");
    const effort = await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "high" });
    expect(current(effort, "model")).toBe("model-beta");
    expect(current(effort, "thought_level")).toBe("high");
    await expect(
      agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "no-such-model" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("`config-no-effort`: a grouped model select with JSON-tuple values and no effort", async () => {
    const agent = start({ FAKE_ACP_MODELS: "config-no-effort" });
    await init(agent);
    const session = await newSession(agent);
    const model = optionsOf(session).find((option) => option.category === "model")!;
    expect(optionsOf(session).some((option) => option.category === "thought_level")).toBe(false);
    expect((model.options as { group: string; options: unknown[] }[]).map((group) => group.group)).toEqual(["acme", "zenith"]);
    expect(JSON.parse(model.currentValue as string)).toEqual(["acme", "model-one"]);
  });

  it("`models`: the older list only, set with session/set_model", async () => {
    const log = join(dir, "requests.jsonl");
    const agent = start({ FAKE_ACP_MODELS: "models", FAKE_ACP_REQUEST_LOG: log });
    await init(agent);
    const session = (await newSession(agent)) as Record<string, any>;
    expect(session.configOptions).toBeUndefined();
    expect(session.models.currentModelId).toBe("acme:model-one");
    const ids = session.models.availableModels.map((model: { modelId: string }) => model.modelId);
    expect(ids.slice(0, 3)).toEqual(["acme:model-one", "acme:model-two", "zenith:model-three"]);
    expect(ids).toHaveLength(15);
    expect(ids.at(-1)).toBe("orbit:model-fifteen");
    await agent.connection.extMethod("session/set_model", { sessionId: session.sessionId, modelId: "zenith:model-three" });
    await expect(agent.connection.extMethod("session/set_model", { sessionId: session.sessionId, modelId: "nope" })).rejects.toMatchObject({
      code: -32602,
    });
    expect(requestLog(log)).toEqual(["initialize", "session/new", "session/set_model", "session/set_model"]);
    expect(logLines(log)[2]).toMatchObject({ params: { modelId: "zenith:model-three" } });
  });

  it("`refuse`: the config shape, every set refused with FAKE_ACP_MODELS_ERROR", async () => {
    const agent = start({ FAKE_ACP_MODELS: "refuse", FAKE_ACP_MODELS_ERROR: "no switching for {env:FAKE_SECRET}", FAKE_SECRET: "s3cr3t-value" });
    await init(agent);
    const session = await newSession(agent);
    expect(current(session, "model")).toBe("default");
    await expect(
      agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-beta" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("no switching for s3cr3t-value") });
  });

  it("`effort-moves`: Model Gamma offers only low and medium, so a change to it moves a high effort to medium", async () => {
    const agent = start({ FAKE_ACP_MODELS: "effort-moves" });
    await init(agent);
    const session = await newSession(agent);
    await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "high" });
    const answer = await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-gamma" });
    expect(current(answer, "model")).toBe("model-gamma");
    expect(current(answer, "thought_level")).toBe("medium");
    const efforts = optionsOf(answer).find((option) => option.category === "thought_level")!.options as { value: string }[];
    expect(efforts.map((entry) => entry.value)).toEqual(["low", "medium"]);
  });

  it("`self-model:<value>` switches its own model mid-turn and says so with config_option_update", async () => {
    const agent = start({ FAKE_ACP_MODELS: "config" });
    await init(agent);
    const session = await newSession(agent);
    await say(agent, session.sessionId, "self-model:model-gamma");
    const update = agent.updates.find((entry) => entry.sessionUpdate === "config_option_update");
    expect(update).toBeDefined();
    expect(current(update, "model")).toBe("model-gamma");
  });

  it("a load answers with the shape's defaults: the session's model is not kept across a load", async () => {
    const agent = start({ FAKE_ACP_MODELS: "config" });
    await init(agent);
    const session = await newSession(agent);
    await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-beta" });
    const loaded = await agent.connection.loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] });
    expect(current(loaded, "model")).toBe("default");
  });

  it("FAKE_ACP_REQUEST_LOG gets one line per request in the order received", async () => {
    const log = join(dir, "requests.jsonl");
    const agent = start({ FAKE_ACP_MODELS: "config", FAKE_ACP_REQUEST_LOG: log });
    await init(agent);
    const session = await newSession(agent);
    await agent.connection.setSessionMode({ sessionId: session.sessionId, modeId: "default" });
    await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-alpha" });
    await say(agent, session.sessionId, "chunks:1");
    expect(requestLog(log)).toEqual(["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]);
    expect(logLines(log)[3]).toMatchObject({ params: { sessionId: session.sessionId, configId: "model", value: "model-alpha" } });
  });

  it("FAKE_ACP_SET_DELAY_MS holds a set's answer after logging it", async () => {
    const log = join(dir, "requests.jsonl");
    const agent = start({ FAKE_ACP_MODELS: "config", FAKE_ACP_REQUEST_LOG: log, FAKE_ACP_SET_DELAY_MS: "400" });
    await init(agent);
    const session = await newSession(agent);
    const began = Date.now();
    await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "low" });
    expect(Date.now() - began).toBeGreaterThanOrEqual(350);
    expect(requestLog(log).at(-1)).toBe("session/set_config_option");
  });

  it("FAKE_ACP_SET_DELAY_COUNT holds only the first N sets", async () => {
    const agent = start({ FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: "3000", FAKE_ACP_SET_DELAY_COUNT: "1" });
    await init(agent);
    const session = await newSession(agent);
    const held = agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "low" });
    const began = Date.now();
    await agent.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "model-beta" });
    expect(Date.now() - began).toBeLessThan(2_000);
    await held;
  });
});

describe("fake slow install (024 T741)", () => {
  it("writes its files into the target over the given time, then a done marker", async () => {
    const target = join(dir, "tree");
    const started = Date.now();
    await fakeSlowInstall({ target, files: 4, seconds: 0.8, bytesPerFile: 1024 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(readdirSync(target).sort()).toEqual([FAKE_INSTALL_DONE_MARKER, "file-1.bin", "file-2.bin", "file-3.bin", "file-4.bin"].sort());
    expect(statSync(join(target, "file-1.bin")).size).toBe(1024);
  });

  it("stops between files when aborted, with no done marker", async () => {
    const target = join(dir, "tree");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    await expect(fakeSlowInstall({ target, files: 10, seconds: 2, signal: abort.signal })).rejects.toThrow();
    const written = readdirSync(target);
    expect(written).not.toContain(FAKE_INSTALL_DONE_MARKER);
    expect(written.length).toBeLessThan(10);
  });

  it("runs as a process that grows the tree and can be killed part way", async () => {
    const target = join(dir, "tree");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", INSTALL, target, "3", "6"], {
      stdio: "ignore",
      windowsHide: true,
    });
    extraPids.push(child.pid!);
    await new Promise((done) => setTimeout(done, 1500));
    const partway = existsSync(target) ? readdirSync(target) : [];
    killTree(child.pid);
    await new Promise((done) => setTimeout(done, 300));
    expect(partway.length).toBeGreaterThan(0);
    expect(partway).not.toContain(FAKE_INSTALL_DONE_MARKER);
    expect(readdirSync(target)).not.toContain(FAKE_INSTALL_DONE_MARKER);
  });
});

describe("fake lockfile install (024 T791, HALLPASS_BROKER_TEST_INSTALL)", () => {
  const LOCK = {
    lockfileVersion: 3,
    packages: {
      "": { name: "root" },
      "node_modules/@scope/pinned": { version: "1.13.1" },
      "node_modules/dep": { version: "2.0.0" },
      "node_modules/dep/node_modules/nested": { version: "0.1.0" },
    },
  };

  it("writes each lockfile entry's package.json at its locked version, then the done marker", async () => {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(LOCK));
    expect(await fakeLockfileInstall({ dir, seconds: 0.3 })).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, "node_modules", "@scope", "pinned", "package.json"), "utf8"))).toEqual({
      name: "@scope/pinned",
      version: "1.13.1",
    });
    expect(JSON.parse(readFileSync(join(dir, "node_modules", "dep", "node_modules", "nested", "package.json"), "utf8")).name).toBe("nested");
    expect(existsSync(join(dir, FAKE_INSTALL_DONE_MARKER))).toBe(true);
  });

  it("takes its seconds from the switch file over the environment", () => {
    const switchFile = join(dir, "switch.json");
    expect(lockfileSeconds({ FAKE_INSTALL_SECONDS: "7" })).toBe(7);
    writeFileSync(switchFile, JSON.stringify({ FAKE_INSTALL_SECONDS: "45" }));
    expect(lockfileSeconds({ FAKE_INSTALL_SECONDS: "7", FAKE_ACP_SWITCH_FILE: switchFile })).toBe(45);
    expect(lockfileSeconds({ FAKE_ACP_SWITCH_FILE: join(dir, "missing.json") })).toBeUndefined();
  });

  it("runs as a process in the tree it is started in", async () => {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(LOCK));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", INSTALL, "--lockfile", "0.3"], {
      cwd: dir,
      stdio: "ignore",
      windowsHide: true,
    });
    extraPids.push(child.pid!);
    expect(await new Promise((done) => child.once("exit", done))).toBe(0);
    expect(existsSync(join(dir, "node_modules", "dep", "package.json"))).toBe(true);
    expect(existsSync(join(dir, FAKE_INSTALL_DONE_MARKER))).toBe(true);
  });
});
