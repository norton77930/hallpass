import { useId, type ReactElement } from "react";
import type { ConversationAgent, ConversationAgentAvailability } from "@hallpass/contracts";
import { AGENT_ORDER, toolsStatus } from "../agent-model.js";
import { TOOLS_STATUS_VIEW } from "../agents/AgentCard.js";
import { useSettings } from "../context.js";
import { Avatar, Mark, Switch } from "../parts.js";

const NOTE_KEYS: Record<ConversationAgent, (entry: ConversationAgentAvailability) => string> = {
  "claude-code": () => "settings.tools.note.claude",
  codex: (entry) => (toolsStatus(entry) === "available" ? "settings.tools.note.codex" : "settings.tools.note.codexPending"),
  hermes: () => "settings.tools.note.hermes",
  deepseek: () => "settings.tools.note.deepseek",
};

/**
 * 024 FR-386, D-024-13: the one setting of this section is the side-panel switch ("Let side-panel
 * agents use the browser tools"), above a table that only reports - which agent can use the tools and,
 * when it cannot, why. The switch shows what the worker last projected; a press only asks, exactly as
 * the side panel's own switch does, so the two never disagree about the consent.
 */
export function BrowserToolsSection(): ReactElement {
  const { state, t, run, nameOf } = useSettings();
  const noteId = useId();
  const granted = state.consent === "granted";
  const note = state.consent === "granted" ? "settings.tools.switchOn" : state.consent === "withdrawn" ? "settings.tools.switchOff" : "settings.tools.switchUnknown";
  const entries = AGENT_ORDER.flatMap((agent) => {
    const entry = state.agents.find((item) => item.agent === agent);
    return entry === undefined ? [] : [entry];
  });
  const helperProblem = state.agentsUnavailable !== undefined || entries.length === 0;

  return (
    <div className="stack narrow" data-section-body="tools" data-consent={state.consent}>
      <div className="blk">
        <div className="row-item boxed" data-tools-switch-card>
          <span className="grow">
            <strong>{t("settings.tools.switchTitle")}</strong>
            <br />
            <span className="meta">{t("settings.tools.switchDesc")}</span>
            <br />
            <span id={noteId} className="meta">
              {t(note)}
            </span>
          </span>
          <Switch
            checked={granted}
            label={t("settings.tools.switchTitle")}
            describedBy={noteId}
            onChange={(next) => {
              void run({ type: "ui.conversation.consent", payload: { granted: next } });
            }}
          />
        </div>
      </div>
      {helperProblem ? (
        <p className="note warn">{t("settings.helper.missingBody")}</p>
      ) : (
        <table className="tools">
          <thead>
            <tr>
              <th scope="col">{t("settings.tools.col.agent")}</th>
              <th scope="col">{t("settings.tools.col.tools")}</th>
              <th scope="col">{t("settings.tools.col.notes")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const view = TOOLS_STATUS_VIEW[toolsStatus(entry)];
              return (
                <tr key={entry.agent} data-agent={entry.agent}>
                  <th scope="row">
                    <span className="agent-cell">
                      <Avatar agent={entry.agent} name={nameOf(entry.agent)} size="sm" />
                      {nameOf(entry.agent)}
                    </span>
                  </th>
                  <td>
                    <Mark kind={view.mark} /> {t(view.key)}
                  </td>
                  <td className="meta">{t(NOTE_KEYS[entry.agent](entry))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="meta">{t("settings.tools.readOnly")}</p>
    </div>
  );
}
