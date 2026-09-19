import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PAIRING_PROGRESS_MS,
  PAIRING_TIMEOUT_FLOOR_MS,
  PAIRING_TIMEOUT_MS,
} from "../src/mcp-server.js";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 004/T100 — pairing that survives a slow human (R-112, FR-059).
 *
 * The owner's E2: their reading time counted against the caller's own bound, so the first call of
 * a session failed while the prompt was still on screen. Three things together answer it, and this
 * file pins all three: the prompt is raised when the MCP session initialises rather than when the
 * first call needs it, the call that waits says so in MCP's own words every five seconds so a
 * client that honours progress does not give up on it, and the bound is long enough (45 s, never
 * under 30) that an owner who takes twenty seconds is answered in that same call.
 *
 * The bounds are read from the environment here for the same reason the rest of this suite does it:
 * the process an agent spawns takes no arguments, so a test's only lever is the environment.
 */
describe("T100 pairing timing", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  let worker: FakeAgentWorker | undefined;

  const TABS = {
    tabs_context: { callId: "", outcome: "ok" as const, result: [{ tabId: 7, url: "https://a.test/" }] },
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-pairing-"));
  });

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    worker = undefined;
    client = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * FR-059's floor, held as an assertion rather than as a clamp on the override.
   *
   * The override exists so a test need not wait three quarters of a minute for a prompt nobody is
   * going to answer; clamping it to 30 s would make every timeout case in this suite that long.
   * What the floor really governs is the *product's* bound, and this is what fails when someone
   * shortens it below what FR-059 promises the owner.
   */
  it("keeps the shipped pairing bound at or above FR-059's floor", () => {
    expect(PAIRING_TIMEOUT_MS).toBe(45_000);
    expect(PAIRING_TIMEOUT_MS).toBeGreaterThanOrEqual(PAIRING_TIMEOUT_FLOOR_MS);
    expect(PAIRING_TIMEOUT_FLOOR_MS).toBe(30_000);
    expect(PAIRING_PROGRESS_MS).toBe(5_000);
  });

  it("asks the owner to pair as the MCP session starts, before any tool call", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });

    // No call has been made, and the owner is already looking at the prompt: the twenty seconds
    // they take are spent before the agent's first call rather than inside it.
    await expect(worker.waitForControlFrame("pair-request")).resolves.toMatchObject({
      type: "pair-request",
      displayName: "Claude Code",
    });
    expect(worker.requests).toEqual([]);
  });

  it("reports progress while the owner decides and succeeds on that same call", async () => {
    client = await startMcpClient({
      env: {
        LOCALAPPDATA: dataDir,
        HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000",
        // The product's cadence is 5 s; a test that waited two of them would be ten seconds of
        // nothing. What is under test is that the wait is *reported*, not `setInterval`.
        HALLPASS_AGENT_PAIRING_PROGRESS_MS: "150",
      },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
    const request = (await worker.waitForControlFrame("pair-request")) as { agentId: string; sessionId: string };

    const seen: Array<{ progress: number; total?: number }> = [];
    const pending = client.callTool("tabs_context", {}, { onProgress: (update) => seen.push(update) });

    // The owner reads the prompt. A client with a 60 s bound would have given up on a call that
    // said nothing; every one of these notifications resets that bound.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)?.total).toBe(20_000);
    expect(worker.requests).toEqual([]);

    worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: true });

    const held = await pending;
    expect(held.isError, held.text).toBe(false);
    expect(held.json).toEqual([{ tabId: 7, url: "https://a.test/" }]);
  });

  it("answers 'not-paired: no answer' when the bound passes with nobody answering", async () => {
    client = await startMcpClient({
      env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "400" },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
    await worker.waitForControlFrame("pair-request");

    const unanswered = await client.callTool("tabs_context");

    // The fact, in the words FR-059 chose: nobody answered. Not `denied`, which is a decision the
    // owner never made, and not `bridge-lost`, which is about the link.
    expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
  });

  it("withdraws the unanswered request so the next call raises it again", async () => {
    client = await startMcpClient({
      env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "400" },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
    await worker.waitForControlFrame("pair-request");
    await client.callTool("tabs_context");

    // The owner was away for the first call. The second must ask them again rather than hand back
    // the timeout for the rest of the session.
    const second = client.callTool("tabs_context");
    await waitFor(
      () => worker?.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
      3_000,
      "a second pair-request",
    );
    const raised = worker.controlFrames.filter((frame) => frame.type === "pair-request");
    const reraised = raised[1] as { agentId: string; sessionId: string };
    worker.send({ type: "pair-result", agentId: reraised.agentId, sessionId: reraised.sessionId, accepted: true });

    const answered = await second;
    expect(answered.isError, answered.text).toBe(false);
    expect(answered.json).toEqual([{ tabId: 7, url: "https://a.test/" }]);
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
