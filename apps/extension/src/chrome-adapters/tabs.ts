/**
 * The `chrome.tabs` calls the agent path makes, plus the page-support classification the 001/002
 * path already used. They share a file because they are the same subject - what a tab is and
 * whether it can be worked on - and because the classification below is what a caller applies to
 * the tab a lookup here returns.
 *
 * These wrappers exist so the agent's tab manager can be read without `chrome.` noise and so a test
 * has one seam to fake. They add no policy: ownership is decided in `agent-tab-manager.ts`.
 */

/**
 * The fields of a Chrome tab the agent path reads. Anything else is deliberately not carried.
 *
 * `active` and `windowId` are here because two tools depend on them and cannot ask for them
 * separately without racing: a screenshot photographs the *active* tab of a window, and a resize
 * acts on the window a tab happens to be in.
 */
export type AgentTabSnapshot = {
  id: number;
  url: string;
  /**
   * Chrome's own title for the tab (004 FR-060). It comes from the tab record and never from the
   * document, which is what lets `tabs_context` name every tab in the browser without reading a
   * page it holds no lease on.
   */
  title: string;
  groupId: number;
  active: boolean;
  windowId: number;
};

function snapshot(tab: chrome.tabs.Tab): AgentTabSnapshot | undefined {
  // A tab with no id is one Chrome is still creating; there is nothing to address yet.
  return tab.id === undefined
    ? undefined
    : {
        id: tab.id,
        /**
         * `about:blank` rather than Chrome's own empty string (004/T166).
         *
         * A tab whose document has committed nothing yet answers `tab.url: ""`, which is the same
         * fact `about:blank` names everywhere else this codebase reports a tab's address - a
         * brand-new tab created with no url is literally `"about:blank"` by Chrome's own account
         * (proven in the packaged `agent-tabs` spec). An empty string leaves an agent unable to
         * tell "no address" from "the field was left out"; the honest word for the first is the
         * address Chrome itself uses for it.
         */
        url: tab.url === undefined || tab.url === "" ? "about:blank" : tab.url,
        // A tab still loading has no title yet; the empty string says so without inventing one.
        title: tab.title ?? "",
        groupId: tab.groupId ?? -1,
        active: tab.active === true,
        windowId: tab.windowId ?? -1,
      };
}

/** One tab, or `undefined` when Chrome no longer has it - which is the "gone" case (FR-044). */
export async function getTabSnapshot(tabId: number): Promise<AgentTabSnapshot | undefined> {
  try {
    return snapshot(await chrome.tabs.get(tabId));
  } catch {
    return undefined;
  }
}

/** Every tab in the current profile, as snapshots; the caller filters by group. */
export async function queryTabSnapshots(): Promise<AgentTabSnapshot[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.map(snapshot).filter((tab): tab is AgentTabSnapshot => tab !== undefined);
}

export async function createTab(url?: string): Promise<AgentTabSnapshot | undefined> {
  return snapshot(await chrome.tabs.create(url === undefined ? {} : { url }));
}

export async function removeTab(tabId: number): Promise<void> {
  await chrome.tabs.remove(tabId);
}

/** Sends a tab to a url. Chrome refuses some destinations outright, and that refusal throws. */
export async function navigateTab(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
}

/**
 * Walks the tab's own session history. Chrome throws when there is nowhere to go, which is the one
 * honest answer: "back" at the start of a history is not a navigation that quietly did nothing.
 */
export async function goBackInTab(tabId: number): Promise<void> {
  await chrome.tabs.goBack(tabId);
}

export async function goForwardInTab(tabId: number): Promise<void> {
  await chrome.tabs.goForward(tabId);
}

/** Brings a tab to the front of its window; `captureVisibleTab` can only see the active one. */
export async function activateTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

/** What one `chrome.tabs.onUpdated` event says about where a tab is now (003/C1). */
export type TabUpdate = { status?: string | undefined; url?: string | undefined };

/**
 * Every tab change, for as long as the caller keeps the subscription (003/C1).
 *
 * `watchTabSettle` below answers "did *this* navigation finish"; this answers the different
 * question of "did the tab move at all". They are separate because the mover is usually not this
 * extension: a link the agent clicked, a redirect, a form submit and the owner typing a url are all
 * navigations no tool of ours started, and something whose permission depends on which site the tab
 * is on cannot learn about them any other way.
 */
