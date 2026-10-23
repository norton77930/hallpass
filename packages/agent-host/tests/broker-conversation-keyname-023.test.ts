import { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationErrorSchema, conversationEventSchema, type ConversationAgent, type ConversationEvent } from "@hallpass/contracts";
import type { UserEnvironmentPorts } from "../src/broker/user-environment.js";
import { poolHarness, turnEnded, waitFor, type PoolHarnessOptions } from "./conversation-harness.js";

/**
 * 023 T722 (R-369, D-023-6, FR-369/370): a Hermes start or first message that fails for its model or
 * key, while the variable Hermes' settings name as its key source is in the owner's user settings but
 * not in what the agent ran with (and not in Hermes' own `.env`): a `key-env-not-in-browser` notice
 * naming the variable - its name only. A value planted in the settings, the `.env` or the agent's
 * environment never appears in an event or a log line. Other agents and other failures: nothing, and
 * the user settings are not even asked.
 */

const PLANTED = "sk-planted-VALUE-0123456789abcdef";
const VARIABLE = "HALLPASS_TEST_023_MODEL_KEY";
const HOME = "X:\\hermes-home-023";
const CONFIG = `model:\n  provider: custom\n  api_key: ${PLANTED}\n  key_env: ${VARIABLE}\n`;
const UNAUTHORIZED = "Error code: 401 - invalid api key";

function machine(options: { dotEnv?: string; userNames?: string[] } = {}) {
  const queries: string[] = [];
  const files: Record<string, string> = { [win32.join(HOME, "config.yaml")]: CONFIG };
  if (options.dotEnv !== undefined) files[win32.join(HOME, ".env")] = options.dotEnv;
  const ports: UserEnvironmentPorts = {
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error("not there"), { code: "ENOENT" });
      return text;
    },
    run: async (file) => {
      queries.push(file);
      return { code: 0, stdout: `${(options.userNames ?? ["Path", VARIABLE]).join("\r\n")}\r\n` };
    },
  };
  return { ports, queries };
}

