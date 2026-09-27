import { useState, type ReactElement } from "react";
import type { AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";

/**
 * The status row (006 FR-083, D-006-4): a state dot, "connected", how many sessions are live, and an
 * overflow menu holding the one thing the owner can do about the pairing itself - unpair.
 *
 * 016 FR-223: the row counts sessions and names no agent. It used to show `paired[0]`'s name - one
 * agent's name for a browser that may serve several - and its one unpair unpaired all of them. The
 * menu is now where the paired agents are named, each with its own unpair that sends one command
 * for that agent and no other.
 *
 * Unpair is behind a menu rather than on the row because it is the one control here that undoes
 * something, and the row is otherwise something the owner only reads. Whether the menu is open is
 * the one piece of UI state this panel keeps (R-125 allows focus and the like); it decides nothing.
 */
export function StatusRow(props: {
  sessionCount: number;
  paired: AgentPanelState["paired"];
  locale: string;
  onUnpair: (agentId: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
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
          {props.paired.map((agent) => (
            // One row per paired agent: its stated name as inert text (remote input), and an
            // unpair whose accessible name carries that name, so two rows never read the same.
            <div key={agent.agentId} role="group" aria-label={agent.displayName} className="agent-menu-row">
              <span className="agent-menu-name">{agent.displayName}</span>
              <button
                type="button"
                role="menuitem"
                aria-label={t("agent.status.unpairAgent").replace("{agent}", () => agent.displayName)}
                onClick={() => {
                  setOpen(false);
                  props.onUnpair(agent.agentId);
                }}
              >
                {t("agent.unpair")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
