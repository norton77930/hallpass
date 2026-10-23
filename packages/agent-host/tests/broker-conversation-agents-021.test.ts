import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import { conversationEventSchema } from "@hallpass/contracts";
import { launchSettings } from "../src/broker/agent-launch-settings.js";
import { Conversation, permissionRuleKey, spawnAgentProcess } from "../src/broker/conversation.js";
import {
  fakeAgentSpec,
  isAlive,
  killLoggedPids,
  makeTempDir,
  poolHarness,
  readFakeLog,
  removeDir,
  requests,
  sleep,
  TestClock,
  turnEnded,
  waitFor,
  type FakeLogLine,
} from "./conversation-harness.js";

/**
 * 021 S2 - Hermes and DeepSeek in the broker (R-351..R-354, R-356; FR-353..FR-357). The fake agent's
 * `hermes` and `deepseek` scenarios answer the way the measured agents do (T653): Hermes sets its own
 * mode after `session/new` and asks with a title and kind; DeepSeek has no ACP modes - its permission
 * mode is the launch environment - and asks with nothing but the id of an action it announced before.
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
const answers = (log: FakeLogLine[]) => log.filter((line) => line.event === "permission-answer");
const starts = (log: FakeLogLine[]) => log.filter((line) => line.event === "start");

async function cardFor(harness: Harness, id: string, from = 0) {
  let requestId = "";
  await waitFor(() => {
    const card = harness.rec.of(id).slice(from).find((entry) => entry.event.type === "permission");
    if (card?.event.type === "permission") requestId = card.event.requestId;
    return requestId !== "";
  }, "a permission card");
  const card = harness.rec.of(id).find((entry) => entry.event.type === "permission" && entry.event.requestId === requestId)!.event;
  if (card.type !== "permission") throw new Error("not a card");
  return card;
}

/** Sends without waiting for the end of the turn. */
async function sendOnly(harness: Harness, id: string, text: string): Promise<number> {
  const from = harness.rec.of(id).length;
  const sent = await harness.pool.send(id, text);
  expect(sent.ok).toBe(true);
  return from;
}

async function untilTurnEnds(harness: Harness, id: string, from: number) {
  await waitFor(() => turnEnded(harness.rec.of(id).slice(from), id), "the end of the turn");
}