const harnesses: Awaited<ReturnType<typeof poolHarness>>[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function setup(env: Record<string, string>, ports: UserEnvironmentPorts, extra: PoolHarnessOptions = {}) {
  const logs: string[] = [];
  const h = await poolHarness({
    env: { HERMES_HOME: HOME, FAKE_ACP_TURN_ERROR: UNAUTHORIZED, ...env },
    userEnvironment: ports,
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
    ...extra,
  });
  harnesses.push(h);
  return { h, logs };
}

const keyNotices = (events: { event: ConversationEvent }[]) =>
  events
    .map((entry) => entry.event)
    .filter((event): event is Extract<ConversationEvent, { type: "notice" }> => event.type === "notice" && event.code === "key-env-not-in-browser");

async function failFirstTurn(h: Awaited<ReturnType<typeof poolHarness>>, agent: ConversationAgent = "hermes") {
  const id = await h.start(agent);
  const from = h.rec.events.length;
  expect(await h.pool.send(id, "fail:turn")).toEqual({ ok: true });
  await waitFor(() => turnEnded(h.rec.events.slice(from), id), "the failed turn");
  return id;
}

describe("023 T722 a first message that fails, the key only in the user's settings", () => {
  it("says key-env-not-in-browser with the variable's name, and no value anywhere", async () => {
    const { ports, queries } = machine({ dotEnv: `OTHER_KEY=${PLANTED}\n` });
    const { h, logs } = await setup({ SOME_OTHER_SETTING: PLANTED }, ports);
    const id = await failFirstTurn(h);
    await waitFor(() => keyNotices(h.rec.of(id)).length > 0, "the key notice");
    const notices = keyNotices(h.rec.of(id));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "notice", code: "key-env-not-in-browser", agent: "hermes", variable: VARIABLE });
    expect(notices[0]!.text).toContain(VARIABLE);
    expect(conversationEventSchema.safeParse(notices[0]).success).toBe(true);
    expect(queries).toHaveLength(1);
    expect(JSON.stringify(h.rec.events)).not.toContain(PLANTED);
    expect(logs.join("\n")).not.toContain(PLANTED);
  });

  it("is not said when the agent's environment has the variable", async () => {
    const { ports } = machine();
    const { h } = await setup({ [VARIABLE]: PLANTED }, ports);
    const id = await failFirstTurn(h);
    expect(keyNotices(h.rec.of(id))).toEqual([]);
    expect(JSON.stringify(h.rec.events)).not.toContain(PLANTED);
  });

  it("is not said when Hermes' own .env defines it", async () => {
    const { ports, queries } = machine({ dotEnv: `${VARIABLE}=${PLANTED}\n` });
    const { h } = await setup({}, ports);
    const id = await failFirstTurn(h);
    expect(keyNotices(h.rec.of(id))).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("is not said when the user's settings do not have it either", async () => {
    const { ports } = machine({ userNames: ["Path"] });
    const { h } = await setup({}, ports);
    const id = await failFirstTurn(h);
    expect(keyNotices(h.rec.of(id))).toEqual([]);
  });

  it("is not looked for when the failure is not about the model or key, or after a turn went through", async () => {
    const { ports, queries } = machine();
    const { h } = await setup({ FAKE_ACP_TURN_ERROR: "something else broke" }, ports);
    const id = await failFirstTurn(h);
    expect(keyNotices(h.rec.of(id))).toEqual([]);

    const second = machine();
    const { h: h2 } = await setup({}, second.ports);
    const ok = await h2.start("hermes");
    await h2.turn(ok, "hello");
    const from = h2.rec.events.length;
    expect(await h2.pool.send(ok, "fail:turn")).toEqual({ ok: true });
    await waitFor(() => turnEnded(h2.rec.events.slice(from), ok), "the failed turn");
    expect(keyNotices(h2.rec.of(ok))).toEqual([]);
    expect([...queries, ...second.queries]).toEqual([]);
  });

  it.each<ConversationAgent>(["claude-code", "codex", "deepseek"])("%s: never, and the user settings are not asked", async (agent) => {
    const { ports, queries } = machine();
    const { h } = await setup({}, ports);
    const id = await failFirstTurn(h, agent);
    expect(keyNotices(h.rec.of(id))).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("023 T722 a start that fails, the key only in the user's settings", () => {
  it("says key-env-not-in-browser before the start's failure is returned", async () => {
    const { ports } = machine();
    const { h, logs } = await setup({ FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: UNAUTHORIZED }, ports);
    const started = await h.pool.start("hermes", { kind: "scratch" });
    expect(started.ok ? "ok" : started.error.code).toBe("agent-model-unreachable");
    const notices = keyNotices(h.rec.events);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: "key-env-not-in-browser", agent: "hermes", variable: VARIABLE });
    expect(JSON.stringify(h.rec.events)).not.toContain(PLANTED);
    expect(logs.join("\n")).not.toContain(PLANTED);
  });

  it("puts the hint in the first start's own failure, which the panel shows - the conversation is dropped with it", async () => {
    const { ports } = machine({ dotEnv: `OTHER_KEY=${PLANTED}\n` });
    const { h, logs } = await setup({ FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: UNAUTHORIZED, SOME_OTHER_SETTING: PLANTED }, ports);
    const started = await h.pool.start("hermes", { kind: "scratch" });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(conversationErrorSchema.safeParse(started.error).success).toBe(true);
    expect(started.error.code).toBe("agent-model-unreachable");
    expect(started.error.detail).toContain(VARIABLE);
    expect(started.error.detail).toMatch(/quit the browser completely/iu);
    expect(started.error.detail).toMatch(/open it again/iu);
    expect(JSON.stringify(started)).not.toContain(PLANTED);
    expect(JSON.stringify(h.rec.events)).not.toContain(PLANTED);
    expect(logs.join("\n")).not.toContain(PLANTED);
  });

  it("is not said for a start that failed for another reason", async () => {
    const { ports, queries } = machine();
    const { h } = await setup({ FAKE_ACP_FAIL_AT: "new", FAKE_ACP_FAIL_MESSAGE: "no such thing" }, ports);
    const started = await h.pool.start("hermes", { kind: "scratch" });
    expect(started.ok).toBe(false);
    expect(keyNotices(h.rec.events)).toEqual([]);
    expect(queries).toEqual([]);
  });
});
