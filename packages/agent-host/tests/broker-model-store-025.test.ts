import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationAgent, ConversationModelChoice, ConversationModelOffer } from "@hallpass/contracts";
import { agentModelsPath, fileModelStore } from "../src/broker/model-store.js";
import { makeTempDir, poolHarness, removeDir } from "./conversation-harness.js";

/**
 * 025 T803 - the remembered list and last choice as a host file (R-401, data-model "Host file"):
 * `<data>\agent-models.json` = `{ version: 1, agents: { <agent>: { offer, seenAt, choice? } } }`,
 * re-read before every write (two browsers' brokers keep each other's agents), temp + rename, an
 * unreadable file kept aside as `.bad-<time>` and an empty start. Invented model names only.
 */

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const AT = new Date(NOW).toISOString();

const CONFIG_OFFER: ConversationModelOffer = {
  source: "config",
  configIds: { model: "model", effort: "effort" },
  models: [
    { value: "default", name: "Default (recommended)" },
    { value: "model-alpha", name: "Model Alpha" },
  ],
  efforts: [
    { value: "default", name: "Default" },
    { value: "high", name: "High" },
  ],
  defaultModel: "default",
  defaultEffort: "default",
};
const LIST_OFFER: ConversationModelOffer = {
  source: "models",
  models: [
    { value: "acme:model-one", name: "Model One" },
    { value: "acme:model-two", name: "Model Two" },
  ],
  efforts: [],
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await makeTempDir("hallpass-models-");
  path = agentModelsPath(join(dir, "data"));
});

afterEach(async () => {
  await removeDir(dir);
});

const onDisk = async () => JSON.parse(await readFile(path, "utf8")) as { version: number; agents: Record<string, unknown> };

describe("T803 agent-models.json", () => {
  it("lives in the data folder as agent-models.json", () => {
    expect(agentModelsPath(join(dir, "data"))).toBe(join(dir, "data", "agent-models.json"));
  });

  it("starts empty with no file, and writes the offer with when it was seen", async () => {
    const store = fileModelStore({ path, now: () => NOW });
    expect(await store.read()).toEqual({});
    await store.recordOffer("claude-code", CONFIG_OFFER, AT);
    expect(await onDisk()).toEqual({ version: 1, agents: { "claude-code": { offer: CONFIG_OFFER, seenAt: AT } } });
    expect(await store.read()).toEqual({ "claude-code": { offer: CONFIG_OFFER, seenAt: AT } });
    // temp + rename: nothing else is left in the folder.
    expect(await readdir(join(dir, "data"))).toEqual(["agent-models.json"]);
  });

  it("writes a choice beside the offer and keeps it when the offer is replaced", async () => {
    const store = fileModelStore({ path, now: () => NOW });
    await store.recordOffer("claude-code", CONFIG_OFFER, AT);
    await store.recordChoice("claude-code", { model: "model-alpha", effort: "high" });
    const later = new Date(NOW + 60_000).toISOString();
    const { defaultModel: _default, ...rest } = CONFIG_OFFER;
    const replaced: ConversationModelOffer = { ...rest, models: [CONFIG_OFFER.models[1]!] };
    await store.recordOffer("claude-code", replaced, later);
    expect((await store.read())["claude-code"]).toEqual({ offer: replaced, seenAt: later, choice: { model: "model-alpha", effort: "high" } });
  });

  it("keeps no choice for an agent it has no offer of", async () => {
    const store = fileModelStore({ path, now: () => NOW });
    await store.recordChoice("codex", { model: "model-alpha" });
    expect(await store.read()).toEqual({});
  });

  it("re-reads the file before every write, so another broker's agents stay", async () => {
    const first = fileModelStore({ path, now: () => NOW });
    const second = fileModelStore({ path, now: () => NOW });
    await first.recordOffer("claude-code", CONFIG_OFFER, AT);
    await second.recordOffer("hermes", LIST_OFFER, AT);
    await first.recordChoice("claude-code", { model: "model-alpha" });
    expect(Object.keys((await onDisk()).agents).sort()).toEqual(["claude-code", "hermes"]);
    expect(await second.read()).toEqual({
      "claude-code": { offer: CONFIG_OFFER, seenAt: AT, choice: { model: "model-alpha" } },
      hermes: { offer: LIST_OFFER, seenAt: AT },
    });
  });

  it("keeps an unreadable file aside as .bad-<time>, logs it, and starts empty", async () => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, agents: { "claude-code": { offer: CONFIG_OFFER, seenAt: AT, extra: true } } }));
    const logs: string[] = [];
    const store = fileModelStore({ path, now: () => NOW, log: (code, detail) => logs.push(`${code} ${detail ?? ""}`) });
    expect(await store.read()).toEqual({});
    const files = await readdir(join(dir, "data"));
    expect(files).toEqual([`agent-models.json.bad-${AT.replace(/[:.]/gu, "-")}`]);
    expect(logs).toEqual([`broker.models-unreadable agent-models.json.bad-${AT.replace(/[:.]/gu, "-")}`]);
    await store.recordOffer("codex", CONFIG_OFFER, AT);
    expect((await onDisk()).agents).toEqual({ codex: { offer: CONFIG_OFFER, seenAt: AT } });
  });

  it("refuses an offer the contract would not carry, and a version it does not know", async () => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, agents: {} }));
    const store = fileModelStore({ path, now: () => NOW });
    expect(await store.read()).toEqual({});
    expect((await readdir(join(dir, "data"))).some((name) => name.startsWith("agent-models.json.bad-"))).toBe(true);
  });
});

