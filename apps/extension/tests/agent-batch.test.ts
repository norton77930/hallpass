import { describe, expect, it, vi } from "vitest";
import { agentBatchStepResultSchema, type AgentNativeRequest, type AgentNativeResponse } from "@hallpass/contracts";
import { createAgentBatch } from "../src/service-worker/agent-tools/batch.js";
import { createStatedPlans } from "../src/service-worker/agent-tools/plans.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createAgentStopSignals, type AgentToolRequest } from "../src/service-worker/agent-tools/stop.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 003/T047 — `browser_batch` (US5, FR-046, FR-047).
 *
 * The batch decides nothing about a page: every step is handed to the same dispatch a single call
 * would have gone through, which is what makes "the gate applies to each step exactly as if it had
 * been sent alone" true by construction rather than by a second copy of the gate living here.
 *
 * So what is asserted here is the batch's own five rules: order, one tab, stopping at the first
 * step that did not end `ok` with the rest reported not run, the owner's Stop ending it where it
 * stands, and - the one place the batch does decide something - `follow-a-plan`, where the whole
 * batch is one question and the owner's answer becomes the session's stated plan for that site.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";

type Recorded = { tool: string; args: Record<string, unknown>; callId: string };

function harness(
  overrides: Partial<Parameters<typeof createAgentBatch>[0]> = {},
  answers: (request: AgentNativeRequest) => AgentNativeResponse | Promise<AgentNativeResponse> = (request) => ({
    callId: request.callId,
    outcome: "ok",
    result: { observed: { effect: "activated" } },
  }),
) {
  const seen: Recorded[] = [];
  const siteModes = createSiteModeStore();
  const plans = createStatedPlans();
  const prompts = createAgentPromptController({ timeoutMs: 80 });
  const stops = createAgentStopSignals();
  const dispatch = vi.fn(async (request: AgentNativeRequest) => {
    seen.push({ tool: request.tool, args: request.args, callId: request.callId });
    return answers(request);
  });
  const runner = createAgentBatch({
    siteModes,
    plans,
    prompts,
    stops,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    siteOfTab: async () => SITE,
    dispatch,
    ...overrides,
  });
  return { runner, seen, siteModes, plans, prompts, stops, dispatch };
}

function batchRequest(steps: Array<{ tool: string; args: Record<string, unknown> }>): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-h1",
    tool: "browser_batch",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, steps },
  } as AgentNativeRequest;
}

const CLICK = { tool: "click", args: { target: { ref: "t_one" } } };
const TYPE = { tool: "type", args: { target: { ref: "t_one" }, text: "hello" } };

