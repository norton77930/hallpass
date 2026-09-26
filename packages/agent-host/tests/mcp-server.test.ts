import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentToolArgSchemas,
  AGENT_015_REASON_OUTCOMES,
  AGENT_TOOL_DESCRIPTORS,
  ATTENTION_SENTENCES,
  INTERRUPT_HINTS,
  PAIRING_DECLINED_MARKER,
  PAIRING_REFUSAL_HINTS,
  type AgentToolName,
} from "@hallpass/contracts";
import {
  positiveEnv,
  splitRememberableDirectories,
  SCREENSHOT_BUDGET_ENV,
  SCREENSHOT_RETENTION_ENV,
  UPLOAD_CONSENT_BOUND_ENV,
} from "../src/mcp-server.js";
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

  /**
   * 004 FR-059a - only a tool call raises a pairing request.
   *
   * Connecting is not asking: with several agent windows open, a card per connect put questions in
   * front of the owner that nobody had asked. The link comes up and nothing is sent; the first call
   * raises the request, and for an agent the owner has already paired the worker answers it at once,
   * so that call goes straight through.
   */
  it("asks the owner to pair on the first call, not on connect, then carries tabs_context both ways", async () => {
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_context: { callId: "", outcome: "ok", result: [{ tabId: 12, url: "https://example.test/" }] },
      },
    });

    // Initialised and attached, and no tool called: nothing has been put in front of the owner.
    await worker.waitForHello();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toEqual([]);

    const result = await client.callTool("tabs_context");

    const pairRequest = await worker.waitForControlFrame("pair-request");
    expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(1);
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
      // No `requestId`: this worker has not advertised `pair-withdraw` (015 FR-219), so the
      // request is the shape a 0.7.0 worker parses.
    });

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

  /**
   * 003 FR-032a - a refusal that does not say it was a decline is an unpair.
   *
   * That is every refusal an extension from before the amendment sends, and the unpair an extension
   * after it sends: the session answers `denied` to every later call without asking again, and the
   * hint names reconnecting as the way back.
   */
  it("answers an unmarked refusal as an unpair: not-paired with the reconnect hint, every call", async () => {
    client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "decline" });
    await worker.waitForHello();

    const first = await client.callTool("tabs_context");
    const second = await client.callTool("tabs_context");

    const unpaired = { outcome: "denied", reason: "not-paired", hint: PAIRING_REFUSAL_HINTS.unpaired };
    expect(first.isError).toBe(true);
    expect(first.json).toEqual(unpaired);
    expect(second.json).toEqual(unpaired);
    // Nothing was forwarded: an unpaired agent never reaches the browser at all, and it was not
    // asked about again either.
    expect(worker.requests).toEqual([]);
    expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(1);
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
    await worker.waitForHello();

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
    await worker.waitForHello();

    const result = await client.callTool("tabs_context");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual([{ tabId: 12, url: "https://example.test/" }]);
    // One greeting per attach, one more for the new session, on the same link and under the same
    // id (the relay keys one socket to one id); a pairing request from each attempt of the call,
    // because only a call raises one (FR-059a) and the retry is the first call of the new session.
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
      const paired = await worker.waitForHello();
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

    /**
     * Also 015 FR-219: the late answer names no `requestId` - a 0.7.0 worker's answer - and is
     * applied exactly as 0.7.0 applied it, withdrawal or not.
     */
    it("re-settles on a pair-result that arrives after the prompt timed out (A2i)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "100" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForHello();

      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });

      worker.send({
        type: "pair-result",
        agentId: request.agentId,
        sessionId: request.sessionId,
        accepted: true,
      });

      // The owner answered late. The next call must not still be reading the timed-out answer.
      await expect(
        (async () => (await client?.callTool("tabs_context"))?.json)(),
      ).resolves.toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    /**
     * 003 FR-032a, acceptance scenario 6 - the owner's decline answers the request it was raised
     * for and nothing after it.
     *
     * The owner's demo of 2026-09-23: one decline left nine open sessions refusing every call with
     * an unexplained `not-paired`. The waiting call ends `denied` with a hint that says the owner
     * declined and not to ask again unasked; the next call raises a fresh request, and an accept of
     * that one lets it through.
     */
    it("ends the waiting call on the owner's decline, and asks afresh on the next call (FR-032a)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      // The call raises the request (FR-059a); the owner declines that one.
      await worker.waitForControlFrame("pair-request");
      worker.send({
        type: "pair-result",
        agentId: request.agentId,
        sessionId: request.sessionId,
        accepted: false,
        features: ["upload-consent", PAIRING_DECLINED_MARKER],
      });

      const declined = await pending;
      expect(declined.json).toEqual({ outcome: "denied", reason: "not-paired", hint: PAIRING_REFUSAL_HINTS.declined });

      const next = client.callTool("tabs_context");
      await waitForCondition(
        () => worker!.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
        "a fresh pair-request after the decline",
      );
      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: true });

      const answered = await next;
      expect(answered.isError, answered.text).toBe(false);
      expect(answered.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    /**
     * A decline that arrives after its request was withdrawn (FR-059) answers nothing: there is no
     * request left for it to be the answer to, so the next call still asks the owner.
     */
    it("does not let a late decline of a withdrawn request refuse the next one (FR-032a)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForHello();
      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });

      worker.send({
        type: "pair-result",
        agentId: request.agentId,
        sessionId: request.sessionId,
        accepted: false,
        features: [PAIRING_DECLINED_MARKER],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const next = client.callTool("tabs_context");
      await waitForCondition(
        () => worker!.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
        "a fresh pair-request after the late decline",
      );
      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: true });

      const answered = await next;
      expect(answered.isError, answered.text).toBe(false);
      expect(answered.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
    });

    it("holds a call for the owner and releases it on the answer (A2ii)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const request = await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      await worker.waitForControlFrame("pair-request");
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Nothing may reach the browser while the owner is still being asked.
      expect(worker.requests).toEqual([]);

      worker.send({
        type: "pair-result",
        agentId: request.agentId,
        sessionId: request.sessionId,
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
      await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      await worker.waitForControlFrame("pair-request");
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
      // The re-request on the new link is the waiting call's own, carried over - not a connect
      // raising one of its own (FR-059a): one request, for the one call that is still waiting.
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(1);
    });

    /**
     * T099a twice over (review follow-up 2026-09-24): the carried-over request is re-sent on *every*
     * attach, once per attach, and the held call is still the one the owner's eventual answer settles.
     */
    it("keeps a call parked on pairing across two relay drops, one pair-request per attach (T099a, FR-059a)", async () => {
      client = await startMcpClient({
        env: {
          LOCALAPPDATA: dataDir,
          HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000",
          HALLPASS_AGENT_DIAL_RETRY_MS: "300",
        },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
      await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      await worker.waitForControlFrame("pair-request");
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request"), "first attach").toHaveLength(1);
      await worker.close();

      // The second relay also goes away before the owner answers.
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
      await worker.waitForControlFrame("pair-request");
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request"), "second attach").toHaveLength(1);
      await worker.close();

      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: TABS,
      });

      const held = await pending;
      expect(held.isError, held.text).toBe(false);
      expect(held.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request"), "third attach").toHaveLength(1);
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
      await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      await worker.waitForControlFrame("pair-request");
      await worker.close();
      worker = undefined;

      const dropped = await pending;
      expect(dropped.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
    });

    /**
     * 015 FR-216 review finding - a withdrawal the link could not carry is not logged as sent.
     *
     * The bound passes with no relay attached, so the frame goes nowhere; the log is what an owner's
     * diagnostics read, and "sent" there would claim a card was taken down that nobody told.
     */
    it("logs a withdrawal it could not send as unsent (FR-216)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "1500" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });
      await worker.waitForHello();

      const pending = client.callTool("tabs_context");
      await worker.waitForControlFrame("pair-request");
      await worker.close();
      worker = undefined;

      await pending;
      await waitForCondition(() => client!.stderr().includes("agent.pair.withdraw-unsent"), "the unsent withdrawal logged");
      expect(client.stderr()).not.toContain("agent.pair.withdraw-sent");
    });

    /**
     * 015 FR-219 - version skew in the upgrade window: new host, extension not reloaded yet.
     *
     * A 0.7.0 worker parses `pair-request` with a strict schema, so a `requestId` it never heard of
     * made it drop the whole frame: no card, and every call timed out (measured 8/8 in S4). The id is
     * sent only once the worker has said, on a `pair-result`, that it takes `pair-withdraw`; until
     * then the request is byte-for-byte what 0.7.0 sent, and the withdrawal names no exchange.
     */
    it("sends a 0.7.0 worker the 0.7.0 pair-request, and names the exchange once pair-withdraw is advertised (FR-219)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const session = await worker.waitForHello();

      const first = client.callTool("tabs_context");
      const oldShape = await worker.waitForControlFrame("pair-request");
      expect(PAIR_REQUEST_070.safeParse(oldShape).success, JSON.stringify(oldShape)).toBe(true);
      expect(oldShape).not.toHaveProperty("requestId");

      // The owner declines that one, from a worker that now says it takes a withdrawal.
      worker.send({
        type: "pair-result",
        agentId: session.agentId,
        sessionId: session.sessionId,
        accepted: false,
        features: [PAIR_WITHDRAW_FEATURE, PAIRING_DECLINED_MARKER],
      });
      await expect(first).resolves.toMatchObject({ isError: true });

      const next = client.callTool("tabs_context");
      await waitForCondition(
        () => worker!.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
        "the next call's pair-request",
      );
      const named = worker.controlFrames.filter((frame) => frame.type === "pair-request")[1] as { requestId?: string };
      expect(named.requestId).toMatch(/^[0-9a-f]{32}$/u);
      worker.send({
        type: "pair-result",
        agentId: session.agentId,
        sessionId: session.sessionId,
        accepted: true,
        features: [PAIR_WITHDRAW_FEATURE],
        requestId: named.requestId,
      });
      const answered = await next;
      expect(answered.isError, answered.text).toBe(false);
    });

    it("withdraws an exchange that had no id without naming one (FR-219)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const session = await worker.waitForHello();

      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
      await expect(worker.waitForControlFrame("pair-withdraw")).resolves.toEqual({
        type: "pair-withdraw",
        agentId: session.agentId,
        sessionId: session.sessionId,
      });
    });

    /**
     * 015 FR-216 - the host tells the worker when it stops waiting, so the card leaves the panel.
     *
     * Until 0.8.0 the bound passing only cleared this process's state, and the owner was left
     * looking at a card whose agent had already been told nobody answered. Each exchange carries its
     * own id, and the next call's exchange a fresh one, so the two are never confused.
     */
    it("withdraws a request whose bound passed, naming its exchange, and mints a fresh id for the next (FR-216)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const session = await worker.waitForHello();
      await advertisePairWithdraw(worker, client, session);

      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
      const withdraw = await worker.waitForControlFrame("pair-withdraw");
      const [first] = worker.controlFrames.filter((frame) => frame.type === "pair-request") as Array<{
        requestId?: string;
      }>;
      expect(first!.requestId).toMatch(/^[0-9a-f]{32}$/u);
      expect(withdraw).toEqual({
        type: "pair-withdraw",
        agentId: session.agentId,
        sessionId: session.sessionId,
        requestId: first!.requestId,
      });

      await client.callTool("tabs_context");
      const requests = worker.controlFrames.filter((frame) => frame.type === "pair-request") as Array<{
        requestId?: string;
      }>;
      expect(requests).toHaveLength(2);
      expect(requests[1]!.requestId).toMatch(/^[0-9a-f]{32}$/u);
      expect(requests[1]!.requestId).not.toBe(first!.requestId);
    });

    it("withdraws an open exchange before the session's stop when the agent closes (FR-216)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "20000" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const session = await worker.waitForHello();
      await advertisePairWithdraw(worker, client, session);

      const pending = client.callTool("tabs_context").catch(() => undefined);
      const request = (await worker.waitForControlFrame("pair-request")) as { requestId?: string };
      await client.close();
      client = undefined;
      await pending;

      await worker.waitForControlFrame("stop");
      const types = worker.controlFrames.map((frame) => frame.type);
      expect(types.filter((type) => type === "pair-withdraw")).toHaveLength(1);
      expect(types.indexOf("pair-withdraw")).toBeLessThan(types.indexOf("stop"));
      expect(worker.controlFrames.find((frame) => frame.type === "pair-withdraw")).toEqual({
        type: "pair-withdraw",
        agentId: session.agentId,
        sessionId: session.sessionId,
        requestId: request.requestId,
      });
    });

    it("withdraws nothing on close when no exchange is open", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: TABS });
      await worker.waitForHello();
      await expect(client.callTool("tabs_context")).resolves.toMatchObject({ isError: false });

      await client.close();
      client = undefined;

      await worker.waitForControlFrame("stop");
      expect(worker.controlFrames.map((frame) => frame.type)).not.toContain("pair-withdraw");
    });

    /**
     * 015 FR-218 - an answer to a withdrawn card is not an answer to the request raised after it.
     *
     * Without the id, a decline the owner gave to the card that was already withdrawn settled the
     * next call's fresh exchange: the next call was refused for a request the owner never saw.
     */
    it("ignores and logs a pair-result naming a withdrawn request (FR-218)", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "1500" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: TABS });
      const session = await worker.waitForHello();
      await advertisePairWithdraw(worker, client, session);
      const unanswered = await client.callTool("tabs_context");
      expect(unanswered.json).toEqual({ outcome: "timed-out", reason: "not-paired: no answer" });
      const withdrawn = (await worker.waitForControlFrame("pair-withdraw")) as { requestId?: string };
      expect(withdrawn.requestId).toMatch(/^[0-9a-f]{32}$/u);

      const next = client.callTool("tabs_context");
      await waitForCondition(
        () => worker!.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
        "the next call's fresh pair-request",
      );
      const fresh = worker.controlFrames.filter((frame) => frame.type === "pair-request")[1] as { requestId?: string };
      worker.send({
        type: "pair-result",
        agentId: session.agentId,
        sessionId: session.sessionId,
        accepted: false,
        features: [PAIRING_DECLINED_MARKER],
        requestId: withdrawn.requestId,
      });
      await waitForCondition(() => client!.stderr().includes("agent.pair.late-ignored"), "the late answer logged");

      worker.send({
        type: "pair-result",
        agentId: session.agentId,
        sessionId: session.sessionId,
        accepted: true,
        requestId: fresh.requestId,
      });
      const answered = await next;
      expect(answered.isError, answered.text).toBe(false);
      expect(answered.json).toEqual([{ tabId: 3, url: "https://a.test/" }]);
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
      const paired = await worker.waitForHello();

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
      await worker.waitForHello();

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
      await worker.waitForHello();

      const result = await client.callTool("file_upload", {
        tabId: 3,
        ref: "tgt-1",
        paths: [join(outside, "diary.txt")],
      });

      expect(result.isError).toBe(true);
      // 014 FR-195: this worker advertised nothing, so there is nobody to ask and the refusal is
      // 0.5.0's - said in the word that tells the agent which side of the link predates the question.
      expect(result.json).toEqual({ outcome: "denied", reason: "upload-outside-allowed-directories" });
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
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_PAIRING_TIMEOUT_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore" });

      // Only a call raises the request (FR-059a).
      const pending = client.callTool("tabs_context");
      const request = (await worker.waitForControlFrame("pair-request")) as {
        agentId: string;
        displayName: string;
      };
      expect(request.displayName).toHaveLength(128);
      expect(request.agentId).toHaveLength(128);
      await pending;
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
      await worker.waitForHello();

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
      await worker.waitForHello();

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
      await worker.waitForHello();

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
      await worker.waitForHello();

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
      await worker.waitForHello();
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
      await worker.waitForHello();
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
      await worker.waitForHello();
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
      await worker.waitForHello();
      // FR-059a: re-linking is connecting, and connecting asks the owner nothing - not even for an
      // agent that is already paired.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toEqual([]);

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError, result.text).toBe(false);
      // The call raised the request, and the answer - naming the same run - arrived before the call
      // read the cache: that is the only way the picture could have been found.
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(1);
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
      await worker.waitForHello();
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
      await worker.waitForHello();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toEqual([]);

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      // FR-059a with R-184 kept: nothing was asked on the re-link, so the first call after it is the
      // one that learns the new run - and it learns it before it reads the cache, not after.
      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests).toEqual([]);
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toHaveLength(1);
    });

    it("forgets its pictures when a worker that names no browser run re-links", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForHello();
      const answer = await takePicture("screenshot");

      await worker.close();
      // An extension from before R-184 says nothing about its run, so this process cannot tell a
      // recycling from a restart and keeps 013's original answer: the pictures go with the link.
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: SHOT });
      await worker.waitForHello();

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
      await worker.waitForHello();
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
      const request = await worker.waitForHello();
      const answer = await takePicture("screenshot");

      // An unpair arrives as an unmarked refusal naming this agent (FR-032, FR-032a); pairing again afterwards is the
      // owner's own doing, and is what makes the picture's absence observable rather than hidden
      // behind `not-paired`.
      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: false });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const unpaired = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });
      expect(unpaired.json).toEqual({ outcome: "denied", reason: "not-paired", hint: PAIRING_REFUSAL_HINTS.unpaired });

      worker.send({ type: "pair-result", agentId: request.agentId, sessionId: request.sessionId, accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const result = await client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });

      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
    });

    /**
     * FR-032a beside R-180: a decline is not remembered, but it is still the owner saying no to this
     * session holding their screen. A session reaches a decline with pictures only one way - it was
     * paired, the owner unpaired it while its link was down (so the unpair never arrived), and the
     * first call after the re-link raised a card they declined (FR-059a: the re-link itself raised
     * nothing) - and those pictures go with it. The run is the same on both links, so nothing but the
     * decline can have cleared them.
     */
    it("forgets its pictures when the owner declines a request the session re-raised", async () => {
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        answers: SHOT,
        browserRunId: RUN_A,
      });
      await worker.waitForHello();
      const answer = await takePicture("screenshot");

      await worker.close();
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "ignore", answers: SHOT });
      const request = await worker.waitForHello();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toEqual([]);

      const refused = client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });
      await worker.waitForControlFrame("pair-request");
      const pairResult = { type: "pair-result", agentId: request.agentId, sessionId: request.sessionId };
      worker.send({ ...pairResult, accepted: false, browserRunId: RUN_A, features: [PAIRING_DECLINED_MARKER] });
      expect((await refused).json).toEqual({
        outcome: "denied",
        reason: "not-paired",
        hint: PAIRING_REFUSAL_HINTS.declined,
      });

      const retried = client.callTool("upload_image", { tabId: 3, imageId: answer.imageId, ref: "tgt-1" });
      await waitForCondition(
        () => worker!.controlFrames.filter((frame) => frame.type === "pair-request").length === 2,
        "a fresh pair-request after the decline",
      );
      worker.send({ ...pairResult, accepted: true, browserRunId: RUN_A });

      const result = await retried;
      expect(result.isError).toBe(true);
      expect((result.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
      expect(worker.requests).toEqual([]);
    });
  });

  /**
   * 014/T374 (US4, FR-193..195) — the question the host asks about the owner's own disk.
   *
   * Until now a path outside the configured roots was the end of the call. It is now a question,
   * and the question travels the one direction nothing else on this link travels: host to worker,
   * during a call the host is holding, because the paths are the host's to see and the panel is
   * the only place the owner can answer. Every assertion here is from outside the process - what
   * crossed the link, what the agent was told, and what is on disk afterwards - because that is
   * the whole claim: the list grows only by an answer, and only ever here.
   */
  describe("the upload directory question (014)", () => {
    /** A file nobody has allowed, and the directory an answer would add, as the host resolves them. */
    async function stageFileOutsideEveryRoot(
      name = "diary.txt",
      contents: string | Buffer = "not for the agent",
    ): Promise<{ directory: string; path: string }> {
      const directory = join(await realpath(dataDir), "private");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), contents);
      return { directory, path: join(directory, name) };
    }

    async function configuredRoots(): Promise<unknown> {
      const raw = await readFile(join(dataDir, "hallpass", "config.json"), "utf8").catch(() => "{}");
      return (JSON.parse(raw) as { uploadRoots?: unknown }).uploadRoots;
    }

    const UPLOADED = {
      file_upload: { callId: "", outcome: "ok" as const, result: { files: [{ name: "diary.txt", size: 17 }] } },
    };

    it("asks about the files, and on 'once' uploads them without widening the list", async () => {
      const outside = await stageFileOutsideEveryRoot();
      const second = join(await realpath(dataDir), "pictures");
      await mkdir(second, { recursive: true });
      await writeFile(join(second, "photo.png"), "x");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "once",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", {
        tabId: 3,
        ref: "tgt-1",
        paths: [outside.path, join(second, "photo.png")],
      });

      expect(result.isError, result.text).toBe(false);
      // One question about the call, naming every file in it and the directory each sits in.
      const asked = (await worker.waitForControlFrame("upload-consent-request")) as {
        sessionId: string;
        callId: string;
        files: Array<{ path: string; directory: string }>;
      };
      expect(asked.files).toEqual([
        { path: outside.path, directory: outside.directory },
        { path: join(second, "photo.png"), directory: second },
      ]);
      expect(asked.sessionId).toMatch(/^[0-9a-f]{32}$/u);
      // The call went, carrying bytes as any allowed upload does - and no path with them.
      expect(worker.requests.map((request) => request.tool)).toEqual(["file_upload"]);
      expect(JSON.stringify(worker.requests)).not.toContain("private");
      // "Once" is about these files and this call: nothing was written down.
      expect(await configuredRoots()).toBeUndefined();
    });

    /**
     * 004 FR-059a beside 014/R-187 §1 - what the worker can be asked is known before the call that
     * needs it, even though re-linking no longer asks for a pairing answer.
     *
     * The browser is upgraded under a live session: the first link's worker advertised nothing, the
     * second's advertises the question. The re-link raises nothing; the upload is the first call on
     * it, so its own pairing answer carries the new capability, and the question is asked.
     */
    it("learns the re-linked worker's capabilities from the first call's own pairing answer", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, HALLPASS_AGENT_DIAL_RETRY_MS: "300" },
      });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: UPLOADED });
      await worker.waitForHello();
      const before = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });
      expect(before.json).toEqual({ outcome: "denied", reason: "upload-outside-allowed-directories" });

      await worker.close();
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "once",
        answers: UPLOADED,
      });
      await worker.waitForHello();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(worker.controlFrames.filter((frame) => frame.type === "pair-request")).toEqual([]);

      const after = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(after.isError, after.text).toBe(false);
      expect(worker.controlFrames.map((frame) => frame.type)).toEqual(["pair-request", "upload-consent-request"]);
      expect(worker.requests.map((request) => request.tool)).toEqual(["file_upload"]);
    });

    it("writes the directory on 'always', and only then sends the call", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "always",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError, result.text).toBe(false);
      expect(worker.requests.map((request) => request.tool)).toEqual(["file_upload"]);
      // The file the *reader* uses, written before the upload proceeded (FR-194).
      expect(await configuredRoots()).toEqual([outside.directory]);
    });

    it("refuses in the owner's own words when they decline", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "deny",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({ outcome: "denied", reason: "upload-declined" });
      expect(worker.requests).toEqual([]);
      expect(await configuredRoots()).toBeUndefined();
    });

    it("distinguishes nobody answering from a decline, on its own bound", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({
        env: { LOCALAPPDATA: dataDir, [UPLOAD_CONSENT_BOUND_ENV]: "400" },
      });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "ignore",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({ outcome: "denied", reason: "upload-not-answered" });
      expect(worker.requests).toEqual([]);
    });

    it("answers an interrupt as a stop that refused nothing (FR-179)", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "interrupted",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({
        outcome: "stopped",
        reason: "owner-interrupted",
        // Nothing was delivered: the call never crossed the link, so there is only one honest hint.
        hint: INTERRUPT_HINTS.nothingDelivered,
      });
      expect(worker.requests).toEqual([]);
    });

    it("ends the question when the browser goes away while it stands", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      const browser = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "ignore",
        answers: UPLOADED,
      });
      worker = browser;
      await browser.waitForHello();

      const pending = client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });
      await browser.waitForControlFrame("upload-consent-request");
      await browser.close();
      worker = undefined;

      const result = await pending;
      expect(result.isError).toBe(true);
      /**
       * Not "nobody answered", and not the owner either (S3 review, the minor finding).
       *
       * The link dropped: nothing was asked of anybody in the end and nothing crossed, which is
       * the 004 vocabulary's `bridge-lost` - the same word this file answers a call that never
       * left the process with. `owner-interrupted` named a person who did nothing at all, and an
       * agent reading it would stop rather than dial again.
       */
      expect(result.json).toEqual({ outcome: "failed", reason: "bridge-lost" });
    });

    /**
     * 014/T384 (S3 review F1) — the wait the agent is not told about is a wait nobody can end.
     *
     * The directory question happens before the call crosses the link, which is exactly why it was
     * the one wait with no progress behind it: the token was registered on the way *out*, after the
     * question had already been answered. 011's promise is the same for this card as for every
     * other - the person at the terminal is told that their browser is asking, and told where to
     * click when the card is in a panel nobody opened.
     */
    it("reports the owner being asked while the directory question stands (011 FR-146)", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        // Answered by hand below, so the tick lands while the question is genuinely standing.
        uploadConsent: "ignore",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const seen: Array<{ progress: number; total?: number; message?: string }> = [];
      const pending = client.callTool(
        "file_upload",
        { tabId: 3, ref: "tgt-1", paths: [outside.path] },
        { onProgress: (update) => seen.push(update) },
      );
      const asked = (await worker.waitForControlFrame("upload-consent-request")) as {
        sessionId: string;
        callId: string;
      };

      worker.send({
        type: "prompt-waiting",
        sessionId: asked.sessionId,
        callId: asked.callId,
        kind: "ask",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 120_000,
      });
      await waitForCondition(() => seen.length >= 1, "a progress notification for the directory card");

      // The tick's own arithmetic, on this call's token - and the sentence that says where to click.
      expect(seen[0]).toEqual({ progress: 5_000, total: 120_000, message: ATTENTION_SENTENCES.consent });
      // Nothing was mis-filed: the tick was matched to the call it named.
      expect(client.stderr()).not.toContain("agent.waiting.unmatched");

      worker.send({ type: "upload-consent-result", callId: asked.callId, decision: "once" });
      const result = await pending;
      expect(result.isError, result.text).toBe(false);
    });

    it("repeats where to click on the answer, when nobody could see the card (011 FR-146)", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "ignore",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const pending = client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });
      const asked = (await worker.waitForControlFrame("upload-consent-request")) as { callId: string };

      // The worker's own bound passed with no panel to show the card in: it says so, and says where
      // the person has to click - the same sentence every other unanswered question carries.
      worker.send({
        type: "upload-consent-result",
        callId: asked.callId,
        decision: "timed-out",
        hint: ATTENTION_SENTENCES.consent,
      });

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.json).toEqual({
        outcome: "denied",
        reason: "upload-not-answered",
        hint: ATTENTION_SENTENCES.consent,
      });
      expect(worker.requests).toEqual([]);
    });

    /**
     * 014/T384 (S3 review F2) — a yes that could not be written down is its own fact.
     *
     * It used to be answered `upload-outside-allowed-directories`, which tells an agent that this
     * browser cannot raise the question - "have the owner reinstall the extension" - about an owner
     * who answered the question on the card in front of them. The list is exactly as it was, and
     * why is on their own disk, so the answer says that and carries the store's own refusal.
     */
    it("tells the agent the owner's yes could not be recorded (F2)", async () => {
      const outside = await stageFileOutsideEveryRoot();
      // Nothing can be renamed over a directory: the store's write fails with the file the reader
      // uses untouched, which is exactly the case this answer is about.
      await mkdir(join(dataDir, "hallpass", "config.json"), { recursive: true });
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "always",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError).toBe(true);
      const answer = result.json as { outcome: string; reason: string; hint?: string };
      expect(answer.outcome).toBe("denied");
      expect(answer.reason).toBe("upload-directory-not-recorded");
      // The store's own words, which are the only place the reason for it exists: the directory the
      // owner answered about, and what went wrong with it.
      expect(answer.hint).toContain(outside.directory);
      expect(answer.hint).toContain("write-failed");
      // Nothing crossed the link, and the list is still the list.
      expect(worker.requests).toEqual([]);
    });

    /**
     * 014/T384 (S3 review F3) — two sessions asking at once is not the owner doing anything.
     *
     * The worker holds one question at a time, so a second session's card is refused `busy` before
     * it is ever raised. Mapped to `interrupted` that reached the agent as `owner-interrupted` - a
     * sentence about a person who was at that moment answering somebody else's question.
     */
    it("answers a worker that is already asking about something else as busy (F3)", async () => {
      const outside = await stageFileOutsideEveryRoot();
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: () => "busy",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(result.isError).toBe(true);
      // The word every other tool of this product answers that situation with: nothing was decided,
      // nothing was refused, and the call may simply be made again.
      expect(result.json).toEqual({ outcome: "busy", reason: "prompt-pending" });
      expect(worker.requests).toEqual([]);
      expect(await configuredRoots()).toBeUndefined();
    });

    it("asks nothing about a file it would refuse whatever the answer was", async () => {
      const big = await stageFileOutsideEveryRoot("big.bin", Buffer.alloc(600_000));
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "always",
        answers: UPLOADED,
      });
      await worker.waitForHello();

      const result = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [big.path] });

      expect(result.isError).toBe(true);
      // The bound is about what a frame can carry, and no permission changes it (0.5.0's word).
      expect(result.json).toEqual({ outcome: "denied", reason: "upload-not-allowed" });
      expect(worker.controlFrames.map((frame) => frame.type)).not.toContain("upload-consent-request");
      expect(await configuredRoots()).toBeUndefined();
    });
  });

  /**
   * 015/T410 — an upload step is checked by the very check a standalone upload gets (FR-210 - FR-215).
   *
   * The pre-pass runs before the batch crosses the link, so everything here is asserted from the two
   * ends a person could observe: what the worker was sent (content, never a path or an id) and what
   * the agent was answered (the standalone answer, naming the step). A refusal sends nothing at all.
   */
  describe("015 uploads inside a batch", () => {
    const PICTURE = "iVBORw0KGgoAAAANSUhEUg==";
    const LATER_CALL_HINT = "A screenshot taken inside this batch can be uploaded in a later call.";

    /** Every step answered `ok`, the way the worker answers a batch that ran to the end. */
    const RAN = {
      screenshot: { callId: "", outcome: "ok" as const, result: { mimeType: "image/png", data: PICTURE, cropped: false } },
      file_upload: { callId: "", outcome: "ok" as const, result: { files: [{ name: "diary.txt", size: 17 }] } },
      browser_batch: (request: { callId: string; args: Record<string, unknown> }) => ({
        callId: request.callId,
        outcome: "ok" as const,
        result: {
          results: (request.args.steps as unknown[]).map((_, index) => ({ index, outcome: "ok" as const })),
        },
      }),
    };

    /** A file in a directory nobody has allowed, as the host resolves it. */
    async function stageOutside(
      directoryName: string,
      name: string,
      contents: string | Buffer = "not for the agent",
    ): Promise<{ directory: string; path: string }> {
      const directory = join(await realpath(dataDir), directoryName);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), contents);
      return { directory, path: join(directory, name) };
    }

    /** A directory the owner allowed before the session started, with the files in it. */
    async function stageAllowed(files: Record<string, string | Buffer>): Promise<string> {
      const root = join(dataDir, "uploads");
      await mkdir(root, { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(root, name), contents);
      }
      await mkdir(join(dataDir, "hallpass"), { recursive: true });
      await writeFile(join(dataDir, "hallpass", "config.json"), JSON.stringify({ uploadRoots: [root] }), "utf8");
      return root;
    }

    async function configuredRoots(): Promise<unknown> {
      const raw = await readFile(join(dataDir, "hallpass", "config.json"), "utf8").catch(() => "{}");
      return (JSON.parse(raw) as { uploadRoots?: unknown }).uploadRoots;
    }

    function consentRequests(): Array<{ callId: string; files: Array<{ path: string; directory: string }> }> {
      return worker!.controlFrames.filter((frame) => frame.type === "upload-consent-request") as never;
    }

    /** What the worker does with a batch it is sent: every step parsed by its standalone schema. */
    function expectWorkerAccepts(args: Record<string, unknown>): void {
      const batch = agentToolArgSchemas.browser_batch.safeParse(args);
      expect(batch.success, JSON.stringify(batch.error?.issues)).toBe(true);
      const { tabId, steps } = args as { tabId: number; steps: Array<{ tool: AgentToolName; args: object }> };
      for (const step of steps) {
        const parsed = agentToolArgSchemas[step.tool].safeParse({ ...step.args, tabId });
        expect(parsed.success, `${step.tool}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }

    it("sends upload steps as content, never as a path or an image id (FR-210, FR-213)", async () => {
      const root = await stageAllowed({ "receipt.txt": "hello" });
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();
      const shot = await client.callTool("screenshot", { tabId: 3 });
      const { imageId } = shot.json as { imageId: string };

      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          { tool: "file_upload", args: { ref: "tgt-1", paths: [join(root, "receipt.txt")] } },
          { tool: "upload_image", args: { imageId, ref: "tgt-2" } },
        ],
      });

      expect(result.isError, result.text).toBe(false);
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot", "browser_batch"]);
      const sent = worker.requests[1]!;
      expect(sent.args).toEqual({
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          // Exactly the standalone rewrites, less the tab: a step runs on the batch's tab.
          {
            tool: "file_upload",
            args: { ref: "tgt-1", files: [{ name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" }] },
          },
          {
            tool: "upload_image",
            args: { target: { ref: "tgt-2" }, file: { name: "screenshot.png", type: "image/png", bytesBase64: PICTURE } },
          },
        ],
      });
      expectWorkerAccepts(sent.args);
      // Not merely absent from the steps: nowhere in the frame at all.
      const frame = JSON.stringify(sent);
      expect(frame).not.toContain("uploads");
      expect(frame).not.toContain(imageId);
      expect(frame).not.toContain('"paths"');
      expect(frame).not.toContain('"imageId"');
    });

    it("asks about a step outside the allowed directories before the batch, under the batch's call", async () => {
      const outside = await stageOutside("private", "diary.txt");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "once",
        answers: RAN,
      });
      await worker.waitForHello();

      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          { tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } },
        ],
      });

      expect(result.isError, result.text).toBe(false);
      const asked = consentRequests();
      expect(asked.map((frame) => frame.files)).toEqual([[{ path: outside.path, directory: outside.directory }]]);
      // The batch's own id, so an interrupt, a stop and the waiting ticks find the question (FR-214).
      expect(asked[0]!.callId).toBe(worker.requests[0]!.callId);
      expect(worker.requests.map((request) => request.tool)).toEqual(["browser_batch"]);
      expectWorkerAccepts(worker.requests[0]!.args);
      expect(JSON.stringify(worker.requests)).not.toContain("private");
      // "Once" is about these files and this call: nothing was written down.
      expect(await configuredRoots()).toBeUndefined();
    });

    it("writes 'always' for one step before the next is resolved, so the same directory is not asked twice", async () => {
      const first = await stageOutside("private", "diary.txt");
      const second = await stageOutside("private", "notes.txt", "also private");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "always",
        answers: RAN,
      });
      await worker.waitForHello();

      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "file_upload", args: { ref: "tgt-1", paths: [first.path] } },
          { tool: "file_upload", args: { ref: "tgt-2", paths: [second.path] } },
        ],
      });

      expect(result.isError, result.text).toBe(false);
      // One question, about the first step only: the owner's own "from now on" answered the second.
      expect(consentRequests().map((frame) => frame.files.map((file) => file.path))).toEqual([[first.path]]);
      expect(await configuredRoots()).toEqual([first.directory]);
      const steps = (worker.requests[0]!.args as { steps: Array<{ args: { files: Array<{ name: string }> } }> }).steps;
      expect(steps.map((step) => step.args.files.map((file) => file.name))).toEqual([["diary.txt"], ["notes.txt"]]);
      expectWorkerAccepts(worker.requests[0]!.args);
    });

    /**
     * The same question and the same answer, once as a batch step and once standalone: the batch's
     * answer is the standalone one with the step named, and neither sent anything (FR-211, FR-212).
     */
    it.each([
      { decision: "deny" as const, reason: "upload-declined" },
      { decision: "ignore" as const, reason: "upload-not-answered" },
    ])("refuses the whole batch as a standalone call is refused on '$decision', naming the step", async ({ decision, reason }) => {
      const outside = await stageOutside("private", "diary.txt");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir, [UPLOAD_CONSENT_BOUND_ENV]: "400" } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: decision,
        answers: RAN,
      });
      await worker.waitForHello();

      const batch = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          { tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } },
        ],
      });
      const standalone = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(batch.isError).toBe(true);
      expect(standalone.json).toEqual({ outcome: "denied", reason });
      expect(batch.json).toEqual({ ...(standalone.json as object), reason: `step 2: ${reason}` });
      // Nothing crossed: not the click before the upload, and not the upload.
      expect(worker.requests).toEqual([]);
      expect(await configuredRoots()).toBeUndefined();
    });

    /**
     * FR-214 - an interrupt (or a stop, which the worker answers the question with the same way)
     * while a step's question stands is the standalone answer: the call never left this process,
     * so it is `owner-interrupted` with "nothing delivered", and no step has run.
     */
    it("answers an interrupt during a step's question as a standalone one, and runs no step (FR-214)", async () => {
      const outside = await stageOutside("private", "diary.txt");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        uploadConsent: "interrupted",
        answers: RAN,
      });
      await worker.waitForHello();

      const batch = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [{ tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } }],
      });
      const standalone = await client.callTool("file_upload", { tabId: 3, ref: "tgt-1", paths: [outside.path] });

      expect(standalone.json).toEqual({
        outcome: "stopped",
        reason: "owner-interrupted",
        hint: INTERRUPT_HINTS.nothingDelivered,
      });
      expect(batch.isError).toBe(true);
      expect(batch.json).toEqual({
        outcome: "stopped",
        reason: "step 1: owner-interrupted",
        hint: INTERRUPT_HINTS.nothingDelivered,
      });
      expect(worker.requests).toEqual([]);
    });

    it("asks one question at a time, in step order", async () => {
      const first = await stageOutside("private", "diary.txt");
      const second = await stageOutside("letters", "letter.txt", "dear owner");
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({
        env: { LOCALAPPDATA: dataDir },
        pairing: "accept",
        features: ["upload-consent"],
        // Answered by hand below, so a second question raised early would be seen standing.
        uploadConsent: () => undefined,
        answers: RAN,
      });
      await worker.waitForHello();

      const pending = client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "file_upload", args: { ref: "tgt-1", paths: [first.path] } },
          { tool: "file_upload", args: { ref: "tgt-2", paths: [second.path] } },
        ],
      });
      await waitForCondition(() => consentRequests().length >= 1, "the first step's question");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(consentRequests().map((frame) => frame.files.map((file) => file.path))).toEqual([[first.path]]);

      worker.send({ type: "upload-consent-result", callId: consentRequests()[0]!.callId, decision: "once" });
      await waitForCondition(() => consentRequests().length >= 2, "the second step's question");
      const asked = consentRequests();
      expect(asked[1]!.files.map((file) => file.path)).toEqual([second.path]);
      expect(asked[1]!.callId).toBe(asked[0]!.callId);
      expect(worker.requests).toEqual([]);

      worker.send({ type: "upload-consent-result", callId: asked[1]!.callId, decision: "once" });
      const result = await pending;
      expect(result.isError, result.text).toBe(false);
      expect(worker.requests.map((request) => request.tool)).toEqual(["browser_batch"]);
      expectWorkerAccepts(worker.requests[0]!.args);
    });

    it("refuses a picture taken inside the same batch as an unknown id, and says to upload it later", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();

      // The id an agent would guess for the screenshot step before it: this session never issued it.
      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "screenshot", args: {} },
          { tool: "upload_image", args: { imageId: "img_a1b2c3d4e5", ref: "tgt-1" } },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({
        outcome: "denied",
        reason: "step 2: unknown-image-id; take a new screenshot and quote its imageId",
        hint: LATER_CALL_HINT,
      });
      expect(worker.requests).toEqual([]);
    });

    it.each([
      { why: "expired", env: { HALLPASS_SCREENSHOT_RETENTION_MS: "1" } },
      { why: "oversize", env: { HALLPASS_SCREENSHOT_BUDGET_CHARS: "8" } },
    ])("refuses a picture that is $why as a standalone call does, naming the step", async ({ why, env }) => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir, ...env } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();
      const { imageId } = (await client.callTool("screenshot", { tabId: 3 })).json as { imageId: string };
      await new Promise((resolve) => setTimeout(resolve, 50));

      const batch = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [{ tool: "upload_image", args: { imageId, ref: "tgt-1" } }],
      });
      const standalone = await client.callTool("upload_image", { tabId: 3, imageId, ref: "tgt-1" });

      const reason = `image-no-longer-available (${why}); take a new screenshot`;
      expect(standalone.json).toEqual({ outcome: "denied", reason });
      // An id this session did issue: no "later call" sentence, which is about ids it never gave out.
      expect(batch.json).toEqual({ outcome: "denied", reason: `step 1: ${reason}` });
      expect(worker.requests.map((request) => request.tool)).toEqual(["screenshot"]);
    });

    it("refuses a batch whose uploads together exceed one frame, and sends nothing", async () => {
      // Each file alone is inside the per-call bound; the two together are not.
      const root = await stageAllowed({ "a.bin": Buffer.alloc(300_000, 1), "b.bin": Buffer.alloc(300_000, 2) });
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();

      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "file_upload", args: { ref: "tgt-1", paths: [join(root, "a.bin")] } },
          { tool: "file_upload", args: { ref: "tgt-2", paths: [join(root, "b.bin")] } },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.json).toEqual({
        outcome: AGENT_015_REASON_OUTCOMES["batch-upload-too-large"],
        reason: "batch-upload-too-large",
        hint: "Split the uploads across calls.",
      });
      expect(worker.requests).toEqual([]);
    });

    it("sends a batch without upload steps exactly as the agent wrote it", async () => {
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();
      const args = {
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          { tool: "type", args: { ref: "field-1", text: "hello" } },
        ],
      };

      const result = await client.callTool("browser_batch", args);

      expect(result.isError, result.text).toBe(false);
      expect(worker.requests.map((request) => request.args)).toStrictEqual([args]);
    });

    /**
     * 015 S3 review F1 - the worker's shape is not a way in (FR-213).
     *
     * A batch step's arguments are the agent's to write, so the worker-facing fields - bytes that
     * claim to be a file, a picture that claims to be the session's - are the obvious thing to try.
     * Each is refused or overwritten before the batch crosses: the only bytes a page is ever handed
     * are the ones the host read, or the one picture it holds.
     */
    describe("the worker's fields, written by the agent (S3 review F1)", () => {
      const FORGED = { name: "forged.txt", type: "text/plain", bytesBase64: "Zm9yZ2Vk" };

      it("refuses a file_upload step that carries bytes and no paths, and sends nothing", async () => {
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
        await worker.waitForHello();

        const result = await client.callTool("browser_batch", {
          tabId: 3,
          steps: [{ tool: "file_upload", args: { ref: "tgt-1", files: [FORGED] } }],
        });

        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "failed", reason: "step 1: invalid-arguments" });
        expect(worker.requests).toEqual([]);
      });

      it("sends only the bytes the host read when bytes are smuggled beside valid paths", async () => {
        const root = await stageAllowed({ "receipt.txt": "hello" });
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
        await worker.waitForHello();

        const result = await client.callTool("browser_batch", {
          tabId: 3,
          steps: [
            { tool: "file_upload", args: { ref: "tgt-1", paths: [join(root, "receipt.txt")], files: [FORGED] } },
          ],
        });

        expect(result.isError, result.text).toBe(false);
        expect(worker.requests[0]!.args).toEqual({
          tabId: 3,
          steps: [
            {
              tool: "file_upload",
              args: { ref: "tgt-1", files: [{ name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" }] },
            },
          ],
        });
        expect(JSON.stringify(worker.requests)).not.toContain(FORGED.bytesBase64);
      });

      it("refuses an upload_image step that carries a file and no imageId, and sends nothing", async () => {
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
        await worker.waitForHello();

        const result = await client.callTool("browser_batch", {
          tabId: 3,
          steps: [{ tool: "upload_image", args: { ref: "tgt-1", file: FORGED } }],
        });

        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "failed", reason: "step 1: invalid-arguments" });
        expect(worker.requests).toEqual([]);
      });
    });

    /**
     * 015 S3 review F2 - a step is held to the shape a standalone call is held to.
     *
     * A standalone `file_upload` never reaches the host without its `ref`: MCP validates it against
     * the tool's own input shape first. A batch step's arguments are an opaque record to that
     * validation, so without the same shape here a step missing its target was sent - and refused by
     * the worker only after the steps before it had run. The same shape, from the same descriptor,
     * refuses it before anything crosses; a stray key is dropped as MCP drops it.
     */
    it("refuses a file_upload step without its target before anything is sent (S3 review F2)", async () => {
      const root = await stageAllowed({ "receipt.txt": "hello" });
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();

      const standalone = await client.callTool("file_upload", { tabId: 3, paths: [join(root, "receipt.txt")] });
      const batch = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [
          { tool: "click", args: { target: { ref: "btn-1" } } },
          { tool: "file_upload", args: { paths: [join(root, "receipt.txt")] } },
        ],
      });

      // Standalone, MCP's own validation refuses it and the host never sees it.
      expect(standalone.isError).toBe(true);
      expect(batch.isError).toBe(true);
      expect(batch.json).toEqual({ outcome: "failed", reason: "step 2: invalid-arguments" });
      // Not the click before it either: nothing crossed.
      expect(worker.requests).toEqual([]);
    });

    it("drops a stray key from a file_upload step as a standalone call's is dropped (S3 review F2)", async () => {
      const root = await stageAllowed({ "receipt.txt": "hello" });
      client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
      worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
      await worker.waitForHello();

      const result = await client.callTool("browser_batch", {
        tabId: 3,
        steps: [{ tool: "file_upload", args: { ref: "tgt-1", paths: [join(root, "receipt.txt")], stray: 1 } }],
      });

      expect(result.isError, result.text).toBe(false);
      // What the worker parses with its strict schema, so a stray key cannot fail the step there.
      expectWorkerAccepts(worker.requests[0]!.args);
      expect(JSON.stringify(worker.requests)).not.toContain("stray");
    });

    /**
     * 015 S3 review F3 - the three endings of a directory question that are not the owner deciding,
     * each answered inside a batch as it is standalone, with the step named.
     */
    describe("the question's other endings, inside a batch (S3 review F3)", () => {
      it("refuses as 0.5.0 did when the worker cannot ask (unavailable)", async () => {
        const outside = await stageOutside("private", "diary.txt");
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        // No `upload-consent` feature: a worker that cannot raise the card.
        worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, pairing: "accept", answers: RAN });
        await worker.waitForHello();

        const result = await client.callTool("browser_batch", {
          tabId: 3,
          steps: [
            { tool: "click", args: { target: { ref: "btn-1" } } },
            { tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } },
          ],
        });

        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "denied", reason: "step 2: upload-outside-allowed-directories" });
        expect(consentRequests()).toEqual([]);
        expect(worker.requests).toEqual([]);
      });

      it("answers busy when the worker is already asking something else", async () => {
        const outside = await stageOutside("private", "diary.txt");
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        worker = await startFakeAgentWorker({
          env: { LOCALAPPDATA: dataDir },
          pairing: "accept",
          features: ["upload-consent"],
          uploadConsent: () => "busy",
          answers: RAN,
        });
        await worker.waitForHello();

        const result = await client.callTool("browser_batch", {
          tabId: 3,
          steps: [{ tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } }],
        });

        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "busy", reason: "step 1: prompt-pending" });
        expect(worker.requests).toEqual([]);
        expect(await configuredRoots()).toBeUndefined();
      });

      it("answers bridge-lost when the link goes away while a step's question stands", async () => {
        const outside = await stageOutside("private", "diary.txt");
        client = await startMcpClient({ env: { LOCALAPPDATA: dataDir } });
        const browser = await startFakeAgentWorker({
          env: { LOCALAPPDATA: dataDir },
          pairing: "accept",
          features: ["upload-consent"],
          uploadConsent: "ignore",
          answers: RAN,
        });
        worker = browser;
        await browser.waitForHello();

        const pending = client.callTool("browser_batch", {
          tabId: 3,
          steps: [{ tool: "file_upload", args: { ref: "tgt-1", paths: [outside.path] } }],
        });
        await browser.waitForControlFrame("upload-consent-request");
        await browser.close();
        worker = undefined;

        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.json).toEqual({ outcome: "failed", reason: "step 1: bridge-lost" });
        expect(browser.requests).toEqual([]);
      });
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
/**
 * 014/T384 (S3 review F7) — what an `always` will and will not write down.
 *
 * The card's "these directories from now on" remembers each file's own parent, and for a file
 * sitting at `D:\` - or on a share root - that parent is everything on the drive or the share: one
 * press, and every file on it is uploadable without another question for as long as the row stands.
 * The owner's yes still uploads what they were shown; those files are simply allowed the way "this
 * once" allows them, and nothing is added.
 *
 * Asserted on the split rather than through a spawned server, because the end-to-end version would
 * have to create a file at a real drive root - which Windows refuses on `C:\` for a process that is
 * not elevated, and which would make the suite depend on which drives this machine happens to have.
 * The rule itself is the contract's (`isRootDirectory`, pinned in the 014 contract suite).
 */
describe("T384 the directories an 'always' remembers", () => {
  it("keeps the ordinary parents and refuses the roots", () => {
    const split = splitRememberableDirectories([
      { path: "C:\\Users\\owner\\docs\\receipt.txt", directory: "C:\\Users\\owner\\docs" },
      { path: "D:\\holiday.png", directory: "D:\\" },
      { path: "\\\\server\\share\\notes.txt", directory: "\\\\server\\share" },
    ]);

    expect(split.remember.map((file) => file.directory)).toEqual(["C:\\Users\\owner\\docs"]);
    // The two that are not written down are still uploaded - once, by path, exactly as "this time"
    // uploads them - so the owner's yes is honoured and the list is not widened to a drive.
    expect(split.onceOnly.map((file) => file.path)).toEqual([
      "D:\\holiday.png",
      "\\\\server\\share\\notes.txt",
    ]);
  });

  it("has nothing to say when no root is among them", () => {
    const split = splitRememberableDirectories([
      { path: "C:\\Users\\owner\\docs\\receipt.txt", directory: "C:\\Users\\owner\\docs" },
    ]);

    expect(split.onceOnly).toEqual([]);
  });
});

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

/** What a 015 worker advertises on its pairing answer when it takes `pair-withdraw` (FR-219). */
const PAIR_WITHDRAW_FEATURE = "pair-withdraw";

/**
 * The `pair-request` a 0.7.0 worker accepts, copied literally from
 * `git show 334841e:packages/contracts/src/agent-tools.ts` (~2582) as a fixture.
 *
 * It is a copy on purpose: the live contract gained an optional `requestId`, and a test reading the
 * live schema would pass the very frame this fixture exists to catch - the one an extension the
 * owner has not reloaded yet refuses whole (015 FR-219).
 */
const PAIR_REQUEST_070 = z.strictObject({
  type: z.literal("pair-request"),
  agentId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  origin: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(128),
});

/**
 * A 015 worker's advertisement, before any call: a late decline, which answers no exchange and is
 * dropped, but whose `features` the host takes as it takes them from every answer.
 */
async function advertisePairWithdraw(
  worker: FakeAgentWorker,
  client: McpHarnessClient,
  session: { agentId: string; sessionId: string },
): Promise<void> {
  worker.send({
    type: "pair-result",
    agentId: session.agentId,
    sessionId: session.sessionId,
    accepted: false,
    features: [PAIR_WITHDRAW_FEATURE, PAIRING_DECLINED_MARKER],
  });
  await waitForCondition(() => client.stderr().includes("agent.pair.decline-late"), "the advertisement read");
}
