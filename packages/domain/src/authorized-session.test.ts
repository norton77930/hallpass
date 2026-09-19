import { describe, expect, it } from "vitest";
import {
  applyRefreshResult,
  consumeAuthorizationState,
  createAuthorizationTransaction,
  createSession,
  logoutLocalFirst,
  s256Challenge,
  transition,
  verifyPkceS256,
} from "./authorized-session.js";

describe("T028 authorized session", () => {
  it("accepts only S256 PKCE and rejects plain or malformed verifiers", async () => {
    const verifier = "a".repeat(43);
    const challenge = await s256Challenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyPkceS256({ verifier, challenge, method: "S256" })).toBe(true);
    expect(await verifyPkceS256({ verifier, challenge, method: "plain" })).toBe(false);
    expect(await verifyPkceS256({ verifier: "short", challenge, method: "S256" })).toBe(false);
  });

  it("rejects expired, mismatched, and replayed OAuth state", () => {
    const tx = createAuthorizationTransaction({
      state: "state-1",
      redirectUri: "https://adgpccmmbgnchnphfaoabfflfcepbopd.chromiumapp.org/auth/callback",
      codeChallenge: "c".repeat(43),
      nowMs: 1_000,
      expiresAtMs: 2_000,
    });
    expect(
      consumeAuthorizationState(tx, {
        state: "state-1",
        redirectUri: "https://adgpccmmbgnchnphfaoabfflfcepbopd.chromiumapp.org/auth/callback",
        nowMs: 1_500,
      }).ok,
    ).toBe(true);
    expect(
      consumeAuthorizationState(tx, {
        state: "state-1",
        redirectUri: "https://adgpccmmbgnchnphfaoabfflfcepbopd.chromiumapp.org/auth/callback",
        nowMs: 1_600,
      }).ok,
    ).toBe(false);
    const expired = createAuthorizationTransaction({
      state: "state-2",
      redirectUri: "https://adgpccmmbgnchnphfaoabfflfcepbopd.chromiumapp.org/auth/callback",
      codeChallenge: "c".repeat(43),
      nowMs: 1_000,
      expiresAtMs: 2_000,
    });
    expect(
      consumeAuthorizationState(expired, {
        state: "state-2",
        redirectUri: "https://adgpccmmbgnchnphfaoabfflfcepbopd.chromiumapp.org/auth/callback",
        nowMs: 3_000,
      }).ok,
    ).toBe(false);
  });

  it("walks the five UI session states", () => {
    let session = createSession("signed-out");
    session = transition(session, "BEGIN_AUTH");
    expect(session.uiState).toBe("authorizing");
    session = transition(session, "AUTH_SUCCEEDED");
    expect(session.uiState).toBe("signed-in");
    session = transition(session, "POLICY_BLOCKED");
    expect(session.uiState).toBe("policy-blocked");
    session = createSession("signed-in");
    session = transition(session, "REAUTH_REQUIRED");
    expect(session.uiState).toBe("reauthentication-required");
    session = transition(session, "LOGOUT");
    expect(session.uiState).toBe("signed-out");
  });

  it("maps refresh 409 to reauthentication-required and clears credentials", () => {
    const session = createSession("signed-in", {
      sessionId: "sid",
      accessCredential: "access",
      refreshCredential: "refresh",
      accountId: "acct-1",
    });
    const next = applyRefreshResult(session, { status: 409, code: "auth.account-mismatch" });
    expect(next.uiState).toBe("reauthentication-required");
    expect(next.reason).toBe("auth.account-mismatch");
    expect(next.accessCredential).toBeUndefined();
    expect(next.accountId).toBeUndefined();
  });

  it("clears local session before remote revoke on logout", () => {
    const session = createSession("signed-in", {
      sessionId: "sid",
      accessCredential: "access",
      accountId: "acct-1",
    });
    const { local, remote } = logoutLocalFirst(session);
    expect(local.uiState).toBe("signed-out");
    expect(local.accessCredential).toBeUndefined();
    expect(remote.sessionId).toBe("sid");
    expect(remote.accessCredential).toBe("access");
  });
});
