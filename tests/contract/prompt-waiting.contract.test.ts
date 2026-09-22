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

    expect(Object.keys(sentences).sort()).toEqual(["consent", "pairing"]);
    for (const [kind, sentence] of Object.entries(sentences)) {
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
  });
});
