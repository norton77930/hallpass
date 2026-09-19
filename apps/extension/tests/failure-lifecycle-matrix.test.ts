import { describe, expect, it } from "vitest";
import { classifyPageSupport } from "../src/chrome-adapters/tabs.js";
import { mapMarkerAfterRestart } from "@hallpass/domain";
import { expireFormValueGrants, createGrant } from "../../../packages/domain/src/authorization-grant.js";
import { recordTerminal as recordTaskTerminal, createTaskState } from "../../../packages/domain/src/task-state.js";

/**
 * Moved out of `tests/e2e/` by WP10 (review L16). These cases import modules directly and never
 * drove a browser, so running them under Playwright claimed journey evidence they do not provide
 * (FR-003). The assertions are unchanged; only the runner and the import depth are.
 */

describe("T082 failure lifecycle matrix", () => {
  it("maps every operation-marker restart without replay", () => {
    expect(mapMarkerAfterRestart("prepared")).toMatchObject({ outcome: "cancellation", replay: false });
    expect(mapMarkerAfterRestart("dispatched")).toMatchObject({ outcome: "attention-required", replay: false });
    expect(mapMarkerAfterRestart("uncertain")).toMatchObject({ outcome: "attention-required", replay: false });
    expect(mapMarkerAfterRestart("observed")).toMatchObject({ outcome: "failure", replay: false });
  });

  it("expires form grants and keeps a single terminal", () => {
    const grants = expireFormValueGrants([
      createGrant({ grantId: "g", grantKind: "form-values", taskId: "t", documentEpoch: "d" }),
    ]);
    expect(grants[0]?.state).toBe("expired");
    const first = recordTaskTerminal(createTaskState(), "success");
    expect(recordTaskTerminal(first, "failure").terminal).toBe("success");
  });

  for (const name of ["iframe-only", "Shadow-DOM-only", "PDF", "incognito", "canvas-WebGL-only"] as const) {
    it(`${name} is unsupported`, () => {
      const flags: Record<string, boolean> = {
        "iframe-only": true,
        "Shadow-DOM-only": false,
        PDF: false,
        incognito: false,
        "canvas-WebGL-only": false,
      };
      expect(
        classifyPageSupport({
          isTopFrame: true,
          protocol: "https:",
          hasIframeOnlyContent: name === "iframe-only",
          hasShadowOnlyContent: name === "Shadow-DOM-only",
          isPdf: name === "PDF",
          incognito: name === "incognito",
          isCanvasOnly: name === "canvas-WebGL-only",
        }),
      ).toBe("unsupported");
      void flags;
    });
  }
});
