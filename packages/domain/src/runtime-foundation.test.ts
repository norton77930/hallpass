import { describe, expect, it } from "vitest";

describe("T014 runtime foundation", () => {
  it("maps interruption without replay", async () => {
    const foundation = await import("./runtime-foundation.js");
    expect(foundation.mapMarkerAfterRestart("prepared")).toEqual({
      outcome: "cancellation",
      reason: "lifecycle-interruption",
      replay: false,
    });
    expect(foundation.mapMarkerAfterRestart("dispatched")).toEqual({
      outcome: "attention-required",
      replay: false,
    });
    expect(foundation.mapMarkerAfterRestart("uncertain")).toEqual({
      outcome: "attention-required",
      replay: false,
    });
    expect(foundation.mapMarkerAfterRestart("observed")).toEqual({
      outcome: "failure",
      reason: "lifecycle-interruption",
      replay: false,
    });
  });
});