describe("T047 browser_batch", () => {
  it("runs the steps in order on the batch's tab and answers each in order", async () => {
    const { runner, seen } = harness();

    const response = await runner.run(batchRequest([CLICK, TYPE]));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        results: [
          { index: 0, outcome: "ok", result: { observed: { effect: "activated" } } },
          { index: 1, outcome: "ok", result: { observed: { effect: "activated" } } },
        ],
      },
    });
    expect(seen.map((step) => step.tool)).toEqual(["click", "type"]);
    // The batch's tab, added to every step: a step never names a tab of its own (contract), so this
    // is the only place the tab a step runs on can come from.
    expect(seen.every((step) => step.args.tabId === AGENT_TAB)).toBe(true);
    // One call id per step, derived from the batch's, so an answer can be traced to its step.
    expect(new Set(seen.map((step) => step.callId)).size).toBe(2);
  });

  it("015/T407: a click step's press outcomes and hint reach the step result unchanged", async () => {
    // What the press path answers for a link that opened a tab (015 FR-200, contracts
    // press-outcomes.md "Applies to": batch steps carry the same `observed` and `hint`).
    const observed = {
      effect: "activated",
      documentChanged: false,
      verified: true,
      verdict: "verified",
      clicks: 1,
      newTabs: [{ tabId: 12, url: `${SITE}/ordinary?from=new-tab`, held: false }],
    };
    const hint = `The press opened tab 12 (${SITE}/ordinary?from=new-tab). It is not held by this session; use tabs_claim to act on it.`;
    const { runner } = harness({}, (request) => ({
      callId: request.callId,
      outcome: "ok",
      result: { observed },
      hint,
    }));

    const response = await runner.run(batchRequest([CLICK]));

    const step = (response.result as { results: unknown[] }).results[0];
    expect(step).toEqual({ index: 0, outcome: "ok", result: { observed }, hint });
    expect(agentBatchStepResultSchema.safeParse(step).success).toBe(true);
  });

  it("stops at the first step that did not end ok and reports the rest as not run", async () => {
    const { runner, seen } = harness({}, (request) =>
      request.args.text === "hello"
        ? { callId: request.callId, outcome: "stale", reason: "stale-target" }
        : { callId: request.callId, outcome: "ok" },
    );

    const response = await runner.run(batchRequest([CLICK, TYPE, CLICK]));

    expect(response.outcome).toBe("ok");
    expect(response.result).toEqual({
      results: [
        { index: 0, outcome: "ok" },
        { index: 1, outcome: "stale", reason: "stale-target" },
        { index: 2, outcome: "failed", reason: "not-run" },
      ],
    });
    // Not run means not sent: the third step never reached the page at all.
    expect(seen).toHaveLength(2);
  });

  /**
   * 008/T226 — the step that raised a dialog stops the batch (FR-111, US3 edge case).
   *
   * It is the same stop-at-first-failure rule reaching one step further, and the step did not fail:
   * the click landed and the page asked a question about it. Every later step would answer
   * `blocked-by-dialog` anyway, so running them would bury the one answer that matters under a
   * column of refusals.
   */
  it("stops at a step whose ok answer carries a dialog the page opened", async () => {
    const dialog = {
      id: "d1",
      type: "confirm" as const,
      message: "Delete 3 orders?",
      openedAt: 1_700_000_000_000,
      tabId: AGENT_TAB,
    };
    const { runner, seen } = harness({}, (request) => ({
      callId: request.callId,
      outcome: "ok",
      ...(request.tool === "click" ? { result: { observed: { effect: "activated" }, dialog } } : {}),
    }));

    const response = await runner.run(batchRequest([CLICK, TYPE, TYPE]));

    expect(response.result).toEqual({
      results: [
        { index: 0, outcome: "ok", result: { observed: { effect: "activated" }, dialog } },
        { index: 1, outcome: "failed", reason: "not-run" },
        { index: 2, outcome: "failed", reason: "not-run" },
      ],
    });
    expect(seen).toHaveLength(1);
  });

  it("refuses a tab the session does not own before any step runs", async () => {
    const { runner, dispatch } = harness();

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "browser_batch",
      tabId: 99,
      args: { tabId: 99, steps: [CLICK] },
    } as AgentNativeRequest);

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses arguments the contract does not admit", async () => {
    const { runner, dispatch } = harness();

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "browser_batch",
      tabId: AGENT_TAB,
      // A step naming its own tab: refused whole rather than run with one of the two tabs picked.
      args: { tabId: AGENT_TAB, steps: [{ tool: "click", args: { tabId: 99, target: { ref: "t" } } }] },
    } as AgentNativeRequest);

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ends at the step it is on when the owner stops, and never calls a stop an effect", async () => {
    let started: (() => void) | undefined;
    const firstStep = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { runner, stops, seen } = harness({}, async (request) => {
      started?.();
      // The step was delivered before the Stop arrived; what the page did is what is reported.
      return { callId: request.callId, outcome: "ok", result: { delivered: true } };
    });

    const pending = runner.run(batchRequest([CLICK, TYPE, CLICK]));
    await firstStep;
    stops.stop("call-1");
    const response = await pending;

    const results = (response.result as { results: Array<{ index: number; outcome: string; reason?: string }> })
      .results;
    // FR-046: the step already delivered reports what was observed, never `stopped`.
    expect(results[0]).toEqual({ index: 0, outcome: "ok", result: { delivered: true } });
    expect(results.slice(1)).toEqual([
      { index: 1, outcome: "stopped", reason: "not-run" },
      { index: 2, outcome: "stopped", reason: "not-run" },
    ]);
    expect(seen).toHaveLength(1);
  });

  /**
   * 014/T357 — the owner interrupted a batch at the step it was on (FR-180).
   *
   * A batch is the one answer that has more to say than "stopped". The per-step list cannot say it
   * on its own: a step that never started and a step that failed both read as `not-run` there, and
   * "how far did it get" is the agent's next question. So the answer names the three groups - what
   * ran, where it was interrupted, what never started - and its outcome is the interrupt's, not
   * the `ok` an ordinary batch answers with.
   */
  it("reports what ran, where it was interrupted and what never started", async () => {
    let reachedThird: (() => void) | undefined;
    const third = new Promise<void>((resolve) => {
      reachedThird = resolve;
    });
    let stops: ReturnType<typeof harness>["stops"] | undefined;
    const built = harness({}, async (request) => {
      const step = Number(request.callId.split("#")[1] ?? -1);
      if (step < 2) return { callId: request.callId, outcome: "ok", result: { delivered: true } };
      // The third step is the one in flight when the owner presses 中斷: the dispatch point it
      // would have gone through answers it, which is what this fake stands in for.
      reachedThird?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      stops?.interruptSession("session-h1");
      return {
        callId: request.callId,
        outcome: "stopped",
        reason: "owner-interrupted",
        hint: "The owner interrupted this step.",
      };
    });
    stops = built.stops;

    const pending = built.runner.run(batchRequest([CLICK, TYPE, CLICK, TYPE, CLICK]));
    await third;
    const response = await pending;

    // `ok`, as every partially-run batch answers: the host composes an error reply from the
    // outcome and the reason alone, so a `stopped` batch would reach the agent with none of the
    // three lists below. The interruption is said on the step it happened to.
    expect(response).toMatchObject({ callId: "call-1", outcome: "ok" });
    const result = response.result as {
      results: Array<{ index: number; outcome: string; reason?: string; hint?: string }>;
      completed: number[];
      interruptedAt: number;
      notRun: number[];
    };
    expect(result.completed).toEqual([0, 1]);
    expect(result.interruptedAt).toBe(2);
    expect(result.notRun).toEqual([3, 4]);
    // The step's own answer is where the reason and the sentence survive the trip to the agent;
    // only that step knows whether its input had already gone out (FR-181).
    expect(result.results[2]).toMatchObject({
      index: 2,
      outcome: "stopped",
      reason: "owner-interrupted",
      hint: "The owner interrupted this step.",
    });
    expect(result.results.slice(3)).toEqual([
      { index: 3, outcome: "stopped", reason: "not-run" },
      { index: 4, outcome: "stopped", reason: "not-run" },
    ]);
    expect(built.seen).toHaveLength(3);
  });

  /** FR-180: and the plan it stated is gone, so the next single call on that site asks again. */
  it("clears the plan it stated when the owner interrupts it", async () => {
    const built = harness({}, async (request) => {
      const step = Number(request.callId.split("#")[1] ?? -1);
      if (step === 0) built.stops.interruptSession("session-h1");
      return { callId: request.callId, outcome: "ok", result: { delivered: true } };
    });
    await built.siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = built.runner.run(batchRequest([CLICK, TYPE]));
    await vi.waitFor(() => expect(built.prompts.currentPlan()).toBeDefined());
    built.prompts.decidePlan(built.prompts.currentPlan()?.planId ?? "", true);
    const response = await pending;

    expect(response).toMatchObject({ outcome: "ok" });
    expect((response.result as { interruptedAt?: number }).interruptedAt).toBe(1);
    expect(built.plans.get(SITE), "consent for a sequence that is over").toBeUndefined();
  });

  it("asks about the whole batch once under follow-a-plan, and its steps then run unprompted", async () => {
    const { runner, siteModes, prompts, plans, seen } = harness();
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = runner.run(batchRequest([CLICK, TYPE]));
    await vi.waitFor(() => expect(prompts.currentPlan()).toBeDefined());
    const plan = prompts.currentPlan();
    expect(plan).toMatchObject({
      site: SITE,
      steps: [
        { tool: "click", summary: "click a page element" },
        { tool: "type", summary: "type text into a page element" },
      ],
    });
    // The owner is never shown the call's arguments, only what the worker says would happen.
    expect(JSON.stringify(plan)).not.toContain("t_one");

    expect(prompts.decidePlan(plan?.planId ?? "", true)).toBe(true);
    const response = await pending;

    expect(response.outcome).toBe("ok");
    expect(seen.map((step) => step.tool)).toEqual(["click", "type"]);
    // The approved list was the session's stated plan while it ran, and is gone once it has.
    expect(plans.get(SITE)).toBeUndefined();
  });

  it("skips the steps the owner struck out and runs the rest in order", async () => {
    const { runner, siteModes, prompts, seen } = harness();
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = runner.run(batchRequest([CLICK, TYPE, CLICK]));
    await vi.waitFor(() => expect(prompts.currentPlan()).toBeDefined());
    prompts.decidePlan(prompts.currentPlan()?.planId ?? "", true, [1]);
    const response = await pending;

    expect(response.result).toEqual({
      results: [
        { index: 0, outcome: "ok", result: { observed: { effect: "activated" } } },
        // Skipped, and said so: an excluded step is the owner's decision, not a step that failed.
        { index: 1, outcome: "denied", reason: "excluded" },
        { index: 2, outcome: "ok", result: { observed: { effect: "activated" } } },
      ],
    });
    expect(seen.map((step) => step.tool)).toEqual(["click", "click"]);
  });

  it("runs nothing when the owner refuses the plan", async () => {
    const { runner, siteModes, prompts, dispatch, plans } = harness();
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = runner.run(batchRequest([CLICK, TYPE]));
    await vi.waitFor(() => expect(prompts.currentPlan()).toBeDefined());
    prompts.decidePlan(prompts.currentPlan()?.planId ?? "", false);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(plans.get(SITE)).toBeUndefined();
  });

  it("runs nothing when the plan question is never answered (D-M3-1)", async () => {
    const { runner, siteModes, dispatch, plans } = harness();
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    await expect(runner.run(batchRequest([CLICK]))).resolves.toEqual({
      callId: "call-1",
      outcome: "timed-out",
      reason: "no-answer",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(plans.get(SITE)).toBeUndefined();
  });

  it("asks no plan question under ask or skip-checks", async () => {
    for (const mode of ["ask", "skip-checks"] as const) {
      const { runner, siteModes, prompts, seen } = harness();
      await siteModes.set(SITE, { mode });

      const response = await runner.run(batchRequest([CLICK]));

      // Under `ask` the steps prompt one at a time inside the dispatch, exactly as if each had been
      // sent alone (FR-047); the batch itself asks nothing and is never wider than `ask`.
      expect(prompts.currentPlan(), mode).toBeUndefined();
      expect(response.outcome, mode).toBe("ok");
      expect(seen.map((step) => step.tool), mode).toEqual(["click"]);
    }
  });

  it("states, for that site alone, the plan the gate will admit step by step", async () => {
    const seen: Array<ReturnType<typeof plansSnapshot>> = [];
    const plansSnapshot = () => {
      const plan = plans.get(SITE);
      return plan ? { site: plan.site, steps: plan.steps, admitted: plan.admittedCount } : undefined;
    };
    const { runner, siteModes, prompts, plans } = harness({}, (request) => {
      seen.push(plansSnapshot());
      return { callId: request.callId, outcome: "ok" };
    });
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = runner.run(batchRequest([CLICK, { tool: "find", args: { query: "a button" } }, TYPE]));
    await vi.waitFor(() => expect(prompts.currentPlan()).toBeDefined());
    prompts.decidePlan(prompts.currentPlan()?.planId ?? "", true);
    await pending;

    // The stated plan holds the two *effects*, in order, and nothing else: only effects reach the
    // gate, so a plan that counted the read among its steps would admit them out of step with
    // itself. Its arguments are the *parsed* ones - `mode: "replace"` is defaulted here - because
    // that is what the gate compares a later call against.
    expect(seen[0]).toEqual({
      site: SITE,
      admitted: 0,
      steps: [
        { tool: "click", args: { tabId: AGENT_TAB, target: { ref: "t_one" } } },
        { tool: "type", args: { tabId: AGENT_TAB, target: { ref: "t_one" }, text: "hello", mode: "replace" } },
      ],
    });
    // Nothing on another site was approved by this answer.
    expect(plans.get("https://other.test")).toBeUndefined();
  });

  /**
   * US5 scenario 3: a `navigate` step moves the tab, and the steps after it are governed by the
   * destination site. The batch does not carry a mode decision across its steps - it reads the site
   * once, to know whether to ask about a plan at all - so every step after a navigation is decided
   * where every other single call is: in the gate, on the binding that step's dispatch made.
   */
  it("asks about the site once, and keeps dispatching across a navigation", async () => {
    let asked = 0;
    const { runner, seen } = harness({
      siteOfTab: async () => {
        asked += 1;
        return SITE;
      },
    });

    const response = await runner.run(
      batchRequest([CLICK, { tool: "navigate", args: { url: "https://other.test/page" } }, CLICK]),
    );

    expect(response.outcome).toBe("ok");
    expect(seen.map((step) => step.tool)).toEqual(["click", "navigate", "click"]);
    expect(asked).toBe(1);
  });

  /**
   * 011 review H1 — a step says which call the host is actually holding.
   *
   * The step's own id is minted here and known nowhere else, so a step that raises a consent card
   * would say it was still waiting under an id the relay cannot route and the router is not
   * holding: the tick is dropped and the batch is given up on with the card on screen. The batch is
   * the only place that knows both ids, so it is the place that says so.
   */
  it("hands each step the batch's own call id beside the step's", async () => {
    const { runner, dispatch } = harness();

    await runner.run(batchRequest([CLICK, TYPE]));

    for (const [index, call] of dispatch.mock.calls.entries()) {
      const step = call[0] as AgentToolRequest;
      expect(step.callId, `step ${index} runs under its own id`).toBe(`call-1#${index}`);
      expect(step.hostCallId, `step ${index} names the call the host holds`).toBe("call-1");
    }
  });

  /**
   * 014/T369 review F7 — the notice rides in a field with a bound, so it is written to fit it.
   *
   * `hint` is `z.string().max(400)` and the answer frame is strict: a sentence one character over
   * does not arrive truncated, it makes the whole frame fail to parse and the agent is told
   * nothing at all. Two origins long enough to overflow it are unusual and perfectly legal, and
   * losing the batch's three lists to them would be a far worse answer than losing the notice.
   */
  it("keeps the step's notice inside the field's bound, whatever the origins are called", async () => {
    const label = (letter: string) => `${letter.repeat(60)}.${letter.repeat(60)}.${letter.repeat(60)}`;
    const from = `https://${label("a")}.test`;
    const to = `https://${label("b")}.test`;
    const { runner, dispatch } = harness({ pendingTransition: async () => ({ from, to }) });

    const response = await runner.run(batchRequest([CLICK, TYPE]));

    const results = (response.result as { results: Array<{ outcome: string; reason?: string; hint?: string }> }).results;
    // The step still says what happened to it, in the words S2 gave it...
    expect(results[0]).toMatchObject({ outcome: "stopped", reason: "site-transition" });
    expect(results[1]).toMatchObject({ outcome: "stopped", reason: "not-run" });
    // ...and the one field with a bound on it stays inside that bound.
    expect(results[0]?.hint?.length ?? 0).toBeLessThanOrEqual(400);
    expect(dispatch, "a step ran on a tab that had moved").not.toHaveBeenCalled();
  });

  it("refuses to run a batch inside a batch even if one reaches it", async () => {
    const { runner, dispatch } = harness();

    const response = await runner.run(batchRequest([{ tool: "browser_batch", args: { steps: [] } }]));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments" });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