describe("T654 Hermes strict", () => {
  it("starts with the managed layer named in its environment, sets `default`, asks before an edit; Reject answers `deny`", async () => {
    h = await poolHarness();
    const id = await h.start("hermes");
    expect(h.pool.state(id)).toBe("idle");

    const managed = join(h.dataDir, "agents", "hermes", "managed", "strict");
    const log = await h.log();
    expect(starts(log)[0]?.launch).toEqual({ HERMES_MANAGED_DIR: managed });
    expect(await readFile(join(managed, "config.yaml"), "utf8")).toBe(
      "agent:\n  disabled_toolsets: [terminal, code_execution, delegation, browser_vault]\n",
    );
    expect(methods(log)).toEqual(["initialize", "session/new", "session/set_mode"]);
    expect(modeIds(log)).toEqual(["default"]);

    const from = await sendOnly(h, id, "tool:edit");
    const card = await cardFor(h, id, from);
    expect(card).toMatchObject({ kind: "edit", title: "Edit src/app.ts" });
    // The request names the action; what it changes comes from the action Hermes announced.
    expect(card.detail).toMatch(/src\/app\.ts/u);
    expect(card.rejectOnly).toBeUndefined();

    expect((await h.pool.answer(id, card.requestId, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(answers(await h.log())).toMatchObject([{ outcome: "selected", optionId: "deny", optionKind: "reject_once" }]);
  });
});

describe("T655 DeepSeek strict", () => {
  it("starts read-only with telemetry off, never sets a mode; the card shows the announced command and reason; Allow answers `allow-once`", async () => {
    h = await poolHarness();
    const id = await h.start("deepseek");
    expect(h.pool.state(id)).toBe("idle");

    const log = await h.log();
    expect(starts(log)[0]?.launch).toEqual({ DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" });
    expect(methods(log)).toEqual(["initialize", "session/new"]);
    const modes = h.rec.of(id).flatMap((entry) => (entry.event.type === "mode" ? [entry.event] : []));
    expect(modes).toEqual([{ type: "mode", mode: "strict" }]);

    const from = await sendOnly(h, id, "tool:execute");
    const card = await cardFor(h, id, from);
    expect(card.detail).toContain("npm test");
    expect(card.detail).toContain("Run the tests to check the change");
    expect(card.rejectOnly).toBeUndefined();

    expect((await h.pool.answer(id, card.requestId, "allow-once")).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(answers(await h.log())).toMatchObject([{ outcome: "selected", optionId: "allow-once", optionKind: "allow_once" }]);
    expect(methods(await h.log())).not.toContain("session/set_mode");
  });
});

describe("T658 stop while starting (R-354, SC-159)", () => {
  it("kills the starting agent's process tree, ends the start `start-cancelled`, frees the cap slot; nothing is left within 5 s", async () => {
    // Read at each launch: the first start hangs at `session/new` with a child process; later ones do not.
    const env: Record<string, string> = { FAKE_ACP_HANG_AT: "new", FAKE_ACP_SPAWN_CHILD: "1" };
    h = await poolHarness({ cap: 1, env });
    let outcome: Awaited<ReturnType<Harness["pool"]["start"]>> | undefined;
    void h.pool.start("deepseek", { kind: "scratch" }).then((result) => (outcome = result));

    let id = "";
    await waitFor(() => {
      const starting = h!.rec.events.find((entry) => entry.event.type === "state" && entry.event.state === "starting");
      id = starting?.conversationId ?? "";
      return id !== "";
    }, "the starting state");
    await waitFor(async () => (await h!.log()).some((line) => line.event === "hang"), "the agent to hang at session/new");
    const pids = (await h.log()).filter((line) => line.event === "start" || line.event === "child").map((line) => line.pid as number);
    expect(pids).toHaveLength(2);
    expect(h.pool.state(id)).toBe("starting");

    const stoppedAt = Date.now();
    expect(await h.pool.stop(id)).toEqual({ ok: true });
    await waitFor(() => outcome !== undefined, "the start to end", 5_000);
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) expect(outcome.error.code).toBe("start-cancelled");
    await waitFor(() => pids.every((pid) => !isAlive(pid)), "the agent and its child to be gone", 5_000);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);

    const states = h.rec.of(id).flatMap((entry) => (entry.event.type === "state" ? [entry.event] : []));
    expect(states.at(-1)).toEqual({ type: "state", state: "stopped", code: "start-cancelled" });
    for (const entry of h.rec.of(id)) expect(conversationEventSchema.safeParse(entry.event).success).toBe(true);
    // Back to not started: no list entry, no live conversation.
    expect(h.pool.state(id)).toBeUndefined();
    expect(await h.pool.views()).toEqual([]);

    // The slot is free: with a cap of one, the next start goes.
    delete env.FAKE_ACP_HANG_AT;
    delete env.FAKE_ACP_SPAWN_CHILD;
    const next = await h.pool.start("deepseek", { kind: "scratch" });
    expect(next.ok).toBe(true);
  });
});

describe("T660 model unreachable (R-356, FR-355, SC-161)", () => {
  /** A value no redaction pattern knows: only the environment says it is a key. */
  const KEY = "plain7x9k2m";

  it.each([
    ["deepseek", "connect ECONNREFUSED 127.0.0.1:8443 (key {env:DEEPSEEK_API_KEY})", /DeepSeek's own settings/u],
    // T692: the same place the panel names (%LOCALAPPDATA%\hermes, or HERMES_HOME if set).
    ["hermes", "HTTP 401 Unauthorized: the key {env:DEEPSEEK_API_KEY} was refused", /Hermes' own settings \(run `hermes model` in a terminal; they live in %LOCALAPPDATA%\\hermes, or HERMES_HOME if set\)/u],
    ["deepseek", "upstream answered 403 Forbidden", /DeepSeek's own settings/u],
    ["deepseek", "DEEPSEEK_API_KEY is not set", /DeepSeek's own settings/u],
  ] as const)("%s: %s -> agent-model-unreachable, where its setting lives, no value of any variable", async (agent, said, hint) => {
    const lines: string[] = [];
    h = await poolHarness({
      env: { FAKE_ACP_TURN_ERROR: said, DEEPSEEK_API_KEY: KEY },
      log: (code, detail) => lines.push(`${code} ${detail ?? ""}`),
    });
    const id = await h.start(agent);
    await h.turn(id, "fail:turn");

    const notices = h.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));
    expect(notices.map((notice) => notice.code)).toEqual(["agent-model-unreachable"]);
    expect(notices[0]!.text).toMatch(hint);
    expect(notices[0]!.text).not.toMatch(/enter|paste/iu);
    const logged = lines.filter((line) => line.startsWith("conversation.model-unreachable"));
    expect(logged).toHaveLength(1);
    if (said.includes("{env:")) expect(logged[0]).toContain("DEEPSEEK_API_KEY");
    expect(JSON.stringify(h.rec.events)).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("any other turn error stays `turn-failed`", async () => {
    h = await poolHarness({ env: { FAKE_ACP_TURN_ERROR: "the tool crashed" } });
    const id = await h.start("deepseek");
    await h.turn(id, "fail:turn");
    const codes = h.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event.code] : []));
    expect(codes).toEqual(["turn-failed"]);
  });
});

describe("T662 / T663 a launch-time mode change restarts the agent between turns (R-351)", () => {
  const texts = (harness: Harness, id: string) =>
    harness.rec.of(id).flatMap((entry) => (entry.event.type === "text" ? [entry.event.text] : []));
  const modeEvents = (harness: Harness, id: string) =>
    harness.rec.of(id).flatMap((entry) => (entry.event.type === "mode" ? [entry.event] : []));

  it("T662 Hermes strict -> automatic: a new run with the agent-review layer and `accept_edits`, continued with session/load", async () => {
    h = await poolHarness();
    const id = await h.start("hermes");
    await h.turn(id, "hello");

    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });
    expect(h.pool.state(id)).toBe("idle");
    const log = await h.log();
    const runs = starts(log);
    expect(runs).toHaveLength(2);
    expect(isAlive(runs[0]!.pid as number)).toBe(false);
    const managed = join(h.dataDir, "agents", "hermes", "managed", "agent-review");
    expect(runs[1]!.launch).toEqual({ HERMES_MANAGED_DIR: managed });
    expect(await readFile(join(managed, "config.yaml"), "utf8")).toBe("agent:\n  disabled_toolsets: [browser_vault]\n");
    const tail = methods(log).slice(methods(log).lastIndexOf("initialize"));
    expect(tail).toEqual(["initialize", "session/load", "session/set_mode"]);
    expect(modeIds(log)).toEqual(["default", "accept_edits"]);
    expect(modeEvents(h, id).at(-1)).toMatchObject({ type: "mode", mode: "agent-review" });
    expect((await h.index.get(id))?.mode).toBe("agent-review");
    // The replay of the reloaded session is not shown again.
    expect(texts(h, id).join("")).toBe("helloecho:hello");

    await h.turn(id, "again");
    expect(texts(h, id).join("")).toContain("echo:again");
  });

  it("T662 during a turn the change is refused `busy` and nothing restarts", async () => {
    h = await poolHarness();
    const id = await h.start("hermes");
    await sendOnly(h, id, "hang");
    await waitFor(() => h!.pool.state(id) === "running", "the turn to run");
    const refused = await h.pool.setMode(id, "agent-review");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("busy");
    expect(starts(await h.log())).toHaveLength(1);
    expect(modeIds(await h.log())).toEqual(["default"]);
  });

});

/**
 * D-021-16 (R-359): DeepSeek keeps the permission mode its session was created with - a resumed
 * session ignores the launch environment - so its mode is fixed once the conversation has started.
 * It is chosen at the start instead, and a resume keeps it.
 */
describe("D-021-16 DeepSeek's mode is fixed once its conversation has started", () => {
  const modeEvents = (harness: Harness, id: string) =>
    harness.rec.of(id).flatMap((entry) => (entry.event.type === "mode" ? [entry.event] : []));

  it("a mode change of a started conversation is refused `mode-fixed`, running or stopped, and the agent is never restarted", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start("deepseek");
    await h.turn(id, "hello");

    const refused = await h.pool.setMode(id, "agent-review");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("mode-fixed");
    expect(h.pool.state(id)).toBe("idle");
    expect(starts(await h.log())).toHaveLength(1);
    expect((await h.index.get(id))?.mode).toBe("strict");
    // The same mode is no change.
    expect(await h.pool.setMode(id, "strict")).toEqual({ ok: true });
    await h.pool.shutdown();

    // Stopped but resumable: still the conversation's fixed mode, not "the agent is not running".
    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    const stopped = await extra.pool.setMode(id, "agent-review");
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.error.code).toBe("mode-fixed");
    expect(starts(await extra.log())).toHaveLength(1);
  });

  it("chosen at the start: launched with the folder sandbox, shown as automatic, and a resume keeps it", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const started = await h.pool.start("deepseek", { kind: "scratch" }, undefined, "agent-review");
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    const id = started.value!.conversationId;
    expect(starts(await h.log()).map((run) => run.launch)).toEqual([
      { DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" },
    ]);
    expect(modeEvents(h, id)).toEqual([{ type: "mode", mode: "agent-review" }]);
    expect((await h.index.get(id))?.mode).toBe("agent-review");
    await h.turn(id, "hello");
    await h.pool.shutdown();

    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await extra.pool.open(id)).ok).toBe(true);
    expect(starts(await extra.log()).at(-1)?.launch).toEqual({ DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" });
    expect(modeEvents(extra, id).at(-1)).toMatchObject({ type: "mode", mode: "agent-review" });
    expect((await extra.index.get(id))?.mode).toBe("agent-review");
    expect((await extra.pool.views()).find((view) => view.conversationId === id)?.mode).toBe("agent-review");
    for (const entry of extra.rec.of(id)) expect(conversationEventSchema.safeParse(entry.event).success).toBe(true);
  });

  it("the conversation itself refuses a change once it has a session, so a caller past the pool cannot restart DeepSeek in another mode", async () => {
    const dir = await makeTempDir("hallpass-conv-");
    const logPath = join(dir, "fake-acp.log");
    const conversation = new Conversation("fixed-1", "deepseek", { clock: new TestClock(), onEvent: () => undefined });
    const launch = (mode: "strict" | "agent-review") => ({
      spec: fakeAgentSpec({ FAKE_ACP_LOG: logPath, FAKE_ACP_SCENARIO: "deepseek", ...launchSettings("deepseek", mode, dir).env }),
      versions: { agent: "deepseek" as const, tested: "1.0.0", found: "1.0.0" },
    });
    try {
      expect((await conversation.start({ cwd: dir, ...launch("strict") })).ok).toBe(true);

      const restarted = await conversation.restart("agent-review", launch("agent-review"));
      expect(restarted.ok).toBe(false);
      if (!restarted.ok) expect(restarted.error.code).toBe("mode-fixed");
      const switched = await conversation.setMode("agent-review");
      expect(switched.ok).toBe(false);
      if (!switched.ok) expect(switched.error.code).toBe("mode-fixed");

      expect(conversation.mode).toBe("strict");
      expect(conversation.state).toBe("idle");
      expect(starts(await readFakeLog(logPath)).map((run) => run.launch)).toEqual([
        { DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" },
      ]);
    } finally {
      await conversation.close("gone");
      await killLoggedPids(logPath);
      await removeDir(dir);
    }
  });

  it("a switch that arrives while the first start waits (before the agent is spawned) is refused; the start goes on in its chosen mode, once", async () => {
    h = await poolHarness();
    let consent!: () => void;
    const consented = new Promise<void>((done) => (consent = done));
    let outcome: Awaited<ReturnType<Harness["pool"]["start"]>> | undefined;
    const mayStart = async () => {
      await consented;
      return { ok: true as const };
    };
    void h.pool.start("deepseek", { kind: "scratch" }, mayStart, "agent-review").then((result) => (outcome = result));
    let id = "";
    await waitFor(async () => {
      id = (await h!.pool.views())[0]?.conversationId ?? "";
      return id !== "";
    }, "the start to be listed");
    expect(h.pool.state(id)).not.toBe("idle");
    expect(starts(await h.log())).toEqual([]);

    const refused = await h.pool.setMode(id, "strict");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("mode-fixed");
    // The mode the start carries is no change.
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });

    consent();
    await waitFor(() => outcome !== undefined, "the start to end");
    expect(outcome?.ok).toBe(true);
    expect(starts(await h.log()).map((run) => run.launch)).toEqual([
      { DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" },
    ]);
    expect(modeEvents(h, id)).toEqual([{ type: "mode", mode: "agent-review" }]);
    expect((await h.index.get(id))?.mode).toBe("agent-review");
  });

  it("a switch that arrives while the spawned agent is still starting is refused; no second run is started", async () => {
    h = await poolHarness({ env: { FAKE_ACP_HANG_AT: "new" } });
    let outcome: Awaited<ReturnType<Harness["pool"]["start"]>> | undefined;
    void h.pool.start("deepseek", { kind: "scratch" }, undefined, "agent-review").then((result) => (outcome = result));
    await waitFor(async () => (await h!.log()).some((line) => line.event === "hang"), "the agent to hang at session/new");
    const id = (await h.pool.views())[0]!.conversationId;
    expect(h.pool.state(id)).toBe("starting");

    const refused = await h.pool.setMode(id, "strict");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("mode-fixed");
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });
    expect(h.pool.state(id)).toBe("starting");
    expect(starts(await h.log()).map((run) => run.launch)).toEqual([
      { DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" },
    ]);

    expect(await h.pool.stop(id)).toEqual({ ok: true });
    await waitFor(() => outcome !== undefined, "the start to end", 5_000);
  });
});

