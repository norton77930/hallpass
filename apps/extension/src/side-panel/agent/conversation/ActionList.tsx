import type { ReactElement } from "react";
import type { ConversationEvent } from "@hallpass/contracts";

type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;

/**
 * 019 FR-287, US2 scenario 4 and 6: every action the agent reports, with what it is, a short line
 * about its input and its latest status - reads and actions allowed by the owner's "for this
 * conversation" rule included, so nothing the agent did is only visible by its absence of a card.
 * The title and input are the agent's words, shown as inert text.
 */
export function ActionList(props: { actions: readonly ToolEvent[]; t: (key: string) => string }): ReactElement {
  const { t } = props;
  return (
    <ul className="agent-conversation-actions" aria-label={t("conversation.actions.label")}>
      {props.actions.map((action) => (
        <li key={action.toolCallId} data-status={action.status} data-kind={action.kind}>
          <span className="agent-conversation-action-title">{action.title}</span>
          {action.inputSummary === "" ? null : (
            <span className="agent-conversation-action-input">{action.inputSummary}</span>
          )}
          <span className="agent-conversation-action-status">{t(`conversation.action.status.${action.status}`)}</span>
          {action.byRule ? <span className="agent-conversation-action-rule">{t("conversation.action.byRule")}</span> : null}
        </li>
      ))}
    </ul>
  );
}
