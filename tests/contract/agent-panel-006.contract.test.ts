import { describe, it } from "vitest";
import { contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 006/T188 — what the rebuilt side panel is told, and the four owner commands it adds.
 *
 * The projection grows the facts the new compositions are derived from (R-127): the paired agent's
 * name, each session's sites and state, and the diagnostics the not-connected page folds away. The
 * commands are the owner's controls and nothing more (R-126): retry the bridge, forget one site's
 * decision, stop one session, hand one session's tabs back. Every one of them names exactly what it
 * is about - a stop that carried anything beyond a session id would be a stop the panel could aim.
 */
const STATE = {
  paired: [
    { agentId: "agent-0", displayName: "Claude Code", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" },
  ],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
};

describe("T188 side panel projection and owner commands (006)", () => {
  it("projects the agent's name, each session's sites and state, and the bridge diagnostics", () => {
    const projection = contractSchema("agentPanelStateSchema");

    expectAccepted(projection, { ...STATE, agentName: "Claude Code" }, "a projection naming the paired agent");
    expectAccepted(
      projection,
      {
        ...STATE,
        sessions: [
          {
            sessionId: "session-1",
            agentId: "agent-0",
            tabs: [{ tabId: 7, url: "https://a.test/", title: "A", active: true, holder: "this" }],
            sites: ["a.test"],
            state: "waiting",
            lastActivityAt: "2026-09-13T00:00:01.000Z",
          },
        ],
      },
      "a session with its sites, its state and its last activity",
    );
    expectAccepted(
      projection,
      {
        ...STATE,
        bridge: "disconnected",
        diagnostics: {
          relayPid: 4242,
          recordPath: "C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json",
          lastDisconnect: { at: "2026-09-13T00:00:02.000Z", reason: "Native host has exited." },
        },
      },
      "the diagnostics the not-connected page folds away",
    );
    expectAccepted(projection, { ...STATE, diagnostics: {} }, "diagnostics with nothing known yet");

    // The 003/004 projection still parses: the panel is rebuilt over the same port, not a new one.
    expectAccepted(projection, STATE, "the projection as 004 sent it");
    expectRejected(
      projection,
      // 016 FR-230 made `idle` a state; the enum is still closed.
      { ...STATE, sessions: [{ sessionId: "session-1", agentId: "agent-0", tabs: [], state: "sleeping" }] },
      "a session state outside working / waiting / idle",
    );
    expectRejected(
      projection,
      { ...STATE, diagnostics: { lastDisconnect: { reason: "closed" } } },
      "a disconnect with no time",
    );
    expectRejected(projection, { ...STATE, diagnostics: { relayPid: "4242" } }, "a relay pid that is not a number");
  });

  it("accepts the four owner commands, each carrying only what it is about", () => {
    const command = contractSchema("agentPanelCommandSchema");

    expectAccepted(command, { type: "ui.agent.retry-bridge", payload: {} }, "a retry");
    expectAccepted(command, { type: "ui.agent.site-clear", payload: { site: "https://a.test" } }, "a site clear");
    expectAccepted(command, { type: "ui.agent.session-stop", payload: { sessionId: "session-1" } }, "a session stop");
    expectAccepted(
      command,
      { type: "ui.agent.session-release", payload: { sessionId: "session-1" } },
      "a session release",
    );

    expectRejected(command, { type: "ui.agent.retry-bridge", payload: { force: true } }, "a retry with an option");
    expectRejected(command, { type: "ui.agent.site-clear", payload: { site: "https://a.test/path" } }, "a clear of a path");
    expectRejected(command, { type: "ui.agent.session-stop", payload: {} }, "a stop naming no session");
    expectRejected(
      command,
      { type: "ui.agent.session-stop", payload: { sessionId: "session-1", callId: "c-1" } },
      "a stop aimed at one call",
    );
    expectRejected(
      command,
      { type: "ui.agent.session-release", payload: { sessionId: "session-1", tabId: 7 } },
      "a release of one tab",
    );
  });
});
