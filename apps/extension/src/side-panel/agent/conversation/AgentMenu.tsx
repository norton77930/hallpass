import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import type { ConversationAgent, ConversationAgentAvailability } from "@hallpass/contracts";
import { AGENT_MARK } from "./agent-mark.js";
import { notReadyReason } from "./not-ready.js";
import { useOutsidePress } from "./outside-press.js";

/**
 * 020 D-020-8, FR-313, T588: the agent chip's menu - the agents the owner switched on, each with its state.
 *
 * 024 FR-384, D-024-2, D-024-3: which agents are listed is the owner's choice on the settings page, so
 * an agent they switched off is not here. A ready agent can be chosen. One that is enabled but cannot
 * start is listed greyed with one line saying why and a link that opens the settings page at its card;
 * nothing is downloaded or installed from here. Choosing an agent only moves the chip; nothing leaves
 * the panel until the owner sends. An agent the worker has not reported yet is listed but cannot be
 * chosen.
 */

type T = (key: string) => string;

export function AgentMenu(props: {
  agents: readonly ConversationAgentAvailability[];
  /** 024: the enabled agents, in the contract's order; no other agent is listed. */
  enabled: readonly ConversationAgent[];
  selected: ConversationAgent;
  agentName: (agent: ConversationAgent) => string;
  t: T;
  id: string;
  onChoose: (agent: ConversationAgent) => void;
  /** 024 FR-384: the link of an agent that cannot start - the settings page at that agent's card. */
  onOpenSettings: (agent: ConversationAgent) => void;
  /** Escape or Tab: the menu closes and focus goes back to the chip. */
  onClose: () => void;
  /** T600: a press outside the menu closes it and leaves the focus where the press put it. */
  onDismiss: () => void;
}): ReactElement {
  const { t } = props;
  const menu = useRef<HTMLUListElement>(null);
  useOutsidePress(menu, props.id, props.onDismiss);
  // The rows that can be chosen and the links of the ones that cannot, in the order they are drawn.
  const items = (): HTMLButtonElement[] => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled), [role=menuitem]") ?? []),
  ];

  useEffect(() => {
    // The chosen agent has focus when the menu opens, as a menu button's menu does.
    const all = items();
    (all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, []);

  const onKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const all = items();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? all.length - 1
      : event.key === "ArrowDown" ? (at + 1) % all.length
      : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <ul ref={menu} id={props.id} role="menu" aria-label={t("conversation.agentMenu.label")} className="agent-conversation-menu" onKeyDown={onKey}>
      {props.enabled.map((agent) => {
        const entry = props.agents.find((candidate) => candidate.agent === agent);
        const availability = entry?.availability;
        const name = props.agentName(agent);
        // FR-384: one line saying why this agent cannot start, when it cannot (D-024-3).
        const reason = notReadyReason(entry, name, t);
        const reasonId = `${props.id}-${agent}-reason`;
        return (
          <li key={agent} role="none" data-agent={agent}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.selected === agent}
              disabled={reason !== undefined}
              data-availability={availability}
              className="agent-conversation-menu-item"
              onClick={() => props.onChoose(agent)}
            >
              {/* T605: the agent's mark as a badge - decoration; the name beside it is the words. */}
              <span className="agent-conversation-agent-badge" aria-hidden="true">
                {AGENT_MARK[agent]}
              </span>
              <span className="agent-conversation-menu-text">
                <span className="agent-conversation-agent-name">{name}</span>
                {/* A ready agent says so; one that cannot start says why on the line below instead. */}
                {availability === "ready" ? (
                  <span className="agent-conversation-availability">{t("conversation.availability.ready")}</span>
                ) : null}
                {/* 021 FR-345, FR-350: the worker's notes (the Windows Git tools missing, a pre-release) in words. */}
                {(entry?.notes ?? []).map((note) => (
                  <span key={note} className="agent-conversation-menu-note" data-note={note}>
                    {t(`conversation.note.${note}`)}
                  </span>
                ))}
              </span>
            </button>
            {reason === undefined ? null : (
              <div className="agent-conversation-reason-row">
                <span id={reasonId} className="agent-conversation-reason">
                  {reason}
                </span>
                {/* The link says where it goes; the line above it says for which agent. */}
                <button
                  type="button"
                  role="menuitem"
                  className="agent-conversation-menu-link"
                  aria-describedby={reasonId}
                  onClick={() => props.onOpenSettings(agent)}
                >
                  {t("conversation.agentMenu.openSettings")}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
