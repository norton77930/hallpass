import { useId, useRef, useState, type ReactElement } from "react";
import type { ConversationEvent } from "@hallpass/contracts";
import { ActionList, inputBeside } from "./ActionList.js";
import type { TurnActionGroup } from "./conversation-log.js";
import { ChevronIcon, WaitIcon } from "./icons.js";
import { InlineCode, shortenPaths } from "./inline-code.js";

type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;

/**
 * 020 T595, US3, FR-318: a turn's actions, out of the way of its answer.
 *
 * While the turn runs, one line names the action under way (`groupTurns`' live one, `LiveLine`).
 * After the turn the steps fold into one "N steps" button that expands to 019 FR-287's rows (name,
 * input, status, allowed-by-rule). Failed and refused actions are listed apart, always in view, in
 * both phases. Everything quoted is the agent's words, shown as inert text.
 *
 * T606 (C2): the message list draws the live line itself, as the last thing in the thread under the
 * reply that is still streaming (`liveElsewhere`); on its own the group still carries it.
 */
export function TurnActions(props: { group: TurnActionGroup; t: (key: string) => string; liveElsewhere?: boolean }): ReactElement | null {
  const { t, group } = props;
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const problems =
    group.problems.length === 0 ? null : (
      <ActionList actions={group.problems} label={t("conversation.turn.problems")} t={t} />
    );
  if (group.running) {
    if (props.liveElsewhere === true && problems === null) return null;
    return (
      <div className="agent-conversation-turn" data-turn="running">
        {props.liveElsewhere === true ? null : <LiveLine live={group.live} t={t} />}
        {problems}
      </div>
    );
  }
  if (group.steps.length === 0 && problems === null) return null;
  return (
    <div className="agent-conversation-turn" data-turn="finished">
      {group.steps.length === 0 ? null : (
        <>
          <button
            type="button"
            className="agent-conversation-steps"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronIcon />
            {group.steps.length === 1 ? t("conversation.turn.step") : t("conversation.turn.steps").replace("{count}", String(group.steps.length))}
          </button>
          {expanded ? <ActionList id={listId} actions={group.steps} t={t} /> : null}
        </>
      )}
      {problems}
    </div>
  );
}

/**
 * The live line: the action under way, or (T606 C3) what waits for the owner's answer, with a
 * warning mark instead of the spinner. A polite live region whose words change only when another
 * action becomes the live one: a new status or a reworded title for the same action is not
 * announced again.
 */
export function LiveLine(props: { live?: ToolEvent | undefined; waitingFor?: string | undefined; t: (key: string) => string }): ReactElement {
  const { t } = props;
  const announced = useRef<{ id: string; title: string; input: string } | undefined>(undefined);
  if (props.live === undefined) announced.current = undefined;
  else if (announced.current?.id !== props.live.toolCallId) announced.current = liveWords(props.live);
  const live = announced.current;
  if (props.waitingFor !== undefined) {
    return (
      <p className="agent-conversation-live" data-waiting="" aria-live="polite" aria-atomic="true">
        <WaitIcon />
        <span className="agent-conversation-action-title">
          <InlineCode text={t("conversation.turn.waiting").replace("{title}", () => props.waitingFor ?? "")} />
        </span>
      </p>
    );
  }
  return (
    <p className="agent-conversation-live" aria-live="polite" aria-atomic="true">
      {live === undefined ? null : (
        <>
          {/* A real element rather than a ::before, so the waiting state can leave it out. */}
          <span className="agent-conversation-spinner" aria-hidden="true" />
          <span className="agent-conversation-action-title">
            <InlineCode text={t("conversation.turn.live").replace("{title}", () => live.title)} />
          </span>
          {live.input === "" ? null : (
            <span className="agent-conversation-action-input" title={live.input}>
              {shortenPaths(live.input)}
            </span>
          )}
        </>
      )}
    </p>
  );
}

const liveWords = (action: ToolEvent) => ({
  id: action.toolCallId,
  title: action.title,
  input: inputBeside(action.title, action.inputSummary) ?? "",
});
