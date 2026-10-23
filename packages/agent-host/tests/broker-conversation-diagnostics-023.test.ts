import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_DIAGNOSTIC_LINES_MAX,
  CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS,
  conversationDiagnosticsFrameSchema,
  conversationResultFrameSchema,
} from "@hallpass/contracts";
import { createCommandHandler, type ConsentStore } from "../src/broker/commands.js";
import type { FolderActions } from "../src/broker/folders.js";
import { poolHarness, waitFor, type PoolHarnessOptions } from "./conversation-harness.js";

/**
 * 023 T725 (R-367, D-023-8, FR-371/372): what an agent run prints about itself (its error output) is
 * always read, so the agent never stalls on a full pipe; the last 50 lines are kept in memory, each
 * cut to 500 characters, with every value of the environment the agent ran with removed and then
 * key-shaped text redacted - before the cut, so no part of a value survives it. The panel asks with
 * `ui.conversation.diagnostics` and gets `conversation-diagnostics`; an unknown or removed
 * conversation has none. Nothing of it reaches the broker log.
 */

/** A value only the environment scrub can catch: no key shape of its own. */
const PLANTED = "plain words of the planted value";
const VARIABLE = "HALLPASS_TEST_023_SETTING";
/** A key shape `redact()` catches although no variable holds it. */
const VENDOR_KEY = "ghp_abcdefghijklmnopqrstu12345";

const harnesses: Awaited<ReturnType<typeof poolHarness>>[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function setup(env: Record<string, string>, extra: PoolHarnessOptions = {}) {
  const logs: string[] = [];
  const h = await poolHarness({
    env: { [VARIABLE]: PLANTED, ...env },
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
    ...extra,
  });
  harnesses.push(h);
  return { h, logs };
}

const written = async (h: Awaited<ReturnType<typeof poolHarness>>) =>
  waitFor(async () => (await h.log()).some((line) => line.event === "stderr-written"), "the agent's error output");

function handlerFor(h: Awaited<ReturnType<typeof poolHarness>>) {
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
  });
  return { handler, sent };
}

describe("023 T725 the last 50 lines, scrubbed, each at most 500 characters", () => {
  it("keeps the last 50 lines with environment values removed, then key shapes redacted", async () => {
    const { h, logs } = await setup({
      FAKE_ACP_STDERR_LINES: "80",
      FAKE_ACP_STDERR_LINE: `line {n} setting={env:${VARIABLE}} key ${VENDOR_KEY}`,
    });
    const id = await h.start("claude-code");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).at(-1)?.startsWith("line 80 ") === true, "the last line");
    const lines = h.pool.diagnostics(id);
    expect(lines).toHaveLength(CONVERSATION_DIAGNOSTIC_LINES_MAX);
    expect(lines[0]).toMatch(/^line 31 /u);
    expect(lines.at(-1)).toMatch(/^line 80 /u);
    expect(lines.at(-1)).toContain(`setting=%${VARIABLE}%`);
    const all = lines.join("\n");
    expect(all).not.toContain(PLANTED);
    expect(all).not.toContain(VENDOR_KEY);
    // The broker log has none of it.
    expect(logs.join("\n")).not.toContain("line 80");
    expect(logs.join("\n")).not.toContain(PLANTED);
  });

  it("scrubs a value before the cut, so no beginning of it is left at the 500th character", async () => {
    const { h } = await setup({
      FAKE_ACP_STDERR_LINES: "1",
      FAKE_ACP_STDERR_LINE: `${"a".repeat(CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS - 10)}{env:${VARIABLE}}${"b".repeat(600)}`,
    });
    const id = await h.start("claude-code");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).length === 1, "the line");
    const [line] = h.pool.diagnostics(id);
    // The placeholder, not the value, is what the cut reaches.
    expect(line).toBe(`${"a".repeat(CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS - 10)}%HALLPASS_`);
    expect(line).not.toContain(PLANTED.slice(0, 5));
  });

  it("leaves no beginning of a value cut by the 16 KB read limit, when scrubbing shrinks the text before it", async () => {
    // The broker reads 16 KB of one line; eight long values before the planted one shrink to their
    // names, so what follows them - 20 characters of the planted value, up to the read limit - would
    // land inside the 500 kept.
    const readMax = 16 * 1024;
    const bigVariable = "HALLPASS_TEST_023_BIG";
    const big = "long setting ".repeat(200).slice(0, 2040);
    const filler = readMax - 20 - 8 * big.length;
    const { h } = await setup({
      [bigVariable]: big,
      FAKE_ACP_STDERR_LINES: "1",
      FAKE_ACP_STDERR_LINE: `${`{env:${bigVariable}}`.repeat(8)}${"c".repeat(filler)}{env:${VARIABLE}}${"d".repeat(100)}`,
    });
    const id = await h.start("claude-code");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).length === 1, "the line");
    const [line] = h.pool.diagnostics(id);
    expect(line).not.toContain(PLANTED.slice(0, 8));
    expect(line).toBe(`${`%${bigVariable}%`.repeat(8)}${"c".repeat(filler)}`);
  });

  it("reads 1 MB without the agent stalling, and keeps only the last 50 lines, cut", async () => {
    const { h } = await setup({ FAKE_ACP_STDERR_BYTES: String(1024 * 1024), FAKE_ACP_STDERR_LINES: "3" });
    const id = await h.start("claude-code");
    await h.turn(id, "hello");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).at(-1) === "stderr line 3", "the last line");
    const lines = h.pool.diagnostics(id);
    expect(lines).toHaveLength(CONVERSATION_DIAGNOSTIC_LINES_MAX);
    expect(lines.slice(-3)).toEqual(["stderr line 1", "stderr line 2", "stderr line 3"]);
    for (const line of lines.slice(0, -3)) expect(line).toBe("x".repeat(CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS));
  }, 30_000);
});

