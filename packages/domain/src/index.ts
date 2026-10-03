export const DOMAIN_PACKAGE = "@hallpass/domain" as const;
export { mapMarkerAfterRestart } from "./runtime-foundation.js";
export type { MarkerPhase } from "./runtime-foundation.js";
export { MemoryTransientStore } from "./transient-store.js";
export type { TransientRecord } from "./transient-store.js";
export {
  s256Challenge,
  verifyPkceS256,
  createAuthorizationTransaction,
  consumeAuthorizationState,
  createSession,
  transition,
  applyRefreshResult,
  logoutLocalFirst,
} from "./authorized-session.js";
export type { Session, SessionUiState, AuthorizationTransaction } from "./authorized-session.js";
export { classifyFormControl, discloseFormValue } from "./form-value-policy.js";
export type { FormClassification, FormControlSnapshot } from "./form-value-policy.js";
export { canonicalOriginFromUrl, originAssessmentBody } from "./canonical-origin.js";
export { decideLocalSafety, combineSafety } from "./origin-safety.js";
export type { LocalSafety, RemoteSafety, SafetyDecision } from "./origin-safety.js";
export {
  createGrant,
  formValuesAuthorized,
  expireFormValueGrants,
  expireAllGrants,
} from "./authorization-grant.js";
export type { Grant, GrantKind } from "./authorization-grant.js";
export {
  createTaskState,
  acceptCapability,
  recordCapabilityResult,
  acceptRemoteTerminal,
  recordApprovedPlan,
  recordPlanStepObserved,
  recordTerminal as recordTaskTerminal,
  nextOutbound,
  runRecord,
  stopRun,
} from "./task-state.js";
export type { TaskMode, TaskState, RemoteTerminalAcceptance, RunRecord } from "./task-state.js";
export { classifyActionRisk, classifyClick, classifyDrag, classifyKeyPress, classifyTextEntry } from "./action-policy.js";
export type { ActionDecision, ActionTarget, KeyPressDecision, TargetKind } from "./action-policy.js";
export {
  isValidInitialPlan,
  canAcceptPlanProposal,
  createPlan,
  markDispatched,
  expirePlanOnDocumentChange,
  nextPendingStep,
  excludeSteps,
  isStepExcluded,
  allStepsExcluded,
  planContainsStep,
} from "./task-plan.js";
export type { PlanStep, TaskPlan } from "./task-plan.js";
export { matchDescription, describedWords } from "./description-matching.js";
export type { DescriptionCandidate } from "./description-matching.js";
export { canonicalDigest } from "./canonical-digest.js";
export { createActionGrant, consumeActionGrant } from "./action-grant.js";
export { defaultBrowserNames } from "./browser-names.js";
export type { BrowserNameInput } from "./browser-names.js";
export type { ActionGrant } from "./action-grant.js";
