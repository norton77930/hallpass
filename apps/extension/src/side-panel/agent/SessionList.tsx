import { useState, type ReactElement } from "react";
import { lookup } from "../../locales/catalog.js";
import { SessionCard } from "./SessionCard.js";
import {
  advanceFolds,
  groupSessions,
  isOpen,
  noFolds,
  toggleFold,
  type FoldState,
  type SessionView,
} from "./session-card-model.js";

/**
 * 036 FR-538 - FR-540, R-536, R-537: the Sessions tab's cards in two groups - first every session that
 * is waiting, working or stopped from the page, then an "Idle" heading with the count and the idle
 * ones in one shared surface - each newest activity first.
 *
 * The owner's open/fold choices live here, in this component's memory, for as long as the panel
 * document does; nothing is stored. A new picture is read by `advanceFolds` during the render that
 * receives it, so a session that starts to need the owner is already open when it first shows.
 */
export type SessionListHandlers = {
  onStop: (sessionId: string) => void;
  onRelease: (sessionId: string) => void;
  onInterrupt: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onWithdrawSitePlan: (sessionId: string) => void;
  onManageSite?: (origin: string) => void;
};

export function SessionList(props: {
  sessions: readonly SessionView[];
  locale: string;
  /** The shell's minute clock (016 FR-230). */
  now: number;
  /** The name the owner knows an agent by (FR-035's stated name). */
  agentName: (agentId: string) => string;
  handlers: SessionListHandlers;
  /** The owner's choices to start from (session id to open); for a captured fixture, never the shell. */
  initialChoices?: ReadonlyMap<string, boolean>;
}): ReactElement | null {
  const t = (key: string): string => lookup(key, props.locale);
  const [folds, setFolds] = useState<FoldState>(() => ({ ...noFolds, choices: props.initialChoices ?? noFolds.choices }));
  const current = advanceFolds(folds, props.sessions);
  // Setting state while rendering is React's own way to adjust state to a new prop, and `advanceFolds`
  // returns the same object when nothing changed, so this settles in one more render at most.
  if (current !== folds) setFolds(current);

  const onlyOne = props.sessions.length === 1;
  const { attention, idle } = groupSessions(props.sessions);
  const card = (session: SessionView): ReactElement => (
    <SessionCard
      key={session.sessionId}
      session={session}
      agentName={props.agentName(session.agentId)}
      locale={props.locale}
      now={props.now}
      open={isOpen(session, current.choices.get(session.sessionId), onlyOne)}
      onToggle={() => setFolds(toggleFold(current, session, onlyOne))}
      onStop={() => props.handlers.onStop(session.sessionId)}
      onRelease={() => props.handlers.onRelease(session.sessionId)}
      onInterrupt={() => props.handlers.onInterrupt(session.sessionId)}
      onResume={() => props.handlers.onResume(session.sessionId)}
      onWithdrawSitePlan={() => props.handlers.onWithdrawSitePlan(session.sessionId)}
      {...(props.handlers.onManageSite === undefined ? {} : { onManageSite: props.handlers.onManageSite })}
    />
  );

  return (
    <>
      {attention.length === 0 ? null : (
        <div className="agent-session-list" data-group="attention">
          {attention.map(card)}
        </div>
      )}
      {idle.length === 0 ? null : (
        <>
          <h2 className="agent-session-group" data-sessions-idle="">
            {t("agent.session.groupIdle")}{" "}
            <span className="agent-session-count">{idle.length}</span>
          </h2>
          <div className="agent-session-list" data-group="idle">
            {idle.map(card)}
          </div>
        </>
      )}
    </>
  );
}
