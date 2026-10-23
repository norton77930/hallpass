import { afterEach, describe, expect, it } from "vitest";
import { conversationEventSchema, type ConversationAgent, type ConversationEvent } from "@hallpass/contracts";
import { CONVERSATION_IDLE_MS } from "../src/broker/conversation.js";
import { fakeBrowserAccess, poolHarness, waitFor, type PoolHarnessOptions } from "./conversation-harness.js";

/**
 * 023 T714 (R-365, D-023-2, FR-364, FR-374): whether an agent took Hallpass's browser tools. The worker
 * says when a conversation's `hallpass` server greets (`conversation-browser-attached`, handed to the
 * pool as `browserAttached`). Hermes starts its servers before it answers `session/new` / `session/load`,
 * so when no greeting came 10 s after that, it did not take them: one `browser-tools-missing` notice per
 * conversation - a restart does not say it again. DeepSeek takes no servers at all: the notice comes at
 * once. Claude Code and Codex are not checked (no false alarms). Without a browser connection nothing
 * was offered, so nothing is missing.
 */

const harnesses: Awaited<ReturnType<typeof poolHarness>>[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function setup(options: PoolHarnessOptions = {}, browser = true) {
  const fake = fakeBrowserAccess();
  const h = await poolHarness({ ...(browser ? { browser: fake.access } : {}), ...options });
  harnesses.push(h);
  return { h, grants: fake.grants };
}

const browserNotices = (h: Awaited<ReturnType<typeof poolHarness>>, id: string) =>
  h.rec
    .of(id)
    .map((entry) => entry.event)
    .filter((event): event is Extract<ConversationEvent, { type: "notice" }> => event.type === "notice" && event.code === "browser-tools-missing");

const TEN_SECONDS = 10_000;

describe("023 T714 Hermes: a greeting within 10 s, or one notice", () => {
  it("says nothing when the conversation's server greeted", async () => {
    const { h } = await setup();
    const id = await h.start("hermes");
    h.pool.browserAttached(id);
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });

  it("says nothing when the greeting came before the session existed", async () => {
    const { h, grants } = await setup({ env: { FAKE_ACP_NEW_DELAY_MS: "400" } });
    const starting = h.pool.start("hermes", { kind: "scratch" });
    await waitFor(() => grants.some((grant) => grant.token !== null), "the run's token");
    h.pool.browserAttached(grants[0]!.conversationId);
    const started = await starting;
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    const id = started.value!.conversationId;
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });

  it("says browser-tools-missing once, 10 s after session/new, and not again after a restart", async () => {
    const { h } = await setup();
    const id = await h.start("hermes");
    h.clock.advance(TEN_SECONDS - 1);
    expect(browserNotices(h, id)).toEqual([]);
    h.clock.advance(1);
    const notices = browserNotices(h, id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "notice", code: "browser-tools-missing", agent: "hermes" });
    expect(conversationEventSchema.safeParse(notices[0]).success).toBe(true);

    // A mode change restarts Hermes (launch-time mode): a new run, a new check - and still one notice.
    expect(await h.pool.setMode(id, "agent-review")).toEqual({ ok: true });
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toHaveLength(1);
  });

  it("checks again after session/load, once per conversation", async () => {
    const { h } = await setup();
    const id = await h.start("hermes");
    h.pool.browserAttached(id);
    // The idle limit ends the run; opening the conversation continues it with session/load.
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    expect(await h.pool.open(id)).toEqual({ ok: true });
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toHaveLength(1);
  });

  it("says nothing when the run ended before the 10 s were up", async () => {
    const { h } = await setup();
    const id = await h.start("hermes");
    expect(await h.pool.send(id, "crash")).toEqual({ ok: true });
    await waitFor(() => h.pool.state(id) === "crashed", "the crash");
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });

  it("says nothing when the owner withdrew the browser before the 10 s were up", async () => {
    const { h } = await setup();
    const id = await h.start("hermes");
    h.pool.revokeBrowserTokens();
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });

  it("says nothing without a browser connection (no tools were offered)", async () => {
    const { h } = await setup({}, false);
    const id = await h.start("hermes");
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });
});

describe("023 T714 DeepSeek takes no browser tools: the notice at once", () => {
  it("comes with the start, without waiting, and once", async () => {
    const { h } = await setup();
    const id = await h.start("deepseek");
    const notices = browserNotices(h, id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "notice", code: "browser-tools-missing", agent: "deepseek" });
    expect(conversationEventSchema.safeParse(notices[0]).success).toBe(true);
    h.pool.browserAttached(id);
    h.clock.advance(TEN_SECONDS);
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    expect(await h.pool.open(id)).toEqual({ ok: true });
    expect(browserNotices(h, id)).toHaveLength(1);
  });
});

describe("023 T714 Claude Code and Codex are not checked (FR-374)", () => {
  it.each<ConversationAgent>(["claude-code", "codex"])("%s: never a notice", async (agent) => {
    const { h } = await setup();
    const id = await h.start(agent);
    h.clock.advance(TEN_SECONDS);
    expect(browserNotices(h, id)).toEqual([]);
  });

  it("a greeting for a conversation this pool does not know is ignored", async () => {
    const { h } = await setup();
    expect(() => h.pool.browserAttached("no-such-conversation")).not.toThrow();
  });
});
