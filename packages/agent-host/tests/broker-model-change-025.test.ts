import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import { conversationEventSchema, conversationResultFrameSchema, type ConversationAgent, type ConversationModelChoice } from "@hallpass/contracts";
import { createCommandHandler } from "../src/broker/commands.js";
import type { AdapterLaunchSpec } from "../src/broker/agents.js";
import { CONVERSATION_IDLE_MS, spawnAgentProcess } from "../src/broker/conversation.js";
import type { FolderActions } from "../src/broker/folders.js";
import { poolHarness, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 025 T811 - changing the model or effort between turns (R-402, R-405, R-406; FR-403 - FR-405,
 * FR-409; D-025-12). One request per part, never retried; one `model` line per accepted part; a
 * refusal keeps what the agent reports; the agent's own `config_option_update` adds no line.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const sets = (log: FakeLogLine[]) =>
  log.filter((line) => line.method === "session/set_config_option" || line.method === "session/set_model").map((line) => line.params);
const events = (harness: Harness, id: string, type: string) => harness.rec.of(id).filter((entry) => entry.event.type === type).map((entry) => entry.event);

async function startWith(harness: Harness, agent: ConversationAgent, model?: ConversationModelChoice): Promise<string> {
  const started = await harness.pool.start(agent, { kind: "scratch" }, undefined, "strict", model);
  if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
  return started.value!.conversationId;
}

const current = async (harness: Harness, id: string) => (await harness.pool.views()).find((view) => view.conversationId === id)?.models?.current;

describe("T811 set-model between turns", () => {
  it("a model change: one request, one line with the model's name and no effort; entry, store and view follow", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    expect(await h.pool.setModel(id, { model: "model-beta" })).toEqual({ ok: true });

    expect(sets(await h.requests())).toEqual([expect.objectContaining({ configId: "model", value: "model-beta" })]);
    const lines = events(h, id, "model");
    expect(lines).toEqual([{ type: "model", model: "Model Beta" }]);
    expect(conversationEventSchema.safeParse(lines[0]).success).toBe(true);
    expect(await current(h, id)).toEqual({ model: "model-beta", effort: "default" });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "default" });
    expect((await h.models.read())["claude-code"]?.choice).toEqual({ model: "model-beta", effort: "default" });
  });

  it("SC-182: choosing a model and an effort makes no model call - no session/prompt reaches the agent", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-beta", effort: "high" });
    expect(await h.pool.setModel(id, { model: "model-gamma" })).toEqual({ ok: true });
    expect(await h.pool.setModel(id, { effort: "low" })).toEqual({ ok: true });
    const methods = (await h.requests()).map((line) => line.method);
    expect(methods).not.toContain("session/prompt");
    expect(methods.filter((method) => method === "session/set_config_option")).toHaveLength(4);
  });

  it("an effort change: the line names the model and the effort, without effortChanged", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    expect(await h.pool.setModel(id, { effort: "high" })).toEqual({ ok: true });
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ configId: "effort", value: "high" })]);
    expect(events(h, id, "model")).toEqual([{ type: "model", model: "Default (recommended)", effort: "High" }]);
  });

  it("D-025-12: a model change that moves the effort names the effort now reported, with effortChanged", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "effort-moves" } });
    const id = await startWith(h, "claude-code", { model: "default", effort: "high" });
    expect(await h.pool.setModel(id, { model: "model-gamma" })).toEqual({ ok: true });
    expect(events(h, id, "model")).toEqual([{ type: "model", model: "Model Gamma", effort: "Medium", effortChanged: true }]);
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "medium" });
  });

  it("Hermes' older list: session/set_model, and the asked model becomes current", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "models" } });
    const id = await startWith(h, "hermes");
    expect(await h.pool.setModel(id, { model: "zenith:model-three" })).toEqual({ ok: true });
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ modelId: "zenith:model-three" })]);
    expect(events(h, id, "model")).toEqual([{ type: "model", model: "Model Three" }]);
    expect(await current(h, id)).toEqual({ model: "zenith:model-three" });
  });

  it("refused: result model-refused with the agent's scrubbed text, one notice, no line, nothing retried, nothing kept", async () => {
    h = await poolHarness({
      env: { FAKE_ACP_MODELS: "refuse", FAKE_ACP_MODELS_ERROR: "not on this plan {env:FAKE_MODEL_SECRET}", FAKE_MODEL_SECRET: "sk-model-secret-654321" },
    });
    const id = await startWith(h, "claude-code");
    const refused = await h.pool.setModel(id, { model: "model-beta", effort: "high" });
    expect(refused).toEqual({ ok: false, error: { code: "model-refused", detail: expect.stringContaining("not on this plan") } });
    expect(JSON.stringify(refused)).not.toContain("sk-model-secret-654321");
    expect(sets(await h.requests())).toHaveLength(1);
    const notices = events(h, id, "notice");
    expect(notices).toEqual([
      { type: "notice", code: "model-refused", agent: "claude-code", text: expect.stringMatching(/^Claude Code kept Default \(recommended\): it refused Model Beta \(.*not on this plan.*\)\.$/u) },
    ]);
    expect(JSON.stringify(notices)).not.toContain("sk-model-secret-654321");
    expect(events(h, id, "model")).toEqual([]);
    expect(await current(h, id)).toEqual({ model: "default", effort: "default" });
    expect((await h.models.read())["claude-code"]?.choice).toBeUndefined();
    expect(h.pool.state(id)).toBe("idle");
  });

  it("model-unknown for a value the live offer does not list, or an agent that reports none; nothing is sent", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    expect(await h.pool.setModel(id, { model: "model-zeta" })).toMatchObject({ ok: false, error: { code: "model-unknown" } });
    expect(await h.pool.setModel(id, { effort: "extreme" })).toMatchObject({ ok: false, error: { code: "model-unknown" } });
    expect(sets(await h.requests())).toEqual([]);
    await h.cleanup();

    h = await poolHarness({ env: { FAKE_ACP_MODELS: "none" } });
    const quiet = await startWith(h, "codex");
    expect(await h.pool.setModel(quiet, { model: "model-alpha" })).toMatchObject({ ok: false, error: { code: "model-unknown" } });
  });

  it("busy while a turn runs and while a card waits; behind a switch in flight four changes queue and a fifth is busy", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const running = await startWith(h, "claude-code");
    expect((await h.pool.send(running, "hang")).ok).toBe(true);
    await waitFor(() => h!.pool.state(running) === "running", "the turn");
    expect(await h.pool.setModel(running, { model: "model-beta" })).toMatchObject({ ok: false, error: { code: "busy" } });

    const waiting = await startWith(h, "claude-code");
    expect((await h.pool.send(waiting, "tool:edit")).ok).toBe(true);
    await waitFor(() => h!.pool.state(waiting) === "waiting-for-owner", "the card");
    expect(await h.pool.setModel(waiting, { model: "model-beta" })).toMatchObject({ ok: false, error: { code: "busy" } });

    const idle = await startWith(h, "claude-code");
    const outcomes = await Promise.all([
      h.pool.setModel(idle, { model: "model-beta" }),
      h.pool.setModel(idle, { model: "model-gamma" }),
      h.pool.setModel(idle, { effort: "low" }),
      // Already current when its turn comes: nothing is sent, and it still succeeds.
      h.pool.setModel(idle, { model: "model-gamma" }),
      h.pool.setModel(idle, { effort: "high" }),
      h.pool.setModel(idle, { model: "model-alpha" }),
    ]);
    expect(outcomes.slice(0, 5)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(outcomes[5]).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(sets(await h.requests()).map((params) => params?.value)).toEqual([
      "model-beta",
      "model-gamma",
      "low",
      "high",
    ]);
    expect(events(h, idle, "model")).toHaveLength(4);
    expect(await current(h, idle)).toEqual({ model: "model-gamma", effort: "high" });
  });

  it("a set-model while another is in flight queues behind it: model then effort, two lines, both ok", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    const [model, effort] = await Promise.all([h.pool.setModel(id, { model: "model-beta" }), h.pool.setModel(id, { effort: "high" })]);
    expect(model).toEqual({ ok: true });
    expect(effort).toEqual({ ok: true });
    expect(sets(await h.requests())).toEqual([
      expect.objectContaining({ configId: "model", value: "model-beta" }),
      expect.objectContaining({ configId: "effort", value: "high" }),
    ]);
    expect(events(h, id, "model")).toEqual([
      { type: "model", model: "Model Beta" },
      { type: "model", model: "Model Beta", effort: "High" },
    ]);
    expect(await current(h, id)).toEqual({ model: "model-beta", effort: "high" });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "high" });
  });

  it("changes queued when the agent exits all resolve agent-exited, and none is sent", async () => {
    // The kill ends the wait long before the delay does; a long one keeps a slow parallel run from racing it.
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: "30000" } });
    const id = await startWith(h, "claude-code");
    const pending = Promise.all([
      h.pool.setModel(id, { model: "model-beta" }),
      h.pool.setModel(id, { effort: "high" }),
      h.pool.setModel(id, { model: "model-gamma" }),
    ]);
    await waitFor(async () => sets(await h!.requests()).length === 1, "the first set in flight");
    process.kill(h.pool.agentPid(id)!);
    const [inFlight, ...queued] = await pending;
    // The one in flight is not a refusal either: its connection closed, so it says agent-exited too.
    expect(inFlight).toMatchObject({ ok: false, error: { code: "agent-exited" } });
    for (const outcome of queued) expect(outcome).toMatchObject({ ok: false, error: { code: "agent-exited" } });
    expect(sets(await h.requests())).toHaveLength(1);
    expect(events(h, id, "model")).toEqual([]);
    expect(events(h, id, "notice").filter((notice) => notice.type === "notice" && notice.code === "model-refused")).toEqual([]);
  });

  it("a message is refused busy while a switch is in flight, and a switch while a mode reload is", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    const [switched, sent] = await Promise.all([h.pool.setModel(id, { model: "model-beta" }), h.pool.send(id, "chunks:1")]);
    expect(switched).toEqual({ ok: true });
    expect(sent).toMatchObject({ ok: false, error: { code: "busy" } });

    const [reloaded, during] = await Promise.all([h.pool.setMode(id, "agent-review"), h.pool.setModel(id, { model: "model-gamma" })]);
    expect(reloaded).toEqual({ ok: true });
    expect(during).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("DeepSeek's fixed mode does not block a model change", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config-no-effort" } });
    const id = await startWith(h, "deepseek");
    const value = JSON.stringify(["acme", "model-two"]);
    expect(await h.pool.setModel(id, { model: value })).toEqual({ ok: true });
    expect(events(h, id, "model")).toEqual([{ type: "model", model: "Model Two" }]);
  });

  it("R-406: the agent's own config_option_update moves the live state with no line", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    await h.turn(id, "self-model:model-gamma chunks:1");
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "default" });
    expect(events(h, id, "model")).toEqual([]);
  });

  it("goes through ui.conversation.set-model, with a schema-valid result", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    const sent: Record<string, unknown>[] = [];
    const handler = createCommandHandler({
      sessionId: "broker-test",
      send: (frame) => {
        sent.push(frame as Record<string, unknown>);
        return true;
      },
      pool: h.pool,
      index: h.index,
      folders: h.folders,
      consent: { read: async () => "granted", write: async () => undefined },
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      install: async () => ({ ok: true, directory: "x" }),
    });
    await handler.handle({
      type: "conversation-command",
      sessionId: "broker-test",
      commandId: "c-1",
      command: { type: "ui.conversation.set-model", payload: { conversationId: id, model: "model-alpha" } },
    });
    const result = sent.find((frame) => frame.type === "conversation-result" && frame.commandId === "c-1");
    expect(conversationResultFrameSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ ok: true });
    expect(events(h, id, "model")).toEqual([{ type: "model", model: "Model Alpha" }]);
  });

  it("a stopped conversation: agent-exited, and the entry keeps the choice for when it continues", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    await h.pool.shutdown();
    expect(await h.pool.setModel(id, { model: "model-beta" })).toMatchObject({ ok: false, error: { code: "agent-exited" } });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "default" });
  });
});

