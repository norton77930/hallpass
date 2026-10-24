import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ConversationAgent } from "@hallpass/contracts";
import { AGENT_ORDER, agentState, needsAttention } from "../agent-model.js";
import { useSettings } from "../context.js";
import type { SettingsRoute } from "../routes.js";
import { AgentCard } from "./AgentCard.js";

/**
 * 024 FR-376, FR-377, T757: the Agents section - what the helper cannot say is told first (the page
 * still opens), then one collapsible card per agent in the fixed order. A card starts open when its
 * agent needs a download or carries a warning, as it is first seen; after that only the owner (or a
 * `#agents/<agent>` route) opens or closes it, so a projection never moves a card under their hands.
 */
export function AgentsSection(props: { route: SettingsRoute }): ReactElement {
  const { state, t, run, nameOf } = useSettings();
  const initial = useRef<Partial<Record<ConversationAgent, boolean>>>({});
  const [chosen, setChosen] = useState<Partial<Record<ConversationAgent, boolean>>>({});
  const discs = useRef<Partial<Record<ConversationAgent, HTMLButtonElement | null>>>({});
  const focusAfterDefault = useRef<ConversationAgent | undefined>(undefined);

  const entries = AGENT_ORDER.flatMap((agent) => {
    const entry = state.agents.find((item) => item.agent === agent);
    return entry === undefined ? [] : [entry];
  });
  for (const entry of entries) {
    if (initial.current[entry.agent] === undefined) {
      initial.current[entry.agent] = needsAttention(agentState(entry, nameOf(entry.agent)), state.choices.enabled[entry.agent] !== false);
    }
  }

  // `#agents/<agent>`: open that card, bring it into view and put the focus on its name.
  const routed = props.route.agent;
  useEffect(() => {
    if (routed === undefined) return;
    setChosen((current) => ({ ...current, [routed]: true }));
    const disc = discs.current[routed];
    disc?.scrollIntoView?.({ block: "start" });
    disc?.focus({ preventScroll: true });
  }, [routed]);

  // Make default turns its own button into the mark; the focus stays on the card.
  const defaultAgent = state.choices.default;
  useEffect(() => {
    if (focusAfterDefault.current !== undefined && focusAfterDefault.current === defaultAgent) {
      discs.current[defaultAgent]?.focus({ preventScroll: true });
      focusAfterDefault.current = undefined;
    }
  }, [defaultAgent]);

  const helperProblem = state.agentsUnavailable !== undefined || state.bridge !== "connected";
  return (
    <>
      <p className="def-hint" id="def-hint">
        {t("settings.agents.defaultHint")}
      </p>
      {helperProblem ? (
        <div className="note warn helper-missing" role="status">
          <div className="notes">
            <h3>{t(state.agentsUnavailable === "host-outdated" ? "settings.connection.helperNeedsUpdate" : "settings.helper.missingTitle")}</h3>
            <p>{t(state.agentsUnavailable === "host-outdated" ? "settings.helper.needsUpdate" : "settings.helper.missingBody")}</p>
            <div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void run({ type: "ui.conversation.check-agents", payload: {} });
                }}
              >
                {t("settings.helper.retry")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="cards">
          {entries.map((entry) => (
            <AgentCard
              key={entry.agent}
              ref={(element) => {
                discs.current[entry.agent] = element;
              }}
              agent={entry.agent}
              entry={entry}
              open={chosen[entry.agent] ?? initial.current[entry.agent] ?? false}
              onToggle={() => setChosen((current) => ({ ...current, [entry.agent]: !(current[entry.agent] ?? initial.current[entry.agent] ?? false) }))}
              onMadeDefault={() => {
                focusAfterDefault.current = entry.agent;
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
