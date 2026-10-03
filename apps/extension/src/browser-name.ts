import { AGENT_BROWSER_NAME_MAX_CHARS } from "@hallpass/contracts";

/**
 * The owner's browser name as it may be kept and sent (018 FR-268, T501).
 *
 * Control characters are stripped and the ends trimmed; what is left must be 1-40 characters, or
 * there is no name (`undefined`). The panel uses it to say "not a name" before sending, and the
 * worker applies it again before storing - the worker is the authority, because the panel's
 * command schema only bounds the length and a name past the worker must fit
 * `agentBrowserNameSchema`, which refuses control characters outright.
 *
 * In `src/` rather than under either side because both sides use it and neither owns it.
 */
export function normalizeBrowserName(raw: string): string | undefined {
  const name = raw.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (name.length === 0 || name.length > AGENT_BROWSER_NAME_MAX_CHARS) return undefined;
  return name;
}
