import { executeInAllFrames } from "./all-frames.js";

/**
 * How the worker reaches a document: injecting the page runtime, and finding out which documents
 * this tab is made of at all (004/T115, R-114).
 */

/**
 * One frame as the merge needs it: the frame, its parent, and the url the browser has for it.
 *
 * `unloaded` (#71) is set only by the read enumeration (`enumerateTabFramesForRead`), on a frame
 * whose real document is not there yet: a reader must not take what it answered as the frame's
 * content, and must say the page was not read whole.
 */
export type EnumeratedFrame = {
  frameId: number;
  parentFrameId: number;
  url: string;
  unloaded?: true;
  unindexed?: true;
};

/**
 * The page runtime, in one named frame.
 *
 * Frame-scoped rather than tab-wide *on purpose*. The isolated world is per frame, so injecting
 * into a child frame cannot touch the top document - but injecting with `allFrames` would re-run
 * this file in the top frame as well, which mints a fresh document epoch there and quietly
 * invalidates the binding an in-flight read is using. So each frame is injected by name, and a
 * frame that already answers is never injected again.
 */
export async function injectContentRuntime(tabId: number, frameId = 0): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["content-runtime.js"],
    world: "ISOLATED",
  });
}

/**
 * The declared agent content script, put into a tab that was open before the extension loaded.
 *
 * Top frame only: the indicator (glow and pill) is drawn there, and every injected frame would
 * announce itself separately for the one answer the top frame needs. The script guards its own
 * listener, so running it where it already is replaces rather than doubles it.
 */
export async function injectAgentContent(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["agent-content.js"],
    world: "ISOLATED",
  });
}

/**
 * Where this frame sits in the page: its index among its parent's frames, all the way to the top.
 *
 * Runs in the frame it describes. `window.parent`, `window.top` and indexed access to `frames` are
 * the handful of things the same-origin policy lets a document ask across an origin boundary, so a
 * cross-origin child can still say where it hangs - which is the whole point, since those are
 * exactly the frames the top document cannot describe.
 */
function framePath(): { url: string; path: number[]; loaded: boolean } {
  const path: number[] = [];
  let current: Window = window;
  let steps = 0;
  while (current !== current.parent && steps < 32) {
    const parent: Window = current.parent;
    let index = -1;
    for (let candidate = 0; candidate < parent.length; candidate += 1) {
      if (parent[candidate] === current) {
        index = candidate;
        break;
      }
    }
    path.unshift(index);
    current = parent;
    steps += 1;
  }
  /*
   * #71: whether this is the frame's real document. Injected without waiting for loads (the read
   * enumeration), a frame that has not loaded - a lazy iframe below the fold, or one injected just
   * after its navigation committed - answers as its *initial* empty `about:blank` document, which
   * even says `readyState` "complete". Fail-honest: "not loaded" whenever the frame is about:blank
   * while its holder names a real source (a `src`/`data` that is not about:blank, or a `srcdoc`
   * that has not replaced it with `about:srcdoc` yet), whenever it is about:blank and its holder
   * cannot be reached to tell (a sandboxed frame), and whenever its document is still loading. A
   * holder with no source, or `src="about:blank"`, is a frame that is blank on purpose.
   */
  let loaded = document.readyState === "complete";
  if (loaded && location.href.startsWith("about:blank")) {
    if (window === window.parent) {
      // The top document still blank while its tab is at a real address: its document is to come.
      loaded = false;
    } else {
      let holder: Element | null = null;
      try {
        holder = window.frameElement;
      } catch {
        holder = null;
      }
      if (!holder || holder.hasAttribute("srcdoc")) {
        loaded = false;
      } else {
        const source = (holder.getAttribute("src") ?? holder.getAttribute("data") ?? "").trim();
        if (source !== "") {
          try {
            loaded = new URL(source, document.baseURI).href.startsWith("about:blank");
          } catch {
            loaded = false;
          }
        }
      }
    }
  }
  return { url: location.href, path, loaded };
}

