import { useState, type ReactElement } from "react";
import { lookup } from "../../locales/catalog.js";

/**
 * The status row (006 FR-083, D-006-4): a state dot, "connected", the paired agent's name, and an
 * overflow menu holding the one thing the owner can do about the pairing itself - unpair.
 *
 * Unpair is behind a menu rather than on the row because it is the one control here that undoes
 * something, and the row is otherwise something the owner only reads. Whether the menu is open is
 * the one piece of UI state this panel keeps (R-125 allows focus and the like); it decides nothing.
 */
export function StatusRow(props: { agentName: string; locale: string; onUnpair: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const t = (key: string): string => lookup(key, props.locale);

  return (
    <div className="agent-status" data-status-row="">
      <span className="agent-dot" aria-hidden="true" />
      <span className="agent-status-text">
        <span className="agent-status-word">{t("agent.status.connected")}</span>
        <span aria-hidden="true"> · </span>
        {/* The agent's own stated name, as inert text - it is remote input. */}
        <span className="agent-status-name">{props.agentName}</span>
      </span>
      <button
        type="button"
        className="agent-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {t("agent.status.menu")}
      </button>
      {open ? (
        <div role="menu" className="agent-menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onUnpair();
            }}
          >
            {t("agent.unpair")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
