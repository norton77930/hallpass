import { captureTab, type CaptureDeps, type CaptureRegion, type CapturedImage } from "../../chrome-adapters/capture.js";
import { queryTabSnapshots } from "../../chrome-adapters/tabs.js";

/**
 * Photographing one tab by id (003/T036, 004/T139).
 *
 * `captureTab` deliberately decides nothing about *which* window is showing what - it is handed a
 * window, a flag and the tab to put back. Somebody has to look that up, and until now the only
 * caller that did was the `screenshot` tool. The position tool needs the same picture for two
 * reasons of its own (its `screenshot` action, and the crop the owner is shown around a point), so
 * the lookup lives here rather than in each of them: two copies of "which tab was the owner on"
 * is how a tool ends up leaving the owner's window showing the agent's page.
 *
 * The two refusals are the read path's own words, kept here so both callers give the same answer:
 * a tab Chrome no longer has is `tab-gone`, and the restricted pages `captureVisibleTab` refuses
 * are the ones FR-039 calls not readable.
 */

export type PhotographDeps = {
  capture?: typeof captureTab;
  captureDeps?: CaptureDeps;
  listTabs?: typeof queryTabSnapshots;
};

export type PhotographOutcome =
  | { ok: true; image: CapturedImage }
  | { ok: false; reason: "tab-gone" | "capture-refused" };

export async function photographTab(
  input: { tabId: number; region?: CaptureRegion },
  deps: PhotographDeps = {},
): Promise<PhotographOutcome> {
  const listTabs = deps.listTabs ?? queryTabSnapshots;
  const capture = deps.capture ?? captureTab;
  const tabs = await listTabs();
  const tab = tabs.find((candidate) => candidate.id === input.tabId);
  if (!tab) {
    return { ok: false, reason: "tab-gone" };
  }
  // Whoever the window is showing right now, so it is showing them again afterwards.
  const displaced = tabs.find((candidate) => candidate.windowId === tab.windowId && candidate.active);
  try {
    const image = await capture(
      {
        tabId: input.tabId,
        windowId: tab.windowId,
        isActive: tab.active,
        ...(displaced && displaced.id !== input.tabId ? { restoreTabId: displaced.id } : {}),
        ...(input.region === undefined ? {} : { region: input.region }),
      },
      deps.captureDeps ?? {},
    );
    return { ok: true, image };
  } catch {
    return { ok: false, reason: "capture-refused" };
  }
}
