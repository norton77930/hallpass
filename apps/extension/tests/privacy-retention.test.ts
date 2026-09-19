import { describe, expect, it } from "vitest";
import { discloseFormValue } from "../../../packages/domain/src/form-value-policy.js";
import { LOG_FORBIDDEN_FIELDS, SESSION_STORAGE_ALLOWLIST } from "../../../packages/contracts/src/common.js";
import { originAssessmentBody } from "../../../packages/domain/src/canonical-origin.js";

/**
 * Moved out of `tests/e2e/` by WP10 (review L16). These cases import modules directly and never
 * drove a browser, so running them under Playwright claimed journey evidence they do not provide
 * (FR-003). The assertions are unchanged; only the runner and the import depth are.
 */

describe("T080 privacy retention", () => {
  it("ordinary form values require the distinct grant and sensitive sentinels stay out", () => {
    // An identified ordinary control: value only ever appears with the distinct form grant.
    const named = { kind: "input", type: "text", name: "nickname", value: "Ada" } as const;
    expect(discloseFormValue(named, false).value).toBeUndefined();
    expect(discloseFormValue(named, true).value).toBe("Ada");
    // An unidentified control fails closed even with the grant.
    const unidentified = discloseFormValue({ kind: "input", type: "text", value: "Ada" }, true);
    expect(unidentified.classification).not.toBe("allowed-ordinary");
    expect(unidentified.value).toBeUndefined();
    const withheld = discloseFormValue({ kind: "input", type: "password", value: "s3cret" }, true);
    expect(JSON.stringify(withheld)).not.toMatch(/s3cret/);
    expect(SESSION_STORAGE_ALLOWLIST).not.toContain("formValue");
    expect(LOG_FORBIDDEN_FIELDS).toEqual(expect.arrayContaining(["body", "taskId", "formValue"]));
    expect(originAssessmentBody("https://127.0.0.1:19445")).toEqual({
      canonicalOrigin: "https://127.0.0.1:19445",
    });
  });
});