/**
 * D-021-16 follow-up (FR-361): the mode chosen before the first message is the mode of the first
 * start, for every agent. The panel used to start strict and then send `set-mode` and the first
 * message together; the broker runs commands as they come, so Hermes' restart was refused `busy` by
 * the turn of that message (the conversation stayed strict) and Claude's reload refused the message.
 */
describe("FR-361 a new conversation starts in the mode chosen before its first message", () => {
  const modeEvents = (harness: Harness, id: string) =>
    harness.rec.of(id).flatMap((entry) => (entry.event.type === "mode" ? [entry.event] : []));
  const managed = (harness: Harness) => ({ HERMES_MANAGED_DIR: join(harness.dataDir, "agents", "hermes", "managed", "agent-review") });

  it.each([
    ["claude-code", ["auto"], () => ({})],
    ["codex", ["agent"], () => ({})],
    ["hermes", ["accept_edits"], managed],
    ["deepseek", [], () => ({ DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" })],
  ] as const)("%s: one run, in automatic from its start, reported and listed as automatic; the first message goes", async (agent, ids, launch) => {
    h = await poolHarness();
    const started = await h.pool.start(agent, { kind: "scratch" }, undefined, "agent-review");
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    const id = started.value!.conversationId;
    const log = await h.log();
    expect(starts(log)).toHaveLength(1);
    expect(starts(log)[0]?.launch ?? {}).toEqual(launch(h));
    expect(modeIds(log)).toEqual(ids);
    // No strict rules on Claude's new session in automatic (D-019-12).
    expect(JSON.stringify(requests(log, "session/new")[0]?.params ?? {})).not.toContain("permissions");
    expect(modeEvents(h, id)).toEqual([{ type: "mode", mode: "agent-review" }]);
    expect((await h.index.get(id))?.mode).toBe("agent-review");
    expect((await h.pool.views()).find((view) => view.conversationId === id)?.mode).toBe("agent-review");
    await h.turn(id, "hello");
    expect(starts(await h.log())).toHaveLength(1);
  });
});

/**
 * Coverage (T693 follow-up): the launch settings tests check what Hallpass would pass; these check what
 * every run the panel starts was actually given - each mode, a restart and a continued conversation.
 */
describe("settings every panel run carries (FR-348, FR-352)", () => {
  it("FR-348 every Hermes run has its saved-logins tool off: started strict, started automatic, restarted into another mode", async () => {
    h = await poolHarness();
    const strictId = await h.start("hermes");
    const automatic = await h.pool.start("hermes", { kind: "scratch" }, undefined, "agent-review");
    expect(automatic.ok).toBe(true);
    expect(await h.pool.setMode(strictId, "agent-review")).toEqual({ ok: true });

    const runs = starts(await h.log());
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      const managed = (run.launch as { HERMES_MANAGED_DIR?: string } | undefined)?.HERMES_MANAGED_DIR;
      expect(managed).toBeDefined();
      expect(await readFile(join(managed!, "config.yaml"), "utf8")).toMatch(/disabled_toolsets: \[[^\]]*\bbrowser_vault\b/u);
    }
  });

  it("FR-352 every DeepSeek run has usage reporting off: started strict, started automatic, and each continued", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const strictId = await h.start("deepseek");
    const automatic = await h.pool.start("deepseek", { kind: "scratch" }, undefined, "agent-review");
    if (!automatic.ok) throw new Error(`start failed: ${automatic.error.code}`);
    await h.pool.shutdown();

    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await extra.pool.open(strictId)).ok).toBe(true);
    expect((await extra.pool.open(automatic.value!.conversationId)).ok).toBe(true);

    const runs = starts(await extra.log());
    expect(runs.map((run) => (run.launch as { DSH_PERMISSION_MODE?: string }).DSH_PERMISSION_MODE)).toEqual([
      "read-only",
      "workspace-write",
      "read-only",
      "workspace-write",
    ]);
    for (const run of runs) expect((run.launch as { DSH_TELEMETRY_MODE?: string }).DSH_TELEMETRY_MODE).toBe("DISABLED");
  });
});

