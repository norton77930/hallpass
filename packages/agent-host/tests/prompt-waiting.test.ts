import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTENTION_SENTENCES } from "@hallpass/contracts";
import { cappedPairingBoundMs, PAIRING_PROGRESS_MESSAGE, PROMPT_PROGRESS_MESSAGE } from "../src/mcp-server.js";
import { KEEP_ALIVE_CAP_MS } from "../src/router.js";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 011/T287 — what the person at the terminal is told while a question waits in a panel they have
 * not opened (FR-146, FR-148, FR-150; contracts/prompt-waiting.md).
 *
 * Chrome will not let the worker open its own side panel without a gesture (R-160), so the first
 * call of a session raises a pairing card nobody can see. The only channel that reaches the person
 * is the agent's own reply, and MCP's progress notification is what carries a message on a call
 * that has not answered yet. This file pins the three things that makes true: the sentence reaches
 * the client on the waiting call's own token, the pairing exchange adopts the bound the worker
 * chose when it saw no panel, and the `timed-out` answer repeats the sentence as a `hint` so the
 * agent relays it even to a client that shows no progress at all.
 */
describe("T287 prompt-waiting on the server", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  let worker: FakeAgentWorker | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-waiting-"));
  });

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    worker = undefined;
    client = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  type Update = { progress: number; total?: number; message?: string };

  it("relays where to click while a consent card waits, and still answers the same call", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    // The worker is holding the call open because it is asking the owner about it.
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: { tabs_context: "hang" },
    });

    const seen: Update[] = [];
    const pending = client.callTool("tabs_context", {}, { onProgress: (update) => seen.push(update) });
    await waitFor(() => (worker?.requests.length ?? 0) === 1, 5_000, "the held call");
    const held = worker.requests[0]!;

    worker.send({
      type: "prompt-waiting",
      sessionId: held.sessionId,
      callId: held.callId,
      kind: "ask",
      panelConnected: false,
      waitedMs: 5_000,
      boundMs: 120_000,
    });
    await waitFor(() => seen.length >= 1, 5_000, "a progress notification");

    // The tick's own arithmetic, on this call's token: what the person is waiting on, how long they
    // have, and the sentence the agent reads out.
    expect(seen[0]).toEqual({ progress: 5_000, total: 120_000, message: ATTENTION_SENTENCES.consent });

    // And the call is still the same call: the owner opens the panel, answers, and this returns.
    worker.send({ callId: held.callId, outcome: "ok", result: [{ tabId: 7, url: "https://a.test/" }] });
    const answered = await pending;
    expect(answered.isError, answered.text).toBe(false);
    expect(answered.json).toEqual([{ tabId: 7, url: "https://a.test/" }]);
  });

  it("says the neutral thing when the panel is open", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: { tabs_context: "hang" },
    });

    const seen: Update[] = [];
    const pending = client.callTool("tabs_context", {}, { onProgress: (update) => seen.push(update) });
    await waitFor(() => (worker?.requests.length ?? 0) === 1, 5_000, "the held call");
    const held = worker.requests[0]!;

    worker.send({
      type: "prompt-waiting",
      sessionId: held.sessionId,
      callId: held.callId,
      kind: "ask",
      panelConnected: true,
      waitedMs: 5_000,
      boundMs: 25_000,
    });
    await waitFor(() => seen.length >= 1, 5_000, "a progress notification");

    // The card is in front of them: telling them to open a panel they are looking at would be
    // noise, and FR-151 keeps the neutral text as free of the question's content as the sentence is.
    expect(seen[0]).toEqual({ progress: 5_000, total: 25_000, message: PROMPT_PROGRESS_MESSAGE });
    expect(seen[0]?.message).not.toContain("Alt+A");

    worker.send({ callId: held.callId, outcome: "ok", result: [] });
    await pending;
  });

  it("holds the pairing for the bound the worker chose, then says where to click", async () => {
    client = await startMcpClient({
      env: {
        LOCALAPPDATA: dataDir,
        // The product's own is 45 s. What is under test is that a tick can lengthen whatever it is.
        HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "1000",
        HALLPASS_AGENT_PAIRING_PROGRESS_MS: "150",
      },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
    const seen: Update[] = [];
    const pending = client.callTool("tabs_context", {}, { onProgress: (update) => seen.push(update) });
    // The call raises the pairing request (004 FR-059a); the tick is about the card that raised.
    const request = (await worker.waitForControlFrame("pair-request")) as { sessionId: string };
    // No `callId`: the pairing exchange belongs to the server, and the tick says only that the
    // pairing card is up and that nobody can see it.
    worker.send({
      type: "prompt-waiting",
      sessionId: request.sessionId,
      kind: "pairing",
      panelConnected: false,
      waitedMs: 200,
      boundMs: 2_500,
    });

    const unanswered = await pending;
    // Past the bound the server started with: without the adoption this call would have been
    // answered while the pairing card was still on screen.
    expect(seen.some((update) => update.message === ATTENTION_SENTENCES.pairing)).toBe(true);
    expect(seen.some((update) => update.total === 2_500)).toBe(true);
    // FR-059's words for the fact, and 011's sentence for what to do about it.
    expect(unanswered.json).toEqual({
      outcome: "timed-out",
      reason: "not-paired: no answer",
      hint: ATTENTION_SENTENCES.pairing,
    });
  });

  it("keeps the ordinary pairing progress text when no tick says the panel is closed", async () => {
    client = await startMcpClient({
      env: {
        LOCALAPPDATA: dataDir,
        HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "800",
        HALLPASS_AGENT_PAIRING_PROGRESS_MS: "150",
      },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
    await worker.waitForHello();

    const seen: Update[] = [];
    const unanswered = await client.callTool("tabs_context", {}, { onProgress: (update) => seen.push(update) });

    // A panel is open, so nobody is told to open one, and the answer carries no hint: the owner
    // saw the card and did not answer it, which is a different fact.
    expect(seen.every((update) => update.message === PAIRING_PROGRESS_MESSAGE)).toBe(true);
    expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
  });

  it("carries the worker's own hint to the agent beside the outcome", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        // The consent prompt's own two minutes passed with the panel still closed.
        tabs_context: {
          callId: "",
          outcome: "timed-out",
          reason: "no-answer",
          hint: ATTENTION_SENTENCES.consent,
        },
      },
    });

    const timedOut = await client.callTool("tabs_context");

    expect(timedOut.isError).toBe(true);
    // Beside the stable code the agent branches on, never instead of it.
    expect(timedOut.json).toEqual({
      outcome: "timed-out",
      reason: "no-answer",
      hint: ATTENTION_SENTENCES.consent,
    });
  });

  /**
   * 011 review L4 — the pairing exchange has the same ceiling the router's calls have.
   *
   * A tick lengthens the exchange to the bound the worker named, and the promise the server makes
   * is the router's: every wait ends. Without a ceiling a worker with a stuck card - or a frame
   * from anywhere else - could hold every call parked on the pairing open for as long as it liked,
   * so the exchange stops where a call held by the same ticks stops, measured from its own start.
   */
  it("never lets a tick hold the pairing past the keep-alive cap", () => {
    // The two-minute closed-panel bound is what the worker actually asks for, and it fits.
    expect(cappedPairingBoundMs(120_000)).toBe(120_000);
    // A worker asking for ten minutes gets the cap, which is the router's own (`noteWaiting`).
    expect(cappedPairingBoundMs(600_000)).toBe(KEEP_ALIVE_CAP_MS);
    expect(KEEP_ALIVE_CAP_MS).toBe(130_000);
  });
});

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
