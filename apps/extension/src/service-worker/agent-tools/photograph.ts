import {
  captureTab,
  decideCapturePath,
  type CaptureDeps,
  type CaptureFrame,
  type CaptureRegion,
  type CaptureSend,
  type CapturedImage,
} from "../../chrome-adapters/capture.js";
import { queryTabSnapshots, tabContentSize } from "../../chrome-adapters/tabs.js";
import type { AttachmentOutcome, InputUnavailableReason } from "./input.js";

/**
 * Photographing one tab by id (003/T036, 004/T139, 012/T311).
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
 *
 * 012 adds the *frame*: the CSS size the picture is of, which is the emulated viewport when a
 * session gave the tab one and the tab's own content area otherwise. It is resolved here because
 * the same answer decides two things a caller cannot decide separately - which capture to take
 * (R-166: `captureVisibleTab` photographs the window, not an emulated viewport) and at what density
 * a region is cropped.
 */

export type PhotographDeps = {
  capture?: typeof captureTab;
  captureDeps?: CaptureDeps;
  listTabs?: typeof queryTabSnapshots;
  /**
   * The emulated size a session gave this tab, or nothing (012/FR-158).
   *
   * A record, never a measurement: reading it costs one `chrome.storage.session` get, while asking
   * the page would mean attaching a debugger to a tab nobody emulated - and a read attaches none.
   */
  currentViewport?: (tabId: number) => Promise<CaptureFrame | undefined>;
  /** One protocol command over the attachment the emulation already holds; the protocol path only. */
  send?: CaptureSend;
  /**
   * Makes sure there *is* an attachment to photograph an emulated tab over (012/S2c F2).
   *
   * The record outlives this worker (R-167), so a screenshot after an MV3 eviction knows the tab
   * is emulated while the attachment map is empty, and the protocol capture would be sent over
   * nothing. It is the viewport's own holder that is claimed - the emulation is entitled to the
   * attachment for as long as it lasts - and a tab Chrome refuses to attach says so in the
   * attachment's words rather than as a page that cannot be read.
   */
  ensureAttached?: (tabId: number) => Promise<AttachmentOutcome>;
  /** The tab's own content area in CSS pixels; the frame of a tab nothing emulates. */
  tabSize?: (tabId: number) => Promise<CaptureFrame | undefined>;
};

/** What the picture will be of, and therefore which capture takes it. */
export type CaptureFrameFacts = {
  /**
   * The CSS size, when it is knowable. Absent is a real answer - Chrome sizes no tab in a window it
   * is still creating - and the caller crops at density 1 and says the frame is unknown rather than
   * inventing one.
   */
  frame?: CaptureFrame;
  /** True when a session's `viewport set` is what the frame is: the protocol path (R-166). */
  emulated: boolean;
};

export type PhotographOutcome =
  | { ok: true; image: CapturedImage; frame?: CaptureFrame }
  | { ok: false; reason: "tab-gone" | "capture-refused" }
  | { ok: false; reason: "input-unavailable"; unavailableReason: InputUnavailableReason };

/** The frame, asked for before anything is photographed so a region can be refused against it. */
export async function captureFrameFacts(tabId: number, deps: PhotographDeps = {}): Promise<CaptureFrameFacts> {
  const emulated = deps.currentViewport ? await deps.currentViewport(tabId).catch(() => undefined) : undefined;
  // Only the size: the record also names the session and the tab, and neither is the agent's
  // business in a picture's answer (012 gate run 1 leaked the whole record as `frame`).
  if (emulated) return { frame: { width: emulated.width, height: emulated.height }, emulated: true };
  const size = await (deps.tabSize ?? tabContentSize)(tabId).catch(() => undefined);
  return { emulated: false, ...(size === undefined ? {} : { frame: size }) };
}

export async function photographTab(
  input: {
    tabId: number;
    region?: CaptureRegion;
    /** 0.1 to 1; absent is the whole picture, which is what every caller before 012 asked for. */
    scale?: number;
    /** Already resolved by the caller that had to refuse a region against it; resolved here if not. */
    facts?: CaptureFrameFacts;
  },
  deps: PhotographDeps = {},
): Promise<PhotographOutcome> {
  const listTabs = deps.listTabs ?? queryTabSnapshots;
  const capture = deps.capture ?? captureTab;
  const tabs = await listTabs();
  const tab = tabs.find((candidate) => candidate.id === input.tabId);
  if (!tab) {
    return { ok: false, reason: "tab-gone" };
  }
  const facts = input.facts ?? (await captureFrameFacts(input.tabId, deps));
  const scale = input.scale ?? 1;
  if (facts.emulated && deps.ensureAttached) {
    // Before the tab is brought forward: a picture that cannot be taken must not cost the owner a
    // flicker of their window first (012/S2c F2).
    const attached = await deps.ensureAttached(input.tabId);
    if (!attached.ok) {
      return { ok: false, reason: "input-unavailable", unavailableReason: attached.unavailableReason };
    }
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
        ...(facts.frame === undefined ? {} : { frame: facts.frame }),
        scale,
        path: decideCapturePath(facts.emulated ? facts.frame : undefined, input.region, scale),
      },
      {
        ...(deps.captureDeps ?? {}),
        ...(deps.send ? { send: deps.send } : {}),
      },
    );
    return { ok: true, image, ...(facts.frame === undefined ? {} : { frame: facts.frame }) };
  } catch {
    return { ok: false, reason: "capture-refused" };
  }
}