describe("FR-356 what Hermes and DeepSeek say they accept reaches the + menu, and the broker holds to it", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  it.each(["hermes", "deepseek"] as const)("%s: pictures yes, the page no, as said at initialize; a page is refused, a file goes", async (agent) => {
    h = await poolHarness();
    const id = await h.start(agent);
    const said = { image: true, context: false };
    expect((await h.pool.views()).find((view) => view.conversationId === id)?.accepts).toEqual(said);
    expect(h.pool.agentAccepts(agent)).toEqual(said);

    const page = "visible words";
    const tab = { url: "https://example.test/a", title: "A page", cut: true };
    expect(
      await h.pool.attach(id, { attachmentId: "t1", index: 0, final: true, kind: "tab", name: "A page", size: page.length, tab, data: b64(page) }),
    ).toEqual({ ok: true });
    const refused = await h.pool.send(id, "see", undefined, undefined, ["t1"]);
    expect(refused.ok ? "ok" : refused.error.code).toBe("attachment-not-accepted");

    expect(await h.pool.attach(id, { attachmentId: "f1", index: 0, final: true, kind: "file", name: "a.txt", size: 1, data: b64("x") })).toEqual({
      ok: true,
    });
    const from = h.rec.events.length;
    expect(await h.pool.send(id, "see", undefined, undefined, ["f1"])).toEqual({ ok: true });
    await waitFor(() => turnEnded(h!.rec.events.slice(from), id), "the end of the turn");
  });
});

