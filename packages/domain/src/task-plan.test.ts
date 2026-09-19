import { describe, expect, it } from "vitest";
import {
  allStepsExcluded,
  canAcceptPlanProposal,
  createPlan,
  excludeSteps,
  expirePlanOnDocumentChange,
  isStepExcluded,
  isValidInitialPlan,
  markDispatched,
  nextPendingStep,
  planContainsStep,
} from "./task-plan.js";
import { canonicalDigest } from "./canonical-digest.js";

describe("T062 task plan", () => {
  it("rejects a one-step initial plan", () => {
    expect(isValidInitialPlan(1)).toBe(false);
    expect(isValidInitialPlan(2)).toBe(true);
    expect(
      createPlan({
        planId: "plan-1",
        version: 1,
        digest: "d",
        steps: [{
          stepId: "s1",
          position: 1,
          capability: "browser.scroll",
          purposeDigest: "p",
          argumentDigest: "a",
          bindingDigest: "b",
        }],
      }),
    ).toBeUndefined();
  });

  it("sequences exact steps and expires on document change after dispatch", async () => {
    const digest = await canonicalDigest({ planId: "plan-1", steps: [1, 2] });
    const plan = createPlan({
      planId: "plan-1",
      version: 1,
      digest,
      steps: [
        {
          stepId: "s1",
          position: 1,
          capability: "browser.scroll",
          purposeDigest: "p1",
          argumentDigest: "a1",
          bindingDigest: "b1",
        },
        {
          stepId: "s2",
          position: 2,
          capability: "browser.click",
          purposeDigest: "p2",
          argumentDigest: "a2",
          bindingDigest: "b2",
        },
      ],
    });
    expect(plan).toBeDefined();
    if (!plan) {
      return;
    }
    expect(nextPendingStep(plan, [])?.stepId).toBe("s1");
    const dispatched = markDispatched(plan);
    expect(dispatched.immutable).toBe(true);
    const expired = expirePlanOnDocumentChange(dispatched);
    expect(expired.expired).toBe(true);
    expect(nextPendingStep(expired, [])).toBeUndefined();
  });
});

describe("WP2 plan replacement and step sequencing", () => {
  const step = (stepId: string, position: number) => ({
    stepId,
    position,
    capability: "browser.click",
    purposeDigest: "p" + position,
    argumentDigest: "a" + position,
    bindingDigest: "b" + position,
  });
  const plan = () =>
    createPlan({
      planId: "plan-1",
      version: 1,
      digest: "digest-1",
      steps: [step("s1", 1), step("s2", 2)],
    });

  it("accepts a first proposal and refuses one that does not cite the current plan", () => {
    expect(canAcceptPlanProposal(undefined, { planId: "plan-1", version: 1, revisionOf: null })).toBe(
      true,
    );
    const current = plan();
    expect(current).toBeDefined();
    if (!current) return;
    expect(canAcceptPlanProposal(current, { planId: "plan-2", version: 1, revisionOf: null })).toBe(
      false,
    );
    expect(
      canAcceptPlanProposal(current, { planId: "plan-2", version: 2, revisionOf: "plan-1" }),
    ).toBe(true);
    expect(
      canAcceptPlanProposal(current, { planId: "plan-2", version: 1, revisionOf: "plan-1" }),
    ).toBe(false);
  });

  it("refuses every replacement once the plan is immutable", () => {
    const current = plan();
    expect(current).toBeDefined();
    if (!current) return;
    expect(
      canAcceptPlanProposal(markDispatched(current), {
        planId: "plan-2",
        version: 2,
        revisionOf: "plan-1",
      }),
    ).toBe(false);
  });

  it("advances through the steps in order and never returns a completed one", () => {
    const current = plan();
    expect(current).toBeDefined();
    if (!current) return;
    expect(nextPendingStep(current, [])?.stepId).toBe("s1");
    expect(nextPendingStep(current, ["s1"])?.stepId).toBe("s2");
    expect(nextPendingStep(current, ["s1", "s2"])).toBeUndefined();
    // Out-of-order completion never promotes a later step past a pending earlier one.
    expect(nextPendingStep(current, ["s2"])?.stepId).toBe("s1");
  });

  it("keeps the binding digest reviewed with each step", () => {
    const current = plan();
    expect(current?.steps[1]?.bindingDigest).toBe("b2");
  });
});

describe("002 US1 a plan carries the steps the user removed", () => {
  const step = (stepId: string, position: number) => ({
    stepId,
    position,
    capability: "browser.click",
    purposeDigest: "p" + position,
    argumentDigest: "a" + position,
    bindingDigest: "b" + position,
  });
  const threeSteps = () =>
    createPlan({
      planId: "plan-1",
      version: 1,
      digest: "d",
      steps: [step("s1", 1), step("s2", 2), step("s3", 3)],
    });

  /**
   * 002/FR-020 and FR-021. Exclusion is recorded on the plan itself, derived from the user's
   * decision, so every later question - what runs next, whether this request is allowed - reads one
   * answer instead of each caller re-deriving it from a list it was handed separately.
   */
  it("skips an excluded step when choosing what runs next", () => {
    const plan = excludeSteps(threeSteps()!, ["s2"]);
    expect(nextPendingStep(plan, [])?.stepId).toBe("s1");
    expect(nextPendingStep(plan, ["s1"])?.stepId).toBe("s3");
    expect(nextPendingStep(plan, ["s1", "s3"])).toBeUndefined();
  });

  it("reports whether a given step was excluded, so a refusal can say why", () => {
    const plan = excludeSteps(threeSteps()!, ["s2"]);
    expect(isStepExcluded(plan, "s2")).toBe(true);
    expect(isStepExcluded(plan, "s1")).toBe(false);
    // A step identifier the plan does not contain is not "not excluded" - it is not a step at all.
    expect(isStepExcluded(plan, "s9")).toBe(false);
    expect(planContainsStep(plan, "s9")).toBe(false);
    expect(planContainsStep(plan, "s2")).toBe(true);
  });

  it("leaves the reviewed steps in place so the panel can still show what was removed", () => {
    const plan = excludeSteps(threeSteps()!, ["s2"]);
    // Excluding is not deleting: the user reviewed three steps and must keep seeing three.
    expect(plan.steps.map((s) => s.stepId)).toEqual(["s1", "s2", "s3"]);
  });

  it("treats excluding every step as a plan with nothing left to run", () => {
    const plan = excludeSteps(threeSteps()!, ["s1", "s2", "s3"]);
    expect(nextPendingStep(plan, [])).toBeUndefined();
    expect(allStepsExcluded(plan)).toBe(true);
    expect(allStepsExcluded(excludeSteps(threeSteps()!, ["s1"]))).toBe(false);
  });
});
