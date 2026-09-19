import { describe, expect, it } from "vitest";
import { createGrant, expireAllGrants, expireFormValueGrants } from "./authorization-grant.js";

describe("WP2 grant expiry never overwrites a revocation", () => {
  it("leaves a revoked form-values grant revoked", () => {
    const revoked = {
      ...createGrant({
        grantId: "grant-form-1",
        grantKind: "form-values",
        taskId: "task-1",
        documentEpoch: "doc-1",
      }),
      state: "revoked" as const,
    };
    const active = createGrant({
      grantId: "grant-form-2",
      grantKind: "form-values",
      taskId: "task-1",
      documentEpoch: "doc-1",
    });
    const expired = expireFormValueGrants([revoked, active]);
    expect(expired.map((grant) => grant.state)).toEqual(["revoked", "expired"]);
  });

  it("leaves a revoked grant revoked when every grant expires", () => {
    const revoked = {
      ...createGrant({ grantId: "grant-read-1", grantKind: "general-page-read", taskId: "task-1" }),
      state: "revoked" as const,
    };
    const active = createGrant({
      grantId: "grant-read-2",
      grantKind: "general-page-read",
      taskId: "task-1",
    });
    expect(expireAllGrants([revoked, active]).map((grant) => grant.state)).toEqual([
      "revoked",
      "expired",
    ]);
  });
});
