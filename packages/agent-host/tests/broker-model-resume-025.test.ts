import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import type { ConversationAgent, ConversationModelChoice, ConversationModelOffer } from "@hallpass/contracts";
import { CONVERSATION_IDLE_MS } from "../src/broker/conversation.js";
import { poolHarness, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 025 T816 - the model at every later session opening (R-403, R-404, R-405; FR-408): a resume after
 * an idle stop, a crash or an open, Claude's mode reload (`session/load` on the same run) and Hermes'
 * mode restart all end on the conversation's model - after the mode is confirmed, before any prompt,
 * with no `model` line - and a load or resume never replaces the stored offer. The fake agent answers
 * a load or resume with its defaults, so each re-apply shows as a request.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const isSet = (line: FakeLogLine) => line.method === "session/set_config_option" || line.method === "session/set_model";
/** The requests after the last opening of the session (`session/load` or `session/resume`). */
const sinceOpening = (log: FakeLogLine[]) => {
  const at = log.map((line) => line.method).lastIndexOf("session/load");
  const resumed = log.map((line) => line.method).lastIndexOf("session/resume");
  return log.slice(Math.max(at, resumed));
};
const methods = (log: FakeLogLine[]) => log.map((line) => line.method);
const events = (harness: Harness, id: string, type: string) => harness.rec.of(id).filter((entry) => entry.event.type === type).map((entry) => entry.event);
const current = async (harness: Harness, id: string) => (await harness.pool.views()).find((view) => view.conversationId === id)?.models?.current;

async function startWith(harness: Harness, agent: ConversationAgent, model?: ConversationModelChoice): Promise<string> {
  const started = await harness.pool.start(agent, { kind: "scratch" }, undefined, "strict", model);
  if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
  return started.value!.conversationId;
}

async function idleStop(harness: Harness, id: string): Promise<void> {
  harness.clock.advance(CONVERSATION_IDLE_MS);
  await waitFor(() => harness.pool.state(id) === "stopped", "the idle stop");
  // The stop clears the lease in the entry; a test that edits the entry waits for that write first.
  await waitFor(async () => (await harness.index.get(id))?.lease === undefined, "the lease cleared");
}

describe("T816 the model at every later opening", () => {
  it("a resume after the idle stop re-applies the entry's model after the mode, before the prompt, with no line", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-beta", effort: "high" });
    await idleStop(h, id);
    await h.turn(id, "chunks:1");

    expect(methods(sinceOpening(await h.requests()))).toEqual([
      "session/load",
      "session/set_mode",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(sinceOpening(await h.requests()).filter(isSet).map((line) => line.params)).toEqual([
      expect.objectContaining({ configId: "model", value: "model-beta" }),
      expect.objectContaining({ configId: "effort", value: "high" }),
    ]);
    expect(events(h, id, "model")).toEqual([]);
    expect(await current(h, id)).toEqual({ model: "model-beta", effort: "high" });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "high" });
  });

  it("a resume after a crash, and an open, re-apply it too", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-gamma" });
    expect((await h.pool.send(id, "crash")).ok).toBe(true);
    await waitFor(() => h!.pool.state(id) === "crashed", "the crash");
    await h.turn(id, "chunks:1");
    expect(sinceOpening(await h.requests()).filter(isSet).map((line) => line.params)).toEqual([expect.objectContaining({ value: "model-gamma" })]);

    await idleStop(h, id);
    expect(await h.pool.open(id)).toEqual({ ok: true });
    expect(sinceOpening(await h.requests()).filter(isSet).map((line) => line.params)).toEqual([expect.objectContaining({ value: "model-gamma" })]);
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "default" });
  });

  it("DeepSeek's session/resume is followed by its model as well", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config-no-effort" } });
    const value = JSON.stringify(["zenith", "model-three"]);
    const id = await startWith(h, "deepseek", { model: value });
    await idleStop(h, id);
    await h.turn(id, "chunks:1");
    expect(methods(sinceOpening(await h.requests()))).toEqual(["session/resume", "session/set_config_option", "session/prompt"]);
  });

  it("Claude's mode reload (session/load on the same run) re-applies the current model after the new mode", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    expect(await h.pool.setModel(id, { model: "model-beta" })).toEqual({ ok: true });
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });

    expect(methods(sinceOpening(await h.requests()))).toEqual(["session/load", "session/set_mode", "session/set_config_option"]);
    expect(sinceOpening(await h.requests()).filter(isSet).map((line) => line.params)).toEqual([expect.objectContaining({ value: "model-beta" })]);
    // One line: the owner's change; the re-apply adds none.
    expect(events(h, id, "model")).toHaveLength(1);
    expect(await current(h, id)).toEqual({ model: "model-beta", effort: "default" });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "default" });
  });

  it("Hermes' mode restart re-applies its model with session/set_model", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "models" } });
    const id = await startWith(h, "hermes", { model: "zenith:model-three" });
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });
    expect(methods(sinceOpening(await h.requests()))).toEqual(["session/load", "session/set_mode", "session/set_model"]);
    expect(await current(h, id)).toEqual({ model: "zenith:model-three" });
    expect((await h.index.get(id))?.model).toEqual({ model: "zenith:model-three" });
    expect(events(h, id, "model")).toEqual([]);
  });

  it("a model no longer offered at a resume: nothing sent, model-unavailable, the entry takes the agent's", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    await idleStop(h, id);
    const entry = (await h.index.get(id))!;
    await h.index.put({ ...entry, model: { model: "model-retired" } });
    await h.turn(id, "chunks:1");
    expect(sinceOpening(await h.requests()).filter(isSet)).toEqual([]);
    expect(events(h, id, "notice")).toEqual([
      expect.objectContaining({
        code: "model-unavailable",
        text: "Claude Code no longer offers model-retired; the conversation uses Default (recommended) instead.",
      }),
    ]);
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "default" });
  });

  it("sends nothing when the agent already reports the entry's model", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "default", effort: "default" });
    await idleStop(h, id);
    await h.turn(id, "chunks:1");
    expect(methods(sinceOpening(await h.requests()))).toEqual(["session/load", "session/set_mode", "session/prompt"]);
  });

  it("an unknown-session resume is refused as before, and nothing of the model is sent", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-beta" });
    await idleStop(h, id);
    const entry = (await h.index.get(id))!;
    await h.index.put({ ...entry, agentSessionId: "no-such-session" });
    const sent = await h.pool.send(id, "chunks:1");
    expect(sent).toMatchObject({ ok: false, error: { code: "cannot-resume" } });
    expect((await h.index.get(id))?.resumable).toBe(false);
    expect(sinceOpening(await h.requests()).filter(isSet)).toEqual([]);
  });

  it("R-406: the agent's own change is in the entry, so the resume after an idle stop does not revert it", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "default" });
    await h.turn(id, "self-model:model-gamma chunks:1");
    await waitFor(async () => (await h!.index.get(id))?.model?.model === "model-gamma", "the entry follows the agent");
    // The owner's last choice for the agent is not the agent's own change.
    expect((await h.models.read())["claude-code"]?.choice).toBeUndefined();
    await idleStop(h, id);
    await h.turn(id, "chunks:1");

    // The fake agent answers the load with its defaults, so the conversation's model is sent again.
    const sets = sinceOpening(await h.requests()).filter(isSet).map((line) => line.params);
    expect(sets).toEqual([expect.objectContaining({ configId: "model", value: "model-gamma" })]);
    expect(sets).not.toContainEqual(expect.objectContaining({ value: "default" }));
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "default" });
    expect(events(h, id, "model")).toEqual([]);
  });

  it("a load or resume never replaces the stored offer", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code");
    const marker: ConversationModelOffer = { source: "models", models: [{ value: "marker", name: "Marker" }], efforts: [] };
    await h.models.recordOffer("claude-code", marker, "2026-10-26T00:00:00.000Z");
    await idleStop(h, id);
    await h.turn(id, "chunks:1");
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });
    expect((await h.models.read())["claude-code"]).toMatchObject({ offer: marker, seenAt: "2026-10-26T00:00:00.000Z" });
  });
});