/**
 * One frame's own offset from the top document's (0, 0), walked entirely in-page (004/T128, B67).
 *
 * Runs in the frame it describes, the same way `framePath` does, and for the same reason: `frames`,
 * `parent` and `frameElement` are the handful of cross-origin-safe properties a document may read
 * about its own place on the page. `frameElement` is the odd one out - it is same-origin-only, and
 * that is exactly what makes this exact rather than a guess. A hop the current frame cannot see
 * (`frameElement` is `null` because the parent is a different origin) stops the walk and reports
 * `complete: false`, so a caller can tell "this frame's whole chain is same-origin, trust the
 * number" from "this walk did not reach the top, use something else".
 */
function frameOffsetToTop(): { x: number; y: number; complete: boolean } {
  let x = 0;
  let y = 0;
  let current: Window = window;
  let steps = 0;
  while (current !== current.top && steps < 32) {
    const owner = current.frameElement as Element | null;
    if (!owner) return { x, y, complete: false };
    const rect = owner.getBoundingClientRect();
    x += rect.x;
    y += rect.y;
    current = current.parent;
    steps += 1;
  }
  return { x, y, complete: current === current.top };
}

/**
 * Every frame's offset from the top document, measured together in one round trip (004/T128, B67).
 *
 * The offset a same-origin frame's own document can compute about itself is exact and needs no
 * pairing with anything the debugger separately enumerates - `frameId` here is the same native id
 * `enumerateTabFrames` reports, addressed by Chrome itself, never matched up by this code. A frame
 * whose chain leaves same-origin partway up answers `undefined`; its offset is measured the other
 * way (`createFrameOffsets`, `DOM.getFrameOwner`/`DOM.getBoxModel`), which is the only one of the
 * two that can see across the boundary at all.
 */
export async function enumerateFrameOffsets(tabId: number): Promise<Map<number, { x: number; y: number }>> {
  const results = (await executeInAllFrames({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: frameOffsetToTop,
  })) as Array<{ frameId?: number; result?: { x?: number; y?: number; complete?: boolean } | null }>;
  const offsets = new Map<number, { x: number; y: number }>();
  for (const entry of results) {
    const result = entry.result;
    if (
      entry.frameId === undefined ||
      !result ||
      result.complete !== true ||
      typeof result.x !== "number" ||
      typeof result.y !== "number"
    ) {
      continue;
    }
    offsets.set(entry.frameId, { x: result.x, y: result.y });
  }
  return offsets;
}

/**
 * Every frame of one tab (004/T115, decided 2026-09-10).
 *
 * The enumerator is the scripting permission the extension already holds: an all-frames execution
 * returns one result per frame carrying that frame's id, so the frame list is a by-product of a
 * capability the manifest already declares. The browser has a navigation-observation permission
 * that would also answer this, and it is deliberately not used - a new permission, plus an
 * exemption from the manifest's scope guard, to learn something we are already told would buy
 * nothing and cost the narrowest manifest the product has.
 *
 * Parentage is not in the result, so each frame reports its own index chain and the chains are
 * matched here: the frame whose path is this one's path minus its last step is its parent. A frame
 * that could not find itself in its parent (`-1`) still lands under that parent, sorted before the
 * parent's indexed frames (its `-1` is the lowest index) and flagged `unindexed`: it has no place
 * in the parent's frame order, so the frame pairing does not trust the order around it (#54).
 */
/**
 * Plants one value in a named frame's **page** world (004/T129, B75).
 *
 * `world: "MAIN"` on purpose: the isolated world our own content script runs in is a separate
 * global from the page's, so a plain assignment there is invisible to a bare `Runtime.evaluate`,
 * which reads the page's own (main-world) context - the one a CDP session addresses by default with
 * no domain enabled. Writing here is the only half of the round trip this worker does in the page's
 * own world, and it writes nothing but the nonce itself.
 */
export async function writeFrameNonce(tabId: number, frameId: number, nonce: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (value: string) => {
      (window as unknown as Record<string, unknown>).__pocAgentOopifNonce = value;
    },
    args: [nonce],
  });
}

/**
 * Removes the round trip's nonce from the page's own world (004/T149), win or lose.
 *
 * Left in place, the property is a stable tell that this extension is driving the tab - on the one
 * path whose entire point is delivering input a page cannot distinguish from a person's. Best-effort:
 * the frame may already be gone by the time this runs, which is not this cleanup's failure to answer
 * for.
 */
