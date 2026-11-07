/**
 * A document's ordinary visible text: the body's text without form controls, scripts, styles,
 * templates, hidden or `aria-hidden` parts, without Hallpass's own indicator layer, and without text
 * the owner cannot see on the page (issue #37).
 *
 * The one definition both readers use: the content runtime's collection (`get_page_text`, through
 * `collector.ts`) and the owner's "Attach this tab" (022 R-342), which runs it in the page through
 * `chrome.scripting` without binding the content runtime - a probe from a new conversation would
 * throw away the refs an agent session holds on the same tab.
 *
 * "Not seen" is decided per text node of the live body, in document order, from what the browser
 * lays out: inside an excluded element; its element is not rendered (`display:none`,
 * `visibility:hidden`, `opacity:0`, a closed `details`); the text itself has no area, or lies wholly
 * left of or above the document's origin (where no scrolling reaches); or an ancestor with clipping
 * overflow is 1px or less wide or tall (the screen-reader-only pattern). Text below the fold or to the
 * right stays, because the owner can scroll to it. Text in the page's own colour, or in a very small
 * size, is still returned: nothing here reads colours or font sizes.
 *
 * A body without a real DOM (the fakes that callers and tests hand in) takes the older clone or
 * `innerText` path. A document with a DOM but no layout (jsdom) skips a check whose function is absent
 * and the geometry checks as a whole, because there every box is empty.
 *
 * Self-contained on purpose: `chrome.scripting.executeScript` sends a function's source and nothing
 * it closes over, so everything it needs is a parameter (the marker attribute) or a page global
 * (`document`, when no body is handed in); the helpers are nested for the same reason.
 */
export function visibleTextOf(
  markerAttribute: string,
  body?: {
    innerText?: string;
    textContent?: string | null;
    cloneNode?: (deep?: boolean) => unknown;
    ownerDocument?: unknown;
  } | null,
): string {
  const target = body === undefined ? (typeof document === "undefined" ? null : document.body) : body;
  if (!target) return "";
  const excludedSelector =
    "input, textarea, select, option, script, style, template, [hidden], " +
    '[aria-hidden="true"], [' +
    markerAttribute +
    "]";

  type Box = { left?: number; top?: number; right: number; bottom: number; width: number; height: number };
  type Walkable = {
    createTreeWalker?: (root: unknown, whatToShow: number) => { nextNode(): unknown };
    createRange?: () => { selectNodeContents(node: unknown): void; getBoundingClientRect?: () => Box };
    defaultView?: {
      scrollX?: number;
      scrollY?: number;
      getComputedStyle?: (element: unknown) => {
        display?: string;
        visibility?: string;
        overflowX?: string;
        overflowY?: string;
      };
    } | null;
    documentElement?: { getBoundingClientRect?: () => Box } | null;
  };
  type Node_ = {
    data?: string;
    parentElement?: ParentEl | null;
    closest?: (selector: string) => unknown;
  };
  type ParentEl = Node_ & {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
    getBoundingClientRect?: () => Box;
  };

  const doc = target.ownerDocument as Walkable | null | undefined;
  if (doc && typeof doc.createTreeWalker === "function") {
    const SHOW_TEXT = 4;
    const walker = doc.createTreeWalker(target, SHOW_TEXT);
    const view = doc.defaultView ?? null;
    const range = typeof doc.createRange === "function" ? doc.createRange() : null;
    const rangeHasGeometry = !!range && typeof range.getBoundingClientRect === "function";
    // A document that reports an empty box for its own root has no layout to ask (jsdom): every
    // other box would be empty too, and the geometry checks would drop all of its text. Chromium
    // always gives the root of a laid-out page an area, so a real browser applies every check.
    const rootBox = doc.documentElement?.getBoundingClientRect?.();
    const hasLayout = !!rootBox && (rootBox.width > 0 || rootBox.height > 0);
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const clips = new Map<unknown, boolean>();

    const clipsToNothing = (element: ParentEl): boolean => {
      const style = view?.getComputedStyle?.(element);
      // No box of its own: its empty rect says nothing, and its `overflow` clips nothing.
      if (style?.display === "contents") return false;
      const overflowX = style?.overflowX ?? "";
      const overflowY = style?.overflowY ?? "";
      const clipping = (value: string): boolean => value !== "" && value !== "visible";
      if (!clipping(overflowX) && !clipping(overflowY)) return false;
      const box = element.getBoundingClientRect?.();
      return !!box && (box.width <= 1 || box.height <= 1);
    };
    // Memoised per element, so a page of many text nodes under few elements stays linear.
    const clippedWithin = (start: ParentEl | null | undefined): boolean => {
      const chain: ParentEl[] = [];
      let found = false;
      let current = start;
      while (current && (current as unknown) !== target) {
        const known = clips.get(current);
        if (known !== undefined) {
          found = known;
          break;
        }
        chain.push(current);
        if (clipsToNothing(current)) {
          found = true;
          break;
        }
        current = current.parentElement;
      }
      for (const element of chain) clips.set(element, found);
      return found;
    };

    let text = "";
    for (let node = walker.nextNode() as Node_ | null; node; node = walker.nextNode() as Node_ | null) {
      const data = node.data ?? "";
      const parent = node.parentElement ?? null;
      if (parent) {
        const excluded = parent.closest?.(excludedSelector);
        // Only inside the body: the clone path never removed the body itself or what encloses it.
        if (excluded && excluded !== target && (target as { contains?: (n: unknown) => boolean }).contains?.(excluded) !== false) {
          continue;
        }
        if (typeof parent.checkVisibility === "function") {
          // `display:contents` has no box, so `checkVisibility` calls it not visible though its text
          // is drawn: ask the nearest element with a box. `visibility` is inherited by the text and
          // that element cannot answer for it, so it is read here; opacity needs a box to apply.
          let box: ParentEl | null = parent;
          let boxStyle = view?.getComputedStyle?.(box);
          if (boxStyle?.display === "contents" && (boxStyle.visibility ?? "visible") !== "visible") continue;
          while (box && boxStyle?.display === "contents") {
            box = box.parentElement ?? null;
            boxStyle = box ? view?.getComputedStyle?.(box) : undefined;
          }
          // Both spellings of the options: the old names (`checkOpacity`, `checkVisibilityCSS`) and
          // the newer ones (`opacityProperty`, `visibilityProperty`) that Chromium keeps as aliases.
          const visible = !box || box.checkVisibility?.({
            checkOpacity: true,
            opacityProperty: true,
            checkVisibilityCSS: true,
            visibilityProperty: true,
          });
          if (!visible) continue;
        }
      }
      // Whitespace between elements has an empty box and no meaning of its own beyond keeping words
      // apart; it stays whenever its element is shown.
      if (hasLayout && /\S/u.test(data)) {
        if (range && rangeHasGeometry) {
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect?.();
          if (
            rect &&
            (rect.width <= 0 || rect.height <= 0 || rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0)
          ) {
            continue;
          }
        }
        if (clippedWithin(parent)) continue;
      }
      text += data;
    }
    return text.trim();
  }

  if (typeof target.cloneNode === "function") {
    const clone = target.cloneNode(true) as {
      textContent?: string | null;
      querySelectorAll?: (selector: string) => ArrayLike<{ remove?: () => void }>;
    };
    const excluded = clone.querySelectorAll?.(excludedSelector);
    if (excluded) {
      for (let index = 0; index < excluded.length; index += 1) excluded[index]?.remove?.();
    }
    return (clone.textContent ?? "").trim();
  }
  return (target.innerText || target.textContent || "").trim();
}
