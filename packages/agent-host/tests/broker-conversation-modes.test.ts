import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import { conversationEventSchema, type ConversationAgent } from "@hallpass/contracts";
import { MODE_ALLOW_LIST } from "../src/broker/conversation.js";
import { poolHarness, requests, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 019/T535 - modes (R-316, FR-289, FR-292). Strict is set *and confirmed* after every
 * `session/new` and `session/load` - the idle resume included - before the owner's first message
 * goes out; the panel's two modes map to an allow-list per agent; and any mode change the owner did
 * not cause, inside the allow-list or not, cancels what is pending, puts the owner's mode back and
 * says so. The agent is the fake ACP agent as a real stdio process.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;
let extra: Harness | undefined;

afterEach(async () => {
  await extra?.cleanup();
  await h?.cleanup();
  h = undefined;
  extra = undefined;
});

const methods = (log: FakeLogLine[]) => log.filter((line) => line.method !== undefined).map((line) => line.method);
const modeIds = (log: FakeLogLine[]) => requests(log, "session/set_mode").map((line) => line.params?.modeId);
const modeEvents = (harness: Harness, id: string) =>
  harness.rec.of(id).flatMap((entry) => (entry.event.type === "mode" ? [entry.event] : []));

describe("T535 strict before the first prompt", () => {
  it.each([
    ["claude-code", "default"],
    ["codex", "read-only"],
  ] as const)("new (%s): set_mode %s is sent and confirmed before session/prompt", async (agent, strictId) => {
    h = await poolHarness();
    const id = await h.start(agent);

    // Confirmed at start: the conversation is idle in strict, and says so.
    expect(h.pool.state(id)).toBe("idle");
    expect(modeEvents(h, id)).toEqual([{ type: "mode", mode: "strict" }]);

    await h.turn(id, "hello");
    const log = await h.log();
    // T566 (R-322): a new Codex session's first input is the broker's `/rename`, also after strict.
    const prompts = agent === "codex" ? ["session/prompt", "session/prompt"] : ["session/prompt"];
    expect(methods(log)).toEqual(["initialize", "session/new", "session/set_mode", ...prompts]);
    expect(modeIds(log)).toEqual([strictId]);
  });

  it("load: a conversation opened from the list is put back to strict before its first prompt", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start("claude-code");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    await h.turn(id, "first");
    await h.pool.shutdown();

    // Another broker (the next browser run) opens it from the shared index.
    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    const opened = await extra.pool.open(id);
    expect(opened.ok).toBe(true);
    await extra.turn(id, "second");

    const log = await extra.log();
    const tail = methods(log).slice(methods(log).lastIndexOf("initialize"));
    expect(tail).toEqual(["initialize", "session/load", "session/set_mode", "session/prompt"]);
    expect(modeIds(log).at(-1)).toBe("default");
    expect(modeEvents(extra, id)[0]).toEqual({ type: "mode", mode: "strict" });
  });

  it("idle resume: after the 10-minute stop the next message loads, sets strict, then prompts", async () => {
    h = await poolHarness();
    const id = await h.start("codex");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    await h.turn(id, "first");

    h.clock.advance(10 * 60_000);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");

    await h.turn(id, "second");
    const log = await h.log();
    const tail = methods(log).slice(methods(log).lastIndexOf("initialize"));
    expect(tail).toEqual(["initialize", "session/load", "session/set_mode", "session/prompt"]);
    expect(modeIds(log)).toEqual(["read-only", "agent", "read-only"]);
    expect(modeEvents(h, id).at(-1)).toEqual({ type: "mode", mode: "strict" });
  });

  it("an agent whose modes lack the strict one is refused before any prompt", async () => {
    // A Codex-shaped mode set under the Claude agent: there is no `default` to set.
    h = await poolHarness({ env: { FAKE_ACP_SCENARIO: "codex" } });
    const started = await h.pool.start("claude-code", { kind: "scratch" });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe("agent-version");
    expect(methods(await h.log())).not.toContain("session/prompt");
  });
});

