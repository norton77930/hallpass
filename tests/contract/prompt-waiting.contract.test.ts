import { describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 011/T283 — the frame that says "still waiting", the hint that says where to click, and the two
 * sentences both of them carry (contracts/prompt-waiting.md, FR-146, FR-148, FR-151).
 *
 * The first call of a session raises a pairing card into a side panel nobody has opened, and Chrome
 * will not let the worker open it (R-160). So the person has to be told, and the only channel that
 * reaches them is the agent's own reply: the worker says "still waiting" every five seconds, the
 * host turns that into a progress notification carrying the sentence, and the `timed-out` outcome
 * repeats it. All three read the same two strings from here, which is what makes the words the
 * gate asserts the words the person sees.
 *
 * The sentences are pinned by shape rather than by text - two lines, the shortcut, no placeholder -
 * because what matters to the person is that one line is in their language and that the way to open
 * the panel is in it. A `{` would mean somebody started templating page content into a sentence
 * FR-151 says carries none.
 */

const SESSION = "b7f0c3e1d9a24f5e";
const CALL = "c3d4e5f6";

function waiting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "prompt-waiting",
    sessionId: SESSION,
    callId: CALL,
    kind: "ask",
    panelConnected: false,
    waitedMs: 5_000,
    boundMs: 120_000,
    ...overrides,
  };
}

