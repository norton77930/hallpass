import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 018 — several browsers, one bridge: the per-browser record, the remembered choice, the identity on
 * `relay-ack`, the new link frames, the two refusals, the three browser tools and the panel's
 * additions (data-model.md, contracts/browser-tools.md, R-266 - R-279).
 *
 * Every change to an existing frame is optional, so a 0.10.0-shaped frame still parses and the link
 * protocol stays 2 (R-267). `relay-standby` is gone from the union (S6, R-274).
 */

const BROWSER_ID = "3f0c8a52-6b1e-4d7a-9c2f-0d4e5b6a7c81";
const RELAY_PID = 4242;
const TOKEN = "t".repeat(32);
const SESSION = "session-1";

const RECORD = {
  browserId: BROWSER_ID,
  browserRunId: "run-1",
  kind: "edge",
  name: "Work Edge",
  legacy: false,
  features: ["browser-choice"],
  relayPid: RELAY_PID,
  port: 51_234,
  token: TOKEN,
  startedAt: "2026-10-03T08:00:00.000Z",
  protocol: 2,
};

const SUMMARY = { browserId: BROWSER_ID, name: "Edge", kind: "edge" };

const PANEL = {
  paired: [],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
};

function toolArgs(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T494 the per-browser record (data-model, R-266, R-276)", () => {
  const record = () => contractSchema("agentBrowserRecordSchema");

  it("accepts a record with and without the optional fields", () => {
    expectAccepted(record(), RECORD, "a full record");
    const { browserRunId: _run, name: _name, ...bare } = RECORD;
    expectAccepted(record(), bare, "a record without a run id or a name");
    expectAccepted(
      record(),
      { ...bare, browserId: "run-1", kind: "unknown", legacy: true, features: [] },
      "a legacy record for an extension older than 018",
    );
    expectAccepted(record(), { ...bare, browserId: "pid-4242", kind: "unknown", legacy: true, features: [] }, "pid-");
  });

  it("refuses what falls outside the shape", () => {
    expectRejected(record(), { ...RECORD, extra: 1 }, "an extra key");
    for (const key of ["browserId", "kind", "legacy", "features", "relayPid", "port", "token", "startedAt", "protocol"]) {
      const copy: Record<string, unknown> = { ...RECORD };
      delete copy[key];
      expectRejected(record(), copy, `a record without ${key}`);
    }
    expectRejected(record(), { ...RECORD, kind: "firefox" }, "an unknown kind");
    expectRejected(record(), { ...RECORD, name: "" }, "an empty name");
    expectRejected(record(), { ...RECORD, name: "n".repeat(41) }, "a 41-character name");
    expectRejected(record(), { ...RECORD, browserId: "../bridge" }, "a browser id that is a path");
    expectRejected(record(), { ...RECORD, browserId: "x".repeat(65) }, "a 65-character browser id");
    expectRejected(record(), { ...RECORD, features: Array.from({ length: 17 }, (_, i) => `f${i}`) }, "17 features");
    expectRejected(record(), { ...RECORD, token: "short" }, "a short token");
  });

  it("names every browser kind and the choice feature", () => {
    expect([...contractExport<readonly string[]>("AGENT_BROWSER_KINDS")]).toEqual([
      "chrome",
      "edge",
      "brave",
      "chromium",
      "unknown",
    ]);
    expect(contractExport<string>("BROWSER_CHOICE_FEATURE")).toBe("browser-choice");
  });
});

describe("T494 the remembered choice (data-model, R-271)", () => {
  const choice = () => contractSchema("agentBrowserChoiceRecordSchema");

  it("is a browser id and when it was chosen, nothing else", () => {
    expectAccepted(choice(), { browserId: BROWSER_ID, chosenAt: "2026-10-03T08:00:00.000Z" }, "a choice");
    expectRejected(choice(), { browserId: BROWSER_ID }, "a choice without a time");
    expectRejected(choice(), { chosenAt: "2026-10-03T08:00:00.000Z" }, "a choice without a browser");
    expectRejected(
      choice(),
      { browserId: BROWSER_ID, chosenAt: "2026-10-03T08:00:00.000Z", agentId: "agent-0" },
      "a choice with an extra key",
    );
  });
});