describe("T665 reopening an old conversation (R-352, FR-357)", () => {
  const texts = (harness: Harness, id: string) =>
    harness.rec.of(id).flatMap((entry) => (entry.event.type === "text" ? [entry.event.text] : []));

  it("DeepSeek continues with session/resume, nothing replayed, and the conversation is marked `replay: none`", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start("deepseek");
    await h.turn(id, "first");
    expect((await h.pool.views())[0]?.replay).toBeUndefined();
    await h.pool.shutdown();

    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await extra.pool.open(id)).ok).toBe(true);
    const log = await extra.log();
    const tail = methods(log).slice(methods(log).lastIndexOf("initialize"));
    expect(tail).toEqual(["initialize", "session/resume"]);
    expect(texts(extra, id)).toEqual([]);
    const view = (await extra.pool.views()).find((entry) => entry.conversationId === id);
    expect(view).toMatchObject({ state: "idle", replay: "none" });

    await extra.turn(id, "second");
    expect(texts(extra, id).join("")).toBe("secondecho:second");
  });

  it("DeepSeek: an agent that no longer has the session -> cannot-resume, as for a load", async () => {
    h = await poolHarness({ browserRunId: "run-a", store: false });
    const id = await h.start("deepseek");
    await h.pool.shutdown();

    // No transcript store: the next agent process knows no session.
    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b", store: false });
    const opened = await extra.pool.open(id);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("cannot-resume");
    expect((await extra.index.get(id))?.resumable).toBe(false);
    expect(methods(await extra.log())).toContain("session/resume");
  });

  it("Hermes continues with session/load and replays the earlier turns; no `replay: none`", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start("hermes");
    await h.turn(id, "first");
    await h.pool.shutdown();

    extra = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await extra.pool.open(id)).ok).toBe(true);
    const log = await extra.log();
    expect(methods(log).slice(methods(log).lastIndexOf("initialize"))).toEqual(["initialize", "session/load", "session/set_mode"]);
    // Text goes out at most once per 50 ms (R-318): the replayed reply follows the replayed message.
    await waitFor(() => texts(extra!, id).join("") === "firstecho:first", "the replayed turn");
    const view = (await extra.pool.views()).find((entry) => entry.conversationId === id);
    expect(view?.replay).toBeUndefined();
  });
});

