import { useEffect, useState, type ReactElement } from "react";
import { lookup } from "../../locales/catalog.js";
import { SESSION_GRANT_KIND_KEYS, SESSION_PLACE_KEYS } from "../agent-panel-keys.js";
import { activityText } from "./activity-text.js";
import {
  CONSENT_CARD_ID,
  clockOfMs,
  primaryAction,
  rowsOf,
  sitesOf,
  type SessionView,
} from "./session-card-model.js";
import { CheckIcon, ChevronIcon, ExternalIcon, PlaceIcon, PlanIcon, TabIcon } from "./session-icons.js";

/**
 * One live session (006 FR-087, D-006-5): which agent, where it is working, whether it is waiting
 * on the owner, and what the owner can do about it.
 *
 * "Where" is the sites it holds tabs on, by host name, and never a title or a url: a title is the
 * page's word, and this panel shows nothing a page authored. End session ends the session; Take back
 * tabs hands every tab back and lets the session go on. Neither is per tab (D-006-5).
 *
 * 036 rebuilds the card as a header and a body. The header is always shown: the session's colour,
 * its title, one line of state, agent and tabs, and the one action that matters now - Answer,
 * Resume or Interrupt (FR-541, FR-542). The body is shown when the card is open: the recording
 * line, "Sites and permissions" (one row per site), "Recent activity" (the newest three rows), the
 * footer and one quiet last line (FR-544). What the card shows is made by `session-card-model.ts`
 * from the picture the worker already sends; every control sends the frame it always did (SC-244).
 */
export type { SessionView };

/** 008 FR-113: the line an activity item reads as. It lives in `activity-text.ts` and is exported from here as before. */
export { activityText };

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

/** The tone a card's state line is drawn in: warning, accent, or quiet (FR-541). */
export type StateTone = "attention" | "busy" | "idle";

/**
 * The card's state line (016 FR-230, 036 FR-541): waiting for you, stopped from the page, working,
 * or idle with how long ago. A projection from before 016 carries no state and reads as working, as it
 * always did.
 */
