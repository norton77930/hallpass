export type ActionGrant = {
  grantId: string;
  taskId: string;
  requestId?: string;
  consumed: boolean;
  state: "active" | "revoked" | "expired";
};

export function createActionGrant(input: Omit<ActionGrant, "consumed" | "state">): ActionGrant {
  return { ...input, consumed: false, state: "active" };
}

export function consumeActionGrant(grant: ActionGrant): ActionGrant | undefined {
  if (grant.state !== "active" || grant.consumed) {
    return undefined;
  }
  grant.consumed = true;
  grant.state = "expired";
  return grant;
}
