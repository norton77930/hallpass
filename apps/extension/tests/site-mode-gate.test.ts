import { describe, expect, it } from "vitest";
import { AGENT_SITE_PLAN_COVERED_TOOLS, AGENT_TOOL_NAMES, type AgentToolName, type SiteMode } from "@hallpass/contracts";
import {
  decideGate,
  requiresGate,
  type GateInput,
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
    // 013/FR-174: putting a file into the page is one kind of change whichever end the bytes came
    // from - the owner's disk or a screenshot this session took - so the two are gated together or
    // the newer one would arrive on an `ask` site without a card.
    for (const tool of ["file_upload", "upload_image"] as const) {
      expect(requiresGate(tool), tool).toBe(true);
    }
    for (const tool of ["find", "tabs_context", "tabs_create", "get_page_text", "wait"] as const) {
      expect(requiresGate(tool), tool).toBe(false);
    }
  });
});

/**
 * 017/T466 — the session's approved site plan, as one more input to the same gate (R-245, R-250).
 *
 * The caller computes "this session's plan names the tab's current origin" and hands the gate a
 * boolean; the gate decides what it is worth. It is worth a card for exactly the page actions
 * FR-254 lists, under the two modes that would otherwise ask - and nothing for page JavaScript,
 * uploads or a forced leave, which keep asking (FR-255, S1 architecture review). Absent or false,
 * every answer the gate has ever given is given again, unchanged.
 */
describe("017 session plan", () => {
  const MODES: readonly SiteMode[] = ["ask", "follow-a-plan", "skip-checks"];
  const STILL_ASK: readonly AgentToolName[] = ["evaluate", "file_upload", "upload_image", "navigate", "tabs_close"];
  const forced = { tabId: 7, url: "https://fixtures.test:19443/next", force: true };

  it("admits every covered page action under ask and under follow-a-plan with no plan behind it", () => {
    for (const tool of AGENT_SITE_PLAN_COVERED_TOOLS) {
      for (const mode of ["ask", "follow-a-plan"] as const) {
        expect(decideGate({ ...base, mode, tool, sitePlanCovers: true }), `${tool} under ${mode}`).toEqual({
          decision: "admit",
        });
      }
    }
  });

  it("keeps page JavaScript, uploads and a forced leave asking on a covered site", () => {
    for (const tool of STILL_ASK) {
      for (const mode of ["ask", "follow-a-plan"] as const) {
        expect(
          decideGate({ ...base, mode, tool, args: tool === "navigate" ? forced : base.args, sitePlanCovers: true }),
          `${tool} under ${mode}`,
        ).toEqual({ decision: "prompt" });
      }
    }
  });

  it("changes nothing under skip-checks, and refuses an ungated tool whatever the plan says", () => {
    for (const tool of [...AGENT_SITE_PLAN_COVERED_TOOLS, ...STILL_ASK]) {
      expect(decideGate({ ...base, mode: "skip-checks", tool, sitePlanCovers: true }), tool).toEqual({
        decision: "admit",
      });
    }
    expect(decideGate({ ...base, mode: "ask", tool: "find", sitePlanCovers: true })).toEqual({
      decision: "refuse",
      reason: "not-a-gated-tool",
    });
  });

  it("still spends the stated plan's step when the batch's own plan names this call", () => {
    // A batch plan the owner approved before the session plan existed keeps counting its steps, so
    // a later step of that batch is still recognised as the plan's own.
    expect(decideGate({ ...base, mode: "follow-a-plan", tool: "click", plan: plan(), sitePlanCovers: true })).toEqual({
      decision: "admit",
      step: 0,
    });
    // And a call the stated plan does not name is admitted by the session plan instead of asked.
    expect(
      decideGate({
        ...base,
        mode: "follow-a-plan",
        tool: "click",
        args: { ref: "tgt-9" },
        plan: plan(),
        sitePlanCovers: true,
      }),
    ).toEqual({ decision: "admit" });
  });

  /**
   * The matrix the gate already answers, run again with the input present and false: every mode,
   * every tool in the closed list, with and without a stated plan for this site, another site, and
   * a spent one. The same answers, or the input changed a decision nobody approved.
   */
  it("answers exactly as before when the plan does not cover the site", () => {
    const plans: Array<StatedPlan | undefined> = [
      undefined,
      plan(),
      plan({ admittedCount: 1 }),
      plan({ admittedCount: 2 }),
      plan({ site: "https://other.test" }),
    ];
    const argsFor = (tool: AgentToolName): Record<string, unknown> =>
      tool === "type"
        ? { ref: "tgt-2", text: "hello" }
        : tool === "navigate"
          ? forced
          : tool === "dialog"
            ? { tabId: 7, action: "accept" }
            : base.args;
    let compared = 0;
    for (const mode of MODES) {
      for (const tool of AGENT_TOOL_NAMES) {
        for (const stated of plans) {
          const input: GateInput = { ...base, mode, tool, args: argsFor(tool), ...(stated ? { plan: stated } : {}) };
          const before = decideGate(input);
          expect(decideGate({ ...input, sitePlanCovers: false }), `${mode} ${tool}`).toEqual(before);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(MODES.length * AGENT_TOOL_NAMES.length * plans.length);
  });
});
