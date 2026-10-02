import { describe, expect, it } from "vitest";
import { requiresGate } from "../../apps/extension/src/service-worker/agent-tools/gate.js";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 017 — the session site plan: the `propose_sites` tool, the covered-tool set, the feature name and
 * the panel's new question and commands (data-model.md, contracts/propose-sites.md, R-247 - R-252).
 *
 * Every panel addition is optional or a new union member, so a 0.9.0 projection still parses; the
 * link protocol does not move.
 */

const ARGS = {
  origins: ["https://example.com", "https://docs.example.org"],
  purpose: "Compare the release notes with the changelog",
  steps: ["read the release notes", "open the changelog"],
};

const PANEL = {
  paired: [
    { agentId: "agent-0", displayName: "Claude Code", origin: "stdio:local", acceptedAt: "2026-10-02T00:00:00.000Z" },
  ],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
};

const SESSION_VIEW = { sessionId: "session-1", agentId: "agent-0", tabs: [] };

const QUESTION = {
  proposalId: "proposal-1",
  sessionId: "session-1",
  origins: ["https://example.com", "https://docs.example.org"],
  purpose: "Compare the release notes with the changelog",
  raisedAt: "2026-10-02T08:00:00.000Z",
};

describe("T460 propose_sites is a closed, non-batch tool (FR-249, R-248)", () => {
  const args = () =>
    contractExport<Record<string, { safeParse: (input: unknown) => { success: boolean } }>>("agentToolArgSchemas")
      .propose_sites!;

  it("is in the tool list and not a batch step", () => {
    expect(contractExport<readonly string[]>("AGENT_TOOL_NAMES")).toContain("propose_sites");
    expect(contractExport<readonly string[]>("AGENT_BATCH_STEP_TOOL_NAMES")).not.toContain("propose_sites");
  });

  it("accepts a proposal with and without steps", () => {
    expectAccepted(args(), ARGS, "a proposal with steps");
    expectAccepted(args(), { origins: ["http://localhost:8080"], purpose: "x" }, "one http origin with a port");
    expectAccepted(
      args(),
      { origins: Array.from({ length: 10 }, (_, i) => `https://s${i}.example.com`), purpose: "p".repeat(200) },
      "ten origins and a 200-character purpose",
    );
    expectAccepted(args(), { ...ARGS, steps: Array.from({ length: 10 }, () => "s".repeat(120)) }, "ten 120-char steps");
  });

  it("refuses what falls outside the shape", () => {
    expectRejected(args(), { ...ARGS, extra: true }, "an extra key");
    expectRejected(args(), { purpose: "x" }, "no origins");
    expectRejected(args(), { ...ARGS, origins: [] }, "an empty origin list");
    expectRejected(
      args(),
      { ...ARGS, origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example.com`) },
      "eleven origins",
    );
    expectRejected(args(), { ...ARGS, origins: ["https://a.com", "https://a.com"] }, "a duplicate origin");
    expectRejected(args(), { origins: ARGS.origins }, "no purpose");
    expectRejected(args(), { ...ARGS, purpose: "" }, "an empty purpose");
    expectRejected(args(), { ...ARGS, purpose: "p".repeat(201) }, "a 201-character purpose");
    expectRejected(args(), { ...ARGS, steps: Array.from({ length: 11 }, () => "s") }, "eleven steps");
    expectRejected(args(), { ...ARGS, steps: [""] }, "an empty step");
    expectRejected(args(), { ...ARGS, steps: ["s".repeat(121)] }, "a 121-character step");
  });

  it("refuses anything that is not an exact http(s) origin (FR-250)", () => {
    for (const origin of [
      "https://a.com/",
      "https://a.com/path",
      "https://a.com?q=1",
      "https://a.com#x",
      "https://*.a.com",
      "a.com",
      "ftp://a.com",
      "file:///C:/x",
      "chrome://settings",
      "data:text/plain,x",
      "HTTPS://A.COM",
      "",
    ]) {
      expectRejected(args(), { ...ARGS, origins: [origin] }, `origin '${origin}'`);
    }
  });

  it("is described to the agent with who decides and what still asks", () => {
    const descriptor = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    ).find((entry) => entry.name === "propose_sites");
    expect(descriptor).toBeDefined();
    expect(descriptor?.description).toContain("The owner approves or declines in the browser's side panel");
    expect(descriptor?.description).toContain("Page JavaScript and file uploads still ask.");
  });

  it("adds the declined and unavailable outcomes", () => {
    const outcomes = contractExport<readonly string[]>("AGENT_TOOL_OUTCOMES");
    expect(outcomes).toContain("declined");
    expect(outcomes).toContain("unavailable");
  });
});

describe("T460 the covered tools and the feature name (R-250, R-251)", () => {
  /**
   * Page JavaScript and uploads keep their own consent (FR-255). A forced `navigate` / `tabs_close`
   * is not among FR-254's page actions either: leaving a page that asked to stay throws away the
   * owner's unsaved work, so it still asks under a plan (S1 architecture review).
   */
  const EXCLUDED = ["evaluate", "file_upload", "upload_image", "navigate", "tabs_close"];

  it("names exactly the gated tools minus page JavaScript, uploads and forced leaves", () => {
    const covered = contractExport<readonly string[]>("AGENT_SITE_PLAN_COVERED_TOOLS");
    expect([...covered]).toEqual([
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
      "computer",
      "dialog",
    ]);
    // Pinned against the worker's own gate, which is the authority on what is gated at all.
    const gated = contractExport<readonly string[]>("AGENT_TOOL_NAMES").filter((name) =>
      requiresGate(name as Parameters<typeof requiresGate>[0]),
    );
    expect([...covered].sort()).toEqual(gated.filter((name) => !EXCLUDED.includes(name)).sort());
    for (const excluded of EXCLUDED) {
      expect(requiresGate(excluded as Parameters<typeof requiresGate>[0]), `${excluded} is gated`).toBe(true);
    }
  });

  it("exports the feature name and keeps the link protocol at 2", () => {
    expect(contractExport<string>("SITE_PLAN_FEATURE")).toBe("site-plan");
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});

describe("T460 the panel's site-plan question and session summary (R-247, R-252)", () => {
  const panel = () => contractSchema("agentPanelStateSchema");

  it("still parses a 0.9.0-shaped projection", () => {
    expectAccepted(panel(), PANEL, "a projection without site plans");
    expectAccepted(panel(), { ...PANEL, sessions: [SESSION_VIEW] }, "a session without a site plan");
  });

  it("accepts the pending question and the active summary", () => {
    expectAccepted(panel(), { ...PANEL, sitePlan: QUESTION }, "a question without steps");
    expectAccepted(
      panel(),
      { ...PANEL, sitePlan: { ...QUESTION, steps: ["read"], alreadyApproved: ["https://example.com"] } },
      "a question with steps and already-approved sites",
    );
    expectAccepted(
      panel(),
      { ...PANEL, sessions: [{ ...SESSION_VIEW, sitePlan: { origins: ["https://example.com"] } }] },
      "a session with an active plan",
    );
  });

  it("rejects what falls outside them", () => {
    expectRejected(panel(), { ...PANEL, sitePlan: { ...QUESTION, extra: 1 } }, "a question with an extra key");
    const { proposalId: _proposalId, ...withoutId } = QUESTION;
    expectRejected(panel(), { ...PANEL, sitePlan: withoutId }, "a question without a proposal id");
    expectRejected(panel(), { ...PANEL, sitePlan: { ...QUESTION, origins: [] } }, "a question with no origins");
    expectRejected(
      panel(),
      { ...PANEL, sitePlan: { ...QUESTION, origins: ["https://a.com/path"] } },
      "a question with a non-origin",
    );
    expectRejected(
      panel(),
      { ...PANEL, sessions: [{ ...SESSION_VIEW, sitePlan: { origins: ["https://a.com"], approvedAt: "x" } }] },
      "a session plan with an extra key",
    );
  });
});

describe("T460 the panel's site-plan commands (R-247, R-252)", () => {
  const command = () => contractSchema("agentPanelCommandSchema");

  it("accepts a decision and a withdraw", () => {
    expectAccepted(
      command(),
      {
        type: "ui.agent.site-plan-decide",
        payload: { proposalId: "proposal-1", approve: true, origins: ["https://example.com"] },
      },
      "an approval of one site",
    );
    expectAccepted(
      command(),
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: false, origins: [] } },
      "a decline",
    );
    expectAccepted(
      command(),
      { type: "ui.agent.site-plan-withdraw", payload: { sessionId: "session-1" } },
      "a withdraw",
    );
  });

  it("rejects extra keys, missing fields and an empty approval", () => {
    expectRejected(
      command(),
      {
        type: "ui.agent.site-plan-decide",
        payload: { proposalId: "proposal-1", approve: true, origins: ["https://example.com"], mode: "skip-checks" },
      },
      "a decision with an extra key",
    );
    expectRejected(
      command(),
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: true } },
      "a decision without origins",
    );
    expectRejected(
      command(),
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: true, origins: [] } },
      "an approval of nothing",
    );
    expectRejected(
      command(),
      { type: "ui.agent.site-plan-withdraw", payload: { sessionId: "session-1", origins: [] } },
      "a withdraw with an extra key",
    );
    expectRejected(command(), { type: "ui.agent.site-plan-withdraw", payload: {} }, "a withdraw without a session");
  });
});

describe("017 FR-263 session activity for a site plan", () => {
  it("accepts one activity line per plan event, carrying the site count, and nothing else", () => {
    const item = () => contractSchema("agentActivityItemSchema");
    for (const outcome of ["approved", "replaced", "withdrawn", "ended"]) {
      expectAccepted(item(), { at: 1, kind: "site-plan", outcome, message: "3" }, `site-plan ${outcome}`);
    }
    expectRejected(
      item(),
      { at: 1, kind: "site-plan", outcome: "approved", origins: ["https://a.example"] },
      "a line that lists origins",
    );
  });
});
