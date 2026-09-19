import { describe, expect, it } from "vitest";
import {
  acceptCapability,
  acceptRemoteTerminal,
  createTaskState,
  recordApprovedPlan,
  recordCapabilityResult,
  recordPlanStepObserved,
  recordTerminal,
  runRecord,
  stopRun,
} from "./task-state.js";

describe("T042 task state", () => {
  it("commits answer-only only when success arrives with zero capability frames", () => {
    const success = recordTerminal(createTaskState(), "success");
    expect(success.mode).toBe("answer-only");
    const afterRead = acceptCapability(createTaskState(), "page.read");
    expect(afterRead.mode).toBe("page-read-only");
    expect(recordTerminal(afterRead, "success").mode).toBe("page-read-only");
  });

  it("accepts exactly one terminal", () => {
    const first = recordTerminal(createTaskState(), "success");
    const second = recordTerminal(first, "failure");
    expect(second.terminal).toBe("success");
  });
});

describe("WP1 remote terminal acceptance", () => {
  it("accepts a remote success only for an answer-only task that saw no capability frame", () => {
    expect(acceptRemoteTerminal(createTaskState(), "success")).toEqual({
      outcome: "success",
      downgraded: false,
    });
  });

  it("accepts a remote success when every required operation succeeded", () => {
    let state = acceptCapability(createTaskState(), "page.read");
    state = recordCapabilityResult(state, "succeeded");
    state = acceptCapability(state, "browser-effect");
    state = recordCapabilityResult(state, "succeeded");
    expect(acceptRemoteTerminal(state, "success")).toEqual({ outcome: "success", downgraded: false });
  });

  it("downgrades a remote success to failure when a required operation did not succeed", () => {
    let state = acceptCapability(createTaskState(), "page.read");
    state = recordCapabilityResult(state, "denied");
    expect(acceptRemoteTerminal(state, "success")).toEqual({
      outcome: "failure",
      reasonCode: "task.unverified-success",
      downgraded: true,
    });
  });

  it("downgrades a remote success to attention-required when an effect is uncertain", () => {
    let state = acceptCapability(createTaskState(), "browser-effect");
    state = recordCapabilityResult(state, "attention-required");
    expect(acceptRemoteTerminal(state, "success")).toEqual({
      outcome: "attention-required",
      reasonCode: "task.effect-uncertain",
      downgraded: true,
    });
  });

  it("prefers attention-required over failure when both an uncertain and a failed result exist", () => {
    let state = acceptCapability(createTaskState(), "page.read");
    state = recordCapabilityResult(state, "failed");
    state = acceptCapability(state, "browser-effect");
    state = recordCapabilityResult(state, "attention-required");
    expect(acceptRemoteTerminal(state, "success").outcome).toBe("attention-required");
  });

  it("never treats a task as answer-only once any capability result was recorded", () => {
    const state = recordCapabilityResult(createTaskState(), "unsupported");
    expect(acceptRemoteTerminal(state, "success")).toMatchObject({
      outcome: "failure",
      downgraded: true,
    });
  });

  it("passes every non-success remote outcome through unchanged", () => {
    let state = acceptCapability(createTaskState(), "page.read");
    state = recordCapabilityResult(state, "denied");
    expect(acceptRemoteTerminal(state, "denial")).toEqual({ outcome: "denial", downgraded: false });
    expect(acceptRemoteTerminal(state, "cancellation")).toEqual({
      outcome: "cancellation",
      downgraded: false,
    });
  });

  it("marks capability frames seen when a plan is accepted", () => {
    const state = acceptCapability(createTaskState(), "plan");
    expect(state.mode).toBe("approved-plan");
    expect(acceptRemoteTerminal(state, "success")).toMatchObject({ outcome: "failure", downgraded: true });
  });
});

describe("WP1 uncertain effects override every remote outcome", () => {
  it("projects attention-required when the service reports failure after an uncertain effect", () => {
    let state = acceptCapability(createTaskState(), "browser-effect");
    state = recordCapabilityResult(state, "attention-required");
    expect(acceptRemoteTerminal(state, "failure")).toEqual({
      outcome: "attention-required",
      reasonCode: "task.effect-uncertain",
      downgraded: true,
    });
    expect(acceptRemoteTerminal(state, "cancellation").outcome).toBe("attention-required");
    expect(acceptRemoteTerminal(state, "denial").outcome).toBe("attention-required");
  });

  it("keeps a remote attention-required as-is after an uncertain effect", () => {
    let state = acceptCapability(createTaskState(), "browser-effect");
    state = recordCapabilityResult(state, "attention-required");
    expect(acceptRemoteTerminal(state, "attention-required")).toEqual({
      outcome: "attention-required",
      downgraded: false,
    });
  });
});

