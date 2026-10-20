import { useEffect, useRef, type RefObject } from "react";

/**
 * 020 T600: a chip's popup (the agent menu, the mode menu) closes when the owner presses anywhere
 * else, as a menu does. The focus is left to whatever was pressed - the popup does not pull it back
 * to its chip, which is what Escape does. A press on the popup itself, or on the chip that controls
 * it (`aria-controls` = the popup's id), is not "outside": the chip's own click toggles it closed.
 */
export function useOutsidePress(root: RefObject<HTMLElement | null>, id: string, onOutside: () => void): void {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target) === true) return;
      // T606 (C10): the frame the popup is drawn in (its padding, its border) is the popup too.
      if (root.current?.closest("[data-popup-frame]")?.contains(target) === true) return;
      // Compared as an attribute, not built into a selector: React's ids carry selector punctuation.
      for (let at: Element | null = target instanceof Element ? target : target.parentElement; at !== null; at = at.parentElement) {
        if (at.getAttribute("aria-controls") === id) return;
      }
      latest.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [root, id]);
}
