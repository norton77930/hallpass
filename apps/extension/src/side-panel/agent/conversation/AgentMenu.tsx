import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { CONVERSATION_AGENTS, type ConversationAgent, type ConversationAgentAvailability } from "@hallpass/contracts";
import { AGENT_MARK } from "./agent-mark.js";
import { availabilityDetail } from "./broker-words.js";
import { useOutsidePress } from "./outside-press.js";

/**
 * 020 D-020-8, FR-313, T588: the agent chip's menu - every supported agent with its state.
 *
 * The states are the worker's availability (019 FR-299 - FR-301), in the same words the 019 picker
 * used: ready, needs a one-time download, not installed (with the install guidance), version not
 * supported (with the installed version and the broker's redacted detail). Choosing an agent only
 * moves the chip; nothing leaves the panel until the owner sends. An agent the worker has not
 * reported yet is listed but cannot be chosen.
 */

type T = (key: string) => string;

export function AgentMenu(props: {
  agents: readonly ConversationAgentAvailability[];
  selected: ConversationAgent;
  /** T606 (C8): the agent the panel remembers using last, when it remembers one (R-335). */
  lastUsed?: ConversationAgent | undefined;
  agentName: (agent: ConversationAgent) => string;
  t: T;
  id: string;
  onChoose: (agent: ConversationAgent) => void;
  /** Escape or Tab: the menu closes and focus goes back to the chip. */
  onClose: () => void;
  /** T600: a press outside the menu closes it and leaves the focus where the press put it. */
  onDismiss: () => void;
}): ReactElement {
  const { t } = props;
  const menu = useRef<HTMLUListElement>(null);
  useOutsidePress(menu, props.id, props.onDismiss);
  const items = (): HTMLButtonElement[] => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)") ?? [])];

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
      {CONVERSATION_AGENTS.map((agent) => {
        const entry = props.agents.find((candidate) => candidate.agent === agent);
        const availability = entry?.availability;
        return (
          <li key={agent} role="none">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.selected === agent}
              disabled={entry === undefined}
              data-availability={availability}
              className="agent-conversation-menu-item"
              onClick={() => props.onChoose(agent)}
            >
              {/* T605: the agent's mark as a badge - decoration; the name beside it is the words. */}
              <span className="agent-conversation-agent-badge" aria-hidden="true">
                {AGENT_MARK[agent]}
              </span>
              <span className="agent-conversation-menu-text">
                <span className="agent-conversation-agent-name">{props.agentName(agent)}</span>
                {availability === undefined ? null : (
                  <span className="agent-conversation-availability">
                    {availability === "ready" && agent === props.lastUsed
                      ? t("conversation.availability.readyLastUsed")
                      : t(`conversation.availability.${availability}`)}
                  </span>
                )}
                {availability === "missing" ? (
                  <span className="agent-conversation-menu-note">{t(`conversation.missing.${agent}`)}</span>
                ) : null}
                {availability === "version-problem" && entry?.version !== undefined ? (
                  <span className="agent-conversation-menu-note">
                    {t("conversation.version.installed").replace("{version}", () => entry.version ?? "")}
                  </span>
                ) : null}
                {/* Already redacted by the broker (R-326); T608: its known sentence is said in the panel's language. */}
                {availability === "version-problem" && entry?.detail !== undefined ? (
                  <span className="agent-conversation-menu-note">{availabilityDetail(entry.detail, props.agentName(agent), t)}</span>
                ) : null}
                {/* 021 FR-345, FR-350: the worker's notes (Git for Windows missing, a pre-release) in words. */}
                {(entry?.notes ?? []).map((note) => (
                  <span key={note} className="agent-conversation-menu-note" data-note={note}>
                    {t(`conversation.note.${note}`)}
                  </span>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