describe("WP2 approved-plan success requires every step observed", () => {
  const approvedPlanState = () => {
    let state = acceptCapability(createTaskState(), "page.read");
    state = recordCapabilityResult(state, "succeeded");
    state = acceptCapability(state, "plan");
    return recordApprovedPlan(state, ["s1", "s2", "s3"]);
  };

  it("downgrades a remote success when a plan step was never observed", () => {
    let state = approvedPlanState();
    for (const stepId of ["s1", "s2"]) {
      state = recordCapabilityResult(state, "succeeded");
      state = recordPlanStepObserved(state, stepId);
    }
    expect(acceptRemoteTerminal(state, "success")).toEqual({
      outcome: "failure",
      reasonCode: "task.unverified-success",
      downgraded: true,
    });
  });

  it("accepts a remote success once every approved step was observed", () => {
    let state = approvedPlanState();
    for (const stepId of ["s1", "s2", "s3"]) {
      state = recordCapabilityResult(state, "succeeded");
      state = recordPlanStepObserved(state, stepId);
    }
    expect(acceptRemoteTerminal(state, "success")).toEqual({ outcome: "success", downgraded: false });
  });

  it("counts each step once and ignores a step the approved plan does not contain", () => {
    let state = approvedPlanState();
    for (const stepId of ["s1", "s1", "s1", "s9"]) {
      state = recordPlanStepObserved(state, stepId);
    }
    expect(state.observedPlanStepIds).toEqual(["s1"]);
  });

  it("replaces the step list when a revised plan is approved before any dispatch", () => {
    let state = recordApprovedPlan(acceptCapability(createTaskState(), "plan"), ["s1", "s2"]);
    state = recordPlanStepObserved(state, "s1");
    state = recordApprovedPlan(state, ["r1", "r2"]);
    expect(state.planStepIds).toEqual(["r1", "r2"]);
    expect(state.observedPlanStepIds).toEqual([]);
  });
});

/**
 * 002 US2 (T035). The run record is what the terminal reports about an approved plan's execution:
 * how many steps there were, how many were observed, and why it stopped if it did. It carries no
 * execution semantics - the worker decides when a step ran and why a run ended, and this only keeps
 * the answer. The counts already exist (`planStepIds`, `observedPlanStepIds`); what is new is the
 * reason, and the derived view the panel is shown.
 */
describe("002 US2 run record", () => {
  const approved = () => recordApprovedPlan(acceptCapability(createTaskState(), "plan"), ["s1", "s2", "s3"]);

  it("names the stop by the position the user saw, and drops it once the run completed", () => {
    // Step 2 was excluded: the kept steps are reviewed positions 1 and 3.
    let state = recordApprovedPlan(acceptCapability(createTaskState(), "plan"), [
      { stepId: "s1", position: 1 },
      { stepId: "s3", position: 3 },
    ]);
    expect(runRecord(state)).toEqual({ total: 2, observed: 0, stoppedAt: 1 });
    state = recordPlanStepObserved(state, "s1");
    // One kept step ran; the next one is the card's step 3, not "step 2 of 2".
    expect(runRecord(stopRun(state, "step-failed"))).toEqual({
      total: 2,
      observed: 1,
      reason: "step-failed",
      stoppedAt: 3,
    });
    state = recordPlanStepObserved(state, "s3");
    expect(runRecord(state)).toEqual({ total: 2, observed: 2, reason: "completed" });
  });

  it("ignores a stop recorded after every kept step already ran", () => {
    let state = recordApprovedPlan(acceptCapability(createTaskState(), "plan"), ["s1", "s2"]);
    state = recordPlanStepObserved(recordPlanStepObserved(state, "s1"), "s2");
    // The run ended when its last step was observed; a Stop pressed afterwards did not end it.
    expect(runRecord(stopRun(state, "user-stopped"))).toEqual({ total: 2, observed: 2, reason: "completed" });
  });

  it("has no record for a task with no approved plan", () => {
    expect(runRecord(createTaskState())).toBeUndefined();
    expect(runRecord(acceptCapability(createTaskState(), "browser-effect"))).toBeUndefined();
  });

  it("derives completion from the steps observed, so a finished plan needs no explicit stop", () => {
    let state = approved();
    expect(runRecord(state)).toEqual({ total: 3, observed: 0, stoppedAt: 1 });
    state = recordPlanStepObserved(state, "s1");
    state = recordPlanStepObserved(state, "s2");
    expect(runRecord(state)).toEqual({ total: 3, observed: 2, stoppedAt: 3 });
    state = recordPlanStepObserved(state, "s3");
    expect(runRecord(state)).toEqual({ total: 3, observed: 3, reason: "completed" });
  });

  it("keeps the first stop reason and ignores every later one", () => {
    let state = recordPlanStepObserved(approved(), "s1");
    state = stopRun(state, "effect-unverified");
    state = stopRun(state, "user-stopped");
    expect(runRecord(state)).toEqual({ total: 3, observed: 1, reason: "effect-unverified", stoppedAt: 2 });
  });

  it("records nothing after the terminal, and nothing for a task that has no run", () => {
    const ended = recordTerminal(approved(), "failure");
    expect(runRecord(stopRun(ended, "user-stopped"))).toEqual({ total: 3, observed: 0, stoppedAt: 1 });
    // A Stop on a task with no plan is a Stop, not a run that stopped.
    expect(runRecord(stopRun(createTaskState(), "user-stopped"))).toBeUndefined();
  });

  it("starts over when a revised plan replaces the approved one", () => {
    let state = stopRun(recordPlanStepObserved(approved(), "s1"), "step-failed");
    state = recordApprovedPlan(state, ["r1", "r2"]);
    expect(runRecord(state)).toEqual({ total: 2, observed: 0, stoppedAt: 1 });
  });
});