describe("T535 allow-list", () => {
  it("maps strict / agent-review to Claude default/auto and Codex read-only/agent, nothing else", () => {
    expect(MODE_ALLOW_LIST).toEqual({
      "claude-code": { strict: "default", "agent-review": "auto" },
      codex: { strict: "read-only", "agent-review": "agent" },
      // 021 T657 (R-351): from the agent descriptions - Hermes' own modes (never `dont_ask`); DeepSeek
      // has no ACP modes, its mode is the launch environment, so nothing is ever sent to it.
      hermes: { strict: "default", "agent-review": "accept_edits" },
      deepseek: {},
    });
  });

  it.each([
    ["claude-code", ["default", "auto", "default"]],
    ["codex", ["read-only", "agent", "read-only"]],
  ] as const)("set-mode on %s sends only allow-listed ids", async (agent: Extract<ConversationAgent, "claude-code" | "codex">, expected) => {
    h = await poolHarness();
    const id = await h.start(agent);
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    expect((await h.pool.setMode(id, "strict")).ok).toBe(true);
    expect(modeIds(await h.log())).toEqual(expected);
    expect(modeEvents(h, id).map((event) => event.mode)).toEqual(["strict", "agent-review", "strict"]);
    // Nothing the panel receives can name an agent mode id: every event is a contract event.
    for (const entry of h.rec.of(id)) expect(conversationEventSchema.safeParse(entry.event).success).toBe(true);
  });
});

/**
 * T542a / D-019-12 (R-317 "Measured in S4"): Claude's `default` does not ask for tools the owner's
 * own settings allow, so in strict the broker adds conversation-scoped ask rules through `_meta` on
 * `session/new` and `session/load`. The agent-review mode cannot keep them (they make `auto` ask too),
 * so a switch reloads the session without them, and back to strict reloads it with them. Codex needs
 * none of this: its `read-only` asked as specified.
 */
