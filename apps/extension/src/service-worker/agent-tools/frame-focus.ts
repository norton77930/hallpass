import { FOCUS_WALK_MAX_DEPTH, type FrameFocusAnswer } from "./frame-site.js";

/**
 * Where the tab's focus is, read across every frame at once (030 T908).
 *
 * Keys sent with no target go wherever the page's focus is, so the site that decides them is the
 * site of the frame holding it. Each frame says where it hangs (its index path from the top, read
 * the way `enumerateTabFrames` reads it) and which of its own child frames, if any, holds its focus;
 * `resolveFocusSite` follows that chain from the top. The browser attaches its own frame id and
 * document id to each answer, and those are what name the frame found - the site itself is then the
 * browser's sender origin for it, never anything a frame wrote here.
 *
 * Isolated world, as every per-frame script is: `document.activeElement`, `parent` and indexed
 * `frames` are the browser's own objects there, which the page's scripts cannot redefine. Needs no
 * permission the extension does not already hold.
 */

/**
 * Runs in each frame: its index path from the top, and which child frame holds its focus.
 *
 * Self-contained, because `executeScript` serialises it: the cap comes in as `maxDepth`
 * (`FOCUS_WALK_MAX_DEPTH`, through `args`). `focusedChild` is `-1` only when focus ended on a plain
 * element of this document, or on none; an index into `frames` when a frame holder has it; and
 * `null` - unknown - for anything else: a holder (`iframe`, `frame`, `embed`, `object`, anything
 * with a `contentWindow`) whose frame is not one of this window's, a shadow chain deeper than the
 * cap, or a state this did not expect. A frame hung deeper than the cap, or at a place its parent
 * does not number, answers `path: null`. Focus inside a shadow root is followed to the element that
 * holds it, closed roots included where `chrome.dom` can open them: only which frame has focus
 * leaves the frame, nothing in the root.
 */
export function focusOfFrame(maxDepth: number): { path: number[] | null; focusedChild: number | null } {
  const unknown = { path: null, focusedChild: null };
  try {
    const path: number[] = [];
    let current: Window = window;
    while (current !== current.parent) {
      if (path.length >= maxDepth) return unknown;
      const parent: Window = current.parent;
      let index = -1;
      for (let candidate = 0; candidate < parent.length; candidate += 1) {
        if (parent[candidate] === current) {
          index = candidate;
          break;
        }
      }
      if (index < 0) return unknown;
      path.unshift(index);
      current = parent;
    }

    const opens = typeof chrome === "object" && typeof chrome?.dom?.openOrClosedShadowRoot === "function";
    let active: Element | null = document.activeElement;
    for (let depth = 0; active !== null; depth += 1) {
      const root: ShadowRoot | null =
        (opens && active instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(active) : null) ?? active.shadowRoot;
      const inner: Element | null = root?.activeElement ?? null;
      if (inner === null) break;
      // Focus goes on below the cap: where it ends is not known.
      if (depth >= maxDepth) return { path, focusedChild: null };
      active = inner;
    }
    if (active === null) return { path, focusedChild: -1 };
    const holder = ["iframe", "frame", "embed", "object"].includes(active.localName) || "contentWindow" in active;
    if (!holder) return { path, focusedChild: -1 };
    const held = (active as { contentWindow?: Window | null }).contentWindow;
    if (held === null || held === undefined) return { path, focusedChild: null };
    for (let candidate = 0; candidate < window.length; candidate += 1) {
      if (window[candidate] === held) return { path, focusedChild: candidate };
    }
    return { path, focusedChild: null };
  } catch {
    return unknown;
  }
}

/** Every frame's focus answer for tab `tabId`, with the browser's frame and document ids. */
export async function readFrameFocus(tabId: number): Promise<FrameFocusAnswer[]> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: focusOfFrame,
    args: [FOCUS_WALK_MAX_DEPTH],
  })) as Array<{ frameId?: number; documentId?: string; result?: unknown }> | undefined;
  return (results ?? []).map((entry) => ({
    ...(typeof entry.frameId === "number" ? { frameId: entry.frameId } : {}),
    ...(typeof entry.documentId === "string" ? { documentId: entry.documentId } : {}),
    result: entry.result ?? null,
  }));
}
