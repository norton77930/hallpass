import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationDiagnosticsFrameSchema, type ConversationAgent } from "@hallpass/contracts";
import { createAgentTestRunner, type AgentTestRunner } from "../src/broker/agent-test.js";
import { createCommandHandler, type ConsentStore } from "../src/broker/commands.js";
import type { FolderActions } from "../src/broker/folders.js";
import { NO_USER_ENVIRONMENT, fakeAgentSpec, killLoggedPids, poolHarness, waitFor } from "./conversation-harness.js";

/**
 * 024 T783 (R-387, FR-387): the settings page asks for an agent's diagnostics by agent, not by
 * conversation. The broker answers with the agent's most recent run here - a conversation's or a
 * Test's, whichever ran last - read now (`readAt`), naming the conversation when it was one. The
 * lines are the 023 R-367 ones (environment values and key shapes already gone) with the user's
 * profile folder said as `%USERPROFILE%`; an agent that has not run here gets no lines.
 */

const PROFILE = "C:\\Users\\Profile Owner";
const PLANTED = "plain words of the planted value";
const VARIABLE = "HALLPASS_TEST_024_SETTING";
const VENDOR_KEY = "ghp_abcdefghijklmnopqrstu12345";
const LINE = `line {n} at c:/users/profile owner/AppData/agent.log setting={env:${VARIABLE}} key ${VENDOR_KEY}`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function setup() {
  // The run's own USERPROFILE is the planted profile, written in other case and slashes in its lines.
  const h = await poolHarness({ env: { [VARIABLE]: PLANTED, USERPROFILE: PROFILE, FAKE_ACP_STDERR_LINES: "2", FAKE_ACP_STDERR_LINE: LINE } });
  cleanups.push(h.cleanup);
  const testLog = join(h.dir, "fake-test.log");
  const tests = createAgentTestRunner({
    dataDir: h.dataDir,
    resolveLaunch: async (agent) => ({
      ok: true,
      spec: fakeAgentSpec({
        FAKE_ACP_LOG: testLog,
        [VARIABLE]: PLANTED,
        FAKE_ACP_STDERR_LINES: "1",
        FAKE_ACP_STDERR_LINE: `test run ${LINE}`,
      }),
      versions: { agent, tested: "1.0.0", found: "1.0.0" },
    }),
    browserTools: async () => "available",
    userEnvironment: NO_USER_ENVIRONMENT,
  });
  cleanups.push(async () => {
    await tests.shutdown();
    await killLoggedPids(testLog);
  });
  const sent: Record<string, unknown>[] = [];
  const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
  const handler = createCommandHandler({
    sessionId: "broker-1",
    send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
    pool: h.pool,
    index: h.index,
    folders: h.folders,
    consent,
    folderActions: {} as FolderActions,
    availability: async (agent) => ({ agent, availability: "ready" }),
    install: async () => ({ ok: false, error: { code: "install-failed", detail: "no installs in this test" } }),
    tests,
    userProfile: PROFILE,
  });
  let serial = 0;
  const ask = async (agent: ConversationAgent) => {
    const commandId = `d-${++serial}`;
    await handler.handle({ type: "conversation-command", sessionId: "broker-1", commandId, command: { type: "ui.conversation.diagnostics", payload: { agent } } });
    expect(sent.find((frame) => frame.commandId === commandId)).toMatchObject({ ok: true });
    const frame = sent.filter((entry) => entry.type === "conversation-diagnostics").at(-1)!;
    expect(conversationDiagnosticsFrameSchema.safeParse(frame).success).toBe(true);
    return frame as { agent: string; readAt: string; conversationId?: string; lines: string[] };
  };
  const askConversation = async (conversationId: string) => {
    const commandId = `d-${++serial}`;
    await handler.handle({ type: "conversation-command", sessionId: "broker-1", commandId, command: { type: "ui.conversation.diagnostics", payload: { conversationId } } });
    expect(sent.find((frame) => frame.commandId === commandId)).toMatchObject({ ok: true });
    const frame = sent.filter((entry) => entry.type === "conversation-diagnostics").at(-1)!;
    expect(conversationDiagnosticsFrameSchema.safeParse(frame).success).toBe(true);
    return frame as { conversationId: string; lines: string[] };
  };
  return { h, tests: tests as AgentTestRunner, ask, askConversation };
}

describe("024 T783 diagnostics by agent", () => {
  it("answers with the latest run, conversation or test, read now, the profile folder and every secret gone", async () => {
    const { h, tests, ask } = await setup();
    const conversationId = await h.start("claude-code");
    await waitFor(() => h.pool.diagnostics(conversationId).length === 2, "the conversation's two lines");

    const before = Date.now();
    const fromConversation = await ask("claude-code");
    expect(fromConversation).toMatchObject({ agent: "claude-code", conversationId });
    expect(Date.parse(fromConversation.readAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(fromConversation.lines).toHaveLength(2);
    expect(fromConversation.lines[0]).toMatch(new RegExp(`^line 1 at %USERPROFILE%/AppData/agent\.log setting=%${VARIABLE}% key `, "u"));
    const all = fromConversation.lines.join("\n");
    expect(all).toContain("%USERPROFILE%/AppData/agent.log");
    expect(all.toLowerCase()).not.toContain("profile owner");
    expect(all).not.toContain(PLANTED);
    expect(all).not.toContain(VENDOR_KEY);

    // A Test after it is the latest run: its lines, and no conversation named.
    await tests.run("claude-code");
    const fromTest = await ask("claude-code");
    expect(fromTest).not.toHaveProperty("conversationId");
    expect(fromTest.lines.length).toBeGreaterThan(0);
    expect(fromTest.lines.every((line) => line.startsWith("test run line "))).toBe(true);
    expect(fromTest.lines.join("\n")).not.toContain(VENDOR_KEY);
    expect(fromTest.lines.join("\n").toLowerCase()).not.toContain("profile owner");
  }, 120_000);

  it("answers by conversation with the lines by agent gives: the profile folder is gone where the lines are kept", async () => {
    const { h, ask, askConversation } = await setup();
    const conversationId = await h.start("claude-code");
    await waitFor(() => h.pool.diagnostics(conversationId).length === 2, "the conversation's two lines");

    const byConversation = await askConversation(conversationId);
    expect(byConversation.conversationId).toBe(conversationId);
    expect(byConversation.lines).toHaveLength(2);
    expect(byConversation.lines[0]).toMatch(new RegExp(`^line 1 at %USERPROFILE%/AppData/agent\\.log setting=%${VARIABLE}% key `, "u"));
    expect(byConversation.lines.join("\n").toLowerCase()).not.toContain("profile owner");
    expect(byConversation.lines).toEqual((await ask("claude-code")).lines);
  }, 120_000);

  it("gives an agent that has not run here no lines", async () => {
    const { ask } = await setup();
    const frame = await ask("codex");
    expect(frame).toMatchObject({ agent: "codex", lines: [] });
    expect(frame).not.toHaveProperty("conversationId");
    expect(typeof frame.readAt).toBe("string");
  });
});