describe("T494 the link frames (contracts/browser-tools.md, R-267)", () => {
  const frame = () => contractSchema("agentLinkFrameSchema");

  it("still parses a 0.10.0-shaped relay-ack and accepts the identity on it", () => {
    expectAccepted(frame(), { type: "relay-ack", relayPid: RELAY_PID }, "a 0.9.0 ack");
    expectAccepted(frame(), { type: "relay-ack", relayPid: RELAY_PID, browserRunId: "run-1" }, "a 0.10.0 ack");
    expectAccepted(
      frame(),
      {
        type: "relay-ack",
        relayPid: RELAY_PID,
        browserRunId: "run-1",
        browserId: BROWSER_ID,
        browserKind: "brave",
        browserName: "Home",
        features: ["browser-choice"],
      },
      "an 018 ack",
    );
    expectRejected(frame(), { type: "relay-ack", relayPid: RELAY_PID, browserKind: "safari" }, "an unknown kind");
    expectRejected(frame(), { type: "relay-ack", relayPid: RELAY_PID, browserName: "" }, "an empty name");
    expectRejected(frame(), { type: "relay-ack", relayPid: RELAY_PID, browserId: "a/b" }, "a path-like id");
    expectRejected(
      frame(),
      { type: "relay-ack", relayPid: RELAY_PID, features: Array.from({ length: 17 }, (_, i) => `f${i}`) },
      "17 features",
    );
  });

  it("accepts the worker's rename and the relay's peer count and conflict", () => {
    expectAccepted(frame(), { type: "browser-name", name: "Work" }, "a rename");
    expectRejected(frame(), { type: "browser-name", name: "" }, "an empty rename");
    expectRejected(frame(), { type: "browser-name", name: "n".repeat(41) }, "a 41-character rename");
    expectRejected(frame(), { type: "browser-name" }, "a rename without a name");

    expectAccepted(frame(), { type: "browser-peers", others: 0, defaultName: "Chrome" }, "no peers");
    expectAccepted(frame(), { type: "browser-peers", others: 2, defaultName: "Chrome 2" }, "two peers");
    expectRejected(frame(), { type: "browser-peers", others: -1, defaultName: "Chrome" }, "negative peers");
    expectRejected(frame(), { type: "browser-peers", others: 1 }, "peers without a default name");

    expectAccepted(frame(), { type: "browser-identity-conflict" }, "a conflict");
    expectRejected(frame(), { type: "browser-identity-conflict", browserId: BROWSER_ID }, "a conflict with a field");
  });

  it("accepts the in-browser choice frames", () => {
    const request = { type: "browser-choice-request", sessionId: SESSION, requestId: "r-1", agentName: "Claude Code", boundMs: 120_000 };
    expectAccepted(frame(), request, "a choice request");
    expectRejected(frame(), { ...request, boundMs: 0 }, "a request with no bound");
    expectRejected(frame(), { ...request, agentName: "" }, "a request with no agent name");
    expectRejected(frame(), { ...request, extra: true }, "a request with an extra key");

    const result = { type: "browser-choice-result", sessionId: SESSION, requestId: "r-1", decision: "confirm" };
    expectAccepted(frame(), result, "a confirm");
    expectAccepted(frame(), { ...result, decision: "decline" }, "a decline");
    expectRejected(frame(), { ...result, decision: "maybe" }, "another decision");
    expectRejected(frame(), { ...result, requestId: "" }, "a result naming no request");

    expectAccepted(frame(), { type: "browser-choice-withdraw", sessionId: SESSION, requestId: "r-1" }, "a withdraw");
    expectRejected(frame(), { type: "browser-choice-withdraw", sessionId: SESSION }, "a withdraw naming no request");
  });

  it("accepts a choose-only hello and still a hello without it", () => {
    const hello = { type: "hello", sessionId: SESSION, agentId: "agent-0", displayName: "Claude Code", token: TOKEN, protocol: 2 };
    expectAccepted(frame(), hello, "an ordinary hello");
    expectAccepted(frame(), { ...hello, intent: "choose" }, "a choose-only hello");
    expectRejected(frame(), { ...hello, intent: "work" }, "another intent");
  });

  it("keeps the protocol at 2 and no longer knows the stand-by frame (S6, R-274)", () => {
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
    expectRejected(frame(), { type: "relay-standby", servingRelayPid: RELAY_PID }, "a relay-standby");
  });
});