describe("023 T725 the panel's request and the conversation's end", () => {
  it("answers ui.conversation.diagnostics with conversation-diagnostics; an unknown conversation has none", async () => {
    const { h } = await setup({ FAKE_ACP_STDERR_LINES: "2" });
    const id = await h.start("claude-code");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).length === 2, "two lines");
    const { handler, sent } = handlerFor(h);
    await handler.handle({ type: "conversation-command", sessionId: "worker", commandId: "d1", command: { type: "ui.conversation.diagnostics", payload: { conversationId: id } } });
    const result = sent.find((frame) => frame.type === "conversation-result" && frame.commandId === "d1");
    expect(result).toMatchObject({ ok: true });
    expect(conversationResultFrameSchema.safeParse(result).success).toBe(true);
    const reply = sent.find((frame) => frame.type === "conversation-diagnostics");
    expect(reply).toEqual({ type: "conversation-diagnostics", sessionId: "broker-1", conversationId: id, lines: ["stderr line 1", "stderr line 2"] });
    expect(conversationDiagnosticsFrameSchema.safeParse(reply).success).toBe(true);

    await handler.handle({ type: "conversation-command", sessionId: "worker", commandId: "d2", command: { type: "ui.conversation.diagnostics", payload: { conversationId: "no-such-conversation-023" } } });
    expect(sent.find((frame) => frame.type === "conversation-result" && frame.commandId === "d2")).toMatchObject({ ok: true });
    expect(sent.filter((frame) => frame.type === "conversation-diagnostics").at(-1)).toEqual({
      type: "conversation-diagnostics",
      sessionId: "broker-1",
      conversationId: "no-such-conversation-023",
      lines: [],
    });
  });

  it("keeps the lines of a run that crashed, and drops them with the conversation", async () => {
    const { h } = await setup({ FAKE_ACP_STDERR_LINES: "2" });
    const id = await h.start("claude-code");
    await written(h);
    await waitFor(() => h.pool.diagnostics(id).length === 2, "two lines");
    expect(await h.pool.send(id, "crash")).toEqual({ ok: true });
    await waitFor(() => h.pool.state(id) === "crashed", "the crash");
    expect(h.pool.diagnostics(id)).toEqual(["stderr line 1", "stderr line 2"]);
    expect(await h.pool.remove(id)).toEqual({ ok: true });
    expect(h.pool.diagnostics(id)).toEqual([]);
  });
});
