import type { AgentPanelCommand } from "@hallpass/contracts";

/**
 * 024 T753 (R-372, FR-375, FR-384, FR-393, FR-394): open the extension's settings page at a route.
 *
 * A settings tab already open is brought forward and moved to the route by its hash, so the page
 * follows without a reload (its router reads `hashchange`); otherwise a new tab opens at
 * `settings.html#<route>`. The tab is found among all tabs by its address with the hash dropped,
 * compared exactly with this extension's own `settings.html` - a match pattern on a
 * `chrome-extension://` address is not something `tabs.query` can be relied on for, and an exact
 * compare can never pick another extension's page or one of ours with a query string.
 */

/** One of the routes R-372 lists; the panel command's schema is the closed check. */
export type SettingsRoute = Extract<AgentPanelCommand, { type: "ui.agent.open-settings" }>["payload"]["route"];

type Tab = { id?: number | undefined; url?: string | undefined; pendingUrl?: string | undefined; windowId?: number | undefined };

/** The parts of `chrome.tabs`, `chrome.windows` and `chrome.runtime` this uses, so a test can stand in. */
export type OpenSettingsDeps = {
  tabs: {
    query(query: Record<string, never>): Promise<Tab[]>;
    update(tabId: number, properties: { active: boolean; url?: string }): Promise<Tab | undefined>;
    create(properties: { url: string }): Promise<Tab | undefined>;
  };
  windows?: { update(windowId: number, properties: { focused: boolean }): Promise<unknown> } | undefined;
  getURL(path: string): string;
};

function chromeDeps(): OpenSettingsDeps {
  return {
    tabs: chrome.tabs as unknown as OpenSettingsDeps["tabs"],
    windows: chrome.windows as unknown as OpenSettingsDeps["windows"],
    getURL: (path) => chrome.runtime.getURL(path),
  };
}

const withoutHash = (url: string): string => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

export async function openSettings(route: SettingsRoute, deps: OpenSettingsDeps = chromeDeps()): Promise<void> {
  const page = deps.getURL("settings.html");
  const target = `${page}${route}`;
  const open = (await deps.tabs.query({})).find(
    (tab) => tab.id !== undefined && [tab.url, tab.pendingUrl].some((url) => url !== undefined && withoutHash(url) === page),
  );
  if (open?.id === undefined) {
    await deps.tabs.create({ url: target });
    return;
  }
  // A tab already at (or on its way to) the route is only brought forward: setting the same address
  // again would reload the page.
  const atRoute = (open.pendingUrl ?? open.url) === target;
  const updated = await deps.tabs.update(open.id, atRoute ? { active: true } : { active: true, url: target });
  const windowId = updated?.windowId ?? open.windowId;
  // The tab is only in front of the owner if its window is.
  if (windowId !== undefined) await deps.windows?.update(windowId, { focused: true });
}
