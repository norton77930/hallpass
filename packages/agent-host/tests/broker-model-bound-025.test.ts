import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import type { ConversationAgent, ConversationModelChoice } from "@hallpass/contracts";
import { CONVERSATION_IDLE_MS, MODEL_SET_BOUND_MS } from "../src/broker/conversation.js";
import { poolHarness, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 025 (0.17.0, owner 2026-10-26) - every model or effort set request the broker sends is bounded at
 * MODEL_SET_BOUND_MS (a real Hermes answered `session/set_model` after 114 s). Past the bound the
 * change is `model-refused` with the timeout text, the conversation keeps its model and takes the
 * next change or message; the late answer resolves nothing, but what it reports is followed. The
 * fake agent's FAKE_ACP_SET_DELAY_MS stands in for the slow agent; the bound is shortened here.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** Short enough for a test, far from the delay: a slow parallel run cannot make the two meet. */
const BOUND_MS = 2_000;
const NEVER_MS = "30000";

const isSet = (line: FakeLogLine) => line.method === "session/set_config_option" || line.method === "session/set_model";
const sets = (log: FakeLogLine[]) => log.filter(isSet).map((line) => line.params);
const events = (harness: Harness, id: string, type: string) => harness.rec.of(id).filter((entry) => entry.event.type === type).map((entry) => entry.event);
const refusals = (harness: Harness, id: string) => events(harness, id, "notice").filter((notice) => notice.type === "notice" && notice.code === "model-refused");
const current = async (harness: Harness, id: string) => (await harness.pool.views()).find((view) => view.conversationId === id)?.models?.current;
const timedOut = (kept: string, asked: string) =>
  `Claude Code did not answer within 2 s, so the model is unchanged: it keeps ${kept} and did not switch to ${asked}.`;

async function startWith(harness: Harness, agent: ConversationAgent, model?: ConversationModelChoice): Promise<string> {
  const started = await harness.pool.start(agent, { kind: "scratch" }, undefined, "strict", model);
  if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
  return started.value!.conversationId;
}

describe("025 the bound on a model or effort set request", () => {
  it("the product bound is 30 s", () => {
    expect(MODEL_SET_BOUND_MS).toBe(30_000);
  });

  it("a set past the bound answers model-refused with the timeout text; model, entry and store are kept; a message goes right after", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: NEVER_MS }, modelSetBoundMs: BOUND_MS });
    const id = await startWith(h, "claude-code");
    const entryBefore = (await h.index.get(id))?.model;
    const storeBefore = (await h.models.read())["claude-code"]?.choice;

    const asked = Date.now();
    const outcome = await h.pool.setModel(id, { model: "model-beta" });
    const took = Date.now() - asked;
    expect(outcome).toEqual({ ok: false, error: { code: "model-refused", detail: timedOut("Default (recommended)", "Model Beta") } });
    expect(took).toBeGreaterThanOrEqual(BOUND_MS - 100);
    expect(took).toBeLessThan(15_000);

    expect(refusals(h, id)).toEqual([{ type: "notice", code: "model-refused", agent: "claude-code", text: timedOut("Default (recommended)", "Model Beta") }]);
    expect(events(h, id, "model")).toEqual([]);
    expect(await current(h, id)).toEqual({ model: "default", effort: "default" });
    expect((await h.index.get(id))?.model).toEqual(entryBefore);
    expect((await h.models.read())["claude-code"]?.choice).toEqual(storeBefore);
    expect(h.pool.state(id)).toBe("idle");

    // Not `busy`: the switch was released, though the agent still has not answered.
    await h.turn(id, "chunks:1");
    expect((await h.requests()).map((line) => line.method)).toContain("session/prompt");
  });

  it("changes queued behind a timed-out one still run, in order, each bounded", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: NEVER_MS }, modelSetBoundMs: BOUND_MS });
    const id = await startWith(h, "claude-code");
    const [model, effort] = await Promise.all([h.pool.setModel(id, { model: "model-beta" }), h.pool.setModel(id, { effort: "high" })]);
    expect(model).toMatchObject({ ok: false, error: { code: "model-refused", detail: timedOut("Default (recommended)", "Model Beta") } });
    expect(effort).toMatchObject({ ok: false, error: { code: "model-refused", detail: timedOut("Default", "High") } });
    expect(sets(await h.requests())).toEqual([
      expect.objectContaining({ configId: "model", value: "model-beta" }),
      expect.objectContaining({ configId: "effort", value: "high" }),
    ]);
    expect(refusals(h, id)).toHaveLength(2);
    expect(await current(h, id)).toEqual({ model: "default", effort: "default" });
  });

  it("the late answer resolves nothing - no second notice, no line - and what it reports is followed; a later update is too", async () => {
    // Late but inside the test: well past the bound, long before the test's own limit.
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: "7000" }, modelSetBoundMs: BOUND_MS });
    const id = await startWith(h, "claude-code");
    const storeBefore = (await h.models.read())["claude-code"]?.choice;
    expect(await h.pool.setModel(id, { model: "model-beta" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    expect(await current(h, id)).toEqual({ model: "default", effort: "default" });

    // The agent did switch, late: its answer carries the options, and the panel ends on what it says.
    await waitFor(async () => (await current(h!, id))?.model === "model-beta", "the late answer followed", 20_000);
    await waitFor(async () => (await h!.index.get(id))?.model?.model === "model-beta", "the entry follows the agent");
    expect(refusals(h, id)).toHaveLength(1);
    expect(events(h, id, "model")).toEqual([]);
    expect((await h.models.read())["claude-code"]?.choice).toEqual(storeBefore);

    // With no switch in flight, the agent's own config_option_update is followed as before.
    await h.turn(id, "self-model:model-gamma chunks:1");
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "default" });
    await waitFor(async () => (await h!.index.get(id))?.model?.model === "model-gamma", "the entry follows the update");
    expect(events(h, id, "model")).toEqual([]);
  });

  it("Hermes' late session/set_model success ({}) is followed: view and entry end on the asked model, the store is unchanged", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "models", FAKE_ACP_SET_DELAY_MS: "7000" }, modelSetBoundMs: BOUND_MS });
    const id = await startWith(h, "hermes");
    const storeBefore = (await h.models.read()).hermes?.choice;
    expect(await h.pool.setModel(id, { model: "zenith:model-three" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    expect(await current(h, id)).toEqual({ model: "acme:model-one" });

    await waitFor(async () => (await current(h!, id))?.model === "zenith:model-three", "the late success followed", 20_000);
    await waitFor(async () => (await h!.index.get(id))?.model?.model === "zenith:model-three", "the entry follows the agent");
    expect(refusals(h, id)).toHaveLength(1);
    expect(events(h, id, "model")).toEqual([]);
    expect((await h.models.read()).hermes?.choice).toEqual(storeBefore);
  });

  it("a late success does not overwrite a newer change of that part the agent accepted meanwhile", async () => {
    h = await poolHarness({
      env: { FAKE_ACP_MODELS: "models", FAKE_ACP_SET_DELAY_MS: "6000", FAKE_ACP_SET_DELAY_COUNT: "1" },
      modelSetBoundMs: BOUND_MS,
    });
    const id = await startWith(h, "hermes");
    expect(await h.pool.setModel(id, { model: "zenith:model-three" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    expect(await h.pool.setModel(id, { model: "acme:model-two" })).toEqual({ ok: true });
    // Past the late answer of the first: it arrived and changed nothing.
    await new Promise((done) => setTimeout(done, 6_000));
    expect(await current(h, id)).toEqual({ model: "acme:model-two" });
    expect((await h.index.get(id))?.model).toEqual({ model: "acme:model-two" });
  });

  it("two changes that both time out on an agent that answers in order end on the second one's model", async () => {
    // A goes at 0 s and answers at 4 s; B goes when A's bound ends (2 s) and answers at 6 s.
    h = await poolHarness({
      env: { FAKE_ACP_MODELS: "models", FAKE_ACP_SET_DELAY_MS: "4000", FAKE_ACP_SET_DELAY_COUNT: "2" },
      modelSetBoundMs: BOUND_MS,
    });
    const id = await startWith(h, "hermes");
    expect(await h.pool.setModel(id, { model: "zenith:model-three" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    expect(await h.pool.setModel(id, { model: "acme:model-two" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    await waitFor(async () => (await current(h!, id))?.model === "acme:model-two", "the second late success followed", 20_000);
    await waitFor(async () => (await h!.index.get(id))?.model?.model === "acme:model-two", "the entry follows the second");
    // Well past both answers: nothing moves it back.
    await new Promise((done) => setTimeout(done, 1_000));
    expect(await current(h, id)).toEqual({ model: "acme:model-two" });
    expect((await h.index.get(id))?.model).toEqual({ model: "acme:model-two" });
  });

  it("late session options are ignored too once a newer change of that part was accepted", async () => {
    h = await poolHarness({
      env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: "6000", FAKE_ACP_SET_DELAY_COUNT: "1" },
      modelSetBoundMs: BOUND_MS,
    });
    const id = await startWith(h, "claude-code");
    expect(await h.pool.setModel(id, { model: "model-beta" })).toMatchObject({ ok: false, error: { code: "model-refused" } });
    expect(await h.pool.setModel(id, { model: "model-gamma" })).toEqual({ ok: true });
    await new Promise((done) => setTimeout(done, 6_000));
    expect(await current(h, id)).toEqual({ model: "model-gamma", effort: "default" });
    expect((await h.index.get(id))?.model).toEqual({ model: "model-gamma", effort: "default" });
  });

  it("the timeout notice names what is current when it is said, not what was current when the request went", async () => {
    // The first set's late answer (at 4.5 s) lands while the second waits (3 s - 6 s) and moves the model.
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: "4500" }, modelSetBoundMs: 3_000 });
    const id = await startWith(h, "claude-code");
    const [first, second] = await Promise.all([h.pool.setModel(id, { model: "model-beta" }), h.pool.setModel(id, { model: "model-gamma" })]);
    const late = "Claude Code did not answer within 3 s, so the model is unchanged: it keeps";
    expect(first).toMatchObject({ ok: false, error: { code: "model-refused", detail: `${late} Default (recommended) and did not switch to Model Beta.` } });
    expect(second).toMatchObject({ ok: false, error: { code: "model-refused", detail: `${late} Model Beta and did not switch to Model Gamma.` } });
  });

  it("an exit during the wait says agent-exited, not the timeout, and nothing follows it", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: NEVER_MS }, modelSetBoundMs: 5_000 });
    const id = await startWith(h, "claude-code");
    const pending = Promise.all([h.pool.setModel(id, { model: "model-beta" }), h.pool.setModel(id, { effort: "high" })]);
    await waitFor(async () => sets(await h!.requests()).length === 1, "the first set in flight");
    process.kill(h.pool.agentPid(id)!);
    const [inFlight, queued] = await pending;
    expect(inFlight).toMatchObject({ ok: false, error: { code: "agent-exited" } });
    expect(queued).toMatchObject({ ok: false, error: { code: "agent-exited" } });
    // Past the bound now: the timer that was set for it says nothing.
    await new Promise((done) => setTimeout(done, 5_500));
    expect(refusals(h, id)).toEqual([]);
    expect(sets(await h.requests())).toHaveLength(1);
  });

  it("at a start, the first prompt goes after the bound, not after the agent's delay", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: NEVER_MS }, modelSetBoundMs: BOUND_MS });
    const began = Date.now();
    const id = await startWith(h, "claude-code", { model: "model-beta" });
    await h.turn(id, "chunks:1");
    expect(Date.now() - began).toBeLessThan(20_000);
    expect(refusals(h, id)).toEqual([{ type: "notice", code: "model-refused", agent: "claude-code", text: timedOut("Default (recommended)", "Model Beta") }]);
    const log = await h.requests();
    expect(log.map((line) => line.method).indexOf("session/prompt")).toBeGreaterThan(log.findIndex(isSet));
    // The agent did not say no: the entry keeps the start's choice for the next opening (the effort it
    // did not ask for is what the agent reported); the store is untouched.
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "default" });
    expect((await h.models.read())["claude-code"]?.choice).toBeUndefined();
  });

  it("at a resume, the first prompt goes after the bound, not after the agent's delay", async () => {
    h = await poolHarness({ env: { FAKE_ACP_MODELS: "config", FAKE_ACP_SET_DELAY_MS: NEVER_MS }, modelSetBoundMs: BOUND_MS });
    const id = await startWith(h, "claude-code");
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");
    await waitFor(async () => (await h!.index.get(id))?.lease === undefined, "the lease cleared");
    const entry = (await h.index.get(id))!;
    await h.index.put({ ...entry, model: { model: "model-beta" } });

    const began = Date.now();
    await h.turn(id, "chunks:1", 20_000);
    expect(Date.now() - began).toBeLessThan(20_000);
    const log = await h.requests();
    const opening = log.map((line) => line.method).lastIndexOf("session/load");
    expect(log.slice(opening).map((line) => line.method)).toEqual(["session/load", "session/set_mode", "session/set_config_option", "session/prompt"]);
    expect(refusals(h, id)).toEqual([{ type: "notice", code: "model-refused", agent: "claude-code", text: timedOut("Default (recommended)", "Model Beta") }]);
    // The agent did not say no: the entry keeps the remembered choice (the effort it names none of is
    // what the agent reported), and the next resume asks again.
    expect((await h.index.get(id))?.model).toEqual({ model: "model-beta", effort: "default" });
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the second idle stop");
    expect(await h.pool.open(id)).toEqual({ ok: true });
    const again = await h.requests();
    expect(again.slice(again.map((line) => line.method).lastIndexOf("session/load")).filter(isSet)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ configId: "model", value: "model-beta" }) }),
    ]);
  });
});
