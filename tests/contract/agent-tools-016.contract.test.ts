import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 016 — a readable panel: the one new link frame and the session view's new facts (data-model.md,
 * contracts/session-label.md, R-203 - R-205).
 *
 * `session-label` is a new frame `type` rather than a field on `hello`, because a 0.8.0 relay parses
 * `hello` strictly and would refuse the greeting outright; the link protocol does not move. Every
 * session view addition is optional so a 0.8.0 projection still parses.
 */

const SESSION = "session-1";

const PANEL = {
  paired: [
    { agentId: "agent-0", displayName: "Claude Code", origin: "stdio:local", acceptedAt: "2026-09-27T00:00:00.000Z" },
  ],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
};

const SESSION_VIEW = { sessionId: SESSION, agentId: "agent-0", tabs: [] };

const withSession = (session: Record<string, unknown>) => ({ ...PANEL, sessions: [{ ...SESSION_VIEW, ...session }] });

describe("T431 the session-label link frame (FR-226, R-204)", () => {
  const frame = () => contractSchema("agentLinkFrameSchema");
  const LABEL = { type: "session-label", sessionId: SESSION, label: "shop-frontend" };

  it("is a member of the link frame union", () => {
    expectAccepted(frame(), LABEL, "a session-label frame");
    expectAccepted(frame(), { ...LABEL, label: "x".repeat(64) }, "a 64-character label");
  });

  it("is strict and bounded", () => {
    expectRejected(frame(), { ...LABEL, path: "C:\\work\\x" }, "a session-label with an extra key");
    expectRejected(frame(), { ...LABEL, label: "" }, "an empty label");
    expectRejected(frame(), { ...LABEL, label: "x".repeat(65) }, "a 65-character label");
    expectRejected(frame(), { ...LABEL, sessionId: "" }, "an empty session id");
    expectRejected(frame(), { type: "session-label", sessionId: SESSION }, "a session-label without a label");
  });

  it("leaves the link protocol at 2", () => {
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});

describe("T431 the session view carries label, start time, colour and idle (FR-227 - FR-231, R-205)", () => {
  const panel = () => contractSchema("agentPanelStateSchema");

  it("exports the colour rotation in order and the idle state", () => {
    expect(contractExport<readonly string[]>("AGENT_SESSION_COLOURS")).toEqual([
      "cyan",
      "green",
      "purple",
      "pink",
      "orange",
      "grey",
      "blue",
    ]);
    expect(contractExport<readonly string[]>("AGENT_SESSION_STATES")).toEqual(["working", "waiting", "idle"]);
  });

  it("accepts the new optional fields", () => {
    expectAccepted(
      panel(),
      withSession({ label: "shop-frontend", startedAt: "2026-09-27T08:00:00.000Z", colour: "cyan", state: "idle" }),
      "a session with label, startedAt, colour and idle",
    );
    for (const colour of ["cyan", "green", "purple", "pink", "orange", "grey", "blue"]) {
      expectAccepted(panel(), withSession({ colour }), `colour ${colour}`);
    }
    expectAccepted(panel(), withSession({ label: "x".repeat(64) }), "a 64-character label");
  });

  it("rejects what falls outside them", () => {
    expectRejected(panel(), withSession({ label: "" }), "an empty label");
    expectRejected(panel(), withSession({ label: "x".repeat(65) }), "a 65-character label");
    expectRejected(panel(), withSession({ colour: "red" }), "a colour outside the rotation");
    expectRejected(panel(), withSession({ startedAt: "" }), "an empty startedAt");
    expectRejected(panel(), withSession({ state: "sleeping" }), "an unknown state");
  });

  it("still parses a 0.8.0 session view", () => {
    expectAccepted(
      panel(),
      withSession({ state: "working", lastActivityAt: "2026-09-27T08:00:01.000Z", inFlight: 0, sites: [] }),
      "a 0.8.0 session view",
    );
  });
});