describe("T542a strict ask rules (D-019-12)", () => {
  const ASK = { claudeCode: { options: { settings: { permissions: { ask: ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell"] } } } } };
  const metas = (log: FakeLogLine[]) =>
    log.filter((line) => line.method === "session/new" || line.method === "session/load").map((line) => [line.method, line.params?.meta]);
  const afterStart = (log: FakeLogLine[]) => methods(log).slice(methods(log).indexOf("session/set_mode") + 1);

  it("claude-code: session/new in strict carries the ask rules", async () => {
    h = await poolHarness();
    await h.start("claude-code");
    expect(metas(await h.log())).toEqual([["session/new", ASK]]);
  });

  it("claude-code: agent-review reloads without them, strict reloads with them and is confirmed before the next prompt", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    await h.turn(id, "chunks:2");
    const textBefore = h.rec.of(id).filter((entry) => entry.event.type === "text").length;

    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    expect((await h.pool.setMode(id, "strict")).ok).toBe(true);
    await h.turn(id, "hello");

    const log = await h.log();
    expect(metas(log)).toEqual([
      ["session/new", ASK],
      ["session/load", null],
      ["session/load", ASK],
    ]);
    expect(afterStart(log)).toEqual([
      "session/prompt",
      "session/load",
      "session/set_mode",
      "session/load",
      "session/set_mode",
      "session/prompt",
    ]);
    expect(modeIds(log)).toEqual(["default", "auto", "default"]);
    // Each switch says the conversation was reloaded; the reload's replay is not shown again.
    const [, toReview, toStrict] = modeEvents(h, id);
    expect(toReview).toMatchObject({ mode: "agent-review", note: expect.stringMatching(/reloaded/u) });
    expect(toStrict).toMatchObject({ mode: "strict", note: expect.stringMatching(/reloaded/u) });
    const owner = h.rec.of(id).flatMap((entry) => (entry.event.type === "text" && entry.event.role === "owner" ? [entry.event.text] : []));
    expect(owner).toEqual(["chunks:2", "hello"]);
    expect(h.rec.of(id).filter((entry) => entry.event.type === "text").length).toBe(textBefore + 2);
    for (const entry of h.rec.of(id)) expect(conversationEventSchema.safeParse(entry.event).success).toBe(true);
  });

  it("claude-code: a resume after the idle stop loads with the ask rules, whatever mode it had", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    await h.turn(id, "first");
    h.clock.advance(10 * 60_000);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");

    await h.turn(id, "second");
    expect(metas(await h.log()).at(-1)).toEqual(["session/load", ASK]);
  });

  it("claude-code: a switch while a turn runs is refused busy and reloads nothing", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    expect((await h.pool.send(id, "hang")).ok).toBe(true);
    await waitFor(async () => requests(await h!.log(), "session/prompt").length === 1, "the prompt");

    const switched = await h.pool.setMode(id, "agent-review");
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error.code).toBe("busy");
    expect((await h.pool.views()).find((view) => view.conversationId === id)?.mode).toBe("strict");
    expect(requests(await h.log(), "session/load")).toEqual([]);
    expect(modeIds(await h.log())).toEqual(["default"]);
  });

  it("codex: never carries _meta and switches with set_mode alone", async () => {
    h = await poolHarness();
    const id = await h.start("codex");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    expect((await h.pool.setMode(id, "strict")).ok).toBe(true);
    const log = await h.log();
    expect(metas(log)).toEqual([["session/new", null]]);
    expect(modeEvents(h, id).every((event) => event.note === undefined)).toBe(true);
  });
});

describe("T535 mode drift", () => {
  it("an agent switching itself inside the list (strict -> auto) is cancelled, reset and told", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    await h.turn(id, "drift:auto chunks:1");

    const log = await h.log();
    expect(modeIds(log)).toEqual(["default", "default"]);
    expect(methods(log)).toContain("session/cancel");
    const last = modeEvents(h, id).at(-1)!;
    expect(last.mode).toBe("strict");
    expect(last.note).toMatch(/auto/u);
  });

  it("an agent switching itself outside the list (auto -> bypassPermissions) gets the owner's mode back", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    await h.turn(id, "drift:bypassPermissions");

    expect(modeIds(await h.log())).toEqual(["default", "auto", "auto"]);
    const last = modeEvents(h, id).at(-1)!;
    expect(last).toMatchObject({ mode: "agent-review" });
    expect(last.note).toMatch(/bypassPermissions/u);
  });

  it("the action pending behind a drift is cancelled, never allowed", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    await h.turn(id, "drift:auto tool:edit");

    const log = await h.log();
    const answers = log.filter((line) => line.event === "permission-answer");
    for (const answer of answers) expect(answer.outcome).toBe("cancelled");
    // The edit never ran.
    const text = h.rec.of(id).flatMap((entry) => (entry.event.type === "text" ? [entry.event.text] : [])).join("");
    expect(text).not.toMatch(/done:/u);
    // A card raised in the race is closed as cancelled, and no tool of the turn finished.
    const raised = h.rec.of(id).flatMap((entry) => (entry.event.type === "permission" ? [entry.event.requestId] : []));
    for (const requestId of raised) {
      expect(h.rec.of(id).map((entry) => entry.event)).toContainEqual({ type: "permission-closed", requestId, answer: "cancelled" });
    }
    expect(h.rec.of(id).some((entry) => entry.event.type === "tool" && entry.event.status === "done")).toBe(false);
    expect(h.pool.state(id)).toBe("idle");
  });

  it("a mode update to the mode the owner chose is no drift", async () => {
    h = await poolHarness();
    const id = await h.start("claude-code");
    await h.turn(id, "drift:default chunks:1");
    const log = await h.log();
    expect(modeIds(log)).toEqual(["default"]);
    expect(methods(log)).not.toContain("session/cancel");
    expect(modeEvents(h, id)).toEqual([{ type: "mode", mode: "strict" }]);
  });
});