describe("T494 the two refusals (FR-272, FR-277, D-018-13)", () => {
  const refusal = () => contractSchema("agentRefusalSchema");
  const summary = () => contractSchema("agentBrowserSummarySchema");

  it("describes a browser by id, name and kind only", () => {
    expectAccepted(summary(), SUMMARY, "a summary");
    expectRejected(summary(), { ...SUMMARY, connectedSince: "x" }, "a summary with an extra key");
    expectRejected(summary(), { browserId: BROWSER_ID, name: "Edge" }, "a summary without a kind");
  });

  it("accepts browser-not-chosen with the connected list", () => {
    expectAccepted(refusal(), { reason: "browser-not-chosen", browsers: [SUMMARY] }, "one browser");
    expectAccepted(refusal(), { reason: "browser-not-chosen", browsers: [] }, "none connected (remembered offline)");
    expectAccepted(
      refusal(),
      { reason: "browser-not-chosen", browsers: Array.from({ length: 16 }, () => SUMMARY) },
      "sixteen browsers",
    );
    expectRejected(
      refusal(),
      { reason: "browser-not-chosen", browsers: Array.from({ length: 17 }, () => SUMMARY) },
      "seventeen browsers",
    );
    expectRejected(refusal(), { reason: "browser-not-chosen" }, "no list");
  });

  it("accepts browser-disconnected with the lost browser and the connected list", () => {
    expectAccepted(
      refusal(),
      { reason: "browser-disconnected", browser: SUMMARY, browsers: [] },
      "lost, nothing else connected",
    );
    expectRejected(refusal(), { reason: "browser-disconnected", browsers: [] }, "no lost browser");
    expectRejected(
      refusal(),
      { reason: "browser-disconnected", browser: SUMMARY, browsers: [], extra: 1 },
      "an extra key",
    );
  });

  it("carries the hint sentences in both languages", () => {
    const hints = contractExport<{ notChosen: string; disconnected: (name: string) => string }>(
      "BROWSER_REFUSAL_HINTS",
    );
    expect(hints.notChosen).toContain(
      "Several browsers are running Hallpass. Ask the user which one to use, then call select_browser with its " +
        "browserId (or request_browser_choice to let them pick it in the browser).",
    );
    const disconnected = hints.disconnected("Work Edge");
    expect(disconnected).toContain(
      "The browser this session was using (Work Edge) is no longer connected. Ask the user whether to wait for it " +
        "or to use another browser.",
    );
    // Both carry a zh-TW line after the English one, as the pairing hints do.
    for (const text of [hints.notChosen, disconnected]) {
      expect(text.split("\n")).toHaveLength(2);
      expect(text.split("\n")[1]).toMatch(/[一-鿿]/u);
    }
    // They ride in the response's `hint`, which is bounded at 400 characters.
    expect(hints.notChosen.length).toBeLessThanOrEqual(400);
    expect(hints.disconnected("n".repeat(40)).length).toBeLessThanOrEqual(400);
  });
});

describe("T494 the three browser tools (FR-269, FR-270, FR-274, R-273)", () => {
  const NAMES = ["list_browsers", "select_browser", "request_browser_choice"];

  it("are in the tool list, described, and not batch steps", () => {
    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    const steps = contractExport<readonly string[]>("AGENT_BATCH_STEP_TOOL_NAMES");
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>("AGENT_TOOL_DESCRIPTORS");
    for (const name of NAMES) {
      expect(names).toContain(name);
      expect(steps).not.toContain(name);
      expect(descriptors.find((entry) => entry.name === name), `the host describes ${name}`).toBeDefined();
    }
    expect(names).toHaveLength(37);
  });

  it("tells the agent the owner decides and to use ids, not names", () => {
    const descriptor = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    ).find((entry) => entry.name === "list_browsers");
    expect(descriptor?.description).toBe(
      "List the browsers running Hallpass on this computer. When several are connected and none is chosen, ask the " +
        "user which one to use and call select_browser with its browserId; never pick one yourself. Refer to " +
        "browsers by browserId, not by name.",
    );
  });

  it("take exactly their arguments", () => {
    expectAccepted(toolArgs("list_browsers"), {}, "list_browsers {}");
    expectRejected(toolArgs("list_browsers"), { all: true }, "list_browsers with an argument");
    expectAccepted(toolArgs("request_browser_choice"), {}, "request_browser_choice {}");
    expectRejected(toolArgs("request_browser_choice"), { browserId: BROWSER_ID }, "request_browser_choice with an id");
    expectAccepted(toolArgs("select_browser"), { browserId: BROWSER_ID }, "select_browser with an id");
    expectRejected(toolArgs("select_browser"), {}, "select_browser without an id");
    expectRejected(toolArgs("select_browser"), { browserId: "" }, "select_browser with an empty id");
    expectRejected(toolArgs("select_browser"), { browserId: "x".repeat(65) }, "a 65-character id");
    expectRejected(toolArgs("select_browser"), { browserId: BROWSER_ID, name: "Edge" }, "an extra key");
  });

  it("answer in closed shapes", () => {
    const list = contractSchema("agentListBrowsersResultSchema");
    const row = { ...SUMMARY, connectedSince: "2026-10-03T08:00:00.000Z", current: true };
    expectAccepted(list, { browsers: [row] }, "one browser");
    expectAccepted(list, { browsers: [] }, "no browser");
    expectRejected(list, { browsers: [{ ...row, tabs: [] }] }, "a row with tabs");

    const select = contractSchema("agentSelectBrowserResultSchema");
    expectAccepted(select, SUMMARY, "a selection");
    expectRejected(select, { ...SUMMARY, current: true }, "a selection with an extra key");

    const choice = contractSchema("agentRequestBrowserChoiceResultSchema");
    expectAccepted(choice, SUMMARY, "a confirmed choice");
    expectAccepted(choice, { chosen: false }, "no browser chosen");
    expectRejected(choice, { chosen: true }, "a choice that names no browser");
  });
});

