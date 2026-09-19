import type { AttentionRequiredCause, RuntimeAction } from "@hallpass/contracts";
import type { PageExecutionOutcome, PagePostEffectProbe } from "./page-ports.js";

/**
 * Post-effect verification, in one place both callers reach (002 "Action contract", 003 FR-040).
 *
 * It was inline in the control port, which made it the remote path's private rule. It is not: the
 * rule is about the *page*, not about who asked - an effect is a success only when the document it
 * ran against is still the one it was aimed at and the action's own evidence says it happened. The
 * local agent has to answer for exactly the same thing, and a second copy of this reasoning is how
 * two callers end up disagreeing about what "verified" means.
 *
 * Extracted unchanged: same order, same bounds, same verdicts. The control port passes what its
 * closure held; nothing about the remote path's behaviour moves.
 */

/**
 * What post-effect verification can establish. Each unverified cause is one of the contract's closed
 * attention-required causes, because they are named on the wire and they leave different things
 * standing: a replaced document invalidates every binding to it; a lost focus, a hovered target no
 * longer shown, a dragged element that did not move, or a click family gesture whose point did not
 * resolve to its target invalidate nothing but the attribution of that one effect. Listed rather
 * than subtracted from the contract's set: a cause added there is a
 * cause this verification may or may not be able to reach, and only this side knows which.
 * `execute-uncertain` and `grant-revoked` are deliberately absent - the first is the cause of an
 * effect nothing observed at all, decided where the executor throws, and the second is decided after
 * a verification that did run.
 */
export const POST_EFFECT_VERDICTS = [
  "document-changed",
  "focus-lost",
  "target-not-visible",
  "not-moved",
  "target-missed",
  "target-unconfirmed",
] as const satisfies readonly AttentionRequiredCause[];

export type EffectVerdict = "verified" | (typeof POST_EFFECT_VERDICTS)[number];

/**
 * The evidence an executed effect carries: the executor's own success arm, not a restatement of it.
 * A renamed or dropped evidence field is a compile error where the verdict is decided rather than a
 * silently absent property that reads as "not observed".
 */
export type PageEffectEvidence = Extract<PageExecutionOutcome, { ok: true }>;

/**
 * Reached only if `BRIDGE_ACTIONS` gains a member without a verification clause. Throwing inside the
 * dispatch's try files the effect as uncertain, which is the only honest answer for an effect
 * nobody knows how to verify.
 */
function noVerdict(capability: never): never {
  throw new Error("unverifiable capability: " + String(capability));
}

export type VerifyEffectInput = {
  /** What the executor observed. */
  executed: PageEffectEvidence;
  /** Whether the worker's own watch on the tab saw a new top-level document. */
  effect: { documentChanged: boolean };
  capability: RuntimeAction;
  tabId: number;
  documentEpoch: string;
  canonicalOrigin: string;
  taskId: string;
  operationId: string;
  runtimeEpochId: string;
  nonce: string;
  /** How long to let a navigation the effect started actually unload the old document. */
  settleMs: number;
  /** Absent means the caller cannot re-probe; the document's own evidence then decides alone. */
  probe?: PagePostEffectProbe | undefined;
  /**
   * The tab to probe, when it is not the active one. The agent's tab usually is not (003 A8): a
   * probe of the active tab would report a stale context for a document that never moved.
   */
  tab?: number | undefined;
  /**
   * A click family gesture's own check on its own arithmetic (004/T128, T129): whether the point
   * it delivered at resolves, in the target's own frame, to the element it was aimed at or to a
   * descendant of it (`hit`), to something else the check actually observed (`missed`), or to
   * nothing at all because the round trip that asks was refused upstream (`unconfirmed` -
   * `stale-context`'s family). The three are kept apart because only `missed` is something this
   * verification watched happen; reporting `unconfirmed` as a miss would claim an observation
   * nobody made. Absent for every capability that does not deliver by coordinate to a resolved
   * target - scrolling, a key press, entering text - and the document being intact says nothing
   * about it either way, so those verify exactly as before.
   */
  pointConfirmation?: "hit" | "missed" | "unconfirmed" | undefined;
};

/**
 * Post-effect verification (extension-runtime.md "Action contract"). Scrolling cannot replace
 * the document. A click, text entry or key press is verified only when the runtime saw no
 * synchronous URL change, the leased tab reported no new top-level document during the settle
 * window, and a re-probe of the already-bound runtime returns the same document epoch and origin.
 * A key press additionally needs the focused element to have kept its identity (002 R-026); that
 * is checked last, once the document is known to be intact, so the cause it names is exact.
 */
