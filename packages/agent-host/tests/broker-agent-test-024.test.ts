import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentTestResultSchema, conversationOverviewFrameSchema, type ConversationAgent, type ConversationAgentAvailability } from "@hallpass/contracts";
import { AGENT_TEST_BOUND_MS, AGENT_TEST_PROMPT, createAgentTestRunner, type AgentTestRunnerOptions } from "../src/broker/agent-test.js";
import { createCommandHandler, type ConsentStore } from "../src/broker/commands.js";
import type { FolderActions } from "../src/broker/folders.js";
import { lastTestPath, readLastTest } from "../src/broker/shared-agent-state.js";
import type { UserEnvironmentPorts } from "../src/broker/user-environment.js";
import {
  NO_USER_ENVIRONMENT,
  TestClock,
  fakeAgentSpec,
  fakeBrowserAccess,
  isAlive,
  killLoggedPids,
  poolHarness,
  readFakeLog,
  requests,
  sleep,
  waitFor,
} from "./conversation-harness.js";

/**
 * 024 T766 (R-379, D-024-10, FR-381): the settings page's Test - one prompt to a copy of the agent
 * that is not a conversation: outside the pool (the running cap, the index and the browser tokens
 * untouched), strict, in `agent-tests\<id>\`, within 90 s; its process and folder are gone before
 * `last-test.json` says how it went - passed, partial (the model answered, the browser tools are
 * missing) or failed, with the start code, the model's time or reason, the browser tools and, for
 * Hermes, the key variable's name.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const lines = async (path: string) => (await readFile(path, "utf8").catch(() => "")).split(/\r?\n/u).filter(Boolean);

/** A pool with a fake-agent conversation, and a test runner over the same fake agent in its own log. */
async function setup(
  options: { env?: Record<string, string>; browserTools?: AgentTestRunnerOptions["browserTools"]; userEnvironment?: UserEnvironmentPorts; boundMs?: number; cap?: number; clock?: TestClock } = {},
) {
  const browser = fakeBrowserAccess();
  const harness = await poolHarness({ store: false, browser: browser.access, ...(options.cap === undefined ? {} : { cap: options.cap }) });
  cleanups.push(harness.cleanup);
  const testLog = join(harness.dir, "fake-test.log");
  const prompts = join(harness.dir, "test-prompts.txt");
  const runner = createAgentTestRunner({
    dataDir: harness.dataDir,
    resolveLaunch: async (agent, mode) => {
      expect(mode).toBe("strict");
      return {
        ok: true,
        spec: fakeAgentSpec({
          FAKE_ACP_LOG: testLog,
          FAKE_ACP_COUNT_PROMPTS: prompts,
          FAKE_ACP_SCENARIO: agent === "hermes" ? "hermes" : agent === "codex" ? "codex" : agent === "deepseek" ? "deepseek" : "claude",
          ...options.env,
        }),
        versions: { agent, tested: "1.0.0", found: "1.0.0" },
      };
    },
    browserTools: options.browserTools ?? (async () => "available"),
    userEnvironment: options.userEnvironment ?? NO_USER_ENVIRONMENT,
    ...(options.boundMs === undefined ? {} : { boundMs: options.boundMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  cleanups.push(async () => {
    await runner.shutdown();
    await killLoggedPids(testLog);
  });
  const testPids = async () => (await readFakeLog(testLog)).flatMap((line) => (line.event === "start" && typeof line.pid === "number" ? [line.pid] : []));
  return { harness, runner, browser, testLog, prompts, testPids };
}

/**
 * Watches for `last-test.json` while the test runs, and at the first sight of it notes whether the
 * test's folder and process were already gone.
 */
function watchResultWrite(dataDir: string, agent: ConversationAgent, pids: () => Promise<number[]>) {
  let stop = false;
  const seen = (async () => {
    // One more look after stop: under load the run can answer while this loop sleeps.
    for (;;) {
      const last = stop;
      if (await exists(lastTestPath(dataDir, agent))) {
        const folders = await readdir(join(dataDir, "agent-tests")).catch(() => []);
        const alive = (await pids()).filter(isAlive);
        return { folders, alive };
      }
      if (last) return undefined;
      await sleep(5);
    }
  })();
  return { seen, stop: () => (stop = true) };
}

describe("024 T766 a test run", () => {
  it("passes outside the pool: cap, index and tokens untouched, one prompt, folder and process gone before the result", async () => {
    const { harness, runner, browser, testLog, prompts, testPids } = await setup({ cap: 1 });
    // The cap of one is taken by the owner's conversation, which has a turn behind it.
    const conversationId = await harness.start("claude-code");
    await harness.turn(conversationId, "hello before the test");
    const historyBefore = harness.pool.page(conversationId, 0);
    const grantsBefore = browser.grants.length;

    const watch = watchResultWrite(harness.dataDir, "claude-code", testPids);
    const result = await runner.run("claude-code");
    watch.stop();
    const atWrite = await watch.seen;

    expect(agentTestResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ outcome: "passed", start: "ok", model: { answered: true, ms: expect.any(Number) }, browserTools: "available" });
    expect(result).not.toHaveProperty("keyHint");
    expect(await readLastTest(harness.dataDir, "claude-code")).toEqual(result);
    // When last-test.json first existed, the folder and the process were already gone.
    expect(atWrite).toEqual({ folders: [], alive: [] });

    // One prompt, the fixed one, in strict mode, with no browser tools offered.
    expect(await lines(prompts)).toHaveLength(1);
    const log = await readFakeLog(testLog);
    expect(JSON.stringify(requests(log, "session/prompt"))).toContain("connection test");
    expect(requests(log, "session/new")[0]?.params).toMatchObject({ servers: [] });
    expect(requests(log, "session/set_mode").map((line) => (line.params as { modeId?: string }).modeId)).toEqual(["default"]);
    expect(AGENT_TEST_PROMPT).toMatch(/OK/u);

    // Not a conversation: no new list entry, no token, the owner's conversation as it was and still live.
    expect((await harness.pool.views()).map((view) => view.conversationId)).toEqual([conversationId]);
    expect((await harness.index.list()).map((entry) => entry.conversationId)).toEqual([conversationId]);
    expect(browser.grants.length).toBe(grantsBefore);
    expect(harness.pool.page(conversationId, 0)).toEqual(historyBefore);
    expect(harness.pool.state(conversationId)).toBe("idle");
    await harness.turn(conversationId, "hello after the test");
  }, 120_000);

  it("is partial when the model answered and the browser tools are missing, and one test per agent runs at a time", async () => {
    const { runner, prompts } = await setup({ browserTools: async () => "missing-component" });
    const first = runner.run("hermes");
    const second = runner.run("hermes");
    expect(runner.running("hermes")).toBe(true);
    expect(second).toBe(first);
    const result = await first;
    expect(result).toMatchObject({ outcome: "partial", start: "ok", model: { answered: true }, browserTools: "missing-component" });
    expect(runner.running("hermes")).toBe(false);
    expect(await lines(prompts)).toHaveLength(1);
  }, 120_000);

  it("fails with the model's reason and, for Hermes, only the key variable's name", async () => {
    const home = "C:\\hermes-home-for-test";
    const userEnvironment: UserEnvironmentPorts = {
      readText: async (path) => {
        if (path === join(home, "config.yaml")) return "model:\n  key_env: HALLPASS_TEST_HERMES_KEY\n";
        throw Object.assign(new Error("not there"), { code: "ENOENT" });
      },
      run: async () => ({ code: 0, stdout: "Path\r\nHALLPASS_TEST_HERMES_KEY\r\n" }),
    };
    const { runner, testPids } = await setup({
      env: { HERMES_HOME: home, FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: "401 Unauthorized: invalid api key" },
      userEnvironment,
    });
    const result = await runner.run("hermes");
    expect(agentTestResultSchema.safeParse(result).success).toBe(true);
    // The fake's message is itself a value of its environment, so the agent's words arrive scrubbed (SC-161).
    expect(result).toMatchObject({ outcome: "failed", start: "ok", model: { answered: false, reason: expect.stringMatching(/could not reach its model/u) }, keyHint: "HALLPASS_TEST_HERMES_KEY" });
    expect(JSON.stringify(result)).not.toContain("invalid api key");
    for (const pid of await testPids()) expect(isAlive(pid)).toBe(false);
  }, 120_000);

  it("waits for Hermes' key-name check when the prompt fails for the model: the variable's name is in last-test.json", async () => {
    const home = "C:\\hermes-home-for-test";
    const userEnvironment: UserEnvironmentPorts = {
      readText: async (path) => {
        if (path === join(home, "config.yaml")) return "model:\n  key_env: HALLPASS_TEST_HERMES_KEY\n";
        throw Object.assign(new Error("not there"), { code: "ENOENT" });
      },
      // The names-only query takes a while on a real machine (up to its 10 s bound).
      run: async () => {
        await sleep(1_500);
        return { code: 0, stdout: "Path\r\nHALLPASS_TEST_HERMES_KEY\r\n" };
      },
    };
    const { runner, harness } = await setup({
      env: { HERMES_HOME: home, FAKE_ACP_FAIL_AT: "prompt", FAKE_ACP_FAIL_MESSAGE: "401 Unauthorized: invalid api key" },
      userEnvironment,
    });
    const result = await runner.run("hermes");
    expect(result).toMatchObject({ outcome: "failed", start: "ok", model: { answered: false, reason: expect.stringMatching(/could not reach its model/u) }, keyHint: "HALLPASS_TEST_HERMES_KEY" });
    expect(await readLastTest(harness.dataDir, "hermes")).toEqual(result);
  }, 120_000);

  it("says an answer whose turn did not end within the bound answered but did not finish", async () => {
    // The bound is passed on the test's clock once the answer is said, however slow the start was.
    const clock = new TestClock();
    const { runner, testLog } = await setup({ env: { FAKE_ACP_HANG_AT: "prompt" }, clock });
    const running = runner.run("claude-code");
    await waitFor(async () => (await readFakeLog(testLog)).some((line) => line.event === "hang"), "the answer said and the turn left open", 90_000);
    // The answer's text reaches the test run (it is coalesced for 50 ms first).
    await sleep(1_000);
    clock.advance(AGENT_TEST_BOUND_MS);
    const result = await running;
    expect(agentTestResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ outcome: "failed", start: "ok", model: { answered: false, reason: expect.stringMatching(/answered but did not finish within 90 s/u) } });
  }, 120_000);

  it("fails with the start code when the agent cannot start or is not there", async () => {
    const { runner, harness } = await setup({ env: { FAKE_ACP_FAIL_AT: "initialize" } });
    expect(await runner.run("claude-code")).toMatchObject({ outcome: "failed", start: "agent-exited", model: { answered: false } });

    const missing = createAgentTestRunner({
      dataDir: harness.dataDir,
      resolveLaunch: async () => ({ ok: false, error: { code: "install-needed", detail: "The Codex connector has not been downloaded yet." } }),
      browserTools: async () => "available",
    });
    expect(await missing.run("codex")).toMatchObject({ outcome: "failed", start: "agent-missing", model: { answered: false, reason: expect.stringMatching(/not been downloaded/u) } });
    expect(await readdir(join(harness.dataDir, "agent-tests"))).toEqual([]);
  }, 120_000);

  it("gives up at its bound with the process and folder gone", async () => {
    const { runner, harness, testPids } = await setup({ env: { FAKE_ACP_HANG_AT: "new" }, boundMs: 3_000 });
    const started = Date.now();
    const result = await runner.run("claude-code");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result).toMatchObject({ outcome: "failed", model: { answered: false, reason: expect.stringMatching(/within 3 s/u) } });
    for (const pid of await testPids()) expect(isAlive(pid)).toBe(false);
    expect(await readdir(join(harness.dataDir, "agent-tests"))).toEqual([]);
  }, 120_000);
});

describe("024 T767 the test command", () => {
  it("answers at once, shows testing while it runs, then the result from last-test.json", async () => {
    const { harness, runner } = await setup();
    const sent: Record<string, unknown>[] = [];
    const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
    const handler = createCommandHandler({
      sessionId: "broker-test",
      send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
      pool: harness.pool,
      index: harness.index,
      folders: harness.folders,
      consent,
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      install: async () => ({ ok: true, directory: "x" }),
      shared: { dataDir: harness.dataDir, browserId: "chrome-a1", pid: process.pid },
      tests: runner,
    });
    const agentIn = (frame: Record<string, unknown> | undefined) =>
      (frame?.agents as ConversationAgentAvailability[] | undefined)?.find((entry) => entry.agent === "claude-code");
    const overviews = () => sent.filter((frame) => frame.type === "conversation-overview");
    await handler.handle({ type: "conversation-command", sessionId: "broker-test", commandId: "t-1", command: { type: "ui.conversation.test", payload: { agent: "claude-code" } } });
    expect(sent.find((frame) => frame.commandId === "t-1")).toMatchObject({ ok: true });
    expect(runner.running("claude-code")).toBe(true);
    await waitFor(() => agentIn(overviews().at(-1))?.testing === true, "an overview saying testing");
    await waitFor(() => agentIn(overviews().at(-1))?.lastTest !== undefined, "an overview with the result", 90_000);
    const last = overviews().at(-1)!;
    expect(conversationOverviewFrameSchema.safeParse(last).success).toBe(true);
    expect(agentIn(last)).toMatchObject({ lastTest: { outcome: "passed" } });
    expect(agentIn(last)).not.toHaveProperty("testing");
  }, 120_000);
});
