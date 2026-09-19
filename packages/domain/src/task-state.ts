import type { CapabilityResultStatus, RunStopReason, TerminalOutcome } from "@hallpass/contracts";

export type TaskMode = "undecided" | "answer-only" | "page-read-only" | "single-action" | "approved-plan";

export type TaskState = {
  mode: TaskMode;
  inboundSequence: number;
  outboundSequence: number;
  /**
   * Whether any capability request, capability result, or Plan has been seen. A remote success is
   * accepted as `answer-only` only while this is false: once the service asked for anything, success
   * must be earned by verified results rather than asserted by the final frame.
   */
  capabilityFramesSeen: boolean;
  /** Required operations whose local result was observed as `succeeded`. */
  verifiedResults: number;
  /** Required operations whose local result was anything other than `succeeded`. */
  requiredNonSucceeded: number;
  /** A begun effect whose outcome could not be observed; it can never be reported as success. */
  uncertainSeen: boolean;
  /** Step IDs of the Plan the user approved; empty in every other mode. */
  planStepIds: string[];
  /**
   * The position each approved step was reviewed under, parallel to `planStepIds`. Exclusions leave
   * gaps, which is the point: the terminal names a step by the number the user saw on the plan card.
   */
  planStepPositions: number[];
  /** Approved Plan steps whose local result was observed as `succeeded`. */
  observedPlanStepIds: string[];
  /**
   * Why the approved Plan's execution ended, when the worker said so (002/FR-022). The first reason
   * recorded stands; completion needs none, because it is derivable from the step counts.
   */
  runStopReason?: RunStopReason;
  terminal?: TerminalOutcome;
};

/**
 * What the terminal tells the user about an approved Plan's execution: how many steps it had, how
 * many were observed to run, and why it stopped if it did. A view over state the worker already
 * keeps - it decides nothing.
 */
export type RunRecord = {
  /** Kept steps in the approved Plan. */
  total: number;
  /** Kept steps this worker observed as succeeded. */
  observed: number;
  reason?: RunStopReason;
  /**
   * The reviewed position of the first kept step that did not run - the number the user saw for it
   * on the plan card - present whenever the run did not complete. The counts are in kept steps and
   * the plan card is in reviewed positions; this is what lets the terminal speak the card's language.
   */
  stoppedAt?: number;
};

export function createTaskState(): TaskState {
  return {
    mode: "undecided",
    inboundSequence: 0,
    outboundSequence: 0,
    capabilityFramesSeen: false,
    verifiedResults: 0,
    requiredNonSucceeded: 0,
    uncertainSeen: false,
    planStepIds: [],
    planStepPositions: [],
    observedPlanStepIds: [],
  };
}

/**
 * Records the exact step list the user approved. A revision approved before the first dispatch
 * replaces it outright, so an observation of a step the user has since replaced cannot count
 * towards the new Plan.
 */
export function recordApprovedPlan(
  state: TaskState,
  steps: ReadonlyArray<string | { stepId: string; position: number }>,
): TaskState {
  if (state.terminal) {
    return state;
  }
  // A replacement Plan is a new run: whatever stopped the previous one has nothing to say about it.
  const { runStopReason: _stopped, ...rest } = state;
  // A bare identifier list is a Plan with nothing excluded, so kept order is reviewed order.
  const planStepIds = steps.map((step) => (typeof step === "string" ? step : step.stepId));
  const planStepPositions = steps.map((step, index) => (typeof step === "string" ? index + 1 : step.position));
  return { ...rest, planStepIds, planStepPositions, observedPlanStepIds: [] };
}

/**
 * Records why the run ended. Only the first reason is kept - a Stop pressed after a step already
 * failed did not end the run, the failure did - and a task with no approved Plan has no run to stop.
 */
export function stopRun(state: TaskState, reason: RunStopReason): TaskState {
  if (
    state.terminal ||
    state.planStepIds.length === 0 ||
    state.runStopReason !== undefined ||
    // A run that already observed every kept step has ended; a Stop after that did not end it.
    state.observedPlanStepIds.length === state.planStepIds.length
  ) {
    return state;
  }
  return { ...state, runStopReason: reason };
}

