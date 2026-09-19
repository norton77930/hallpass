import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_DESCRIPTORS } from "@hallpass/contracts";
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
});

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
