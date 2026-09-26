import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 003/T005 — the three closed boundaries the agent bridge is built on, asserted from the outside:
 * the outcome enum, the tool-name enum, the native frame (request, response, control) and the
 * site-mode projection. Per-tool argument shapes are stubs at this point and are pinned by the
 * later slices that define them; what is pinned here is that the surface is *closed*, because a
 * frame the worker does not understand must not be able to reach a handler by carrying an extra
 * field or an unknown name.
 */
describe("T005 agent tools contract", () => {
  it("closes the tool-call outcome enum", () => {
    expect(contractExport("AGENT_TOOL_OUTCOMES")).toEqual([
      "ok",
      "denied",
      "stale",
      "busy",
      "not-readable",
      "not-actionable",
      "stopped",
      "timed-out",
      "failed",
    ]);
    const outcome = contractSchema("agentToolOutcomeSchema");
    for (const value of contractExport<readonly string[]>("AGENT_TOOL_OUTCOMES")) {
      expectAccepted(outcome, value, value);
    }
    // "cancelled", "error" and the like are words other layers use; none of them is an outcome.
    for (const value of ["cancelled", "error", "unknown", "OK", ""]) {
      expectRejected(outcome, value, `outcome '${value}'`);
    }
  });

  it("closes the tool-name enum to the surface the contracts document names", () => {
    expect(contractExport("AGENT_TOOL_NAMES")).toEqual([
      "tabs_context",
      "tabs_create",
      "tabs_close",
      // 004: taking one of the owner's own tabs, and giving it back.
      "tabs_claim",
      "tabs_release",
      "navigate",
      "resize_window",
      // 012: an emulated viewport for the tab, which is not the owner's window.
      "viewport",
      "get_page_text",
      "read_page",
      "find",
      "screenshot",
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
      // 004: acting at a viewport point, for what the page's structure does not describe.
      "computer",
      "browser_batch",
      "wait",
      "read_console",
      "read_network",
      "evaluate",
      "file_upload",
      // 013: the same delivery, for a picture this session took rather than a file on disk.
      "upload_image",
      // 005: the browser's downloads, listed for the session that caused them.
      "downloads_context",
      // 008: recording the session as a GIF, and answering the dialogs a page opens.
      "gif_recorder",
      "dialog",
    ]);
    // Every name has an argument schema, and nothing else does: the registry and the enum are one
    // list, so a tool cannot be registered without a declared argument shape.
    const argSchemas = contractExport<Record<string, unknown>>("agentToolArgSchemas");
    expect(Object.keys(argSchemas).sort()).toEqual(
      [...contractExport<readonly string[]>("AGENT_TOOL_NAMES")].sort(),
    );
  });

  it("round-trips a native request and rejects anything the frame does not declare", () => {
    const request = contractSchema("agentNativeRequestSchema");
    // 004: every call frame names its session (see `agent-link-frames.contract.test.ts`).
    const valid = { callId: "call-1", sessionId: "session-1", tool: "tabs_context", args: {} };
    expectAccepted(request, valid, "a minimal request");
    expectAccepted(request, { ...valid, tool: "click", tabId: 7, args: { ref: "t_1" } }, "a tab-bound request");
    expect(request.safeParse(valid)).toMatchObject({ success: true });

    expectRejected(request, { ...valid, extra: true }, "an unknown field");
    expectRejected(request, { callId: "call-1", tool: "tabs_context" }, "a request with no args");
    expectRejected(request, { ...valid, callId: "" }, "an empty callId");
    expectRejected(request, { ...valid, callId: "c".repeat(65) }, "an over-long callId");
    expectRejected(request, { ...valid, tool: "not_a_tool" }, "an unknown tool");
    expectRejected(request, { ...valid, tabId: -1 }, "a negative tabId");
    expectRejected(request, { ...valid, tabId: 1.5 }, "a fractional tabId");
    expectRejected(request, { ...valid, args: [] }, "args that are not an object");
  });

  it("round-trips a native response and holds it to one outcome and nothing more", () => {
    const response = contractSchema("agentNativeResponseSchema");
    expectAccepted(response, { callId: "call-1", outcome: "ok" }, "a bare ok");
    expectAccepted(response, { callId: "call-1", outcome: "ok", result: { tabs: [] } }, "a result");
    expectAccepted(response, { callId: "call-1", outcome: "denied", reason: "site-mode" }, "a reason");

    expectRejected(response, { callId: "call-1", outcome: "ok", extra: 1 }, "an unknown field");
    expectRejected(response, { callId: "call-1" }, "a response with no outcome");
    expectRejected(response, { callId: "call-1", outcome: "cancelled" }, "an outcome outside the enum");
    expectRejected(response, { callId: "", outcome: "ok" }, "an empty callId");
    // The host says why in a code, never in page text: the field is bounded for the same reason
    // every other reason code in this repository is.
    expectRejected(
      response,
      { callId: "call-1", outcome: "failed", reason: "x".repeat(201) },
      "an unbounded reason",
    );
  });

  it("closes the control frames to pairing, unpairing and stop", () => {
    const control = contractSchema("agentControlFrameSchema");
    expectAccepted(
      control,
      { type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-1" },
      "a pair request",
    );
    expectAccepted(
      control,
      { type: "pair-result", agentId: "agent-1", sessionId: "session-1", accepted: true },
      "an accept",
    );
    expectAccepted(
      control,
      { type: "pair-result", agentId: "agent-1", sessionId: "session-1", accepted: false },
      "a decline",
    );
    expectAccepted(control, { type: "unpair", agentId: "agent-1" }, "an unpair");
    expectAccepted(control, { type: "stop" }, "a stop for every session");
    expectAccepted(control, { type: "stop", sessionId: "session-1" }, "a stop for one session");

    expectRejected(control, { type: "pair-accepted", agentId: "agent-1" }, "an undeclared frame type");
    expectRejected(
      control,
      { type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "s-1", extra: 1 },
      "an unknown field on a pair request",
    );
    expectRejected(control, { type: "pair-request", agentId: "agent-1" }, "a pair request missing its disclosure");
    expectRejected(
      control,
      { type: "pair-result", agentId: "agent-1", sessionId: "session-1" },
      "a pair result with no answer",
    );
    expectRejected(control, { type: "unpair" }, "an unpair naming no agent");
    // A response is not a control frame: the two share a channel, never a shape.
    expectRejected(control, { callId: "call-1", outcome: "ok" }, "a tool response");
  });

  it("carries the two link frames the relay needs, and nothing else", () => {
    const control = contractSchema("agentControlFrameSchema");
    // `hello` authenticates the relay to the MCP server on the loopback link (R-102); it never
    // reaches the worker, but it travels the same union so one decoder reads the whole channel.
    expectAccepted(control, { type: "hello", token: "a".repeat(64) }, "the relay's hello");
    // The relay's one answer when no MCP server is listening; the worker retries later (FR-033).
    expectAccepted(control, { type: "bridge-unavailable" }, "an unavailable bridge");

    expectRejected(control, { type: "hello" }, "a hello with no token");
    expectRejected(control, { type: "hello", token: "" }, "a hello with an empty token");
    expectRejected(control, { type: "hello", token: "a".repeat(64), agentId: "a" }, "a hello carrying identity");
    expectRejected(control, { type: "bridge-unavailable", reason: "no server" }, "an unavailable bridge with prose");
  });

  it("closes the agent panel's projection and the commands the owner can send", () => {
    expect(contractExport("AGENT_PANEL_PORT_NAME")).toBe("hallpass-panel");

    const projection = contractSchema("agentPanelMessageSchema");
    const state = {
      pending: { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" },
      paired: [
        { agentId: "agent-0", displayName: "Claude Code", origin: "stdio:local", acceptedAt: "2026-09-08T00:00:00.000Z" },
      ],
      sessions: [{ sessionId: "session-1", agentId: "agent-0", tabs: [{ tabId: 7, url: "https://a.test/", title: "A", active: true }] }],
      // 004/T109a: the browser's own tabs travel beside the sessions, so the owner sees the ones
      // nobody holds as well as the ones an agent does.
      tabs: [{ tabId: 7, url: "https://a.test/", title: "A", active: true, holder: "none" }],
      sites: [],
      bridge: "connected",
    };
    expectAccepted(projection, { type: "worker.agent.state", payload: state }, "the agent state projection");
    expectAccepted(
      projection,
      { type: "worker.agent.state", payload: { paired: [], sessions: [], tabs: [], sites: [], bridge: "unavailable" } },
      "a projection with nothing paired",
    );
    // 006 FR-085: each question is dated so the panel shows them in arrival order.
    expectAccepted(
      projection,
      {
        type: "worker.agent.state",
        payload: {
          ...state,
          pending: { ...state.pending, requestedAt: "2026-09-13T10:00:00.000Z" },
          prompt: { promptId: "p-1", raisedAt: "2026-09-13T10:00:01.000Z", site: "https://a.test", tool: "click", argsSummary: "click" },
          plan: { planId: "plan-1", raisedAt: "2026-09-13T10:00:02.000Z", site: "https://a.test", steps: [] },
        },
      },
      "dated questions",
    );
    expectRejected(
      projection,
      { type: "worker.agent.state", payload: { ...state, bridge: "connecting" } },
      "a bridge status outside the three",
    );
    expectRejected(
      projection,
      { type: "worker.agent.state", payload: { ...state, extra: 1 } },
      "an unknown field on the projection",
    );
    // Nothing page-derived reaches the panel through this port beyond the tab URLs it must show.
    expectRejected(projection, { type: "worker.agent.activity", payload: {} }, "an undeclared projection");

    const command = contractSchema("agentPanelCommandSchema");
    expectAccepted(command, { type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } }, "an accept");
    expectAccepted(command, { type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: false } }, "a decline");
    expectAccepted(command, { type: "ui.agent.unpair", payload: { agentId: "agent-1" } }, "an unpair");
    // 006 FR-084: ignore names the agent and nothing else - the worker turns it into a decline of this request (amended 2026-09-24).
    expectAccepted(command, { type: "ui.agent.pair-ignore", payload: { agentId: "agent-1" } }, "an ignore");
    expectRejected(command, { type: "ui.agent.pair-ignore", payload: { agentId: "agent-1", accepted: false } }, "an ignore carrying a decision");
    expectAccepted(command, { type: "ui.agent.connect", payload: {} }, "a connect");
    // The two US3 commands are asserted in full by `agent-effect-tools.contract.test.ts`; named here
    // so this test still describes the whole closed union rather than a stale part of it.
    expectAccepted(command, { type: "ui.agent.effect-decide", payload: { promptId: "p-1", allow: false } }, "a deny");
    expectAccepted(command, { type: "ui.agent.site-mode", payload: { site: "https://a.test", mode: "ask" } }, "a mode");

    expectRejected(command, { type: "ui.agent.pair-decide", payload: { agentId: "agent-1" } }, "a decision with no answer");
    expectRejected(command, { type: "ui.agent.pair", payload: { agentId: "agent-1" } }, "an undeclared command");
    // The panel is the only place a pairing changes, and it can only ever say yes or no to one it
    // was shown: it cannot mint a pairing for an agent that never asked.
    expectRejected(
      command,
      { type: "ui.agent.unpair", payload: { agentId: "agent-1", displayName: "x" } },
      "an unpair carrying more than the id",
    );
  });

  it("closes the site-mode projection to the three modes and one record shape", () => {
    expect(contractExport("SITE_MODES")).toEqual(["ask", "follow-a-plan", "skip-checks"]);
    const record = contractSchema("siteModeRecordSchema");
    expectAccepted(
      record,
      { site: "https://example.test", mode: "ask", diagnosticsGranted: false },
      "a plain site",
    );
    expectAccepted(
      record,
      { site: "https://localhost:18787", mode: "skip-checks", diagnosticsGranted: true },
      "a fixture origin with a port",
    );

    expectRejected(record, { site: "https://example.test", mode: "ask" }, "a record with no diagnostics flag");
    expectRejected(
      record,
      { site: "https://example.test", mode: "ask", diagnosticsGranted: false, extra: 1 },
      "an unknown field",
    );
    expectRejected(
      record,
      { site: "https://example.test", mode: "allow-everything", diagnosticsGranted: false },
      "a mode outside the three",
    );
    // "Site" is scheme + host (+ port), so anything narrower or wider is not a site (R-108): a
    // record keyed by a path would make one page's decision apply to another's.
    for (const site of [
      "https://example.test/login",
      "https://example.test/",
      "example.test",
      "https://user:pw@example.test",
      "https://*.example.test",
      "",
    ]) {
      expectRejected(record, { site, mode: "ask", diagnosticsGranted: false }, `site '${site}'`);
    }
  });
});
