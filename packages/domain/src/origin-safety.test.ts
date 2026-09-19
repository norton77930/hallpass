import { describe, expect, it } from "vitest";
import { canonicalOriginFromUrl, originAssessmentBody } from "./canonical-origin.js";
import { combineSafety, decideLocalSafety } from "./origin-safety.js";

describe("T043 origin safety", () => {
  it("sends only canonical origin", () => {
    const origin = canonicalOriginFromUrl("https://user:pass@127.0.0.1:19445/secret?q=1#frag");
    expect(origin).toBe("https://127.0.0.1:19445");
    expect(originAssessmentBody(origin ?? "")).toEqual({ canonicalOrigin: "https://127.0.0.1:19445" });
  });

  it("treats local deny as final and remote non-allow as fail-closed", () => {
    const origin = "https://127.0.0.1:19444";
    expect(decideLocalSafety(origin, { allow: [], deny: [origin] })).toBe("deny");
    expect(combineSafety("deny").mayCallRemote).toBe(false);
    expect(combineSafety("unknown", "unavailable").effective).toBe("blocked-unknown");
    expect(combineSafety("unknown", "allow").effective).toBe("allow");
  });

  it.each([
    ["allow", undefined, "allow", false],
    ["deny", undefined, "deny", false],
    ["unknown", undefined, "blocked-unknown", true],
    ["unknown", "allow", "allow", false],
    ["unknown", "deny", "blocked-unknown", false],
    ["unknown", "unknown", "blocked-unknown", false],
    ["unknown", "invalid", "blocked-unknown", false],
    ["unknown", "expired", "blocked-unknown", false],
    ["unknown", "unavailable", "blocked-unknown", false],
  ] as const)(
    "closes local/remote matrix %s + %s as %s (mayCallRemote=%s)",
    (local, remote, effective, mayCallRemote) => {
      expect(combineSafety(local, remote)).toMatchObject({ local, effective, mayCallRemote });
    },
  );
});
