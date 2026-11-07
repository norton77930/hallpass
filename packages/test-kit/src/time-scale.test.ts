import { describe, expect, it } from "vitest";
import { parseTimeScale, scaledMs } from "./time-scale.js";

describe("HALLPASS_TEST_TIME_SCALE (issue #28)", () => {
  it("is 1 when unset or empty, so CI keeps the shipped deadlines", () => {
    expect(parseTimeScale(undefined)).toBe(1);
    expect(parseTimeScale("")).toBe(1);
  });

  it("takes a number of at least 1 as written", () => {
    expect(parseTimeScale("1")).toBe(1);
    expect(parseTimeScale("4")).toBe(4);
    expect(parseTimeScale("2.5")).toBe(2.5);
  });

  it("falls back to 1 for anything that is not a number of at least 1", () => {
    for (const raw of ["0", "-1", "0.5", "abc", "NaN", "Infinity"]) {
      expect(parseTimeScale(raw)).toBe(1);
    }
  });

  it("multiplies a default deadline by the scale", () => {
    expect(scaledMs(15_000, "4")).toBe(60_000);
    expect(scaledMs(15_000, "")).toBe(15_000);
  });
});