/**
 * #23 (0.17.0 follow-up): while a change is queued behind the one in flight nothing else changes the
 * run - a mode change and Hermes' restart are refused `busy`, the idle stop waits - and a switch the
 * agent answered just before it went away never reports after the agent's exit.
 */
describe("#23 the model change queue", () => {
  it("a mode change, a Hermes restart and the idle stop wait while a change is in flight and one queued", async () => {
    // The jumps past the idle limit must not end the sets on their own bound.
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "models", FAKE_ACP_SET_DELAY_MS: "1500" }, modelSetBoundMs: 10 * CONVERSATION_IDLE_MS });
    const id = await startWith(h, "hermes");
    const pending = Promise.all([h.pool.setModel(id, { model: "acme:model-two" }), h.pool.setModel(id, { model: "zenith:model-three" })]);
    await waitFor(async () => sets(await h!.requests()).length === 1, "the first set in flight");

    // One in flight, one queued.
    expect(await h.pool.setMode(id, "agent-review")).toMatchObject({ ok: false, error: { code: "busy" } });
    h.clock.advance(CONVERSATION_IDLE_MS);
    expect(h.pool.state(id)).toBe("idle");
    expect(h.pool.agentPid(id)).toBeDefined();

    // The queued one is in flight now: still nothing else.
    await waitFor(async () => sets(await h!.requests()).length === 2, "the queued set in flight");
    expect(await h.pool.setMode(id, "agent-review")).toMatchObject({ ok: false, error: { code: "busy" } });
    h.clock.advance(CONVERSATION_IDLE_MS);
    expect(h.pool.state(id)).toBe("idle");

    expect(await pending).toEqual([{ ok: true }, { ok: true }]);
    // Nothing restarted meanwhile: one run, no second session opening.
    expect((await h.requests()).filter((line) => line.method === "session/load")).toEqual([]);
    expect(await current(h, id)).toEqual({ model: "zenith:model-three" });

    // The queue is empty: the idle countdown runs again.
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop after the queue");
  });

  it("an agent that answers a change and exits at once: no model line after its agent-exited notice", async () => {
    // The agent's answer and its exit are held, then handed on in the order that loses the race:
    // the answer, and the exit one immediate later - before the conversation reports the switch.
    let holding = false;
    let exitHeld = false;
    const held: Array<() => void> = [];
    const spawnAgent = (spec: AdapterLaunchSpec, cwd: string): ChildProcess => {
      const child = spawnAgentProcess(spec, cwd);
      const hold = (target: NodeJS.EventEmitter, events: string[]) => {
        const emit = target.emit.bind(target);
        target.emit = (event: string | symbol, ...args: unknown[]) => {
          if (!holding || !events.includes(String(event))) return emit(event, ...args);
          if (target === child && event === "exit") exitHeld = true;
          held.push(() => emit(event, ...args));
          return true;
        };
      };
      hold(child.stdout!, ["data", "end", "close"]);
      hold(child, ["exit", "close"]);
      return child;
    };
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_EXIT_AFTER_SET: "1" }, spawnAgent });
    const id = await startWith(h, "claude-code");
    holding = true;
    const changing = h.pool.setModel(id, { model: "model-beta" });
    await waitFor(() => exitHeld, "the answer and the exit held");
    holding = false;
    const [answer, ...rest] = held.splice(0);
    answer!();
    setImmediate(() => {
      for (const release of rest) release();
    });
    const outcome = await changing;
    await waitFor(() => h!.pool.state(id) === "crashed", "the exit");
    const order = h.rec
      .of(id)
      .map((entry) => entry.event)
      .filter((event) => event.type === "model" || (event.type === "notice" && event.code === "agent-exited"))
      .map((event) => event.type);
    // Reported before the exit, or not at all - and the result says the same.
    if (outcome.ok) expect(order).toEqual(["model", "notice"]);
    else {
      expect(outcome).toMatchObject({ ok: false, error: { code: "agent-exited" } });
      expect(order).toEqual(["notice"]);
    }
  });
});
