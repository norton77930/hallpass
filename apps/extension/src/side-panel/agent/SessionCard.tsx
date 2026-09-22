import type { ReactElement } from "react";
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
  return t("agent.activity.dialog")
    .replace("{site}", () => item.site ?? "")
    .replace("{message}", () => item.message ?? "");
}

/** A short label for the session, from its host-minted id: the last few characters tell two apart. */
export function sessionLabel(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
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

export function SessionCard(props: {
  session: SessionView;
  agentName: string;
  locale: string;
  onStop: () => void;
  onRelease: () => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const { session } = props;
  const state = session.state ?? "working";
  const sites = session.sites ?? [];
  // Newest first, as the worker keeps it; the panel never re-orders what it is told (FR-113).
  const activity = session.activity ?? [];
  const titleId = `agent-session-${session.sessionId}`;

  return (
    <section
      className="agent-session"
      data-session-id={session.sessionId}
      data-session-state={state}
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>
        {/* The name this session's greeting carried, as inert text - it is remote input. The paired
            record's name is only a fallback: one agent id is shared by every MCP client on the machine. */}
        {session.agentName ?? props.agentName} · {t("agent.session.label").replace("{id}", sessionLabel(session.sessionId))}
      </h2>
      <p className="agent-session-sites">
        {sites.length === 0
          ? t("agent.session.noSites")
          : t("agent.session.sites").replace("{sites}", () => sites.join(", "))}
      </p>
      <p className="agent-session-state">{t(state === "waiting" ? "agent.session.waiting" : "agent.session.working")}</p>
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
      <div className="agent-session-actions">
        <button type="button" className="agent-danger" onClick={props.onStop}>
          {t("agent.session.stop")}
        </button>
        <button type="button" onClick={props.onRelease}>
          {t("agent.session.release")}
        </button>
      </div>
    </section>
  );
}
