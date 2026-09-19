export type GrantKind = "general-page-read" | "form-values" | "action";

export type Grant = {
  grantId: string;
  grantKind: GrantKind;
  taskId: string;
  documentEpoch?: string;
  state: "active" | "revoked" | "expired";
};

export function createGrant(input: Omit<Grant, "state">): Grant {
  if (input.grantKind === "form-values" && !input.documentEpoch) {
    throw new Error("form-values grant requires documentEpoch");
  }
  return { ...input, state: "active" };
}

export function formValuesAuthorized(grants: readonly Grant[], taskId: string, documentEpoch: string): boolean {
  const general = grants.find(
    (grant) => grant.grantKind === "general-page-read" && grant.taskId === taskId && grant.state === "active",
  );
  const form = grants.find(
    (grant) =>
      grant.grantKind === "form-values" &&
      grant.taskId === taskId &&
      grant.documentEpoch === documentEpoch &&
      grant.state === "active",
  );
  return Boolean(general && form);
}

/**
 * Expiry only ends an authorization that is still live. A grant the user revoked stays `revoked`:
 * relabelling it as expired would tell them the lifetime lapsed on its own when in fact they took
 * it away, and the grant projection is the only place they can see which happened.
 */
export function expireFormValueGrants(grants: Grant[]): Grant[] {
  return grants.map((grant) =>
    grant.grantKind === "form-values" && grant.state === "active"
      ? { ...grant, state: "expired" as const }
      : grant,
  );
}

export function expireAllGrants(grants: Grant[]): Grant[] {
  return grants.map((grant) =>
    grant.state === "active" ? { ...grant, state: "expired" as const } : grant,
  );
}