describe("R-354 a new conversation is listed while its first start runs", () => {
  it("is in the list as `starting` from the start on; Stop by the listed id cancels it and leaves no entry", async () => {
    let changes = 0;
    h = await poolHarness({ env: { FAKE_ACP_HANG_AT: "new" }, onChange: () => (changes += 1) });
    let outcome: Awaited<ReturnType<Harness["pool"]["start"]>> | undefined;
    void h.pool.start("deepseek", { kind: "scratch" }).then((result) => (outcome = result));
    await waitFor(async () => (await h!.log()).some((line) => line.event === "hang"), "the agent to hang at session/new");

    // The panel knows the conversation only from the list (the overview), not from the start's result.
    expect(changes).toBeGreaterThan(0);
    const views = await h.pool.views();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ agent: "deepseek", folder: { kind: "scratch" }, mode: "strict", state: "starting", resumable: false });
    const id = views[0]!.conversationId;
    const pid = starts(await h.log())[0]!.pid as number;

    expect(await h.pool.stop(id)).toEqual({ ok: true });
    await waitFor(() => outcome !== undefined, "the start to end", 5_000);
    if (outcome?.ok === false) expect(outcome.error.code).toBe("start-cancelled");
    expect(outcome?.ok).toBe(false);
    await waitFor(() => !isAlive(pid), "the agent to be gone", 5_000);
    expect(await h.pool.views()).toEqual([]);
    expect(await h.index.get(id)).toBeUndefined();
    expect(await h.index.list()).toEqual([]);
  });

  it("a first start that fails leaves nothing in the list", async () => {
    h = await poolHarness({ env: { FAKE_ACP_FAIL_AT: "new" } });
    const started = await h.pool.start("deepseek", { kind: "scratch" });
    expect(started.ok).toBe(false);
    expect(await h.pool.views()).toEqual([]);
    expect(await h.index.list()).toEqual([]);
  });

  it("a first start that succeeds is listed once, from the index", async () => {
    h = await poolHarness();
    const id = await h.start("deepseek");
    const views = await h.pool.views();
    expect(views.map((view) => [view.conversationId, view.state, view.resumable])).toEqual([[id, "idle", true]]);
  });
});

describe("installed agents behind a batch file (Hermes' hermes-acp.cmd)", () => {
  it("spawnAgentProcess keeps a verbatim cmd.exe command line as it is, a path with a space included", async () => {
    const dir = await makeTempDir("hallpass-verbatim-");
    try {
      const folder = join(dir, "with space");
      await mkdir(folder);
      const file = join(folder, "agent.cmd");
      await writeFile(file, "@echo off\r\necho arg=%1\r\n", "utf8");
      // As agents.ts builds it for a .cmd: cmd.exe /d /s /c "<file> <args>" with verbatim arguments.
      const child = spawnAgentProcess(
        { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `""${file}" acp"`], env: {}, windowsVerbatimArguments: true },
        dir,
      );
      child.stdin?.end();
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      const code = await new Promise<number | null>((done) => child.once("exit", done));
      expect(out.trim()).toBe("arg=acp");
      expect(code).toBe(0);
    } finally {
      await removeDir(dir);
    }
  });
});

