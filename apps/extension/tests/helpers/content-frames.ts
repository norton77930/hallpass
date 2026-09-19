import { DEFAULT_BOUNDS } from "@hallpass/contracts";

/**
 * A fixed binding nonce for tests that only need a frame the schema accepts. Tests that are about
 * the nonce itself mint their own values instead of using this one.
 */
export const TEST_NONCE = "0".repeat(32);

/** The collection limits the worker would inject, restated here so a test frame is a real frame. */
export const TEST_COLLECTION_BOUNDS = {
  maxVisibleTextChars: DEFAULT_BOUNDS.maxVisibleTextChars,
  maxSemanticNodes: DEFAULT_BOUNDS.maxSemanticNodes,
  maxLabelChars: DEFAULT_BOUNDS.maxLabelChars,
};