export async function verifyPageEffect(input: VerifyEffectInput): Promise<EffectVerdict> {
  const { executed, effect, capability } = input;
  if (capability === "browser.scroll") {
    return "verified";
  }
  // A reply that does not say whether the document moved has not observed the effect. Treating
  // the absence as "unchanged" would transmit a success nobody verified, which is exactly what
  // the closed result shape exists to prevent.
  if (executed.documentChanged !== false) {
    return "document-changed";
  }
  if (input.settleMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, input.settleMs));
  }
  if (effect.documentChanged) {
    return "document-changed";
  }
  const probe = input.probe;
  if (probe) {
    const observed = await probe({
      taskId: input.taskId,
      operationId: input.operationId,
      runtimeEpochId: input.runtimeEpochId,
      nonce: input.nonce,
      expectedTabId: input.tabId,
      canonicalOrigin: input.canonicalOrigin,
      ...(input.tab === undefined ? {} : { tab: input.tab }),
    });
    if (
      effect.documentChanged ||
      !observed.ok ||
      observed.documentEpoch !== input.documentEpoch ||
      observed.canonicalOrigin !== input.canonicalOrigin
    ) {
      return "document-changed";
    }
  }
  // The document is intact. Each action's own evidence decides the rest (002 R-026): delivered,
  // but what it should have shown did not happen, is uncertain with the cause named - a key
  // whose target lost focus, a hovered target no longer shown, a dragged element that did not
  // move - and nothing bound to this document has gone stale. Exhaustive on purpose: a member
  // added without a clause here is a compile error, not a "verified" it never earned.
  switch (capability) {
    case "browser.enter-text":
      // 004/T146 (S4 review): a named target is clicked to place the caret before the text is
      // delivered (`deliverKeyboard`), the same way a key press is - and the same suspect rect
      // arithmetic that click confirms. `focusRetained` is absent when nothing was clicked first (no
      // target named), which verifies exactly as before; `false` is a real check that ran and found
      // the caret somewhere else.
      return executed.focusRetained === false ? "focus-lost" : "verified";
    // The click family verifies the same way an activation does for the document: the events were
    // delivered and the document they were delivered into is still the one they were aimed at. A
    // page's context menu or selection beyond that is the page's business, and claiming to have
    // observed one would be claiming more than the runtime saw - that principle is unchanged.
    //
    // What *is* this side's business is whether the dispatched point landed where it was aimed:
    // that is our own arithmetic (a rect turned into a coordinate), not page semantics, and it is
    // checkable by asking the target's own frame whether the point resolves to the target element
    // or to a descendant of it (004/T128). `pointConfirmation` is absent for a caller that did not
    // run that check, and `undefined` reads as "verified" for backward compatibility. A caller
    // that did run it and got `missed` names the mismatch the check actually observed; `unconfirmed`
    // is a different fact - the check itself was refused upstream (004/T129) - and is never reported
    // as a miss, because nothing here observed one.
    case "browser.click":
    case "browser.double-click":
    case "browser.right-click":
    case "browser.triple-click":
      if (input.pointConfirmation === "missed") return "target-missed";
      if (input.pointConfirmation === "unconfirmed") return "target-unconfirmed";
      return "verified";
    // Setting a control is verified the same way entering text is: the events were delivered into
    // an intact document. Whether the control *took* the value is the effect's own evidence
    // (`valueMatched`), reported to the caller rather than folded into this verdict - the document
    // is not in doubt, only the outcome of this one control is.
    case "browser.form-input":
      return "verified";
    case "browser.key-press":
      return executed.focusRetained === true ? "verified" : "focus-lost";
    case "browser.hover":
      // 004/T150: `pointConfirmation` is the browser-level path's own check that the delivered
      // point actually resolves to the target (004/T128) - the only evidence a hover has, since its
      // entire purpose is to change what is under the pointer, and `targetVisible` is this worker's
      // own arithmetic on the same rect the confirmation exists to distrust. Absent only for the
      // page-level executor path, which never ran that check and still answers from its own
      // `targetVisible` evidence, unchanged.
      if (input.pointConfirmation === "missed") return "target-missed";
      if (input.pointConfirmation === "unconfirmed") return "target-unconfirmed";
      if (input.pointConfirmation === "hit") return "verified";
      return executed.targetVisible === true ? "verified" : "target-not-visible";
    case "browser.drag":
      return executed.moved === true ? "verified" : "not-moved";
    default:
      return noVerdict(capability);
  }
}