describe("T656 reject-only cards", () => {
  it("an action never announced gives a reject-only card that no conversation rule answers and no allow can answer", async () => {
    h = await poolHarness();
    const id = await h.start("deepseek");

    // An "allow for this conversation" rule from an announced action of the same kind.
    const first = await sendOnly(h, id, "tool:execute");
    const announced = await cardFor(h, id, first);
    expect((await h.pool.answer(id, announced.requestId, "allow-conversation")).ok).toBe(true);
    await untilTurnEnds(h, id, first);

    const second = await sendOnly(h, id, "tool:unannounced");
    const card = await cardFor(h, id, second);
    expect(card.rejectOnly).toBe(true);
    expect(conversationEventSchema.safeParse(card).success).toBe(true);
    expect(h.pool.state(id)).toBe("waiting-for-owner");

    for (const answer of ["allow-once", "allow-conversation"] as const) {
      const refused = await h.pool.answer(id, card.requestId, answer);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("invalid-command");
    }
    await sleep(100);
    expect(answers(await h.log())).toHaveLength(1);
    expect(h.pool.state(id)).toBe("waiting-for-owner");

    expect((await h.pool.answer(id, card.requestId, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, second);
    expect(answers(await h.log()).map((answer) => answer.optionId)).toEqual(["allow-once", "reject-once"]);
  });
});

describe("T668 review: a DeepSeek action without a name gets no conversation rule (R-317)", () => {
  /** The card of the turn sent at `from`, or undefined once that turn ended without one. */
  async function cardOrEnd(harness: Harness, id: string, from: number) {
    await waitFor(
      () =>
        harness.rec.of(id).slice(from).some((entry) => entry.event.type === "permission") ||
        turnEnded(harness.rec.of(id).slice(from), id),
      "a card or the end of the turn",
    );
    const card = harness.rec.of(id).slice(from).find((entry) => entry.event.type === "permission")?.event;
    return card?.type === "permission" ? card : undefined;
  }

  const byRule = (harness: Harness, id: string, from: number) =>
    harness.rec.of(id).slice(from).some((entry) => entry.event.type === "tool" && entry.event.byRule === true);

  it("kind `other` with neither a tool name nor a title forms no rule key; named ones keep theirs", () => {
    expect(permissionRuleKey({ toolCallId: "a", kind: "other", title: "" })).toBeUndefined();
    expect(permissionRuleKey({ toolCallId: "b", kind: "other", title: "   " })).toBeUndefined();
    expect(permissionRuleKey({ toolCallId: "c", kind: "other" })).toBeUndefined();
    expect(permissionRuleKey({ toolCallId: "d", kind: "other", title: "hallpass - read_page (MCP)" })).toBe("other:hallpass - read_page (MCP)");
    expect(permissionRuleKey({ toolCallId: "e", kind: "other", title: "", _meta: { claudeCode: { toolName: "mcp__x__y" } } })).toBe(
      "other:mcp__x__y",
    );
    expect(permissionRuleKey({ toolCallId: "f", kind: "execute", title: "" })).toBe("execute");
  });

  it("allow for this conversation on `tool:execute` allows that one action; a later `tool:edit` still asks and nothing is answered for the owner", async () => {
    h = await poolHarness();
    const id = await h.start("deepseek");
    const first = await sendOnly(h, id, "tool:execute");
    const card = await cardFor(h, id, first);
    expect(card).toMatchObject({ kind: "other", title: "" });
    expect((await h.pool.answer(id, card.requestId, "allow-conversation")).ok).toBe(true);
    await untilTurnEnds(h, id, first);

    const second = await sendOnly(h, id, "tool:edit");
    const next = await cardOrEnd(h, id, second);
    expect(next).toBeDefined();
    expect(byRule(h, id, second)).toBe(false);
    expect(answers(await h.log())).toHaveLength(1);
    expect(h.pool.state(id)).toBe("waiting-for-owner");
    expect((await h.pool.answer(id, next!.requestId, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, second);
    expect(answers(await h.log()).map((answer) => answer.optionId)).toEqual(["allow-once", "reject-once"]);
  });
});

describe("T668 review: Stop on a listed first start that waits for its slot (R-354)", () => {
  it("cap full, the victim slow to close: Stop by the listed id ends the start `start-cancelled`; no agent is spawned and nothing is indexed", async () => {
    let first = true;
    h = await poolHarness({
      cap: 1,
      // The victim ignores the end of its input, so its close waits out the 3 s stop bound.
      spawnAgent: (spec, cwd) => {
        const child = spawnAgentProcess(spec, cwd);
        const input = child.stdin;
        if (first && input !== null) {
          first = false;
          input.end = (() => input) as typeof input.end;
        }
        return child;
      },
    });
    const victim = await h.start("deepseek");
    expect(starts(await h.log())).toHaveLength(1);

    let outcome: Awaited<ReturnType<Harness["pool"]["start"]>> | undefined;
    void h.pool.start("deepseek", { kind: "scratch" }).then((result) => (outcome = result));
    let id = "";
    await waitFor(async () => {
      id = (await h!.pool.views()).find((view) => view.conversationId !== victim)?.conversationId ?? "";
      return id !== "";
    }, "the new start to be listed");
    // Admission is still waiting for the victim to close.
    expect(starts(await h.log())).toHaveLength(1);

    expect(await h.pool.stop(id)).toEqual({ ok: true });
    await waitFor(() => outcome !== undefined, "the start to end", 10_000);
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) expect(outcome.error.code).toBe("start-cancelled");
    expect(starts(await h.log())).toHaveLength(1);
    expect(h.pool.state(id)).toBeUndefined();
    expect(await h.index.get(id)).toBeUndefined();
    expect((await h.pool.views()).map((view) => view.conversationId)).not.toContain(id);
  });
});

describe("T668 review: an ordinary turn error shows no value of any variable (SC-161)", () => {
  it("`turn-failed` and the broker log name the variable, never its value", async () => {
    const VALUE = "plain7x9k2m";
    const lines: string[] = [];
    h = await poolHarness({
      env: { FAKE_ACP_TURN_ERROR: "the tool crashed reading {env:HALLPASS_TEST_SECRET}", HALLPASS_TEST_SECRET: VALUE },
      log: (code, detail) => lines.push(`${code} ${detail ?? ""}`),
    });
    const id = await h.start("deepseek");
    await h.turn(id, "fail:turn");
    const notices = h.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));
    expect(notices.map((notice) => notice.code)).toEqual(["turn-failed"]);
    expect(notices[0]!.text).toContain("HALLPASS_TEST_SECRET");
    expect(JSON.stringify(h.rec.events)).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain(VALUE);
  });
});

describe("T692 re-review: a failed mode reset shows no value of any variable (SC-161)", () => {
  it("`mode-reset-failed` names the variable, never its value", async () => {
    const VALUE = "plain7x9k2m";
    const harness = await poolHarness({
      env: { FAKE_ACP_RESET_ERROR: "mode locked by key {env:HALLPASS_TEST_SECRET}", HALLPASS_TEST_SECRET: VALUE },
    });
    h = harness;
    const id = await harness.start("claude-code");
    await harness.turn(id, "drift:auto chunks:1");
    await vi.waitFor(() => {
      const codes = harness.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event.code] : []));
      expect(codes).toContain("mode-reset-failed");
    });
    const notice = harness.rec.of(id).flatMap((entry) => (entry.event.type === "notice" && entry.event.code === "mode-reset-failed" ? [entry.event] : []))[0]!;
    expect(notice.text).toContain("HALLPASS_TEST_SECRET");
    expect(JSON.stringify(h.rec.events)).not.toContain(VALUE);
  });
});