export function runRecord(state: TaskState): RunRecord | undefined {
  const total = state.planStepIds.length;
  if (total === 0) {
    return undefined;
  }
  const observed = state.observedPlanStepIds.length;
  const completed = observed === total;
  const reason = state.runStopReason ?? (completed ? "completed" : undefined);
  const firstUnobserved = state.planStepIds.findIndex((stepId) => !state.observedPlanStepIds.includes(stepId));
  const stoppedAt = completed || firstUnobserved < 0 ? undefined : state.planStepPositions[firstUnobserved];
  return {
    total,
    observed,
    ...(reason !== undefined ? { reason } : {}),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
  };
}

/** Marks one approved step observed. Unknown and repeated step IDs never raise the count. */
export function recordPlanStepObserved(state: TaskState, stepId: string): TaskState {
  if (
    state.terminal ||
    !state.planStepIds.includes(stepId) ||
    state.observedPlanStepIds.includes(stepId)
  ) {
    return state;
  }
  return { ...state, observedPlanStepIds: [...state.observedPlanStepIds, stepId] };
}

export function acceptCapability(state: TaskState, capability: "page.read" | "browser-effect" | "plan"): TaskState {
  if (state.terminal) {
    return state;
  }
  const seen = { ...state, capabilityFramesSeen: true };
  if (capability === "page.read") {
    if (seen.mode === "undecided") {
      return { ...seen, mode: "page-read-only" };
    }
    return seen;
  }
  if (capability === "plan") {
    if (seen.mode === "single-action") {
      return seen;
    }
    return { ...seen, mode: "approved-plan" };
  }
  if (seen.mode === "approved-plan") {
    return seen;
  }
  return { ...seen, mode: "single-action" };
}

/**
 * Records the local outcome of one required operation (a page read or a browser effect). Every
 * result the worker transmits for a request counts, so a request that fails closed before consent
 * still prevents a later vacuous success.
 */
export function recordCapabilityResult(state: TaskState, status: CapabilityResultStatus): TaskState {
  if (state.terminal) {
    return state;
  }
  return {
    ...state,
    capabilityFramesSeen: true,
    verifiedResults: status === "succeeded" ? state.verifiedResults + 1 : state.verifiedResults,
    requiredNonSucceeded:
      status === "succeeded" ? state.requiredNonSucceeded : state.requiredNonSucceeded + 1,
    uncertainSeen: state.uncertainSeen || status === "attention-required",
  };
}

export type RemoteTerminalAcceptance = {
  outcome: TerminalOutcome;
  /** Present only when the remote outcome was replaced by a locally verified one. */
  reasonCode?: string;
  downgraded: boolean;
};

/**
 * The remote terminal is untrusted input (CT-008). Once an effect was transmitted as uncertain, every
 * remote outcome becomes `attention-required`: a service cannot relabel an unverified effect as
 * success, failure, denial, or a clean cancellation (SC-005, SC-008). A `success` is otherwise
 * accepted only when the task is genuinely answer-only or every required operation was locally
 * observed as `succeeded`; otherwise it is downgraded to the outcome the local evidence supports
 * (CT-009, SC-004). Other non-success remote outcomes are never upgraded.
 */
export function acceptRemoteTerminal(state: TaskState, outcome: TerminalOutcome): RemoteTerminalAcceptance {
  if (state.uncertainSeen && outcome !== "attention-required") {
    return { outcome: "attention-required", reasonCode: "task.effect-uncertain", downgraded: true };
  }
  if (outcome !== "success") {
    return { outcome, downgraded: false };
  }
  if (state.requiredNonSucceeded > 0) {
    return { outcome: "failure", reasonCode: "task.unverified-success", downgraded: true };
  }
  if (state.observedPlanStepIds.length < state.planStepIds.length) {
    // An approved Plan is a promise about every step. A service that stops asking after two of
    // three steps and then reports success is claiming work this worker never saw run.
    return { outcome: "failure", reasonCode: "task.unverified-success", downgraded: true };
  }
  if (state.capabilityFramesSeen && state.verifiedResults === 0) {
    // A capability request or Plan arrived but no required operation ever produced a verified
    // result, so success would be vacuous; answer-only cannot be selected after any such frame.
    return { outcome: "failure", reasonCode: "task.unverified-success", downgraded: true };
  }
  return { outcome: "success", downgraded: false };
}

export function recordTerminal(state: TaskState, outcome: TerminalOutcome): TaskState {
  if (state.terminal) {
    return state;
  }
  const mode = state.mode === "undecided" ? "answer-only" : state.mode;
  return { ...state, mode, terminal: outcome };
}

export function nextOutbound(state: TaskState): TaskState {
  return { ...state, outboundSequence: state.outboundSequence + 1 };
}
