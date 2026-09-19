export function isValidInitialPlan(stepCount: number): boolean {
  return stepCount >= 2;
}

export type PlanStep = {
  stepId: string;
  position: number;
  capability: string;
  purposeDigest: string;
  argumentDigest: string;
  /**
   * Digest of everything the user reviewed for this step: capability, purpose, expected context,
   * data categories, and canonical arguments. A later request may run this step only when it
   * reproduces this digest exactly, so a matching `stepId` alone authorizes nothing.
   */
  bindingDigest: string;
};

export type TaskPlan = {
  planId: string;
  version: number;
  digest: string;
  steps: PlanStep[];
  immutable: boolean;
  expired: boolean;
  /**
   * The steps the user removed while approving (002/FR-020).
   *
   * They stay in `steps`. Excluding is not deleting: the record of what the user took out is what
   * the terminal carries back to them, and without it a run that ended early is indistinguishable
   * from the product breaking. What changes is that these steps are never chosen to run and never
   * authorise a request.
   */
  excludedStepIds: readonly string[];
};

export function createPlan(
  // A plan is created from what the service proposed. Exclusions are the user's answer to it, so
  // they are recorded by `excludeSteps` when the decision arrives, never supplied at creation.
  input: Omit<TaskPlan, "immutable" | "expired" | "excludedStepIds">,
): TaskPlan | undefined {
  if (!isValidInitialPlan(input.steps.length)) {
    return undefined;
  }
  return { ...input, immutable: false, expired: false, excludedStepIds: [] };
}

/**
 * Whether a proposed Plan may replace the one under review. Before the first dispatch a strictly
 * newer full version may cite the current plan; after it the Plan is immutable and every proposal
 * is refused, so a service cannot rewrite the steps a user already approved or extend the task with
 * new ones (`extension-runtime.md`, "An initial Plan must contain at least two effects").
 */
export function canAcceptPlanProposal(
  current: TaskPlan | undefined,
  proposal: { planId: string; version: number; revisionOf: string | null },
): boolean {
  if (!current) {
    return true;
  }
  if (current.immutable) {
    return false;
  }
  return proposal.revisionOf === current.planId && proposal.version > current.version;
}

export function markDispatched(plan: TaskPlan): TaskPlan {
  return { ...plan, immutable: true };
}

export function expirePlanOnDocumentChange(plan: TaskPlan): TaskPlan {
  return { ...plan, expired: true, immutable: true };
}

export function nextPendingStep(plan: TaskPlan, completedStepIds: readonly string[]): PlanStep | undefined {
  if (plan.expired) {
    return undefined;
  }
  return plan.steps.find(
    (step) => !completedStepIds.includes(step.stepId) && !plan.excludedStepIds.includes(step.stepId),
  );
}

/**
 * Records the user's exclusions on the plan they approved.
 *
 * Every identifier must name a step of this plan; one that does not is dropped rather than stored,
 * because an exclusion nobody can point at is not a decision the panel could have offered. The
 * caller is what refuses such a decision - this function's job is to leave the plan coherent.
 */
export function excludeSteps(plan: TaskPlan, stepIds: readonly string[]): TaskPlan {
  const known = stepIds.filter((stepId) => planContainsStep(plan, stepId));
  return { ...plan, excludedStepIds: [...new Set([...plan.excludedStepIds, ...known])] };
}

export function planContainsStep(plan: TaskPlan, stepId: string): boolean {
  return plan.steps.some((step) => step.stepId === stepId);
}

/** Whether this step was removed by the user, so a refusal can name the reason rather than guess. */
export function isStepExcluded(plan: TaskPlan, stepId: string): boolean {
  return plan.excludedStepIds.includes(stepId);
}

/**
 * Whether the user removed everything. This is a denial expressed as an approval, and the caller
 * has to send it as one: an approval covering no work would tell the service the user agreed to a
 * plan they in fact rejected step by step.
 */
export function allStepsExcluded(plan: TaskPlan): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => isStepExcluded(plan, step.stepId));
}