describe("T692 review: a start that fails shows no value of any variable, and a 401 is the model (SC-161, R-356)", () => {
  const VALUE = "plain7x9k2m";
  /** The agent's own error carries the value; only the launch environment says it is one. */
  const failingWith = (step: "initialize" | "new", message: string) => ({
    env: { HALLPASS_TEST_SECRET: VALUE },
    spawnAgent: (spec: Parameters<typeof spawnAgentProcess>[0], cwd: string) =>
      spawnAgentProcess({ ...spec, env: { ...spec.env, FAKE_ACP_FAIL_AT: step, FAKE_ACP_FAIL_MESSAGE: message } }, cwd),
  });

  it("a 401 at session/new is agent-model-unreachable with where the agent's setting lives, the variable named, never its value", async () => {
    const lines: string[] = [];
    h = await poolHarness({ ...failingWith("new", `HTTP 401 Unauthorized: key ${VALUE} refused`), log: (code, detail) => lines.push(`${code} ${detail ?? ""}`) });
    const started = await h.pool.start("deepseek", { kind: "scratch" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("agent-model-unreachable");
    expect(started.error.detail).toMatch(/DeepSeek's own settings/u);
    expect(started.error.detail).toContain("%HALLPASS_TEST_SECRET%");
    expect(JSON.stringify(started)).not.toContain(VALUE);
    expect(JSON.stringify(h.rec.events)).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain(VALUE);
    expect(await h.pool.views()).toEqual([]);
  });

  it("any other start failure of another version keeps its version message, with the variable named instead of its value", async () => {
    h = await poolHarness({ ...failingWith("initialize", `the adapter crashed reading ${VALUE}`), foundVersion: "2.0.0" });
    const started = await h.pool.start("hermes", { kind: "scratch" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("agent-version");
    expect(started.error.detail).toContain("Tested with Hermes 1.0.0, found 2.0.0.");
    expect(started.error.detail).toContain("%HALLPASS_TEST_SECRET%");
    expect(JSON.stringify(started)).not.toContain(VALUE);
  });

  it("the same failure of the tested version is no version problem: the start failure with the agent's words, still without the value", async () => {
    h = await poolHarness(failingWith("initialize", `the adapter crashed reading ${VALUE}`));
    const started = await h.pool.start("hermes", { kind: "scratch" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("agent-exited");
    expect(started.error.detail).toMatch(/^Hermes 1\.0\.0 could not start\. The agent said \(initialize\): /u);
    expect(started.error.detail).not.toMatch(/Tested with/u);
    expect(started.error.detail).toContain("%HALLPASS_TEST_SECRET%");
    expect(JSON.stringify(started)).not.toContain(VALUE);
  });
});

describe("R-358: a start failure of the tested version is not called a version problem (owner's live run)", () => {
  it("DeepSeek closing the connection at initialize is a start failure, not agent-version", async () => {
    h = await poolHarness({ env: { FAKE_ACP_EXIT_AT: "initialize" } });
    const started = await h.pool.start("deepseek", { kind: "scratch" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("agent-exited");
    expect(started.error.detail).toMatch(/^DeepSeek 1\.0\.0 could not start\. The agent said \(initialize\): \S/u);
    expect(await h.pool.views()).toEqual([]);
  });

  it("Hermes without a provider at session/new is agent-model-unreachable, with the agent's own words", async () => {
    const message = "Internal error: Hermes is not connected to any AI provider yet. Run `hermes model` to choose a provider and model.";
    // The message goes to the fake agent alone: in the harness environment it would be scrubbed as a value (SC-161).
    h = await poolHarness({
      spawnAgent: (spec, cwd) => spawnAgentProcess({ ...spec, env: { ...spec.env, FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: message } }, cwd),
    });
    const started = await h.pool.start("hermes", { kind: "scratch" });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("agent-model-unreachable");
    expect(started.error.detail).toMatch(/^Hermes could not reach its model\. Check Hermes' own settings \(run `hermes model` in a terminal/u);
    expect(started.error.detail).toContain("The agent said (session/new): Internal error: Hermes is not connected to any AI provider yet.");
  });
});
