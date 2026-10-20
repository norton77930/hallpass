import type { ReactElement } from "react";
import type { ConversationEvent } from "@hallpass/contracts";
import { InlineCode, shortenPaths } from "./inline-code.js";

type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;

/**
 * 019 FR-287, US2 scenario 4 and 6: every action the agent reports, with what it is, a short line
 * about its input and its latest status - reads and actions allowed by the owner's "for this
 * conversation" rule included, so nothing the agent did is only visible by its absence of a card.
 * The title and input are the agent's words, shown as inert text.
 */
export function ActionList(props: {
  actions: readonly ToolEvent[];
  t: (key: string) => string;
  id?: string;
  /** 020 FR-318: the list's name, when it is not every action of the turn (the problems). */
  label?: string;
}): ReactElement {
  const { t } = props;
  return (
    <ul id={props.id} className="agent-conversation-actions" aria-label={props.label ?? t("conversation.actions.label")}>
      {props.actions.map((action) => (
        <li key={action.toolCallId} data-status={action.status} data-kind={action.kind}>
          {/* T607 (W1): one line each; a long path shows its tail and the title attribute has it all. */}
          <span className="agent-conversation-action-title" title={action.title}>
            <InlineCode text={action.title} />
          </span>
          {inputBeside(action.title, action.inputSummary) === undefined ? null : (
            <span className="agent-conversation-action-input" title={action.inputSummary}>
              {shortenPaths(action.inputSummary)}
            </span>
          )}
          <span className="agent-conversation-action-status">{t(`conversation.action.status.${action.status}`)}</span>
          {action.byRule ? <span className="agent-conversation-action-rule">{t("conversation.action.byRule")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Trimmed, without the backticks an agent puts around a command or path. */
const plain = (words: string): string => words.replaceAll("`", "").trim();

/**
 * T602: the input line beside an action's title, or nothing when it would only repeat it ("Read
 * src/a.ts" next to "src/a.ts"). An input that adds something stays, so FR-287's detail is in view.
 */
export function inputBeside(title: string, input: string): string | undefined {
  const added = plain(input);
  return added === "" || plain(title).includes(added) ? undefined : input;
}
