import { CONVERSATION_AGENTS, type ConversationAgent } from "@hallpass/contracts";

/**
 * 024 R-372: the page's routes are its hash - `#agents`, `#agents/<agent>`, `#sites`,
 * `#sites?site=<canonical origin>`, `#tools`, `#connection`. Anything else reads as `#agents`.
 */
export const SETTINGS_SECTIONS = ["agents", "sites", "tools", "connection"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type SettingsRoute = {
  section: SettingsSection;
  /** `#agents/<agent>`: open and show this agent's card. */
  agent?: ConversationAgent;
  /** `#sites?site=<origin>`: mark this site's row, or say it is no longer listed. */
  site?: string;
};

export function parseRoute(hash: string): SettingsRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = queryAt < 0 ? "" : raw.slice(queryAt + 1);
  const slashAt = path.indexOf("/");
  const head = slashAt < 0 ? path : path.slice(0, slashAt);
  const tail = slashAt < 0 ? "" : path.slice(slashAt + 1);
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(head) ? (head as SettingsSection) : "agents";
  if (section === "agents") {
    return (CONVERSATION_AGENTS as readonly string[]).includes(tail) ? { section, agent: tail as ConversationAgent } : { section };
  }
  if (section === "sites") {
    const site = new URLSearchParams(query).get("site");
    return site === null || site === "" ? { section } : { section, site };
  }
  return { section };
}

export function formatRoute(route: SettingsRoute): string {
  if (route.section === "agents" && route.agent !== undefined) return `#agents/${route.agent}`;
  if (route.section === "sites" && route.site !== undefined) return `#sites?site=${encodeURIComponent(route.site)}`;
  return `#${route.section}`;
}
