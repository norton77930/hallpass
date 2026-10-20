import { useEffect, useRef } from "react";

const OPENED = "agent-menu-opened";

/**
 * T607 (S1): at most one menu is open at a time. A menu that opens tells the document; every other
 * open menu closes itself. The press outside that already closes a menu is a pointer's way; this is
 * the way for a keyboard, where the next menu is opened by a click that no press came before.
 *
 * `id` names the menu (or the control that owns several menus of which one is open at a time);
 * `close` ends it without moving the focus, which has already gone where the owner put it.
 */
export function useExclusiveMenu(id: string, open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onOther = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) latest.current();
    };
    document.addEventListener(OPENED, onOther);
    document.dispatchEvent(new CustomEvent<string>(OPENED, { detail: id }));
    return () => document.removeEventListener(OPENED, onOther);
  }, [id, open]);
}
