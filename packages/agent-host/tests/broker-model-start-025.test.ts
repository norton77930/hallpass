import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import {
  conversationOverviewFrameSchema,
  conversationViewSchema,
  type ConversationAgent,
  type ConversationModelOffer,
  type ConversationModelWant,
} from "@hallpass/contracts";
import { createCommandHandler } from "../src/broker/commands.js";
import type { FolderActions } from "../src/broker/folders.js";
import { memoryModelStore } from "../src/broker/model-store.js";
import { poolHarness, type FakeLogLine } from "./conversation-harness.js";

/**
 * 025 T805 / T807 - the model picker at the start of a conversation (R-401, R-403, R-405; FR-400,
 * FR-401, FR-402, FR-407, FR-408; SC-179). The fake agent's FAKE_ACP_MODELS shapes stand in for the
 * four agents' answers, with invented names; FAKE_ACP_REQUEST_LOG records every request in order.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const methods = (log: FakeLogLine[]) => log.map((line) => line.method);
const sets = (log: FakeLogLine[]) =>
  log.filter((line) => line.method === "session/set_config_option" || line.method === "session/set_model").map((line) => line.params);
/** SC-179: every model request before the first prompt. */
const setsBeforeFirstPrompt = (log: FakeLogLine[]) => {
  const prompt = log.findIndex((line) => line.method === "session/prompt");
  if (prompt === -1) return true;
  return log.slice(prompt).every((line) => line.method !== "session/set_config_option" && line.method !== "session/set_model");
};
const events = (harness: Harness, id: string, type: string) => harness.rec.of(id).filter((entry) => entry.event.type === type).map((entry) => entry.event);

async function startWith(harness: Harness, agent: ConversationAgent, model?: ConversationModelWant): Promise<string> {
  const started = await harness.pool.start(agent, { kind: "scratch" }, undefined, "strict", model);
  if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
  return started.value!.conversationId;
}

async function viewOf(harness: Harness, id: string) {
  const view = (await harness.pool.views()).find((entry) => entry.conversationId === id)!;
  expect(conversationViewSchema.safeParse(view).success).toBe(true);
  return view;
}