export function watchTabUpdates(listener: (tabId: number, update: TabUpdate) => void): () => void {
  const handler = (tabId: number, changeInfo: TabUpdate, tab?: { url?: string | undefined }): void => {
    // The url is only on the event while it is changing; a `complete` carries the tab instead.
    listener(tabId, {
      ...(changeInfo.status === undefined ? {} : { status: changeInfo.status }),
      ...(changeInfo.url === undefined ? (tab?.url === undefined ? {} : { url: tab.url }) : { url: changeInfo.url }),
    });
  };
  chrome.tabs?.onUpdated?.addListener(handler);
  return (): void => {
    chrome.tabs?.onUpdated?.removeListener(handler);
  };
}

/**
 * Waits for one tab to reach `complete` *because of this navigation*, or for the bound to pass.
 *
 * The listener is attached by the *caller* before it starts the navigation, because Chrome may
 * report `complete` before the promise that started it resolves; a listener attached afterwards
 * would wait for a status change that has already happened.
 *
 * Arming early is also what makes the first `complete` ambiguous (003/B4): the page the tab is
 * *leaving* can finish loading in that window, and taking that as the answer reports a navigation
 * as settled before it began, on the old page's url. So when the caller says where the tab was, a
 * `complete` counts only once this navigation has been seen to start - a `loading` after arming -
 * or once the tab is demonstrably somewhere else. A caller that does not know the previous url
 * gets the older, looser rule, because there is nothing to compare against.
 */
export type TabSettleWatcher = {
  /** Resolves `true` when the tab reached `complete` in time, `false` when the bound passed. */
  settled: Promise<boolean>;
  /** Stops listening; safe to call more than once. */
  stop: () => void;
};

export function watchTabSettle(
  tabId: number,
  timeoutMs: number,
  options: { fromUrl?: string } = {},
): TabSettleWatcher {
  let stop = (): void => {};
  const settled = new Promise<boolean>((resolve) => {
    let startedLoading = false;
    const listener = (
      changedTabId: number,
      changeInfo: { status?: string; url?: string },
      tab?: { url?: string | undefined },
    ): void => {
      if (changedTabId !== tabId) return;
      if (changeInfo.status === "loading") {
        startedLoading = true;
        return;
      }
      if (changeInfo.status !== "complete") return;
      if (options.fromUrl !== undefined && !startedLoading) {
        const url = changeInfo.url ?? tab?.url;
        // Same page, and this navigation was never seen to start: this completion is the previous
        // load's, and the tab has not gone anywhere yet.
        if (url === undefined || url === options.fromUrl) return;
      }
      stop();
      resolve(true);
    };
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, timeoutMs);
    stop = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { settled, stop: () => stop() };
}

export type PageSupport = "supported" | "unsupported" | "inaccessible";

export type PageSupportInput = {
  protocol?: string;
  hostname?: string;
  pathname?: string;
  contentType?: string;
  incognito?: boolean;
  isTopFrame?: boolean;
  hasIframeOnlyContent?: boolean;
  hasShadowOnlyContent?: boolean;
  isPdf?: boolean;
  isChromeInternal?: boolean;
  isExtensionOrigin?: boolean;
  isWebStore?: boolean;
  isFileUrl?: boolean;
  isCanvasOnly?: boolean;
};

export function classifyPageSupport(input: PageSupportInput): PageSupport {
  if (input.isTopFrame === false) {
    return "unsupported";
  }
  if (input.incognito) {
    return "unsupported";
  }
  if (
    input.hasIframeOnlyContent ||
    input.hasShadowOnlyContent ||
    input.isPdf ||
    input.isChromeInternal ||
    input.isExtensionOrigin ||
    input.isWebStore ||
    input.isFileUrl ||
    input.isCanvasOnly
  ) {
    return "unsupported";
  }
  const protocol = input.protocol ?? "";
  if (protocol === "chrome:" || protocol === "chrome-extension:" || protocol === "file:" || protocol === "data:" || protocol === "blob:") {
    return "unsupported";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return "unsupported";
  }
  if (input.contentType && input.contentType !== "text/html") {
    return "unsupported";
  }
  return "supported";
}
