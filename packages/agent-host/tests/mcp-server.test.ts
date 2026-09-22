import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_DESCRIPTORS } from "@hallpass/contracts";
import { positiveEnv, SCREENSHOT_BUDGET_ENV, SCREENSHOT_RETENTION_ENV } from "../src/mcp-server.js";
import { PENDING_AGENT_TOOL_NAMES } from "../src/tool-offering.js";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 003/T012+T020 — the MCP server proven from both ends without a browser: a real MCP client over
 * stdio on one side, a stand-in for Chrome's relay on the other.
 *
 * This is the half of the spike that can be a unit test. It pins the ordering the whole feature
 * rests on: a tool call is held until the owner's answer to the pairing prompt arrives, and it is
 * answered in the contract's own outcomes whether the answer is yes, no, or nobody at all.
 *
 * It spawns the built `dist/mcp-server.js`, so `npx tsc -b` has to have run; that is deliberate,
 * because it is the built artefact an agent actually spawns.
 */
describe("T012 agent MCP server", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  let worker: FakeAgentWorker | undefined;

  beforeEach(async () => {
    // A private LOCALAPPDATA so a run never reads or writes the developer's real bridge file.
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-"));
  });

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    worker = undefined;
    client = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("offers exactly the tools that have a worker handler behind them", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    // 004/T088a — registration is the *implemented* list, not the whole descriptor table: a
    // descriptor exists as soon as the contract names a tool, but an agent that is offered a tool
    // nothing answers spends a call to learn that, and every offered tool is a promise.
    await expect(client.listToolNames()).resolves.toEqual([
      "tabs_context",
      "tabs_create",
      "tabs_close",
      // 004/T105: the worker answers these now, so the host may offer them.
      "tabs_claim",
      "tabs_release",
      "navigate",
      "resize_window",
      // 012/S1: the worker gives a tab an emulated viewport and clears it again, so it is offered.
      "viewport",
      // 005/T183: the worker answers the session's download ring, so the host may offer it.
      "downloads_context",
      "get_page_text",
      "read_page",
      "screenshot",
      "find",
      "click",
      "right_click",
      "double_click",
      "triple_click",
      "hover",
      "drag",
      "type",
      "key",
      "scroll",
      "form_input",
      // 004/T139: acting by position has a worker handler now, so it is offered like any other.
      "computer",
      "browser_batch",
      "wait",
      "read_console",
      "read_network",
      "evaluate",
      "file_upload",
      // 013/S1: the *host* answers this one - every refusal it can take is decided before the call
      // crosses the link - so it is offered from the slice that adds the interception.
      "upload_image",
      // 008/S3: the worker records a session and writes the GIF, so the tool is offered.
      "gif_recorder",
      // 008/S4: the worker hears the page's dialogs and answers them, so it is offered too - and
      // the pending list is empty again, which is the state it should usually be in.
      "dialog",
    ]);
  });

  it("registers from the implemented list rather than from the descriptor table", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    const names = await client.listToolNames();

    // Registration is a *filter* over the table, and the filter is what this pins. 008/S1 declares
    // two tools a slice before their runners, so "held back" is now a state somebody names rather
    // than one a missing handler falls into: a descriptor that is neither implemented nor on the
    // pending list goes red here, where it is decided, instead of in an agent's wasted call.
    const described = AGENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);
    expect(
      described.filter((name) => !names.includes(name) && !PENDING_AGENT_TOOL_NAMES.has(name)),
    ).toEqual([]);
    // And the pending ones really are held back, which is the other half of the promise.
    for (const pending of PENDING_AGENT_TOOL_NAMES) {
      expect(names, `${pending} has no worker handler yet`).not.toContain(pending);
    }
  });

  /**
   * 004/T105 - a refusal reaches the agent with the evidence it needs to act on it.
   *
   * `held-by-session` without the session is `not-yours` with extra syllables: the whole reason the
   * code exists is that "wait for that agent" and "claim it" are different next moves. The stable
   * code stays the thing an agent branches on; the structured refusal travels beside it.
   */
  it("carries a refusal's evidence to the agent, not just its code", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_claim: {
          callId: "",
          outcome: "denied",
          reason: "held-by-session",
          refusal: { reason: "held-by-session", sessionId: "session-other" },
        },
      },
    });

    const result = await client.callTool("tabs_claim", { tabId: 7 });

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      outcome: "denied",
      reason: "held-by-session",
      refusal: { reason: "held-by-session", sessionId: "session-other" },
    });
  });

  it("asks the owner to pair, then carries tabs_context to the worker and back", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_context: { callId: "", outcome: "ok", result: [{ tabId: 12, url: "https://example.test/" }] },
      },
    });

    const pairRequest = await worker.waitForControlFrame("pair-request");
    expect(pairRequest).toEqual({
      type: "pair-request",
      // Stable across sessions, so the owner is asked once (SC-020); its value is machine-local.
      agentId: expect.stringMatching(/^[0-9a-f]{32}$/),
      // What the MCP client called itself, which is what the owner sees in the prompt.
      displayName: "Claude Code",
      origin: "stdio:local",
      // Per agent session, not per relay connection (D-M3-3): the worker adopts it so a reconnect
      // reconciles the tab group this session already owns.
      sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

    const result = await client.callTool("tabs_context");

    expect(result.isError).toBe(false);
    expect(result.json).toEqual([{ tabId: 12, url: "https://example.test/" }]);
    expect(worker.requests).toEqual([
      {
        callId: expect.stringMatching(/^[0-9a-f]{16}$/),
        // 004: the session the server minted at `initialize`, on every call frame.
        sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
        tool: "tabs_context",
        args: {},
      },
    ]);
  });

  it("answers denied/not-paired when the owner declines, and keeps answering it", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "decline" });
    await worker.waitForControlFrame("pair-request");

    const first = await client.callTool("tabs_context");
    const second = await client.callTool("tabs_context");

    expect(first.isError).toBe(true);
    expect(first.json).toEqual({ outcome: "denied", reason: "not-paired" });
    expect(second.json).toEqual({ outcome: "denied", reason: "not-paired" });
    // Nothing was forwarded: an unpaired agent never reaches the browser at all.
    expect(worker.requests).toEqual([]);
  });

  /**
   * 004/T094 - the greeting travels the other way now: the server presents the relay's token and
   * waits to be acknowledged. Nothing it has to say reaches the worker before that, so a relay that
   * refuses the greeting never sees a pairing prompt raised for this agent.
   */
  it("asks for nothing until a relay has acknowledged its greeting", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      // A relay demanding a token that is not the one in its record: the server's greeting cannot
      // match it, so it is never acknowledged.
      env: { LOCALAPPDATA: dataDir },
      token: "0".repeat(64),
    });

    await expect(worker.waitForControlFrame("pair-request", 500)).rejects.toThrow(/timed out/);
    expect(worker.controlFrames).toEqual([]);
  });

  /**
   * 004/R-111 - the two ways a call can have nowhere to go, told apart.
   *
   * 003 answered `bridge-unavailable` to a second agent session whose record the first had
   * overwritten (the owner's E1), which is why the code has to mean one thing now: no relay at all.
   * A relay that published a port and is simply not attached to *this* session is `bridge-lost`,
   * and the difference is what tells an agent whether trying again in a moment is worth anything.
   */
  it("tells the agent the bridge is unavailable when no relay has published a record", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });

    const result = await client.callTool("tabs_context");

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ outcome: "failed", reason: "bridge-unavailable" });
  });

  it("tells the agent the bridge is lost when a relay is published but not attached", async () => {
    client = await startMcpClient({
      // 004/T094b: a call with a record on disk now waits for the attach, so this session - which
      // will never be acknowledged - is given a bound it can wait out inside a test.
      env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "300" },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, token: "0".repeat(64) });
    // The record is there and names a live relay; this session just never got onto it.
    await expect(worker.waitForControlFrame("pair-request", 500)).rejects.toThrow(/timed out/);

    const result = await client.callTool("tabs_context");

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ outcome: "failed", reason: "bridge-lost" });
  });

  /**
   * 004/T094b - a session's first call must not race its own dial (FR-055).
   *
   * The packaged journey issues two sessions' first calls together, so the second arrives while its
   * own dial is still in flight; answering `bridge-lost` on the spot made the contract depend on a
   * human being slow enough for the pairing prompt to give the first session a head start. A record
   * on disk means a link *is* coming, so the call waits for it, bounded by the FR-057 recovery
   * bound. Nothing on disk still fails at once: there is nothing to wait for.
   */
  it("holds a first call until its own dial attaches, then runs it (T094b)", async () => {
    client = await startMcpClient({
      // The dial's first attempt finds nothing and the next one is a second and a half away, which
      // is the window the relay is published in - the same shape as a browser starting late.
      env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "1500", HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "10000" },
    });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_context: { callId: "", outcome: "ok", result: [{ tabId: 7, url: "https://late.test/" }] },
      },
    });
    // The state this is about: the relay is published, and this session has not reached it yet - no
    // greeting has been acknowledged, so no pairing prompt has been raised.
    expect(worker.controlFrames).toEqual([]);

    const result = await client.callTool("tabs_context");

    expect(result.isError).toBe(false);
    expect(result.json).toEqual([{ tabId: 7, url: "https://late.test/" }]);
  });

  it("fails a call with no record at once rather than waiting out the bound (T094b)", async () => {
    client = await startMcpClient({
      env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "5000" },
    });

    const started = Date.now();
    const result = await client.callTool("tabs_context");

    expect(result.json).toEqual({ outcome: "failed", reason: "bridge-unavailable" });
    // Nothing published a port, so nothing is coming: the agent is told now, not in five seconds.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  /**
   * 004/T162 - a call already sent to the relay is answered honestly when the link drops before its
   * answer arrives.
   *
   * `bridge-lost` is the right word when a call never left this process - the two tests above are
   * exactly that. This call reached the relay: the worker may have run it, or even delivered its
   * effect to the page, before the socket closed. `bridge-lost` invites a blind retry, which is only
   * safe when nothing happened - so this case needs its own word, in the same spirit as
   * `target-unconfirmed`, that says the outcome is unknown rather than implying it is safe to redo.
   */
  it("answers a call already sent to the relay honestly when the link drops mid-call (T162)", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      // The worker receives the call and never answers it - standing in for a relay superseded
      // mid-call whose drain bound passed with the worker's answer still not in hand.
      answers: { tabs_context: "hang" },
    });
    await worker.waitForControlFrame("pair-request");

    const pending = client.callTool("tabs_context");
    await waitForCondition(() => worker!.requests.length > 0, "the call to reach the relay");
    await worker.close();

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ outcome: "failed", reason: "call-unconfirmed" });
  });

  /**
   * 006 FR-087 (S1 review) - the owner pressed Stop on the panel. The worker forgot the session,
   * but this process is still paired and still attached, so its next call is told
   * `session-ended` rather than `not-paired`. It greets the relay again under its own id - the
   * worker takes that as a new session - asks to pair again (answered at once, the agent is still
   * paired) and retries the call once. The agent goes on without restarting anything.
   */
  it("greets again as a new session and retries the call once when the worker says the session ended", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_context: ({ callId }) =>
          worker!.hellos.length < 2
            ? { callId, outcome: "denied", reason: "session-ended" }
            : { callId, outcome: "ok", result: [{ tabId: 12, url: "https://example.test/" }] },
      },
    });
    await worker.waitForControlFrame("pair-request");

    const result = await client.callTool("tabs_context");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual([{ tabId: 12, url: "https://example.test/" }]);
    // One greeting per attach, one more for the new session, on the same link and under the same
    // id (the relay keys one socket to one id); a pairing request after each.
    expect(worker.hellos.map((hello) => hello.sessionId)).toEqual([worker.hellos[0]?.sessionId, worker.hellos[0]?.sessionId]);
    expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(2);
    expect(worker.requests.map((request) => request.tool)).toEqual(["tabs_context", "tabs_context"]);
    expect(worker.requests[1]?.sessionId).toBe(worker.requests[0]?.sessionId);

    // The retry is one: a worker that says it again is answered as it said.
    worker.hellos.length = 0;
    const again = await client.callTool("tabs_context");
    expect(again.isError).toBe(true);
    expect(again.json).toEqual({ outcome: "denied", reason: "session-ended" });
  });

  /**
   * The M2 review's pairing findings. Each of them is about *this* session's answer: which agent an
   * answer is about, whether a late answer still counts, and what the agent is told when the link
   * goes away while the owner is still deciding.
   */
  describe("pairing answers belong to one agent and one link", () => {
    const TABS = {
      tabs_context: { callId: "", outcome: "ok" as const, result: [{ tabId: 3, url: "https://a.test/" }] },
    };

    it("ignores a pair-result about another agent (A1)", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: TABS });
      const paired = (await worker.waitForControlFrame("pair-request")) as { sessionId: string };
      await expect(client.callTool("tabs_context")).resolves.toMatchObject({ isError: false });

      // An unpair of a *different* agent arrives as a decline naming that agent. It is not this
      // session's answer, so this session stays paired.
      worker.send({
        type: "pair-result",
        agentId: "some-other-agent",
        sessionId: paired.sessionId,
        accepted: false,
      });

      const after = await client.callTool("tabs_context");
      expect(after.isError).toBe(false);
      expect(after.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    it("re-settles on a pair-result that arrives after the prompt timed out (A2i)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "100" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForControlFrame("pair-request");

      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });

      const agentId = (request as { agentId: string }).agentId;
      worker.send({
        type: "pair-result",
        agentId,
        sessionId: (request as { sessionId: string }).sessionId,
        accepted: true,
      });

      // The owner answered late. The next call must not still be reading the timed-out answer.
      await expect(
        (async () => (await client?.callTool("tabs_context"))?.json)(),
      ).resolves.toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    it("holds a call for the owner and releases it on the answer (A2ii)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForControlFrame("pair-request");

      const pending = client.callTool("tabs_context");
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Nothing may reach the browser while the owner is still being asked.
      expect(worker.requests).toEqual([]);

      worker.send({
        type: "pair-result",
        agentId: (request as { agentId: string }).agentId,
        sessionId: (request as { sessionId: string }).sessionId,
        accepted: true,
      });

      const held = await pending;
      expect(held.isError).toBe(false);
      expect(held.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    /**
     * 004/T099a — a link that drops while the owner is deciding is no longer the call's failure.
     *
     * In 003 a dropped relay ended the session, so settling the pairing `bridge-closed` was the
     * truth. FR-057 makes the link come back without the owner doing anything, so the exchange the
     * drop interrupted is re-requested on the next attach and the call the owner is still deciding
     * about waits for the answer they are about to give. The owner's E1 arrived exactly this way:
     * both sessions' first call answered `bridge-closed` at session start, for a link that healed.
     */
    it("re-requests a pairing its link dropped on and lets the held call continue (T099a)", async () => {
      client = await startMcpClient({
        env: {
          LOCALAPPDATA: dataDir,
          HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000",
          // The relay comes back a moment later, so the dial must not sit out a whole cadence.
          HALLPASS_AGENT_DIAL_RETRY_MS: "300",
        },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
      await worker.waitForControlFrame("pair-request");

      const pending = client.callTool("tabs_context");
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The link goes away while the owner is still looking at the prompt.
      await worker.close();

      // Chrome respawns the relay on its own (FR-057); this one carries the owner's yes.
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: TABS,
      });

      const held = await pending;
      expect(held.isError, held.text).toBe(false);
      expect(held.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    /**
     * The other half of T099a: the failure that is still real. Nothing comes back, so the pairing
     * bound passes with no answer - and the agent is told nobody answered, never that the owner
     * refused (`:154`). A drop and a decision stay different facts; only the word for a drop moved.
     */
    it("fails a held call as timed-out, not denied, when no link comes back (A6/T099a)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "1500" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
      await worker.waitForControlFrame("pair-request");

      const pending = client.callTool("tabs_context");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await worker.close();
      worker = undefined;

      const dropped = await pending;
      expect(dropped.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
    });

    /**
     * 003/D-M3-4 ("refuses a second relay while one is attached") lived here and is retired by
     * 004/R-111: there is one relay and N servers now, and a server holds one dialled link rather
     * than accepting connections at all, so a "second relay" is not a state this process can be in.
     * The property that replaced it - two servers on one relay, each getting only its own answers -
     * is proven against the real relay process in `relay-process.test.ts`.
     */

    /**
     * 003/M4 Part A — the worker has to be able to tell "the relay blinked" from "the agent left".
     *
     * Only the second releases the session's tabs and un-marks its group, and only this process
     * knows which happened: the relay sees a socket close either way. A `stop` naming the session
     * and no call is that announcement; the router's per-call backstop names a `callId` and means
     * something else entirely (D-M3-1).
     */
    it("tells the worker its session ended when the agent closes the server", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: TABS });
      const paired = (await worker.waitForControlFrame("pair-request")) as { sessionId: string };

      await client.close();
      client = undefined;

      const stop = await worker.waitForControlFrame("stop");
      expect(stop).toEqual({ type: "stop", sessionId: paired.sessionId });
    });

    /**
     * 003/T063 — the host is what reads a file (US7, FR-051).
     *
     * The agent names paths; the worker is handed bytes. Both halves are asserted from outside: an
     * allowed file crosses the link as base64 with no path anywhere in the frame, and a path outside
     * every configured root never reaches the browser at all - refused, and said out loud in the
     * host's own stable code, before anything was opened.
     */
    it("reads an allowed file and sends bytes, never a path (US7)", async () => {
      const root = join(dataDir, "uploads");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "receipt.txt"), "hello", "utf8");
      await mkdir(join(dataDir, "hallpass"), { recursive: true });
      await writeFile(
        join(dataDir, "hallpass", "config.json"),
        JSON.stringify({ uploadRoots: [root] }),
        "utf8",
      );
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: {
          file_upload: { callId: "", outcome: "ok" as const, result: { files: [{ name: "receipt.txt", size: 5 }] } },
        },
      });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("file_upload", {
        tabId: 3,
        ref: "tgt-1",
        paths: [join(root, "receipt.txt")],
      });

      expect(result.isError, result.text).toBe(false);
      expect(worker.requests).toEqual([
        {
          callId: expect.stringMatching(/^[0-9a-f]{16}$/),
          sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
          tool: "file_upload",
          tabId: 3,
          args: {
            tabId: 3,
            ref: "tgt-1",
            files: [{ name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" }],
          },
        },
      ]);
      // Not merely absent from the arguments: nowhere in the frame at all.
      expect(JSON.stringify(worker.requests)).not.toContain("uploads");
    });

    it("refuses a path outside the owner's roots without reading it (US7 scenario 2)", async () => {
      const outside = join(dataDir, "private");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "diary.txt"), "not for the agent", "utf8");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept" });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("file_upload", {
        tabId: 3,
        ref: "tgt-1",
        paths: [join(outside, "diary.txt")],
      });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({ outcome: "denied", reason: "upload-not-allowed" });
      // Nothing crossed the link, and the host said which rule refused it - a code, not the path.
      expect(worker.requests).toEqual([]);
      expect(client.stderr()).toContain("agent.upload.refused outside-roots");
      expect(client.stderr()).not.toContain("diary");
    });

    it("clamps an over-long display name and agent id to the contract's bound (A6)", async () => {
      await mkdir(join(dataDir, "hallpass"), { recursive: true });
      await writeFile(join(dataDir, "hallpass", "agent-id"), `${"a".repeat(300)}\n`, "utf8");
      client = await startMcpClient({
        clientName: "N".repeat(300),
        env: { LOCALAPPDATA: dataDir },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });

      const request = (await worker.waitForControlFrame("pair-request")) as {
        agentId: string;
        displayName: string;
      };
      expect(request.displayName).toHaveLength(128);
      expect(request.agentId).toHaveLength(128);
    });
  });

  /**
   * 013/T329 (US1, US3) — the id on a picture, and `upload_image` answered by the host alone.
   *
   * Every assertion here is made from outside the process, because the claim is about what the
   * *agent* is handed and what crosses the link: the picture's id travels on the screenshot's text
   * block, and a refusal for an id the host cannot resolve is decided before anything reaches the
   * browser. That is the same shape `file_upload` has - the host is the end that holds the bytes -
   * and it is why an id never appears in a frame at all.
   */
  describe("the screenshot's id and the upload_image interception (013)", () => {
    const PICTURE = "iVBORw0KGgoAAAANSUhEUg==";
    const UPLOAD_SENTENCE = "Quote imageId to upload_image to put this picture into a page (kept 5 minutes).";
    const TOO_LARGE_SENTENCE =
      "Too large to retain for upload_image; a smaller screenshot (scale or region) can be.";

    const SHOT = {
      screenshot: { callId: "", outcome: "ok" as const, result: { mimeType: "image/png", data: PICTURE, cropped: false } },
      computer: { callId: "", outcome: "ok" as const, result: { mimeType: "image/png", data: PICTURE, cropped: false } },
      upload_image: {
        callId: "",
        outcome: "ok" as const,
        result: { delivery: "input" as const, file: { name: "screenshot.png", size: 17 } },
      },
    };

    /** The screenshot's own id, read the way an agent reads it: off the answer's text block. */
    async function takePicture(tool: "screenshot" | "computer"): Promise<{ imageId: string; upload: string }> {
      const args = tool === "screenshot" ? { tabId: 3 } : { tabId: 3, action: "screenshot" };
      const shot = await client!.callTool(tool, args);
      expect(shot.isError, shot.text).toBe(false);
      expect(shot.images).toEqual([{ data: PICTURE, mimeType: "image/png" }]);
      return shot.json as { imageId: string; upload: string };
    }

    it("puts an id and the upload sentence on both kinds of screenshot answer (FR-167)", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");

      // `toolReply` recognises a picture by its shape, not by the tool's name, so the action that
      // an agent aiming by coordinate uses has to come out with the same id as the tool does.
      const plain = await takePicture("screenshot");
      const computed = await takePicture("computer");

      for (const answer of [plain, computed]) {
        expect(answer.imageId).toMatch(/^img_[a-z0-9]{10}$/u);
        expect(answer.upload).toBe(UPLOAD_SENTENCE);
      }
      // Two pictures, two ids: an id names one answer, never "the last screenshot".
      expect(plain.imageId).not.toBe(computed.imageId);
      // The bytes stay out of the text block, as they have since the S9 probe.
      expect(JSON.stringify(plain)).not.toContain(PICTURE);
    });

    it("still gives an id to a picture it could not keep, and says why (FR-172)", async () => {
      client = await startMcpClient({
        // A budget no real picture would breach, so the oversize answer can be read in a unit test;
        // the constant stands when the variable is unset (S3/T341 uses the same two overrides).
        env: { LOCALAPPDATA: dataDir, HALLPASS_SCREENSHOT_BUDGET_CHARS: "8" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");

      const answer = await takePicture("screenshot");

      // The id is issued either way: an agent told on the spot why this one cannot be uploaded
      // learns the rule without spending a call to find out.
      expect(answer.imageId).toMatch(/^img_[a-z0-9]{10}$/u);
      expect(answer.upload).toBe(TOO_LARGE_SENTENCE);

      const refused = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });
      expect(refused.isError).toBe(true);
      expect(refused.json).toEqual({
        outcome: "denied",
        reason: "image-no-longer-available (oversize); take a new screenshot",
      });
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
    });

    it("refuses an id it never issued before anything reaches the browser", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("upload_image", { tabId: 3, imageId: "img_a1b2c3d4e5", ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      // The whole point of deciding it here: the page is never touched, and the consent card the
      // worker would raise for an upload is never raised for a call that cannot happen.
      expect(worker.requests).toEqual([]);
      expect(client.stderr()).toContain("agent.upload-image.refused unknown-image-id");
    });

    it("refuses a picture whose five minutes have passed", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_SCREENSHOT_RETENTION_MS: "1" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");

      const answer = await takePicture("screenshot");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({
        outcome: "denied",
        // Not `unknown-image-id`: the host did issue this id, and "take a new screenshot" is a
        // different next move from "you are quoting an id from somewhere else".
        reason: "image-no-longer-available (expired); take a new screenshot",
      });
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
      expect(client.stderr()).toContain("agent.upload-image.refused expired");
    });

    it("turns a live id into bytes and a target, and carries no id across the link", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      const byRef = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(byRef.isError, byRef.text).toBe(false);
      expect(worker.requests[1]).toEqual({
        callId: expect.stringMatching(/^[0-9a-f]{16}$/),
        sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
        tool: "upload_image",
        tabId: 3,
        args: {
          tabId: 3,
          target: { ref: "tgt-1" },
          // Byte-identical to the picture the agent was handed, under the default name.
          file: { name: "screenshot.png", type: "image/png", bytesBase64: PICTURE },
        },
      });
      // Not merely absent from the arguments: the id is nowhere in the frame, because the worker has
      // no id to resolve and must not be able to name one.
      expect(JSON.stringify(worker.requests[1])).not.toContain(answer.imageId);

      // The same picture again, at a point and under the agent's own name - taking does not spend it.
      const byPoint = await client.callTool("upload_image", {
        tabId: 3,
        imageId: answer.imageId,
        coordinate: { x: 120, y: 340 },
        filename: "evidence.png",
      });

      expect(byPoint.isError, byPoint.text).toBe(false);
      expect(worker.requests[2]?.args).toEqual({
        tabId: 3,
        target: { coordinate: { x: 120, y: 340 } },
        file: { name: "evidence.png", type: "image/png", bytesBase64: PICTURE },
      });
    });

    it("refuses a call that names both a ref and a coordinate, or neither", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      const both = await client.callTool("upload_image", {
        tabId: 3,
        imageId: answer.imageId,
        ref: "tgt-1",
        coordinate: { x: 1, y: 2 },
      });
      const neither = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId });

      // The MCP input schema cannot carry "exactly one of", so the host is where it becomes a
      // refusal - and it is the last place the id still exists, so it is the right place.
      for (const result of [both, neither]) {
        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "failed", reason: "invalid-arguments" });
      }
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
    });

    /**
     * R-180, as R-184 amended it — the ways a session loses its pictures, each observed through the
     * agent's own answer. In every one of them the honest word is `unknown-image-id`: the issued set
     * goes with the bytes, so the host is not claiming to have forgotten a picture it now knows
     * nothing about.
     *
     * What R-184 changed is the *link* case. A dropped socket is no longer one of them on its own:
     * a recycled service worker takes the relay down with it, and FR-168 promises the retention
     * survives that. The browser run the worker names on its pairing answer is what separates the
     * recycling from a browser that exited, and a worker that names none is answered as before.
     */
    const RUN_A = "run-aaaaaaaa";
    const RUN_B = "run-bbbbbbbb";

    it("keeps its pictures when the same browser run re-links after a drop (F4, FR-168)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: SHOT,
        browserRunId: RUN_A,
      });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      // Chrome recycled the service worker, which killed the native host and this link with it; the
      // browser is the same one, so the next worker greets under the same run.
      await worker.close();
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: SHOT,
        browserRunId: RUN_A,
      });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError, result.text).toBe(false);
      // The picture crossed the *new* link: the retention outlived the port, which is what SC-097's
      // worker-restart half asks for.
      expect(worker.requests.map((request) => request.tool)).toEqual(["upload_image"]);
    });

    it("forgets its pictures when a different browser run takes the link over", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: SHOT,
        browserRunId: RUN_A,
      });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      await worker.close();
      // The browser exited and was started again: `chrome.storage.session` went with it, so the
      // worker mints a new run - which is the fact this process reads "the browser exited" off.
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: SHOT,
        browserRunId: RUN_B,
      });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests).toEqual([]);
    });

    it("forgets its pictures when a worker that names no browser run re-links", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      await worker.close();
      // An extension from before R-184 says nothing about its run, so this process cannot tell a
      // recycling from a restart and keeps 013's original answer: the pictures go with the link.
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForControlFrame("pair-request");

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests).toEqual([]);
    });

    it("forgets its pictures when the worker says the session ended", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: {
          ...SHOT,
          // The owner pressed Stop on the card: the worker forgot the session, so the host greets
          // again as a new one (006 FR-087) and retries the call once. The retried call belongs to
          // a session that never took this picture.
          upload_image: ({ callId }) => ({ callId, outcome: "denied", reason: "session-ended" }),
        },
      });
      await worker.waitForControlFrame("pair-request");
      const answer = await takePicture("screenshot");

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      // The first attempt crossed the link, the retry never did: the cache was cleared between them.
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot", "upload_image"]);
    });

    it("forgets its pictures when the owner unpairs the agent", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      const request = (await worker.waitForControlFrame("pair-request")) as {
        agentId: string;
        sessionId: string;
      };
      const answer = await takePicture("screenshot");

      // An unpair arrives as a decline naming this agent (FR-032); pairing again afterwards is the
      // owner's own doing, and is what makes the picture's absence observable rather than hidden
      // behind `not-paired`.
      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: false });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const unpaired = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });
      expect(unpaired.json).toEqual({ outcome: "denied", reason: "not-paired" });

      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
    });
  });
});