/** T819: what the pool writes there, through real fake-agent starts (seconds each). */
describe("T819 what the pool writes to agent-models.json", () => {
  type Harness = Awaited<ReturnType<typeof poolHarness>>;
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.cleanup();
  });
  const start = async (harness: Harness, agent: ConversationAgent, model?: ConversationModelChoice) => {
    const started = await harness.pool.start(agent, { kind: "scratch" }, undefined, "strict", model);
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
  };

  it("a later session/new with a different list replaces the offer; a choice it no longer lists becomes the agent's (R-405)", { timeout: 60_000 }, async () => {
    const env: Record<string, string> = { FAKE_ACP_MODELS: "config" };
    const harness = await poolHarness({ env, models: fileModelStore({ path }) });
    harnesses.push(harness);
    await start(harness, "claude-code", { model: "model-beta" });
    expect((await onDisk()).agents["claude-code"]).toMatchObject({ offer: { source: "config" }, choice: { model: "model-beta", effort: "default" } });

    env.FAKE_ACP_MODELS = "config-no-effort";
    await start(harness, "claude-code");
    const stored = (await onDisk()).agents["claude-code"] as { offer: ConversationModelOffer; choice?: unknown };
    expect(stored.offer.models.map((entry) => entry.name)).toEqual(["Model One", "Model Two", "Model Three"]);
    expect(stored.offer.efforts).toEqual([]);
    expect(stored.choice).toEqual({ model: JSON.stringify(["acme", "model-one"]) });
  });

  it("an agent that reports none is recorded with an empty offer (no chip)", { timeout: 60_000 }, async () => {
    const harness = await poolHarness({ env: { FAKE_ACP_MODELS: "none" }, models: fileModelStore({ path }) });
    harnesses.push(harness);
    await start(harness, "codex", { model: "model-alpha" });
    expect((await onDisk()).agents).toEqual({ codex: { offer: { source: "models", models: [], efforts: [] }, seenAt: expect.any(String) } });
  });

  it("two brokers on one file keep both agents", { timeout: 60_000 }, async () => {
    const first = await poolHarness({ env: { FAKE_ACP_MODELS: "config" }, models: fileModelStore({ path }) });
    const second = await poolHarness({ env: { FAKE_ACP_MODELS: "models" }, models: fileModelStore({ path }) });
    harnesses.push(first, second);
    // One after the other: each write re-reads the file (R-401); two writes in the same instant are not locked.
    await start(first, "claude-code", { model: "model-alpha" });
    await start(second, "hermes", { model: "zenith:model-three" });
    const agents = (await onDisk()).agents as Record<string, { choice?: unknown }>;
    expect(Object.keys(agents).sort()).toEqual(["claude-code", "hermes"]);
    expect(agents["claude-code"]?.choice).toEqual({ model: "model-alpha", effort: "default" });
    expect(agents.hermes?.choice).toEqual({ model: "zenith:model-three" });
  });
});
