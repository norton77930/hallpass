/**
 * Every finite limit the protocol enforces, in one closed object.
 *
 * A boundary without a bound is memory the receiver spends before it can judge what it received,
 * so each of these is part of the contract rather than a tuning knob a caller may omit. The values
 * are the ones the product owner recorded as D9, and they are protocol constants: both deployables
 * ship the defaults, and nothing reads a bound from the wire.
 *
 * The factory exists so the limits live in one object rather than as literals spread across two
 * schema modules, and so a test can build the same protocol with a tighter one. Making a deployment
 * able to choose different bounds would need a build-time input on the extension (the content script
 * and panel are separately bundled and cannot be reached from a server composition root) plus an
 * agreement check between the two sides; nothing needs that today, and claiming it before it exists
 * would be a promise the shipped artefacts do not keep.
 */
export type ProtocolBounds = {
  /** The largest single channel frame either side may send, in bytes. */
  maxFrameBytes: number;
  /** `server.progress.textDelta`, `server.terminal.summary`, and every request `purpose`. */
  maxNarrativeChars: number;
  /** `browser.enter-text` text, and a disclosed ordinary form value. */
  maxTextEntryChars: number;
  /** Collected `visibleText`, before truncation is reported. */
  maxVisibleTextChars: number;
  /** Collected semantic nodes, before truncation is reported. */
  maxSemanticNodes: number;
  /** Disclosed form-value items in one page-read result. */
  maxFormValueItems: number;
  /** Steps in one proposed plan. */
  maxPlanSteps: number;
  /**
   * Capability requests one frame may carry as an ordered sequence (002/FR-022).
   *
   * It cannot exceed `maxPlanSteps`: a sequence is only ever admitted against an approved plan, so a
   * longer one could only describe work the user never saw.
   */
  maxRequestSequenceLength: number;
  /**
   * How long a wait may run before it ends with its condition unmet (002/FR-027), in milliseconds.
   *
   * A wait performs no effect, but an unbounded one is a task that never reaches a terminal, which is
   * the outcome Constitution XI forbids. The value is a termination bound, not a latency target.
   */
  maxWaitMs: number;
  /**
   * Elements a description may match before the answer becomes "too broad" (002/FR-026).
   *
   * Past this the product stops choosing and says so. Raising it would make the assistant guess among
   * more candidates, not resolve more accurately.
   */
  maxResolutionCandidates: number;
  /** An accessible name projected into a review, and a collected node label. */
  maxLabelChars: number;
  /** An account label projected to the panel. */
  maxAccountLabelChars: number;
};

/**
 * The recorded D9 defaults. `maxLabelChars` matches the review-card label bound the panel contract
 * already pins at 80: a label is the only page-authored string a review shows, so the collector and
 * the review projection must agree on its length rather than truncating at two different points.
 */
export const DEFAULT_BOUNDS: ProtocolBounds = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxNarrativeChars: 4_000,
  maxTextEntryChars: 2_000,
  maxVisibleTextChars: 8_000,
  maxSemanticNodes: 200,
  maxFormValueItems: 100,
  maxPlanSteps: 20,
  maxRequestSequenceLength: 20,
  maxWaitMs: 15_000,
  maxResolutionCandidates: 5,
  maxLabelChars: 80,
  maxAccountLabelChars: 200,
});

/**
 * Builds a closed bounds object. Every value must be a positive integer: a bound that is absent,
 * fractional, or non-positive is a deployment error, and failing here is the only place it can be
 * caught before a schema is built from it.
 */
export function createBounds(overrides: Partial<ProtocolBounds> = {}): ProtocolBounds {
  const merged = { ...DEFAULT_BOUNDS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`invalid-bound:${key}`);
    }
  }
  // A sequence is admitted only against an approved plan, so one longer than any plan could only
  // describe work the user never saw. Checked here because this is the stated place an invalid
  // deployment is caught, not left to the admission that would refuse it later.
  if (merged.maxRequestSequenceLength > merged.maxPlanSteps) {
    throw new Error("invalid-bound:maxRequestSequenceLength");
  }
  return Object.freeze(merged);
}

/** The dimension a collection ran out of, so the panel can say what was cut rather than that something was. */
export const TRUNCATION_DIMENSIONS = ["visible-text", "semantic-nodes"] as const;

export type TruncationDimension = (typeof TRUNCATION_DIMENSIONS)[number];