function stateOf(session: SessionView, now: number, t: (key: string) => string): { text: string; tone: StateTone } {
  const state = session.state ?? "working";
  if (state === "waiting") return { text: t("agent.session.waiting"), tone: "attention" };
  if (session.heldAt !== undefined) return { text: t("agent.session.heldFromPage"), tone: "attention" };
  if (state === "working") return { text: t("agent.session.working"), tone: "busy" };
  const ago = session.lastActivityAt === undefined ? undefined : lastActionText(session.lastActivityAt, now, t);
  return {
    text: ago === undefined ? t("agent.session.idleUnknown") : t("agent.session.idle").replace("{ago}", () => ago),
    tone: "idle",
  };
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
 * is cut past a couple of dozen characters with the whole of it in `title`. The site-plan question
 * (017 FR-251) uses this, so the owner sees one name for one session.
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

/** How many activity rows show before "Show all" (FR-550). */
export const VISIBLE_ACTIVITY_ROWS = 3;

/**
 * 036 R-538: Answer brings the question slot's card into view and moves focus to it; it answers
 * nothing and sends nothing. With no card on screen (a stale picture) it brings the top of the panel
 * into view instead, and changes nothing.
 */
function bringConsentIntoView(): void {
  const target = document.getElementById(CONSENT_CARD_ID);
  if (target === null) {
    document.querySelector(".agent-shell")?.scrollTo?.({ top: 0 });
    return;
  }
  target.scrollIntoView?.({ block: "nearest" });
  target.focus();
}

export function SessionCard(props: {
  session: SessionView;
  agentName: string;
  locale: string;
  /** The shell's minute clock (016 FR-230): "last action" is measured against it, not re-fetched. */
  now: number;
  /** 036 FR-539, FR-540: whether the body shows, and the header's open/fold press (panel-local, sends nothing). */
  open: boolean;
  onToggle: () => void;
  onStop: () => void;
  onRelease: () => void;
  onInterrupt: () => void;
  /** 034 R-521: lifts the owner's Stop from the page; the panel sends one `ui.agent.session-resume`. */
  onResume: () => void;
  /** 017 FR-259: ends this session's site plan at once; the session goes on. */
  onWithdrawSitePlan: () => void;
  /**
   * 024 FR-393, R-381: opens the settings page at a site, by its origin (036 FR-547: one per site
   * row). A row offers it only for a site with a known origin; the panel sends one
   * `ui.agent.open-settings`.
   */
  onManageSite?: (origin: string) => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const { session, open } = props;
  const state = session.state ?? "working";
  // 034 R-521: the owner stopped this session from the page and has not resumed it yet.
  const heldFromPage = session.heldAt !== undefined;
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
  const [allRows, setAllRows] = useState(false);

  const titleId = `agent-session-${session.sessionId}`;
  const subId = `${titleId}-state`;
  const bodyId = `${titleId}-body`;
  const held = session.tabs.length;
  const agentNameOf = session.agentName ?? props.agentName;
  const titleText = session.label ?? agentNameOf;
  const status = stateOf(session, props.now, t);
  const primary = primaryAction(session);
  const attention = state === "waiting" || heldFromPage;
  const started = clockTime(session.startedAt);

  const sites = open ? sitesOf(session) : [];
  // Newest first, as the worker keeps it; the panel merges rows but never re-orders what it is told (FR-113, FR-550).
  const rows = open ? rowsOf(session.activity ?? [], t) : [];
  const shownRows = allRows ? rows : rows.slice(0, VISIBLE_ACTIVITY_ROWS);
  const recording = recordingLine(session.recording, t);

  return (
    <section
      className="agent-session"
      data-session-id={session.sessionId}
      data-session-state={state}
      data-open={open ? "true" : "false"}
      data-attention={attention ? "true" : "false"}
      aria-labelledby={titleId}
    >
      <div className="agent-session-head">
        {/* The whole of this block is the open/fold press: the button inside the title is stretched over it. */}
        <div className="agent-session-headmain">
          <span className="agent-session-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
          {/* 016 FR-225: the same colour as the session's tab group, so a card and its tabs are found
              together. Decoration only - the title already says which session - and absent when the
              worker gave the session no colour, rather than a colour the panel made up. */}
          {session.colour === undefined ? null : (
            <span className="agent-session-bar" data-colour={session.colour} aria-hidden="true" />
          )}
          <h2 className="agent-session-title">
            <button
              type="button"
              className="agent-session-toggle"
              aria-expanded={open}
              {...(open ? { "aria-controls": bodyId } : {})}
              aria-describedby={subId}
              aria-label={t(open ? "agent.session.toggleHide" : "agent.session.toggleShow").replace("{name}", () => titleText)}
              onClick={props.onToggle}
            >
              {/* The folder its host reported (016 FR-226 - FR-228), else the name this session's
                  greeting carried - both inert text, remote input. The paired record's name is only a
                  fallback: one agent id is shared by every MCP client on the machine. */}
              <span id={titleId} className="agent-session-name">
                {session.label !== undefined ? (
                  <span className="agent-session-label" title={session.label}>
                    {visibleLabel(session.label)}
                  </span>
                ) : (
                  agentNameOf
                )}
              </span>
            </button>
          </h2>
          <p className="agent-session-sub" id={subId}>
            <span className="agent-session-state" data-tone={status.tone}>
              {status.text}
            </span>
            <span className="agent-session-sep" aria-hidden="true">
              ·
            </span>
            <span className="agent-session-agent">{agentNameOf}</span>
            {held === 0 ? null : (
              <>
                <span className="agent-session-sep" aria-hidden="true">
                  ·
                </span>
                <span className="agent-session-tabs">
                  {held === 1 ? t("agent.session.tabCountOne") : t("agent.session.tabCount").replace("{n}", String(held))}
                </span>
              </>
            )}
          </p>
        </div>
        {/*
          036 FR-542: the one action that matters now, shown even while the card is folded. Answer only
          brings the question into view (R-538); Resume is 034's, Interrupt is 014 FR-178's: deliberately
          not `disabled` when the count says nothing is in flight - the picture can be a moment old, and a
          control that did nothing in that moment would look broken - so it is marked unavailable for the
          eye and assistive technology, and pressing it anyway says what happened.
        */}
        {primary === "answer" ? (
          <button type="button" className="agent-session-primary" data-strong="true" onClick={bringConsentIntoView}>
            {t("agent.session.answer")}
          </button>
        ) : primary === "resume" ? (
          <button type="button" className="agent-session-primary" data-strong="true" onClick={props.onResume}>
            {t("agent.session.resume")}
          </button>
        ) : primary === "interrupt" ? (
          <button
            type="button"
            className="agent-session-primary"
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
      </div>
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
      {open ? (
        <div className="agent-session-body" id={bodyId}>
          {/* 008 FR-109: what the session's recording is doing, in one line. Absent while there is no
              recording and none has been exported - a card that said "no recording" would be a fact
              about nothing on every card the owner ever sees. */}
          {recording === undefined ? null : <p className="agent-session-recording">{recording}</p>}
          {/*
            036 FR-545 - FR-548: every site once, with what the session may do there. The site plan's
            withdraw (017 FR-259) sits on the title: one press, always in view, leaving the session,
            its tabs and its remembered sites untouched. Absent entirely with nothing to list.
          */}
          {sites.length === 0 ? null : (
            <section className="agent-session-section" aria-labelledby={`${titleId}-sites`}>
              <div className="agent-session-section-head">
                <h3 id={`${titleId}-sites`}>{t("agent.session.sitesTitle")}</h3>
                {session.sitePlan === undefined ? null : (
                  <button type="button" className="agent-session-textbutton" data-tone="danger" onClick={props.onWithdrawSitePlan}>
                    {t("agent.session.sitePlanWithdraw")}
                  </button>
                )}
              </div>
              <ul className="agent-session-sites">
                {sites.map((site) => (
                  <li key={site.origin ?? `host:${site.host}`}>
                    <div className="agent-session-site-line">
                      <span className="agent-session-site-name" title={site.host}>
                        {site.host}
                      </span>
                      <span className="agent-session-marks">
                        {site.tabHere ? (
                          <span className="agent-session-mark" data-mark="tab">
                            <TabIcon />
                            {t("agent.session.markTab")}
                          </span>
                        ) : null}
                        {site.inPlan ? (
                          <span className="agent-session-mark" data-mark="plan">
                            <PlanIcon />
                            {t("agent.session.markPlan")}
                          </span>
                        ) : null}
                      </span>
                      {/* 024 FR-393, 036 FR-547: the standing permissions are on the settings page; each site with a known origin links there. */}
                      {site.origin === undefined || props.onManageSite === undefined ? null : (
                        <button
                          type="button"
                          className="agent-session-iconbutton agent-session-manage"
                          aria-label={t("agent.session.manageSiteLabel").replace("{site}", () => site.host)}
                          title={t("agent.session.manageSiteLabel").replace("{site}", () => site.host)}
                          onClick={() => props.onManageSite?.(site.origin ?? "")}
                        >
                          <ExternalIcon />
                        </button>
                      )}
                    </div>
                    {site.grants.length === 0 ? null : (
                      <div className="agent-session-grants">
                        {/* 031 FR-475: what the owner allowed this session here, and where they said so. */}
                        {site.grants.map((grant) => (
                          <span className="agent-session-grant" key={`${grant.kind}-${grant.source}`}>
                            <CheckIcon />
                            {t(SESSION_GRANT_KIND_KEYS[grant.kind])}
                            <span
                              className="agent-session-place"
                              title={t("agent.session.grantPlace").replace("{place}", () => t(SESSION_PLACE_KEYS[grant.source]))}
                            >
                              <PlaceIcon place={grant.source} />
                              <span className="agent-sr-only">{t(SESSION_PLACE_KEYS[grant.source])}</span>
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {/*
            008 FR-113: what happened on this session's tabs while the owner may have been looking
            elsewhere. Every dialog is here whatever the mode decided, because an accept in `skip-checks`
            is over in a moment and this is the only trace of it. The page's words are rendered as the
            page wrote them - inert text, never markup - and the sentence around them is the panel's own.
            Absent entirely when nothing has happened: an empty list is a fact about nothing.
          */}
          {rows.length === 0 ? null : (
            <section className="agent-session-section" aria-labelledby={`${titleId}-activity`}>
              <div className="agent-session-section-head">
                <h3 id={`${titleId}-activity`}>{t("agent.activity.title")}</h3>
              </div>
              {/*
                The position is part of the identity: two dialogs can be answered inside one
                millisecond and end the same way, and a key of the timestamp alone would make them one
                item as far as React is concerned.
              */}
              <ol className="agent-session-activity">
                {shownRows.map((row, index) => (
                  <li key={`${row.at}-${row.kind}-${index}`}>
                    <time className="agent-activity-time" dateTime={new Date(row.at).toISOString()}>
                      {clockOfMs(row.at)}
                    </time>
                    <div className="agent-activity-main">
                      <p className="agent-activity-text">{row.text}</p>
                      {row.result === undefined && row.place === undefined ? null : (
                        <p className="agent-activity-meta">
                          {row.result === undefined ? null : (
                            <span className="agent-activity-result" data-tone={row.tone}>
                              {row.result}
                            </span>
                          )}
                          {row.place === undefined ? null : (
                            <span className="agent-session-place">
                              <PlaceIcon place={row.place} />
                              {t(SESSION_PLACE_KEYS[row.place])}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {rows.length <= VISIBLE_ACTIVITY_ROWS ? null : (
                <button
                  type="button"
                  className="agent-session-textbutton agent-session-more"
                  data-tone="accent"
                  aria-expanded={allRows}
                  onClick={() => setAllRows(!allRows)}
                >
                  {allRows ? t("agent.session.showLess") : t("agent.session.showAll").replace("{n}", String(rows.length))}
                </button>
              )}
            </section>
          )}
          {/*
            036 FR-551: Take back tabs on the left while there is something to take back (016 FR-234), End
            session on the right as a danger text button, always there. Interrupt and Resume are in the header.
          */}
          <div className="agent-session-foot">
            {held >= 1 ? (
              <button type="button" className="agent-session-takeback" onClick={props.onRelease}>
                {t("agent.session.takeBack").replace("{n}", String(held))}
              </button>
            ) : null}
            <button type="button" className="agent-session-textbutton agent-session-end" data-tone="danger" onClick={props.onStop}>
              {t("agent.session.stop")}
            </button>
          </div>
          {/*
            016 FR-231, 036 FR-544: the host-minted id, for the owner who is asked for it and for nobody
            else - so it is here, folded under the start time, and nowhere else on the card.
          */}
          <details className="agent-session-tech">
            <summary>
              {started === undefined ? t("agent.details.title") : t("agent.session.startedDetails").replace("{time}", started)}
            </summary>
            <p>{t("agent.session.id").replace("{id}", () => session.sessionId)}</p>
          </details>
        </div>
      ) : null}
    </section>
  );
}