/**
 * 013/T337 (S2c review F3) — the two bounds a test may shorten, and what a mistyped one does.
 *
 * The overrides exist so a gate run need not wait five minutes for a picture to expire (T341). The
 * rule worth pinning is the fall-back: anything that is not a positive finite number leaves the
 * product's own bound standing, because each of the alternatives would reach the cache as a bound
 * of its own - `NaN` expires every picture on the next sweep, `0` keeps none at all, and a negative
 * retention is a window that closed before the picture arrived. A pure function, so it is asserted
 * directly rather than through a spawned process whose behaviour would be five minutes wide.
 */
describe("T337 the screenshot cache's environment overrides", () => {
  it("takes a positive number and falls back to the default for anything else", () => {
    expect(positiveEnv(SCREENSHOT_RETENTION_ENV, { [SCREENSHOT_RETENTION_ENV]: "1500" })).toBe(1_500);
    expect(positiveEnv(SCREENSHOT_BUDGET_ENV, { [SCREENSHOT_BUDGET_ENV]: "4096" })).toBe(4_096);

    for (const raw of ["abc", "0", "-5", ""]) {
      expect(positiveEnv(SCREENSHOT_RETENTION_ENV, { [SCREENSHOT_RETENTION_ENV]: raw }), raw).toBeUndefined();
      expect(positiveEnv(SCREENSHOT_BUDGET_ENV, { [SCREENSHOT_BUDGET_ENV]: raw }), raw).toBeUndefined();
    }
    // Unset is the shipping case: the module's own five minutes and eight mebibytes stand.
    expect(positiveEnv(SCREENSHOT_RETENTION_ENV, {})).toBeUndefined();
    expect(positiveEnv(SCREENSHOT_BUDGET_ENV, {})).toBeUndefined();
  });
});

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