export async function clearFrameNonce(tabId: number, frameId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: () => {
      delete (window as unknown as Record<string, unknown>).__pocAgentOopifNonce;
    },
  });
}

export async function enumerateTabFrames(
  tabId: number,
  options: { injectImmediately?: boolean } = {},
): Promise<EnumeratedFrame[]> {
  const immediate = options.injectImmediately === true;
  const results = (await executeInAllFrames({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: framePath,
    ...(immediate ? { injectImmediately: true } : {}),
  })) as Array<{ frameId?: number; result?: { url?: string; path?: number[]; loaded?: boolean } | null }>;
  const described = results.flatMap((entry) => {
    const result = entry.result;
    if (entry.frameId === undefined || !result || typeof result.url !== "string" || !Array.isArray(result.path)) {
      // A frame that answered nothing cannot be placed in the tree, and a frame placed by guess
      // would put a document's content under the wrong element. It is left out; the read still
      // covers every frame that did answer.
      return [];
    }
    // #71: only an immediate injection can catch a frame before its document; the waiting one
    // answers from loaded frames only and keeps its answer exactly as it was.
    const unloaded = immediate && result.loaded !== true;
    return [{ frameId: entry.frameId, url: result.url, path: result.path, unloaded }];
  });
  const byPath = new Map(described.map((frame) => [frame.path.join("."), frame.frameId]));
  // #54: index by index as numbers - as text, a frame at index 10 sorted before the one at 2, and
  // siblings are paired against the debugger's tree in this order (`frames.ts` `pairChildren`).
  const byIndexes = (left: number[], right: number[]): number => {
    for (let step = 0; step < left.length; step += 1) {
      const difference = (left[step] ?? 0) - (right[step] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  return described
    .sort((left, right) => left.path.length - right.path.length || byIndexes(left.path, right.path))
    .map((frame) => {
      const unloaded = frame.unloaded ? { unloaded: true as const } : {};
      // #54: a frame that could not find itself in its parent's `frames` (an iframe inside a shadow
      // root is not there) has no place in that parent's order, so it is flagged and the frame
      // pairing (`frames.ts` `pairChildren`) does not trust the order around it.
      const unindexed = frame.path.length > 0 && frame.path[frame.path.length - 1] === -1;
      if (frame.path.length === 0) return { frameId: frame.frameId, parentFrameId: -1, url: frame.url, ...unloaded };
      const parentFrameId = byPath.get(frame.path.slice(0, -1).join("."));
      // 004/T153 (S4 review): a frame whose parent never answered - sandboxed, CSP-blocked, or
      // simply not yet injectable when this enumeration ran - is not the top document, and `-1`
      // is the value that means exactly that everywhere this list is read (`frames.ts`'s
      // `offsetFor` treats it as "nothing to add"). Naming this frame as its own parent is the
      // honest unknown: never a valid ancestor (no frame is its own parent), so the chain walk
      // that reads it stops and answers `undefined` rather than a click delivered somewhere
      // arbitrary on the page.
      return {
        frameId: frame.frameId,
        parentFrameId: parentFrameId ?? frame.frameId,
        url: frame.url,
        ...unloaded,
        ...(unindexed ? { unindexed: true as const } : {}),
      };
    });
}

/**
 * The frame enumeration the read tools use (#71, owner option A): injected without waiting for the
 * tab's frames to load.
 *
 * Waiting is what an all-frames injection does by default, and a lazy iframe below the fold never
 * loads until the page is scrolled to it, so a read enumerated that way gave no answer at all - in
 * the measurement, nothing within 10 s, three times out of three. Injected immediately, the same
 * page answered within a few milliseconds with every frame, the unloaded lazy ones as their initial
 * about:blank document. Those are flagged `unloaded` so the read leaves them out and says
 * `truncated`. The all-frames bound stays as a safety net.
 *
 * Reads only. A not-yet-loaded cross-site frame answers as an about:blank document of its parent's
 * origin, so the click ref locator, the frame offsets and the frame consent lookups
 * (`readMainWorldMarks`, `readFrameFocus`) keep the waiting `enumerateTabFrames`.
 */
export function enumerateTabFramesForRead(tabId: number): Promise<EnumeratedFrame[]> {
  return enumerateTabFrames(tabId, { injectImmediately: true });
}
