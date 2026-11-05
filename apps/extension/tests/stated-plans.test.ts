import { describe, expect, it } from "vitest";
import { createStatedPlans } from "../src/service-worker/agent-tools/plans.js";

/**
 * Security review 2026-11-05 S6 - the stated-plan store, which until now was cleared only by the
 * batch that stated a plan (`finally`). A session that ends mid-batch - the owner's Stop, a dropped
 * link - must take its plans with it, so nothing a later session does on that site is admitted by
 * consent given to the one that is gone.
 */
describe("S6 stated plans belong to a session", () => {
  const SITE = "https://fixtures.test:19443";
  const plan = (sessionId: string, planId: string) => ({ planId, sessionId, site: SITE, steps: [], admittedCount: 0 });

  it("records which session stated the plan", () => {
    const plans = createStatedPlans();
    plans.set(plan("session-1", "plan-1"));
    expect(plans.get(SITE)?.sessionId).toBe("session-1");
  });

  it("clears every plan of a session that ended, and no other session's", () => {
    const plans = createStatedPlans();
    plans.set(plan("session-1", "plan-1"));
    plans.set({ ...plan("session-2", "plan-2"), site: "https://other.test" });
    plans.clearSession("session-1");
    expect(plans.get(SITE)).toBeUndefined();
    expect(plans.get("https://other.test")?.planId).toBe("plan-2");
  });
});