/** The `config` shape's offer as the parser reads it (no `current`: the store keeps the agent's). */
const CONFIG_OFFER: ConversationModelOffer = {
  source: "config",
  configIds: { model: "model", effort: "effort" },
  models: [
    { value: "default", name: "Default (recommended)", description: "Model Alpha for most tasks" },
    { value: "model-alpha", name: "Model Alpha" },
    { value: "model-beta", name: "Model Beta" },
    { value: "model-gamma", name: "Model Gamma" },
  ],
  efforts: [
    { value: "default", name: "Default" },
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
  defaultModel: "default",
  defaultEffort: "default",
};

describe("T805 the chosen model before the first message", () => {
  it("sets model then effort after the mode is confirmed and before any prompt; no line; entry, store and view follow", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-beta", effort: "high" });

    const log = await h.requests();
    expect(methods(log)).toEqual(["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/set_config_option"]);
    expect(sets(log)).toEqual([
      expect.objectContaining({ configId: "model", value: "model-beta" }),
      expect.objectContaining({ configId: "effort", value: "high" }),
    ]);
    // FR-401: a start is not a change - no `model` event.
    expect(events(h, id, "model")).toEqual([]);

    await h.turn(id, "chunks:1");
    const after = await h.requests();
    expect(setsBeforeFirstPrompt(after)).toBe(true);
    // FR-402: nothing but the protocol's own requests is sent.
    expect(methods(after).every((method) => method === "initialize" || String(method).startsWith("session/"))).toBe(true);

    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "high" });
    expect((await h.models.read())["claude-code"]).toEqual({ offer: CONFIG_OFFER, seenAt: expect.any(String), choice: { model: "model-beta", effort: "high" } });
    const view = await viewOf(h, id);
    expect(view.models).toEqual({ ...CONFIG_OFFER, current: { model: "model-beta", effort: "high" } });
    expect(view.model).toBeUndefined();
  });

  it("an effort alone in the start sends that one effort request before the prompt; the store's choice takes the agent's model", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { effort: "high" });
    expect(methods(await h.requests())).toEqual(["initialize", "session/new", "session/set_mode", "session/set_config_option"]);
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ configId: "effort", value: "high" })]);
    await h.turn(id, "chunks:1");
    expect(setsBeforeFirstPrompt(await h.requests())).toBe(true);
    expect(events(h, id, "model")).toEqual([]);
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "high" });
    expect((await h.models.read())["claude-code"]?.choice).toEqual({ model: "default", effort: "high" });
  });

  it("without a choice in the start uses the store's, sending only the part that differs", async () => {
    const models = memoryModelStore({ "claude-code": { offer: CONFIG_OFFER, seenAt: "2026-10-25T00:00:00.000Z", choice: { model: "default", effort: "high" } } });
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" }, models });
    const id = await startWith(h, "claude-code");
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ configId: "effort", value: "high" })]);
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "high" });
    // The offer is the one this session/new reported; the choice stays the owner's.
    expect((await h.models.read())["claude-code"]?.choice).toEqual({ model: "default", effort: "high" });
  });

  it("sends nothing when the agent already reports the choice, and nothing with no choice anywhere", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    await startWith(h, "claude-code", { model: "default", effort: "default" });
    await startWith(h, "claude-code");
    expect(sets(await h.requests())).toEqual([]);
  });

  it("a refused start-time switch still starts: one model-refused notice with the agent's scrubbed text, the first message goes after it", async () => {
    h = await poolHarness({
      env: { FAKE_ACP_MODELS: "refuse", FAKE_ACP_MODELS_ERROR: "plan does not include it {env:FAKE_MODEL_SECRET}", FAKE_MODEL_SECRET: "sk-model-secret-123456" },
    });
    const id = await startWith(h, "claude-code", { model: "model-beta", effort: "high" });
    expect(h.pool.state(id)).toBe("idle");
    const notices = events(h, id, "notice");
    expect(notices).toEqual([
      {
        type: "notice",
        code: "model-refused",
        agent: "claude-code",
        text: expect.stringMatching(/^Claude Code kept Default \(recommended\): it refused Model Beta \(.*plan does not include it.*\)\.$/u),
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain("sk-model-secret-123456");
    // No retry, and the effort is not tried after the model was refused.
    expect(sets(await h.requests())).toHaveLength(1);
    expect(events(h, id, "model")).toEqual([]);

    await h.turn(id, "chunks:1");
    expect(setsBeforeFirstPrompt(await h.requests())).toBe(true);
    // R-405: the store's choice is left as it was (none); the entry says what the agent reports.
    expect((await h.models.read())["claude-code"]?.choice).toBeUndefined();
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "default" });
  });

  it("a remembered model the agent no longer offers sends nothing, says model-unavailable once, and the agent's own replaces it", async () => {
    const models = memoryModelStore({ "claude-code": { offer: CONFIG_OFFER, seenAt: "2026-10-25T00:00:00.000Z", choice: { model: "model-zeta" } } });
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" }, models });
    const id = await startWith(h, "claude-code");
    expect(sets(await h.requests())).toEqual([]);
    expect(events(h, id, "notice")).toEqual([
      {
        type: "notice",
        code: "model-unavailable",
        agent: "claude-code",
        text: "Claude Code no longer offers model-zeta; the conversation uses Default (recommended) instead.",
      },
    ]);
    expect((await h.models.read())["claude-code"]?.choice).toEqual({ model: "default", effort: "default" });
    expect((await h.index.get(id))?.model).toEqual({ model: "default", effort: "default" });
  });

  it("Hermes' older list is switched with session/set_model", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "models" } });
    const id = await startWith(h, "hermes", { model: "zenith:model-three" });
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ modelId: "zenith:model-three" })]);
    expect(methods(await h.requests())).toContain("session/set_model");
    expect((await viewOf(h, id)).models?.current).toEqual({ model: "zenith:model-three" });
    expect((await h.models.read()).hermes?.offer.source).toBe("models");
  });

  it("DeepSeek's grouped values go back byte for byte, with no effort and no mode request", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config-no-effort" } });
    const value = JSON.stringify(["zenith", "model-three"]);
    const id = await startWith(h, "deepseek", { model: value });
    expect(methods(await h.requests())).toEqual(["initialize", "session/new", "session/set_config_option"]);
    expect(sets(await h.requests())).toEqual([expect.objectContaining({ configId: "model", value })]);
    expect((await h.index.get(id))?.model).toEqual({ model: value });
  });

  it("an agent that reports no models: nothing is sent, the view has no models, the store keeps an empty offer", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "none" } });
    const id = await startWith(h, "codex", { model: "model-alpha" });
    expect(methods(await h.requests())).toEqual(["initialize", "session/new", "session/set_mode"]);
    const view = await viewOf(h, id);
    expect(view.models).toBeUndefined();
    expect((await h.index.get(id))?.model).toBeUndefined();
    expect((await h.models.read()).codex?.offer).toEqual({ source: "models", models: [], efforts: [] });
    expect(h.rec.of(id).some((entry) => entry.event.type === "notice")).toBe(false);
  });
});

describe("T807 what the overview and the views carry", () => {
  it("availability carries the store's offer and choice (no current); a stopped view carries the entry's model", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config" } });
    const id = await startWith(h, "claude-code", { model: "model-alpha" });

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
    await handler.sendOverview();
    const overview = sent.find((frame) => frame.type === "conversation-overview")!;
    expect(conversationOverviewFrameSchema.safeParse(overview).success).toBe(true);
    const agents = overview.agents as { agent: string; models?: unknown }[];
    expect(agents.find((entry) => entry.agent === "claude-code")?.models).toEqual({ offer: CONFIG_OFFER, choice: { model: "model-alpha", effort: "default" } });
    expect(agents.find((entry) => entry.agent === "codex")?.models).toBeUndefined();

    // Running: the live offer with its current, and no entry value beside it.
    const running = await viewOf(h, id);
    expect(running.models?.current).toEqual({ model: "model-alpha", effort: "default" });
    expect(running.model).toBeUndefined();
    // Stopped: the entry's values, no live offer.
    await h.pool.shutdown();
    const stopped = await viewOf(h, id);
    expect(stopped.models).toBeUndefined();
    expect(stopped.model).toEqual({ model: "model-alpha", effort: "default" });
  });
});
