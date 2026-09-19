import type { StatedPlan } from "./gate.js";

/**
 * The session's approved plans, one per site (003/T048, data-model StatedPlan).
 *
 * A plan is what `follow-a-plan` means in this feature: the owner approved one `browser_batch` for
 * one site, and the gate then admits exactly that batch's steps, in order, once each. So the store
 * is deliberately tiny and deliberately in memory - a plan is ephemeral, belongs to one session, and
 * a plan that survived the batch that stated it would be standing consent nobody gave.
 *
 * Keyed by site rather than by plan id because that is the question the gate asks: "is there a plan
 * for the site this effect would land on". A second batch on the same site replaces the first,
 * which is right - the owner's latest answer is their answer.
 */

export type StatedPlanStore = {
  /** The plan governing one site, if the owner approved one. */
  get(site: string): StatedPlan | undefined;
  set(plan: StatedPlan): void;
  /** Records that the gate admitted one step, so the same step is never admitted twice. */
  admit(site: string, step: number): void;
  /** Drops the plan when the batch that stated it is over, or when it is replaced. */
  clear(planId: string): void;
};

export function createStatedPlans(): StatedPlanStore {
  const bySite = new Map<string, StatedPlan>();

  return {
    get(site) {
      return bySite.get(site);
    },
    set(plan) {
      bySite.set(plan.site, plan);
    },
    admit(site, step) {
      const plan = bySite.get(site);
      // Only ever forwards, and only past the step the gate actually admitted: a plan whose count
      // could move backwards would admit an approved step a second time.
      if (plan && step >= plan.admittedCount) {
        bySite.set(plan.site, { ...plan, admittedCount: step + 1 });
      }
    },
    clear(planId) {
      for (const [site, plan] of bySite) {
        if (plan.planId === planId) bySite.delete(site);
      }
    },
  };
}
