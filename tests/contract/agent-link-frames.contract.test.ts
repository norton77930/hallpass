import { describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 004/T076 — the loopback link between the relay and an mcp-server (contracts README §1).
 *
 * 003 had one server and one relay, so the link needed nothing but a shared token: whoever answered
 * was the only peer there was. 004 puts several agent sessions on one browser, and that turns every
 * frame on the link into a question of *whose* it is - which is why `hello` now carries the session
 * the server minted, why the relay answers with its own pid, and why a call frame that names no
 * session is refused here rather than routed by guesswork.
 *
 * The record is the other half of the same inversion. In 003 the server published it and the relay
 * dialled; in 004 the relay listens and every server dials, so the pid in the file is the *relay's*.
 * The two shapes are one field apart and would otherwise parse into each other, which is exactly the
 * mistake this test exists to make impossible: a 003-shaped record must not read as a 004 one.
 */

const TOKEN = "t".repeat(64);
const SESSION = "b7f0c3e1d9a24f5e";
const RELAY_PID = 4321;

describe("T076 agent link frames", () => {
  it("greets with the session the server minted, and refuses a greeting without the token", () => {
    const frame = contractSchema("agentLinkFrameSchema");
    const hello = {
      type: "hello",
      sessionId: SESSION,
      agentId: "claude-code",
      displayName: "Claude Code",
      token: TOKEN,
      protocol: AGENT_LINK_PROTOCOL,
    };

    expectAccepted(frame, hello, "a hello naming the session, the agent and the token");

    const { token: _token, ...withoutToken } = hello;
    /**
     * The token proves the peer read the relay's record - that is, that it runs as this user - and
     * a greeting without one is not anonymous, it is unauthenticated. It is *optional in the shape*
     * since T099i, because the relay forwards this same frame to the worker with the token stripped:
     * the token is the relay's own admission check and has no business in the extension. Which
     * makes the relay's explicit check, not this schema, the thing that refuses an untokened peer -
     * and it is asserted where that check lives (`relay-mux.test.ts`).
     */
    expectAccepted(frame, withoutToken, "the announcement the relay forwards, with no token");
    expectRejected(frame, { ...hello, token: "" }, "a hello with an empty token");
    expectRejected(frame, { ...hello, protocol: 0 }, "a hello stamped with no protocol at all");

    const { sessionId: _sessionId, ...withoutSession } = hello;
    expectRejected(frame, withoutSession, "a hello with no session");
    expectRejected(frame, { ...hello, relayPid: RELAY_PID }, "a hello carrying an undeclared field");
  });

  it("answers a greeting with the relay's own pid", () => {
    const frame = contractSchema("agentLinkFrameSchema");

    expectAccepted(frame, { type: "hello-ack", relayPid: RELAY_PID }, "a hello-ack");
    expectRejected(frame, { type: "hello-ack" }, "a hello-ack with no pid");
    expectRejected(frame, { type: "hello-ack", relayPid: 0 }, "a hello-ack naming pid zero");
    expectRejected(frame, { type: "hello-ack", relayPid: "4321" }, "a hello-ack whose pid is text");
  });

  it("ends one session and announces one relay, and never the two at once", () => {
    const frame = contractSchema("agentLinkFrameSchema");

    expectAccepted(frame, { type: "session-ended", sessionId: SESSION }, "a session-ended");
    expectRejected(frame, { type: "session-ended" }, "a session-ended naming no session");

    expectAccepted(frame, { type: "relay-started", relayPid: RELAY_PID }, "a relay-started");
    expectRejected(frame, { type: "relay-started" }, "a relay-started with no pid");
    // Where the relay wrote its record (006 FR-082 follow-up): optional, so a relay built before
    // the field still greets a worker that knows it, and a worker built before it still accepts one.
    expectAccepted(
      frame,
      { type: "relay-started", relayPid: RELAY_PID, recordPath: "C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json" },
      "a relay-started naming its record",
    );
    expectRejected(frame, { type: "relay-started", relayPid: RELAY_PID, recordPath: 7 }, "a relay-started whose record path is not text");
    // A relay restart is about the relay and a session end is about one session. A frame that
    // carried both would leave the worker to decide which of the two just happened.
    expectRejected(
      frame,
      { type: "relay-started", relayPid: RELAY_PID, sessionId: SESSION },
      "a relay-started naming a session",
    );
    expectRejected(frame, { type: "resumed", sessionId: SESSION }, "a frame type nobody declared");
  });

  /**
   * Two browsers (2026-10-02). The ack names the browser run so a relay can tell its own browser's
   * previous relay from another browser's; optional both ways, because a host from before it reads
   * only `type` and `relayPid` and a worker from before it never sends one. The relay that stands
   * aside says so with its own frame, naming the relay that keeps serving.
   */
  it("acks with the browser run when it has one, and stands by with the serving relay's pid", () => {
    const frame = contractSchema("agentLinkFrameSchema");

    expectAccepted(frame, { type: "relay-ack", relayPid: RELAY_PID }, "an ack from a worker before the run id");
    expectAccepted(frame, { type: "relay-ack", relayPid: RELAY_PID, browserRunId: "run-1" }, "an ack naming its run");
    expectRejected(frame, { type: "relay-ack", relayPid: RELAY_PID, browserRunId: "" }, "an ack with an empty run");
    expectRejected(frame, { type: "relay-ack", relayPid: RELAY_PID, browserRunId: "r".repeat(65) }, "an ack with an oversized run");

    expectAccepted(frame, { type: "relay-standby", servingRelayPid: RELAY_PID }, "a relay-standby");
    expectRejected(frame, { type: "relay-standby" }, "a relay-standby naming no serving relay");
    expectRejected(frame, { type: "relay-standby", servingRelayPid: 0 }, "a relay-standby naming pid zero");
    expectRejected(frame, { type: "relay-standby", servingRelayPid: RELAY_PID, sessionId: SESSION }, "a relay-standby naming a session");
  });

  it("names the record's owner in a sidecar, leaving the record's own shape untouched", () => {
    const owner = contractSchema("agentBridgeOwnerSchema");
    const record = contractSchema("agentBridgeRecordSchema");

    expectAccepted(owner, { relayPid: RELAY_PID, browserRunId: "run-1" }, "an owner naming its run");
    expectAccepted(owner, { relayPid: RELAY_PID }, "an owner whose worker named no run");
    expectRejected(owner, { browserRunId: "run-1" }, "an owner naming no relay");
    // The record stays exactly what running servers parse: the run id has no place in it.
    expectRejected(
      record,
      { port: 51_234, token: TOKEN, relayPid: RELAY_PID, startedAt: "2026-10-02T09:00:00.000Z", protocol: AGENT_LINK_PROTOCOL, browserRunId: "run-1" },
      "a record carrying the owner's run",
    );
  });

  it("carries the session on every call frame", () => {
    const request = contractSchema("agentNativeRequestSchema");
    const call = { callId: "call-1", sessionId: SESSION, tool: "tabs_context", args: {} };

    expectAccepted(request, call, "a call naming its session");
    expectAccepted(request, { ...call, tabId: 7 }, "a call naming its session and a tab");

    const { sessionId: _sessionId, ...withoutSession } = call;
    // The relay routes answers by `callId` and everything else by `sessionId`, and the worker holds
    // one lease table across several live sessions. A call with no session is a call nothing can
    // decide about, so it is refused at the boundary instead of being attributed to a guess.
    expectRejected(request, withoutSession, "a call naming no session");
    expectRejected(request, { ...call, sessionId: "" }, "a call with an empty session");
  });

  it("answers a pairing request with the session that asked (T094a)", () => {
    const frame = contractSchema("agentControlFrameSchema");
    const result = { type: "pair-result", agentId: "claude-code", sessionId: SESSION, accepted: true };

    expectAccepted(frame, result, "a pair-result naming the session it answers");

    const { sessionId: _sessionId, ...withoutSession } = result;
    // The relay routes a worker frame by its `callId` or its `sessionId` and never broadcasts, so a
    // pair-result naming neither is dropped as unaddressed and the pairing can never settle. The
    // frame is the only thing that says whose question this answers, which is why it is required
    // rather than optional: an optional field would let that drop happen again silently.
    expectRejected(frame, withoutSession, "a pair-result naming no session");
    expectRejected(frame, { ...result, sessionId: "" }, "a pair-result with an empty session");
  });

  /**
   * 003 FR-032a - a decline and an unpair reach the agent as different answers, and the difference
   * rides where an installed 0.6.0 host still parses it.
   *
   * The frame is strict, so a new key would make that host drop the whole answer - including the
   * unpair FR-032 says takes effect at once. `features` has been an open list since 0.6.0, so the
   * mark goes there, and its absence is the unpair the spec says an unmarked refusal means.
   */
  it("marks a decline inside the field an older host already accepts (FR-032a)", () => {
    const frame = contractSchema("agentControlFrameSchema");
    const marker = contractExport<string>("PAIRING_DECLINED_MARKER");
    const refusal = { type: "pair-result", agentId: "claude-code", sessionId: SESSION, accepted: false };

    expect(marker.length).toBeGreaterThan(0);
    expect(marker.length).toBeLessThanOrEqual(64);
    expectAccepted(frame, { ...refusal, features: [marker] }, "a decline");
    expectAccepted(frame, { ...refusal, features: ["upload-consent", marker] }, "a decline from a worker that can ask");
    expectAccepted(frame, refusal, "an unmarked refusal, which is an unpair");
    // Why not a key of its own: this is what the host would do with it.
    expectRejected(frame, { ...refusal, declined: true }, "a decline carried in a key the frame does not declare");
  });

  it("says what each refusal means in both languages, sized for the hint (FR-032a)", () => {
    const hints = contractExport<Record<string, string>>("PAIRING_REFUSAL_HINTS");
    const response = contractSchema("agentNativeResponseSchema");

    expect(Object.keys(hints).sort()).toEqual(["declined", "unpaired"]);
    for (const [kind, hint] of Object.entries(hints)) {
      const lines = hint.split("\n");
      expect(lines, `${kind} is two lines`).toHaveLength(2);
      expect(lines[1], `${kind}'s second line is zh-TW`).toMatch(/[一-鿿]/);
      expect(hint, `${kind} carries no placeholder`).not.toContain("{");
      // `reason` stays the code every client already branches on; the sentence is the hint.
      expectAccepted(response, { callId: "c-1", outcome: "denied", reason: "not-paired", hint }, `${kind} as a hint`);
    }
    expect(hints["declined"]).toContain("declined");
    expect(hints["unpaired"]).toContain("/mcp");
  });

  it("reads the relay's record and refuses the 003 one", () => {
    const record = contractSchema("agentBridgeRecordSchema");
    const startedAt = "2026-09-09T09:00:00.000Z";

    expectAccepted(
      record,
      { port: 51_234, token: TOKEN, relayPid: RELAY_PID, startedAt, protocol: AGENT_LINK_PROTOCOL },
      "the relay's record",
    );

    // T099j: the relay outlives a host upgrade, so an unstamped record is one written by a build
    // whose frames mean something else. It must not read as an address.
    expectRejected(
      record,
      { port: 51_234, token: TOKEN, relayPid: RELAY_PID, startedAt },
      "a record with no protocol stamp",
    );

    // 003's record was the *server's* and named `pid`. Both files sit at the same path, so a strict
    // shape is the only thing that stops a server left over from 003 being dialled as a relay.
    expectRejected(
      record,
      { port: 51_234, token: TOKEN, pid: RELAY_PID, startedAt, protocol: AGENT_LINK_PROTOCOL },
      "the 003 record naming a server pid",
    );
    expectRejected(
      record,
      {
        port: 51_234,
        token: TOKEN,
        relayPid: RELAY_PID,
        pid: RELAY_PID,
        startedAt,
        protocol: AGENT_LINK_PROTOCOL,
      },
      "a record naming both pids",
    );
    expectRejected(
      record,
      { port: 0, token: TOKEN, relayPid: RELAY_PID, startedAt, protocol: AGENT_LINK_PROTOCOL },
      "a record naming no port",
    );
  });
});
