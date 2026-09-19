export type LocalSafety = "allow" | "deny" | "unknown";
export type RemoteSafety = "allow" | "deny" | "unknown" | "invalid" | "expired" | "unavailable";

export type SafetyDecision = {
  local: LocalSafety;
  remote?: RemoteSafety;
  effective: "allow" | "deny" | "blocked-unknown";
  mayCallRemote: boolean;
};

export function decideLocalSafety(origin: string, policy: { allow: string[]; deny: string[] }): LocalSafety {
  if (policy.deny.includes(origin)) {
    return "deny";
  }
  if (policy.allow.includes(origin)) {
    return "allow";
  }
  return "unknown";
}

export function combineSafety(local: LocalSafety, remote?: RemoteSafety): SafetyDecision {
  if (local === "deny") {
    return { local, effective: "deny", mayCallRemote: false };
  }
  if (local === "allow") {
    return { local, effective: "allow", mayCallRemote: false };
  }
  if (remote === "allow") {
    return { local, remote, effective: "allow", mayCallRemote: false };
  }
  if (remote === undefined) {
    return { local, effective: "blocked-unknown", mayCallRemote: true };
  }
  return { local, remote, effective: "blocked-unknown", mayCallRemote: false };
}