describe("T283 prompt-waiting", () => {
  it("carries one pending question's wait, with or without the call it belongs to", () => {
    const frame = contractSchema("agentLinkFrameSchema");

    expectAccepted(frame, waiting(), "a consent prompt's tick, naming the held call");

    const { callId: _callId, ...withoutCall } = waiting({ kind: "pairing" });
    // Pairing has no call of its own: the server owns that exchange, and the call waiting on it is
    // whichever one arrived first. A tick that named a call would attach the pairing to one of them.
    expectAccepted(frame, withoutCall, "a pairing tick, naming no call");

    for (const kind of ["plan", "dialog", "diagnostics"]) {
      expectAccepted(frame, waiting({ kind }), `a ${kind} prompt's tick`);
    }
  });

  it("refuses a kind, a count or a field nobody declared", () => {
    const frame = contractSchema("agentLinkFrameSchema");

    // The kinds are the questions the panel can hold. An unknown one would pick no sentence.
    expectRejected(frame, waiting({ kind: "pairing-request" }), "a tick naming a kind nobody declared");
    expectRejected(frame, waiting({ kind: "" }), "a tick naming no kind");
    expectRejected(frame, waiting({ waitedMs: -1 }), "a tick that has waited a negative time");
    // The host divides by this bound; a zero would re-arm the backstop into the past.
    expectRejected(frame, waiting({ boundMs: 0 }), "a tick bounded by nothing");
    expectRejected(frame, waiting({ panelConnected: "false" }), "a tick whose panel presence is text");
    expectRejected(frame, waiting({ sessionId: "" }), "a tick naming no session");
    // Strict, like every other frame here: page text reaches a log through a field nobody declared.
    expectRejected(frame, waiting({ title: "Buy now" }), "a tick carrying an undeclared field");
  });

  /**
   * 031 T911 (contracts/terminal-consent.md, R-452, R-459): the three frames that let the owner answer
   * a consent question in the agent's own client. Strict like every other link frame; the relay
   * forwards them unchanged.
   */
  describe("031 terminal consent frames", () => {
    const raised = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: "prompt-raised",
      sessionId: SESSION,
      callId: CALL,
      promptId: "prompt-1",
      kind: "effect",
      site: "https://shop.test",
      action: "click the Buy button",
      choices: ["once", "session", "deny"],
      boundMs: 120_000,
      ...overrides,
    });
    const answer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: "prompt-answer",
      sessionId: SESSION,
      callId: CALL,
      promptId: "prompt-1",
      choice: "once",
      ...overrides,
    });
    const settled = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      type: "prompt-settled",
      sessionId: SESSION,
      callId: CALL,
      promptId: "prompt-1",
      answeredFrom: "client",
      ...overrides,
    });

    it("accepts a raised question, an answer and a settlement", () => {
      const frame = contractSchema("agentLinkFrameSchema");
      expectAccepted(frame, raised(), "an effect question with all three choices");
      expectAccepted(frame, raised({ kind: "diagnostics", choices: ["once", "deny"] }), "a diagnostics question");
      expectAccepted(frame, raised({ action: "x".repeat(200) }), "an action at the bound");
      for (const choice of ["once", "session", "deny"]) {
        expectAccepted(frame, answer({ choice }), `an answer '${choice}'`);
      }
      for (const answeredFrom of ["client", "browser", "none"]) {
        expectAccepted(frame, settled({ answeredFrom }), `a settlement answered from '${answeredFrom}'`);
      }
    });

    it("refuses a field, a choice or a source nobody declared", () => {
      const frame = contractSchema("agentLinkFrameSchema");
      expectRejected(frame, raised({ title: "Buy now" }), "a raised frame with an undeclared field");
      expectRejected(frame, answer({ title: "Buy now" }), "an answer with an undeclared field");
      expectRejected(frame, settled({ title: "Buy now" }), "a settlement with an undeclared field");
      expectRejected(frame, raised({ action: "x".repeat(201) }), "an action longer than 200 characters");
      expectRejected(frame, raised({ kind: "ask" }), "a kind that is not effect or diagnostics");
      expectRejected(frame, raised({ choices: ["once", "always"] }), "a raised choice outside the enum");
      expectRejected(frame, raised({ boundMs: 0 }), "a question bounded by nothing");
      expectRejected(frame, answer({ choice: "always" }), "an answer outside once|session|deny");
      expectRejected(frame, answer({ choice: "" }), "an answer naming no choice");
      expectRejected(frame, settled({ answeredFrom: "terminal" }), "a source outside client|browser|none");
      const { callId: _callId, ...withoutCall } = answer();
      expectRejected(frame, withoutCall, "an answer naming no call");
      // T929 I1: every frame names the one question it is about, so an answer meant for one
      // question of a call can never settle the next question of the same call.
      for (const [name, build] of [["raised", raised], ["answer", answer], ["settled", settled]] as const) {
        const { promptId: _promptId, ...withoutPrompt } = build();
        expectRejected(frame, withoutPrompt, `a ${name} frame naming no question`);
        expectRejected(frame, build({ promptId: "" }), `a ${name} frame naming an empty question`);
      }
    });

    it("names the capability the worker advertises", () => {
      expect(contractExport<string>("TERMINAL_CONSENT_FEATURE")).toBe("terminal-consent");
    });

    it("lets the panel answer for the session and grant diagnostics, and nothing more", () => {
      const command = contractSchema("agentPanelCommandSchema");
      const decide = (payload: Record<string, unknown>) => ({
        type: "ui.agent.effect-decide",
        payload: { promptId: "prompt-1", allow: true, ...payload },
      });
      expectAccepted(command, decide({ session: true }), "an allow for this site for the session");
      expectAccepted(command, decide({ grantDiagnostics: true }), "an allow that also grants diagnostics");
      expectRejected(command, decide({ session: false }), "a session flag that is not true");
      expectRejected(command, decide({ grantDiagnostics: false }), "a diagnostics flag that is not true");
      expectRejected(command, decide({ session: "yes" }), "a session flag that is text");
    });

    /** 031 R-455: the one sentence every expired consent question carries, to relay to the owner. */
    it("tells the agent where the owner answers, in both languages, within the hint bound", () => {
      const hint = contractExport<string>("CONSENT_TIMEOUT_HINT");
      const lines = hint.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/Alt\+A/);
      expect(lines[0]).toContain("side panel");
      expect(lines[1]).toContain("Alt+A");
      expect(lines[1]).toMatch(/[一-鿿]/);
      expect(hint).not.toContain("{");
      expectAccepted(
        contractSchema("agentNativeResponseSchema"),
        { callId: CALL, outcome: "timed-out", reason: "no-answer", hint },
        "a timed-out answer carrying it",
      );
    });

    /** 031 FR-475, R-458: the session card lists its grants with where each was given. */
    it("lets a session card carry its grants with their source, and nothing more", () => {
      const panel = contractSchema("agentPanelStateSchema");
      const base = { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected" };
      const card = (grants: unknown) => ({ ...base, sessions: [{ sessionId: SESSION, agentId: "agent-0", tabs: [], grants }] });
      const grant = { site: "https://shop.test", kind: "page-actions", source: "client" };
      expectAccepted(panel, card([grant, { ...grant, kind: "diagnostics", source: "browser" }]), "two grants");
      expectAccepted(panel, { ...base, sessions: [{ sessionId: SESSION, agentId: "agent-0", tabs: [] }] }, "a 0.20 card with none");
      const max = contractExport<number>("AGENT_SESSION_GRANTS_SHOWN");
      expectAccepted(panel, card(Array.from({ length: max }, () => grant)), "grants at the bound");
      expectRejected(panel, card(Array.from({ length: max + 1 }, () => grant)), "grants past the bound");
      expectRejected(panel, card([]), "an empty list, which is no grants and is sent as none");
      expectRejected(panel, card([{ ...grant, grantedAt: 1 }]), "a grant with an undeclared field");
      expectRejected(panel, card([{ ...grant, source: "terminal" }]), "a source outside client|browser");
      expectRejected(panel, card([{ ...grant, kind: "always" }]), "a kind outside page-actions|diagnostics");
      expectRejected(panel, card([{ ...grant, site: "https://shop.test/path" }]), "a site that is not an origin");
    });
  });

  it("leaves the link protocol where it is", () => {
    // The frame is optional and unknown types are dropped at both ends (relay: unaddressed; host:
    // `agent.frame.rejected`). The worker sends a tick only while no panel is connected (011 review
    // M1), so an old relay in front of a new host changes nothing for a question the person can
    // see, and a closed-panel wait falls back to the bounds it had before 011: the host's flat
    // backstop for a call, and the server's own 45 s for a pairing. A bump would have refused that
    // pair outright, which is the worse failure.
    expect(AGENT_LINK_PROTOCOL).toBe(2);
  });

  it("lets a timed-out answer say where to click", () => {
    const response = contractSchema("agentNativeResponseSchema");
    const sentences = contractExport<{ pairing: string; consent: string }>("ATTENTION_SENTENCES");
    const timedOut = { callId: CALL, outcome: "timed-out", reason: "no-answer" };

    expectAccepted(response, timedOut, "a timed-out answer with no hint");
    expectAccepted(response, { ...timedOut, hint: sentences.consent }, "a timed-out answer that says where to click");
    expectRejected(response, { ...timedOut, hint: "x".repeat(401) }, "a hint longer than the bound");
    expectRejected(response, { ...timedOut, hint: 7 }, "a hint that is not text");

    // And inside a batch, which is where a consent card most often meets a panel nobody has open:
    // the step that timed out carries the sentence, or the batch's answer swallows it (T293).
    const step = contractSchema("agentBatchStepResultSchema");
    const timedOutStep = { index: 2, outcome: "timed-out", reason: "no-answer" };
    expectAccepted(step, timedOutStep, "a timed-out step with no hint");
    expectAccepted(step, { ...timedOutStep, hint: sentences.consent }, "a timed-out step that says where to click");
    expectRejected(step, { ...timedOutStep, hint: "x".repeat(401) }, "a step hint longer than the bound");
  });

  it("says where to click in both languages, and says nothing else", () => {
    const sentences = contractExport<Record<string, string>>("ATTENTION_SENTENCES");

    expect(Object.keys(sentences).sort()).toEqual(["choice", "consent", "pairing"]);
    for (const [kind, sentence] of Object.entries(sentences)) {
      // Each travels as a `hint` on a strict frame, so each must fit the hint bound (400).
      expect(sentence.length, `${kind} fits the hint bound`).toBeLessThanOrEqual(400);
      const lines = sentence.split("\n");
      // One line each, English first: the agent relays the whole thing, and the person reads the
      // line they can read.
      expect(lines, `${kind} is two lines`).toHaveLength(2);
      expect(lines[0], `${kind}'s English line`).toMatch(/Alt\+A/);
      expect(lines[1], `${kind}'s zh-TW line`).toContain("Alt+A");
      expect(lines[1], `${kind}'s second line is zh-TW`).toMatch(/[一-鿿]/);
      // FR-151: nothing about the page, the arguments or the session - so nothing to fill in.
      expect(sentence, `${kind} carries no placeholder`).not.toContain("{");
      expect(sentence, `${kind} names the side panel`).toContain("side panel");
    }
    expect(sentences.pairing).toContain("pairing");
    expect(sentences.consent).toContain("consent card");
    // The choice spans browsers: it names none of them, and no consent card.
    expect(sentences.choice).toContain("which browser");
    expect(sentences.choice).not.toContain("Chrome");
    expect(sentences.choice).not.toContain("consent card");
  });
});
