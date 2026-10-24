import { displayOrigin } from "../../side-panel/agent/display-origin.js";

/**
 * 024 FR-385: a site as the owner reads it - the panel's own `displayOrigin` (an internationalised host
 * is shown in both forms, so a look-alike is not mistaken for the real one), and an https site without
 * its scheme because that is the ordinary case. The canonical origin stays the command's payload.
 */
export function siteLabel(origin: string): string {
  const shown = displayOrigin(origin);
  return shown.startsWith("https://") ? shown.slice("https://".length) : shown;
}
