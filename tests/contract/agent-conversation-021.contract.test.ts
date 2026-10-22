import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 021 - Hermes and DeepSeek in the side-panel conversation (contracts/agents.md; T638). Every change
 * is additive and optional, every object stays `strictObject`: two agent ids, availability notes, a
 * reject-only permission card, the `start-cancelled` code on a stopped state, two error codes, and a
 * conversation the agent cannot replay.
 */

const SESSION = "broker-session-1";
const CONVERSATION = "c0a8f3d2-6b1e-4d7a-9c2f-0d4e5b6a7c81";
const NOW = "2026-10-22T08:00:00.000Z";

const VIEW = {
  conversationId: CONVERSATION,
  agent: "deepseek",
  title: "Tidy the invoices",
  folder: { kind: "scratch" },
  mode: "strict",
  createdAt: NOW,
  lastUsedAt: NOW,
  resumable: true,
  state: "idle",
};

const PERMISSION = {
  type: "permission",
  requestId: "req-1",
  toolCallId: "tc-1",
  kind: "other",
  title: "",
  detail: "",
};

const event = (body: Record<string, unknown>) => ({
  type: "conversation-event",
  sessionId: SESSION,
  conversationId: CONVERSATION,
  seq: 1,
  event: body,
});

const overview = (agents: unknown[], conversations: unknown[] = []) => ({
  type: "conversation-overview",
  sessionId: SESSION,
  conversations,
  agents,
  folders: [],
});

describe("T638 agent identifiers (contracts/agents.md)", () => {
  it("lists the four agents in the panel's order", () => {
    expect(contractExport<readonly string[]>("CONVERSATION_AGENTS")).toEqual(["claude-code", "codex", "hermes", "deepseek"]);
  });

  it("starts and installs the new agents, and refuses an unknown one", () => {
    const c = contractSchema("conversationCommandSchema");
    for (const agent of ["hermes", "deepseek"]) {
      expectAccepted(c, { type: "ui.conversation.start", payload: { agent, folder: { kind: "scratch" } } }, `a ${agent} start`);
      expectAccepted(c, { type: "ui.conversation.install", payload: { agent } }, `a ${agent} install`);
    }
    expectRejected(c, { type: "ui.conversation.start", payload: { agent: "gemini", folder: { kind: "scratch" } } }, "an unknown agent");
  });

  it("carries all four agents in one overview", () => {
    const agents = ["claude-code", "codex", "hermes", "deepseek"].map((agent) => ({ agent, availability: "ready" }));
    expectAccepted(contractSchema("agentLinkFrameSchema"), overview(agents), "an overview of four agents");
  });
});

describe("T638 availability notes", () => {
  const f = () => contractSchema("agentLinkFrameSchema");

  it("accepts git-missing and pre-release notes, alone or together", () => {
    expectAccepted(f(), overview([{ agent: "hermes", availability: "ready", version: "0.22.2", notes: ["git-missing"] }]), "git-missing");
    expectAccepted(f(), overview([{ agent: "deepseek", availability: "needs-install", notes: ["pre-release"] }]), "pre-release");
    expectAccepted(f(), overview([{ agent: "hermes", availability: "ready", notes: ["git-missing", "pre-release"] }]), "both notes");
    expectAccepted(f(), overview([{ agent: "hermes", availability: "ready", notes: [] }]), "no notes");
  });

  it("refuses an unlisted note", () => {
    expectRejected(f(), overview([{ agent: "hermes", availability: "ready", notes: ["python-missing"] }]), "an unlisted note");
    expectRejected(f(), overview([{ agent: "hermes", availability: "ready", notes: "git-missing" }]), "a note that is not a list");
  });

  it("names the notes in the contract", () => {
    expect(contractExport<readonly string[]>("CONVERSATION_AGENT_NOTES")).toEqual(["git-missing", "pre-release"]);
  });
});

describe("T638 reject-only permission card (R-353)", () => {
  const f = () => contractSchema("agentLinkFrameSchema");

  it("accepts rejectOnly: true and a card without it", () => {
    expectAccepted(f(), event({ ...PERMISSION, rejectOnly: true }), "a reject-only card");
    expectAccepted(f(), event(PERMISSION), "an ordinary card");
  });

  it("refuses rejectOnly with any other value", () => {
    expectRejected(f(), event({ ...PERMISSION, rejectOnly: false }), "rejectOnly false");
    expectRejected(f(), event({ ...PERMISSION, rejectOnly: "yes" }), "rejectOnly as text");
  });
});

describe("T638 stop while starting and the two error codes (R-354, R-356)", () => {
  const f = () => contractSchema("agentLinkFrameSchema");

  it("adds start-cancelled and agent-model-unreachable to the error codes", () => {
    const codes = contractExport<readonly string[]>("CONVERSATION_ERROR_CODES");
    for (const code of ["start-cancelled", "agent-model-unreachable"]) {
      expect(codes).toContain(code);
      expectAccepted(
        f(),
        { type: "conversation-result", sessionId: SESSION, commandId: "c", ok: false, error: { code, detail: "d" } },
        `error code ${code}`,
      );
    }
  });

  it("lets a stopped state carry start-cancelled, and nothing else", () => {
    expectAccepted(f(), event({ type: "state", state: "stopped", code: "start-cancelled" }), "a cancelled start");
    expectAccepted(f(), event({ type: "state", state: "stopped" }), "a plain stop");
    expectRejected(f(), event({ type: "state", state: "stopped", code: "agent-exited" }), "another code on a state");
  });
});

describe("D-021-16 a mode fixed once the conversation has started (R-359, FR-360)", () => {
  const link = () => contractSchema("agentLinkFrameSchema");
  const command = () => contractSchema("conversationCommandSchema");

  it("names DeepSeek as the one such agent and adds the mode-fixed refusal", () => {
    expect(contractExport<readonly string[]>("CONVERSATION_MODE_FIXED_AGENTS")).toEqual(["deepseek"]);
    expect(contractExport<readonly string[]>("CONVERSATION_ERROR_CODES")).toContain("mode-fixed");
    expectAccepted(
      link(),
      { type: "conversation-result", sessionId: SESSION, commandId: "c", ok: false, error: { code: "mode-fixed", detail: "d" } },
      "error code mode-fixed",
    );
  });

  it("lets a start carry one of the two modes, and nothing else", () => {
    for (const mode of ["strict", "agent-review"]) {
      expectAccepted(command(), { type: "ui.conversation.start", payload: { agent: "deepseek", folder: { kind: "scratch" }, mode } }, `a ${mode} start`);
    }
    expectRejected(
      command(),
      { type: "ui.conversation.start", payload: { agent: "deepseek", folder: { kind: "scratch" }, mode: "danger-full-access" } },
      "a full-access start",
    );
  });
});

describe("T638 a conversation the agent cannot replay (R-352)", () => {
  const f = () => contractSchema("agentLinkFrameSchema");

  it("accepts replay: none on the conversation view, and only that value", () => {
    expectAccepted(f(), overview([], [{ ...VIEW, replay: "none" }]), "replay none");
    expectAccepted(f(), overview([], [VIEW]), "no replay field");
    expectRejected(f(), overview([], [{ ...VIEW, replay: "full" }]), "an unlisted replay value");
  });
});
