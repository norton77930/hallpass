import { describe, expect, it } from "vitest";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { EMPTY_PAIRING_STATE, reducePairing } from "../src/service-worker/pairing-controller.js";
import { shownText } from "../src/service-worker/shown-text.js";

/**
 * Security review 2026-11-05 S27 - text a page or an agent authored reaches the panel without the
 * characters that would restyle the card's own sentence: bidi overrides and isolates, zero-width
 * characters, C0/C1 controls. Newlines and tabs stay.
 */
describe("S27 shown text", () => {
  it("removes format and control characters and keeps everything visible", () => {
    expect(shownText("Cancel\u202E rest of the sentence")).toBe("Cancel rest of the sentence");
    expect(shownText("a\u200Bb\u2066c\u2069d\u00ADe")).toBe("abcde");
    expect(shownText("line one\nline\ttwo\u0007bell\u009Fx")).toBe("line one\nline\ttwobellx");
    expect(shownText("中文 and emoji 🙂 stay")).toBe("中文 and emoji 🙂 stay");
  });

  it("applies to the consent card's label and dialog text", async () => {
    const prompts = createAgentPromptController({ timeoutMs: 60 });
    const asked = prompts.ask({
      callId: "call-1",
      sessionId: "session-1",
      site: "https://shop.example",
      tool: "dialog",
      argsSummary: "press OK\u202E",
      targetLabel: "\u202EDelete everything",
      dialogText: "Really?\u200B\nYes or no",
    });
    const current = prompts.current();
    expect(current?.argsSummary).toBe("press OK");
    expect(current?.targetLabel).toBe("Delete everything");
    expect(current?.dialogText).toBe("Really?\nYes or no");
    prompts.decide(current?.promptId ?? "", false);
    await asked;
  });

  it("applies to an agent's display name on the pairing card", () => {
    const state = reducePairing(EMPTY_PAIRING_STATE, {
      type: "connection",
      agentId: "agent-1",
      displayName: "Claude\u202E edoC",
      origin: "stdio:local",
    });
    expect(state.pending?.displayName).toBe("Claude edoC");
  });
});
