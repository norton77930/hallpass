/**
 * HALLPASS_TEST_TIME_SCALE (issues #22, #28): a slow or busy machine multiplies the default
 * deadlines of the test run (vitest's test/hook timeout and the shared harness waits). Unset,
 * empty, non-numeric or below 1 means 1, which is what CI runs at. Only defaults are scaled; a
 * bound that is itself the claim under test is never passed through here.
 *
 * vitest.config.ts parses the same variable inline (it loads before anything is built); keep the
 * two rules identical.
 */
export function parseTimeScale(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? value : 1;
}

/** The scale for this process, read once from the environment. */
export const TIME_SCALE: number = parseTimeScale(process.env["HALLPASS_TEST_TIME_SCALE"]);

/** A default deadline in milliseconds, multiplied by the scale. */
export function scaledMs(ms: number, raw: string | undefined = process.env["HALLPASS_TEST_TIME_SCALE"]): number {
  return ms * parseTimeScale(raw);
}
