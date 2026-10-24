import { useId, useRef, useState, type ReactElement } from "react";
import { lookup } from "../../locales/catalog.js";
import { MoreIcon } from "./conversation/icons.js";
import { useExclusiveMenu } from "./conversation/exclusive-menu.js";
import { useOutsidePress } from "./conversation/outside-press.js";

/**
 * The status row (006 FR-083, D-006-4): a state dot, "connected", how many sessions are live, and an
 * overflow menu.
 *
 * 024 R-381, FR-392, T782: the row is the connection line and nothing else. The paired agents and their
 * Unpair, and the upload folders' list file, moved to the settings page; the one entry the menu holds
 * now is "Settings", which opens that page at the agents (R-372). The row counts sessions and names no
 * agent (016 FR-223). Whether the menu is open is the one piece of UI state this panel keeps (R-125
 * allows focus and the like); it decides nothing.
 */
export function StatusRow(props: {
  sessionCount: number;
  locale: string;
  /** Opens the settings page; the panel sends one `ui.agent.open-settings`. */
  onOpenSettings: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // T606: a press anywhere else closes the menu, as Escape does (which also gives the focus back).
  useOutsidePress(menu, menuId, () => setOpen(false));
  // T607 (S1): opening another menu closes this one.
  useExclusiveMenu(menuId, open, () => setOpen(false));
  const t = (key: string): string => lookup(key, props.locale);
  const count =
    props.sessionCount === 0
      ? t("agent.status.sessionsNone")
      : props.sessionCount === 1
        ? t("agent.status.sessionsOne")
        : t("agent.status.sessions").replace("{n}", String(props.sessionCount));

  return (
    <div className="agent-status" data-status-row="">
      <span className="agent-dot" aria-hidden="true" />
      <span className="agent-status-text">
        <span className="agent-status-word">{t("agent.status.connected")}</span>
        <span aria-hidden="true"> · </span>
        <span className="agent-status-count">{count}</span>
      </span>
      {/* T605: an icon button; its name stays the words, for assistive technology and a hover. */}
      <button
        ref={button}
        type="button"
        className="agent-icon-button agent-menu-button"
        title={t("agent.status.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <MoreIcon />
        <span className="agent-sr-only">{t("agent.status.menu")}</span>
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          className="agent-menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
            button.current?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onOpenSettings();
            }}
          >
            {t("agent.status.settings")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
