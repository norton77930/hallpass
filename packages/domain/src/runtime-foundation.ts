/**
 * What survives of the archived remote path's runtime foundation (009/T245).
 *
 * The epoch, terminal gate, sequence tracker and envelope decision were the task channel's, and they
 * went with it. The marker mapping stayed because it answers a question the worker still faces: a
 * service-worker restart leaves an operation marker mid-flight, and the phase it was in decides the
 * outcome the run is allowed to claim.
 */
export type MarkerPhase = "prepared" | "dispatched" | "observed" | "uncertain";

export function mapMarkerAfterRestart(phase: MarkerPhase): {
  outcome: "cancellation" | "attention-required" | "failure";
  reason?: "lifecycle-interruption";
  replay: false;
} {
  if (phase === "prepared") {
    return { outcome: "cancellation", reason: "lifecycle-interruption", replay: false };
  }
  if (phase === "observed") {
    return { outcome: "failure", reason: "lifecycle-interruption", replay: false };
  }
  return { outcome: "attention-required", replay: false };
}