describe("T494 the panel (contracts/browser-tools.md Panel, FR-268, FR-274)", () => {
  const panel = () => contractSchema("agentPanelStateSchema");
  const command = () => contractSchema("agentPanelCommandSchema");
  const BROWSER = { name: "Work Edge", defaultName: "Edge", kind: "edge", others: 1 };
  const CHOICE = { requestId: "r-1", agentName: "Claude Code", raisedAt: "2026-10-03T08:00:00.000Z" };

  it("still parses a 0.10.0 projection and accepts this browser and the choice card", () => {
    expectAccepted(panel(), PANEL, "a projection without a browser");
    expectAccepted(panel(), { ...PANEL, browser: BROWSER }, "a projection with this browser");
    expectAccepted(panel(), { ...PANEL, browserChoice: CHOICE }, "a projection with a choice card");
    expectRejected(panel(), { ...PANEL, browser: { ...BROWSER, others: -1 } }, "negative peers");
    expectRejected(panel(), { ...PANEL, browser: { ...BROWSER, kind: "opera" } }, "an unknown kind");
    expectRejected(panel(), { ...PANEL, browser: { ...BROWSER, extra: 1 } }, "a browser with an extra key");
    expectRejected(panel(), { ...PANEL, browserChoice: { ...CHOICE, requestId: "" } }, "a card naming no request");
  });

  it("adds the choice card to the prompt kinds a tick can name", () => {
    expect(contractExport<readonly string[]>("AGENT_PROMPT_KINDS")).toContain("browser-choice");
    expectAccepted(
      contractSchema("promptWaitingFrameSchema"),
      { type: "prompt-waiting", sessionId: SESSION, kind: "browser-choice", panelConnected: false, waitedMs: 5_000, boundMs: 120_000 },
      "a tick for a choice card",
    );
  });

  it("accepts a rename and a choice decision", () => {
    expectAccepted(command(), { type: "ui.agent.browser-rename", payload: { name: "Work" } }, "a rename");
    expectAccepted(command(), { type: "ui.agent.browser-rename", payload: { name: "n".repeat(40) } }, "40 chars");
    expectRejected(command(), { type: "ui.agent.browser-rename", payload: { name: "" } }, "an empty rename");
    expectRejected(command(), { type: "ui.agent.browser-rename", payload: { name: "n".repeat(41) } }, "41 chars");
    expectRejected(command(), { type: "ui.agent.browser-rename", payload: { name: "x", kind: "edge" } }, "extra key");

    const decide = { type: "ui.agent.browser-choice-decide", payload: { requestId: "r-1", confirm: true } };
    expectAccepted(command(), decide, "a confirm");
    expectAccepted(command(), { ...decide, payload: { requestId: "r-1", confirm: false } }, "a decline");
    expectRejected(command(), { ...decide, payload: { requestId: "r-1" } }, "a decision without confirm");
    expectRejected(command(), { ...decide, payload: { confirm: true } }, "a decision naming no request");
  });
});
