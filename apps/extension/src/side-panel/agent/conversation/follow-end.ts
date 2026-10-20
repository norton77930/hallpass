import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * T602: the message log follows the newest content. While the owner is at the end of the log (or
 * within `slack` px of it) new text keeps it at the end; once they scrolled up to read, nothing pulls
 * them down until they come back. A log that appears - a conversation opened - shows its end.
 */

export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Whether the scroller shows its end, give or take `slack` px. */
export function nearEnd(box: ScrollBox, slack = 40): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

/**
 * Keeps `scroller` at its end after every render while the owner is there, and when the scroller
 * itself changes size (the message box grew, the panel got shorter). Returns the scroll handler that
 * records where the owner is, whether they are away from the end (T606 P4: "Jump to latest" is
 * offered), and the jump itself, which takes them to the end and follows again.
 */
export function useFollowEnd(scroller: RefObject<HTMLElement | null>): { onScroll: () => void; away: boolean; jump: () => void } {
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const toEnd = (): void => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  };
  useLayoutEffect(toEnd);
  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    following.current = nearEnd(element);
    setAway(!following.current);
  };
  const jump = (): void => {
    following.current = true;
    setAway(false);
    toEnd();
  };
  return { onScroll, away, jump };
}
