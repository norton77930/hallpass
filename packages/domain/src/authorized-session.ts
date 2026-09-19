const UNRESERVED = /^[A-Za-z0-9._~-]{43,128}$/;

export type SessionUiState =
  | "signed-out"
  | "authorizing"
  | "signed-in"
  | "reauthentication-required"
  | "policy-blocked";

export type Session = {
  uiState: SessionUiState;
  sessionId?: string;
  accessCredential?: string;
  refreshCredential?: string;
  accountId?: string;
  organizationId?: string;
  reason?: string;
};

export type AuthorizationTransaction = {
  state: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAtMs: number;
  consumed: boolean;
};

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export async function verifyPkceS256(input: {
  verifier: string;
  challenge: string;
  method: string;
}): Promise<boolean> {
  if (input.method !== "S256" || !UNRESERVED.test(input.verifier)) {
    return false;
  }
  return (await s256Challenge(input.verifier)) === input.challenge;
}

export function createAuthorizationTransaction(input: {
  state: string;
  redirectUri: string;
  codeChallenge: string;
  nowMs: number;
  expiresAtMs: number;
}): AuthorizationTransaction {
  void input.nowMs;
  return {
    state: input.state,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    expiresAtMs: input.expiresAtMs,
    consumed: false,
  };
}

export function consumeAuthorizationState(
  tx: AuthorizationTransaction,
  input: { state: string; redirectUri: string; nowMs: number },
): { ok: boolean } {
  if (tx.consumed || input.state !== tx.state || input.redirectUri !== tx.redirectUri) {
    return { ok: false };
  }
  if (input.nowMs > tx.expiresAtMs) {
    return { ok: false };
  }
  tx.consumed = true;
  return { ok: true };
}

export function createSession(
  uiState: SessionUiState,
  extras: Omit<Session, "uiState"> = {},
): Session {
  return { uiState, ...extras };
}

export function transition(
  session: Session,
  event: "BEGIN_AUTH" | "AUTH_SUCCEEDED" | "POLICY_BLOCKED" | "REAUTH_REQUIRED" | "LOGOUT",
): Session {
  if (event === "BEGIN_AUTH") {
    return { ...session, uiState: "authorizing" };
  }
  if (event === "AUTH_SUCCEEDED") {
    return { ...session, uiState: "signed-in" };
  }
  if (event === "POLICY_BLOCKED") {
    return { ...session, uiState: "policy-blocked" };
  }
  if (event === "REAUTH_REQUIRED") {
    return { ...session, uiState: "reauthentication-required" };
  }
  return {
    uiState: "signed-out",
  };
}

export function applyRefreshResult(
  session: Session,
  result: { status: number; code?: string },
): Session {
  if (result.status === 409) {
    return {
      uiState: "reauthentication-required",
      reason: "auth.account-mismatch",
    };
  }
  return session;
}

export function logoutLocalFirst(session: Session): {
  local: Session;
  remote: { sessionId?: string; accessCredential?: string };
} {
  return {
    local: { uiState: "signed-out" },
    remote: {
      ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
      ...(session.accessCredential !== undefined ? { accessCredential: session.accessCredential } : {}),
    },
  };
}
