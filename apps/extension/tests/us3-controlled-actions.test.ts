import { describe, expect, it } from "vitest";
import { executeAction } from "../src/content-runtime/actions.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { createPlan } from "../../../packages/domain/src/task-plan.js";

/**
 * Moved out of `tests/e2e/` by WP10 (review L16). These cases import modules directly and never
 * drove a browser, so running them under Playwright claimed journey evidence they do not provide
 * (FR-003). The assertions are unchanged; only the runner and the import depth are.
 */

describe("T067 US3 controlled actions", () => {
  it("single-action scroll and a two-step plan are representable", () => {
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-1", snapshotId: "s", documentEpoch: "d" });
    expect(executeAction(registry, { capability: "browser.scroll", documentEpoch: "d" }).ok).toBe(false);
    const plan = createPlan({
      planId: "p1",
      version: 1,
      digest: "digest",
      steps: [
        { stepId: "s1", position: 1, capability: "browser.scroll", purposeDigest: "p", argumentDigest: "a", bindingDigest: "b1" },
        { stepId: "s2", position: 2, capability: "browser.click", purposeDigest: "p", argumentDigest: "a", bindingDigest: "b2" },
      ],
    });
    expect(plan?.steps).toHaveLength(2);
  });
});
