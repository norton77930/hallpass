import { describe, expect, it } from "vitest";
import {
  decideGate,
  requiresGate,
  type StatedPlan,
} from "../src/service-worker/agent-tools/gate.js";

/**
 * 003/T024 — the per-site gate (FR-041, FR-042, R-107).
 *
 * The gate is where the owner's standing decision becomes an answer about one call, so what is
 * asserted here is every rule that decision can take, including the two that are easy to get
 * backwards: an unplanned step under `follow-a-plan` is a *prompt*, not a refusal - the owner may
 * still say yes to it - and reading never reaches the gate at all, because reading is not an effect
 * the owner consented to individually.
 */

const base = {
  sessionId: "session-1",
  tabId: 7,
  site: "https://fixtures.test:19443",
  args: { ref: "tgt-1" },
} as const;

function plan(overrides: Partial<StatedPlan> = {}): StatedPlan {
  return {
    planId: "plan-1",
    site: "https://fixtures.test:19443",
    steps: [
      { tool: "click", args: { ref: "tgt-1" } },
      { tool: "type", args: { ref: "tgt-2", text: "hello" } },
    ],
    admittedCount: 0,
    ...overrides,
  };
}

describe("T024 per-site gate", () => {
  it("admits every effect under skip-checks", () => {
    expect(decideGate({ ...base, mode: "skip-checks", tool: "click" })).toEqual({ decision: "admit" });
    expect(decideGate({ ...base, mode: "skip-checks", tool: "drag" })).toEqual({ decision: "admit" });
  });

  it("prompts under ask, which is what a site nobody decided about is", () => {
    expect(decideGate({ ...base, mode: "ask", tool: "click" })).toEqual({ decision: "prompt" });
  });

  it("admits the next unadmitted step of the session's plan", () => {
    expect(decideGate({ ...base, mode: "follow-a-plan", tool: "click", plan: plan() })).toEqual({
      decision: "admit",
      step: 0,
    });

    // The second step is next only once the first has been admitted; asking for it early is not
    // "the plan the owner approved" and falls back to the owner.
    expect(
      decideGate({
        ...base,
        mode: "follow-a-plan",
        tool: "type",
        args: { ref: "tgt-2", text: "hello" },
        plan: plan(),
      }),
    ).toEqual({ decision: "prompt" });

    expect(
      decideGate({
        ...base,
        mode: "follow-a-plan",
        tool: "type",
        args: { ref: "tgt-2", text: "hello" },
        plan: plan({ admittedCount: 1 }),
      }),
    ).toEqual({ decision: "admit", step: 1 });
  });

  it("prompts when the step's arguments are not the ones that were stated", () => {
    expect(
      decideGate({ ...base, mode: "follow-a-plan", tool: "click", args: { ref: "tgt-9" }, plan: plan() }),
    ).toEqual({ decision: "prompt" });
  });

  it("prompts under follow-a-plan with no plan, or a plan for another site", () => {
    expect(decideGate({ ...base, mode: "follow-a-plan", tool: "click" })).toEqual({ decision: "prompt" });
    expect(
      decideGate({
        ...base,
        mode: "follow-a-plan",
        tool: "click",
        plan: plan({ site: "https://other.test" }),
      }),
    ).toEqual({ decision: "prompt" });
    // A plan whose steps have all been admitted governs nothing further.
    expect(
      decideGate({ ...base, mode: "follow-a-plan", tool: "click", plan: plan({ admittedCount: 2 }) }),
    ).toEqual({ decision: "prompt" });
  });

  /**
   * 008/FR-112 as the S4 review amended it (US3 scenario 7): under `follow-a-plan`, pressing OK on
   * a dialog the plan's own steps raised is part of the plan, not a fresh question. It spends no
   * step - the dialog is not one of them - so the plan continues where it was; a plan for another
   * site is no permission at all, exactly as it is for a click.
   */
  it("admits a dialog accept on the plan's site under follow-a-plan, and spends no step", () => {
    const accept = { tabId: 7, action: "accept" } as const;
    expect(
      decideGate({ ...base, mode: "follow-a-plan", tool: "dialog", args: accept, plan: plan() }),
    ).toEqual({ decision: "admit" });

    expect(
      decideGate({
        ...base,
        mode: "follow-a-plan",
        tool: "dialog",
        args: accept,
        plan: plan({ site: "https://other.test" }),
      }),
    ).toEqual({ decision: "prompt" });

    expect(decideGate({ ...base, mode: "follow-a-plan", tool: "dialog", args: accept })).toEqual({
      decision: "prompt",
    });
  });

  it("refuses a call it was never meant to see rather than admitting it", () => {
    // Reads and tab management do not pass through here at all. Reaching the gate with one is a
    // wiring mistake, and answering `admit` would turn that mistake into consent nobody gave.
    expect(decideGate({ ...base, mode: "skip-checks", tool: "find" })).toEqual({
      decision: "refuse",
      reason: "not-a-gated-tool",
    });
  });

  it("names which tools the gate governs", () => {
    for (const tool of [
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
    ] as const) {
      expect(requiresGate(tool), tool).toBe(true);
    }
    // 008/US3: two more the owner consents to. Pressing OK on a page's dialog agrees to whatever
    // it proposed, and leaving a page that asked to stay throws away work they have not saved -
    // which is why `navigate` and `tabs_close` are here now and were not before. Only a `force`
    // call reaches the gate for those two; an ordinary navigation never asks it anything.
    for (const tool of ["dialog", "navigate", "tabs_close"] as const) {
      expect(requiresGate(tool), tool).toBe(true);
    }
    for (const tool of ["find", "tabs_context", "tabs_create", "get_page_text", "wait"] as const) {
      expect(requiresGate(tool), tool).toBe(false);
    }
  });
});
