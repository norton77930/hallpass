import { useEffect, useState, type ReactElement } from "react";
import type { AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import { ACTIVITY_OUTCOME_KEYS, WINDOW_STATE_KEYS } from "../agent-panel-keys.js";

/**
 * One live session (006 FR-087, D-006-5): which agent, where it is working, whether it is waiting
 * on the owner, and the two things the owner can do about it.
 *
 * "Where" is the sites it holds tabs on, by host name, and never a title or a url: a title is the
 * page's word, and this panel shows nothing a page authored. Stop ends the session; Release tabs
 * hands every tab back and lets the session go on. Neither is per tab (D-006-5).
 *
 * 016 (FR-225 – FR-234) makes it readable: a stripe in the session's tab-group colour, a title of
 * the agent and the folder it was started in, a subtitle of when and what it holds, a state line
 * that can say idle, the id folded under technical details, and only the controls that would do
 * something - "End session" always, "Interrupt this step" while working, "Take back tabs" while it
 * holds any.
 */
export type SessionView = AgentPanelState["sessions"][number];

type ActivityItem = NonNullable<SessionView["activity"]>[number];

/**
 * The line an activity item reads as (008 FR-113, FR-119).
 *
 * One template per kind, because the kinds are different sentences about different things: a
 * dialog is something a *page* said, a restore is something this extension did to the owner's own
 * window. Both are written here from pieces - a state word, a host, the page's own message - so no
 * worker English ever reaches the card.
 */
export function activityText(item: ActivityItem, t: (key: string) => string): string {
  if (item.kind === "interrupt") {
    // 014 FR-182: one line for the owner's own action, with no site and no message - they ended a
    // step, and which step it was is not something the card should claim to know afterwards.
    return t("agent.activity.interrupt");
  }
  if (item.kind === "restore") {
    const state = item.message === "fullscreen" ? WINDOW_STATE_KEYS.fullscreen : WINDOW_STATE_KEYS.maximized;
    return t("agent.activity.restore").replace("{state}", () => t(state));
  }
  if (item.kind === "viewport") {
    // 012 FR-159: a third sentence, because this is a third kind of thing. The size is the
    // worker's own `"WxH"` - two numbers it chose, never a word from the page - and a cleared
    // viewport carries none, so the two outcomes are two templates rather than one with a hole.
    return item.outcome === "set"
      ? t("agent.activity.viewportSet").replace("{size}", () => item.message ?? "")
      : t("agent.activity.viewportCleared");
  }
  if (item.kind === "upload") {
    // 013 FR-174: a fourth sentence - a picture the session took, now in the owner's page. The
    // worker sends the delivery the *page* reported, `input` or `drop`, and the two read as two
    // different things: a file handed to a form, and a file dropped on the page. A site the worker
    // could not name leaves no hole in either, the way a restore's missing state does not.
    const sentence =
      item.message === "input" ? t("agent.activity.uploadInput") : t("agent.activity.uploadDrop");
    return sentence.replace("{site}", () => item.site ?? t("agent.activity.unknownSite"));
  }
  if (item.kind === "site-plan") {
    // 017 FR-263: one sentence per plan event, from the site count the worker sends; the outcome word
    // (approved, replaced, withdrawn, ended) is the card's, as for every other kind.
    return item.message === "1"
      ? t("agent.activity.sitePlanOne")
      : t("agent.activity.sitePlan").replace("{n}", () => item.message ?? "");
  }
  return t("agent.activity.dialog")
    .replace("{site}", () => item.site ?? "")
    .replace("{message}", () => item.message ?? "");
}

/**
 * How many characters of the folder the title shows before it cuts (016 FR-227).
 *
 * The label is remote input of up to 64 characters and the panel is 360 px wide; past this the
 * title would wrap under the agent's name, so it is cut with an ellipsis and the whole text rides in
 * the `title` attribute for the owner who hovers.
 */
export const LABEL_VISIBLE_CHARS = 24;

/** The label as the title shows it: whole, or its first characters and an ellipsis (FR-227). */
export function visibleLabel(label: string): string {
  const characters = [...label];
  return characters.length <= LABEL_VISIBLE_CHARS ? label : `${characters.slice(0, LABEL_VISIBLE_CHARS).join("")}…`;
}

/**
 * A worker timestamp as the owner's own wall clock, `HH:mm` (016 FR-228), or nothing when it does
 * not parse - a card that said "started NaN:NaN" would be a fact about nothing.
 */
export function clockTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * How long ago the last action was (016 FR-230): just now under a minute, minutes under an hour,
 * then hours and minutes. `now` is the shell's minute clock, so the words move on without a
 * projection; a timestamp from the future (a clock skew) reads as just now rather than negative.
 */
export function lastActionText(iso: string, now: number, t: (key: string) => string): string | undefined {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t("agent.session.justNow");
  if (minutes < 60) return t("agent.session.minutesAgo").replace("{m}", String(minutes));
  return t("agent.session.hoursAgo")
    .replace("{h}", String(Math.floor(minutes / 60)))
    .replace("{m}", String(minutes % 60));
}

/**
 * The card's state line (016 FR-230): working, waiting for you, or idle with the last action. A
 * projection from before 016 carries no state and reads as working, as it always did.
 */
function stateText(session: SessionView, now: number, t: (key: string) => string): string {
  const state = session.state ?? "working";
  if (state === "waiting") return t("agent.session.waiting");
  if (state === "working") return t("agent.session.working");
  const ago = session.lastActivityAt === undefined ? undefined : lastActionText(session.lastActivityAt, now, t);
  return ago === undefined ? t("agent.session.idleUnknown") : t("agent.session.idle").replace("{ago}", () => ago);
}

/**
 * The subtitle (016 FR-229): when the session started, and how many tabs it holds on which sites -
 * or that it holds none. Sites by host name only, never a title (006 R-127).
 */
function subtitleText(session: SessionView, t: (key: string) => string): string {
  const count = session.tabs.length;
  const sites = (session.sites ?? []).join(t("agent.session.siteSeparator"));
  const holds =
    count === 0
      ? t("agent.session.noSites")
      : (count === 1 ? t("agent.session.holdsOne") : t("agent.session.holds").replace("{n}", String(count))).replace(
          "{sites}",
          () => sites,
        );
  const started = clockTime(session.startedAt);
  // Without a folder the title already ends in the start time; saying it twice reads as a mistake.
  return started === undefined || session.label === undefined
    ? holds
    : `${t("agent.session.started").replace("{time}", started)} · ${holds}`;
}

/**
 * The card's recording line, or nothing at all (008 FR-109).
 *
 * Three states and one order: a full recording is named as full even though it is `stopped`,
 * because "waiting for export" is what the owner can act on; a recording with frames says how many;
 * and a session whose recording is over says which file it wrote, which is the only trace left of
 * it (FR-108). The file name is one this extension minted or one that passed the filename grammar -
 * it is never a page's word.
 */
export function recordingLine(
  recording: SessionView["recording"],
  t: (key: string) => string,
): string | undefined {
  if (!recording) return undefined;
  if (recording.full) return t("agent.session.recordingFull").replace("{frames}", String(recording.frames));
  if (recording.frames > 0) return t("agent.session.recording").replace("{frames}", String(recording.frames));
  return recording.lastExport === undefined
    ? undefined
    : t("agent.session.recordingExported").replace("{filename}", recording.lastExport);
}

/**
 * What a session is called on a card (016 FR-226 – FR-228): the agent's name, then the folder its
 * host reported, else when it started. Both are remote input and rendered as inert text; the folder
 * is cut past a couple of dozen characters with the whole of it in `title`. The session card's title
 * and the site-plan question (017 FR-251) both use this, so the owner sees one name for one session.
 */
export function SessionTitle(props: {
  agentName: string;
  label?: string | undefined;
  startedAt?: string | undefined;
  t: (key: string) => string;
}): ReactElement {
  const started = clockTime(props.startedAt);
  return (
    <>
      {props.agentName}
      {props.label !== undefined ? (
        <>
          {" · "}
          <span className="agent-session-label" title={props.label}>
            {visibleLabel(props.label)}
          </span>
        </>
      ) : started !== undefined ? (
        ` · ${props.t("agent.session.started").replace("{time}", started)}`
      ) : null}
    </>
  );
}

/** How long the "nothing was running" line stays up (FR-178): long enough to read, then gone. */
export const NOTHING_TO_INTERRUPT_MS = 4_000;

export function SessionCard(props: {
  session: SessionView;
  agentName: string;
  locale: string;
  /** The shell's minute clock (016 FR-230): "last action" is measured against it, not re-fetched. */
  now: number;
  onStop: () => void;
  onRelease: () => void;
  onInterrupt: () => void;
  /** 017 FR-259: ends this session's site plan at once; the session goes on. */
  onWithdrawSitePlan: () => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const { session } = props;
  const state = session.state ?? "working";
  /**
   * Whether there is anything to interrupt (014 FR-178), as the worker counted it.
   *
   * A projection from before this slice carries no count, which reads as nothing running - the
   * honest fallback: a control that claimed to be actionable on a picture that never said so
   * would be a promise made by the panel rather than by the session.
   */
  const inFlight = session.inFlight ?? 0;
  const [saidNothing, setSaidNothing] = useState(false);
  useEffect(() => {
    if (!saidNothing) return undefined;
    const timer = setTimeout(() => setSaidNothing(false), NOTHING_TO_INTERRUPT_MS);
    return () => clearTimeout(timer);
  }, [saidNothing]);
  // Newest first, as the worker keeps it; the panel never re-orders what it is told (FR-113).
  const activity = session.activity ?? [];
  const titleId = `agent-session-${session.sessionId}`;
  const held = session.tabs.length;
  const sitePlan = session.sitePlan;

  return (
    <section
      className="agent-session"
      data-session-id={session.sessionId}
      data-session-state={state}
      aria-labelledby={titleId}
    >
      {/* 016 FR-225: the same colour as the session's tab group, so a card and its tabs are found
          together. Decoration only - the title already says which session - and absent when the
          worker gave the session no colour, rather than a colour the panel made up. */}
      {session.colour === undefined ? null : (
        <div className="agent-session-stripe" data-colour={session.colour} aria-hidden="true" />
      )}
      <div className="agent-session-body">
        <h2 id={titleId}>
          {/* The name this session's greeting carried, as inert text - it is remote input. The paired
              record's name is only a fallback: one agent id is shared by every MCP client on the machine. */}
          {/* 016 FR-226 – FR-228: then the folder its host reported, else when it started. */}
          <SessionTitle
            agentName={session.agentName ?? props.agentName}
            label={session.label}
            startedAt={session.startedAt}
            t={t}
          />
        </h2>
        <p className="agent-session-sites">{subtitleText(session, t)}</p>
        <p className="agent-session-state">{stateText(session, props.now, t)}</p>
        {/* 008 FR-109: what the session's recording is doing, in one line. Absent while there is no
            recording and none has been exported - a card that said "no recording" would be a fact
            about nothing on every card the owner ever sees. */}
        {recordingLine(session.recording, t) === undefined ? null : (
          <p className="agent-session-recording">{recordingLine(session.recording, t)}</p>
        )}
        {/*
          008 FR-113: what happened on this session's tabs while the owner may have been looking
          elsewhere. Every dialog is here whatever the mode decided, because an accept in `skip-checks`
          is over in a moment and this is the only trace of it. The page's words are rendered as the
          page wrote them - inert text, never markup - and the sentence around them is the panel's own.
          Absent entirely when nothing has happened: an empty list is a fact about nothing.
        */}
        {activity.length === 0 ? null : (
          <ul className="agent-session-activity" aria-label={t("agent.activity.title")}>
            {/*
              The position is part of the identity: two dialogs can be answered inside one
              millisecond and end the same way, and a key of the timestamp and the outcome alone
              would make them one item as far as React is concerned.
            */}
            {activity.map((item, index) => (
              <li key={`${item.at}-${item.outcome}-${index}`}>
                <span className="agent-activity-text">{activityText(item, t)}</span>{" "}
                <span className="agent-activity-outcome">{t(ACTIVITY_OUTCOME_KEYS[item.outcome])}</span>
              </li>
            ))}
          </ul>
        )}
        {/*
          017 FR-259, R-252: the plan this session works under, where the owner can see it and end it.
          The count is the summary and the sites unfold beneath it, as inert text; withdrawing is one
          press, always in view, and leaves the session, its tabs and its remembered sites untouched.
          Absent entirely with no plan.
        */}
        {sitePlan === undefined ? null : (
          <div className="agent-session-site-plan-row">
            <details className="agent-details agent-session-site-plan">
              <summary>
                {sitePlan.origins.length === 1
                  ? t("agent.session.sitePlanOne")
                  : t("agent.session.sitePlan").replace("{n}", String(sitePlan.origins.length))}
              </summary>
              <ul>
                {sitePlan.origins.map((origin) => (
                  <li key={origin}>{origin}</li>
                ))}
              </ul>
            </details>
            <button type="button" onClick={props.onWithdrawSitePlan}>
              {t("agent.session.sitePlanWithdraw")}
            </button>
          </div>
        )}
        {/*
          014 FR-178: what the owner is told when they interrupt a session that was not doing
          anything. A line rather than a card, announced rather than focused: nothing was decided and
          nothing is being asked, so it must not take the place their next action is heading for.
        */}
        {saidNothing ? (
          <p className="agent-session-nothing" role="status">
            {t("agent.session.nothingToInterrupt")}
          </p>
        ) : null}
        {/*
          016 FR-232 – FR-234: "End session" always, first and on its own; the rest only when they
          would do something, after a spacer that keeps them away from it.
        */}
        <div className="agent-session-actions">
          <button type="button" className="agent-danger" onClick={props.onStop}>
            {t("agent.session.stop")}
          </button>
          <span className="agent-session-spacer" aria-hidden="true" />
          {/*
            014 FR-178, 016 FR-233: shown only while the session is working. Still deliberately not
            `disabled` when the count says nothing is in flight: the picture can be a moment old - the
            call it named may have answered while the owner was reaching for the mouse - and a control
            that simply did nothing in that moment would look broken. So it is marked unavailable for
            assistive technology and for the eye, and pressing it anyway says what happened instead
            (014 US1 scenario 5). With a call in flight it is the plain control it looks like.
          */}
          {state === "working" ? (
            <button
              type="button"
              className="agent-interrupt"
              aria-disabled={inFlight === 0}
              onClick={() => {
                if (inFlight === 0) {
                  setSaidNothing(true);
                  return;
                }
                setSaidNothing(false);
                props.onInterrupt();
              }}
            >
              {t("agent.session.interrupt")}
            </button>
          ) : null}
          {/* 016 FR-234: today's release, counted, and only while there is something to take back. */}
          {held >= 1 ? (
            <button type="button" onClick={props.onRelease}>
              {t("agent.session.takeBack").replace("{n}", String(held))}
            </button>
          ) : null}
        </div>
        {/*
          016 FR-231: the host-minted id, for the owner who is asked for it and for nobody else - so it
          is here, folded, and nowhere else on the card. The `<details>` idiom is NotConnected's.
        */}
        <details className="agent-details">
          <summary>{t("agent.details.title")}</summary>
          <p>{t("agent.session.id").replace("{id}", () => session.sessionId)}</p>
        </details>
      </div>
    </section>
  );
}
