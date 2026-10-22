import { useRef, type ReactElement } from "react";
import { CONVERSATION_ERROR_CODES, type ConversationAgent, type ConversationState } from "@hallpass/contracts";
import { CONVERSATION_NOTICE_KEYS } from "../../agent-panel-keys.js";
import { actionWords } from "./action-words.js";
import { SentAttachments } from "./attachments/AttachmentChips.js";
import { groupTurns, type TimelineItem } from "./conversation-log.js";
import { useFollowEnd } from "./follow-end.js";
import { errorDetailWords, modelUnreachableHint, noticeWords } from "./broker-words.js";
import { DownIcon } from "./icons.js";
import { InlineCode } from "./inline-code.js";
import { Reply } from "./Reply.js";
import { LiveLine, TurnActions } from "./TurnActions.js";

/** The states in which the agent's turn is still under way, so its last reply may still grow. */
const TURN_UNDER_WAY: ReadonlySet<ConversationState> = new Set<ConversationState>(["running", "waiting-for-owner"]);

/** The broker's English lead-in on a failed turn's notice (`packages/agent-host/src/broker/conversation.ts`). */
const TURN_FAILED_PREFIX = "The agent's turn failed: ";

/** The broker's crash notice: "{agent} ended unexpectedly[ (exit N)]. Send a message to continue." */
const CRASH_NOTICE = /^.{1,80} ended unexpectedly(?: \(exit (\d{1,10})\))?\. Send a message to continue\.$/;

const isErrorCode = (code: string): boolean => (CONVERSATION_ERROR_CODES as readonly string[]).includes(code);
const noticeKey = (code: string): string | undefined =>
  Object.hasOwn(CONVERSATION_NOTICE_KEYS, code) ? CONVERSATION_NOTICE_KEYS[code as keyof typeof CONVERSATION_NOTICE_KEYS] : undefined;

/**
 * 019 FR-285, FR-287: the conversation as it happened - the owner's messages, the agent's answer
 * growing as it streams, the actions between them, and notices.
 *
 * A `log` with polite announcements, so a screen reader hears the answer arrive without being
 * interrupted mid-sentence (the 006 a11y rule for anything that updates on its own). A notice with
 * a `ConversationError` code, or one of the contract's `CONVERSATION_NOTICES`, is said in the panel's
 * own words, with the broker's redacted detail under it; any other notice is the broker's own
 * sentence. Everything quoted is inert text.
 *
 * 020 FR-316, FR-317: the agent's text is Markdown, rendered inertly by `Reply`; the owner's own
 * text stays plain. The broker sends no end marker per reply, so a reply counts as finished - and
 * gets Copy - once anything follows it in the timeline, or once the turn is no longer under way.
 *
 * 020 FR-318 (T595): each turn's actions are one `TurnActions` (`groupTurns`, R-334) - a live line
 * while the turn runs, "N steps" once it ended, failed and refused actions always in view.
 *
 * T602: the log is the open conversation's one scroller and follows the newest content while the
 * owner is at its end (`useFollowEnd`); it opens at the end.
 */
export function MessageList(props: {
  timeline: readonly TimelineItem[];
  agentName: string;
  /** 021 FR-355: the agent, for the hint on a model it could not reach. */
  agent?: ConversationAgent;
  /** The conversation's latest state; while the turn is under way the last reply may still grow. */
  state?: ConversationState | undefined;
  /** T606 (C3): the title of the permission card that waits for the owner, if one does. */
  waitingFor?: string | undefined;
  t: (key: string) => string;
}): ReactElement {
  const { t } = props;
  const turnUnderWay = props.state !== undefined && TURN_UNDER_WAY.has(props.state);
  const items = groupTurns(props.timeline, turnUnderWay);
  const lastIndex = items.length - 1;
  const scroller = useRef<HTMLDivElement>(null);
  const { onScroll, away, jump } = useFollowEnd(scroller);
  // T606 (C2): the live line is the thread's last line, under the reply that is still streaming.
  const running = [...items].reverse().find((item) => item.kind === "turn-actions" && item.running);
  const live = running?.kind === "turn-actions" ? running.live : undefined;
  const showLive = running !== undefined || props.waitingFor !== undefined;
  return (
    // T606 (P4): the frame holds the log and, over its lower right corner, "Jump to latest" - outside
    // the log, so the log's own children stay the conversation.
    <div className="agent-conversation-log-frame">
      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label={t("conversation.messages.label")}
        className="agent-conversation-log"
        onScroll={onScroll}
      >
        {items.map((item, index) => {
          if (item.kind === "text") {
            return (
              <div key={item.key} className="agent-conversation-message" data-message-role={item.role}>
                {/* T605: no name on screen - the owner's bubble and the agent's flowing reply say who
                    spoke; a screen reader still hears it. */}
                <span className="agent-conversation-who agent-sr-only">
                  {item.role === "owner" ? t("conversation.role.owner") : props.agentName}
                </span>
                {item.role === "owner" ? (
                  <>
                    {/* 022 R-343: a message may be attachments only. */}
                    {item.text === "" && item.attachments !== undefined ? null : <p>{item.text}</p>}
                    {item.attachments === undefined ? null : <SentAttachments attachments={item.attachments} t={t} />}
                  </>
                ) : (
                  <Reply text={item.text} finished={index !== lastIndex || !turnUnderWay} t={t} />
                )}
              </div>
            );
          }
          if (item.kind === "turn-actions") {
            return <TurnActions key={item.key} group={item} t={t} liveElsewhere />;
          }
          if (item.kind === "answer") {
            // 020 FR-319: one line for a card's answer; the title is the agent's words, inert text.
            return (
              <p key={item.key} className="agent-conversation-answer" data-answer={item.answer}>
                <InlineCode text={t(`conversation.answered.${item.answer}`).replace("{title}", () => actionWords(item.title, t))} />
              </p>
            );
          }
          const { code, text } = item.notice;
          const own = noticeKey(code);
          // H3: the broker words its turn-stopped / turn-failed notices in English; the panel says
          // them in the owner's language and keeps only the failure's own detail.
          if (code === "turn-stopped") {
            return (
              <div key={item.key} className="agent-conversation-notice" data-notice-code={code}>
                <p>{t("conversation.state.stopped")}</p>
              </div>
            );
          }
          if (code === "turn-failed") {
            const detail = text.startsWith(TURN_FAILED_PREFIX) ? text.slice(TURN_FAILED_PREFIX.length) : text;
            return (
              <div key={item.key} className="agent-conversation-notice" data-notice-code={code}>
                <p>{t("conversation.notice.turn-failed")}</p>
                {detail === "" ? null : <p className="agent-conversation-detail">{detail}</p>}
              </div>
            );
          }
          // T607 (K1): the broker's crash notice is one title in the panel's language and, when it
          // names one, the exit code as a value - not the broker's English sentence again.
          const crash = code === "agent-exited" ? CRASH_NOTICE.exec(text) : null;
          if (crash !== null) {
            const exit = crash[1];
            return (
              <div key={item.key} className="agent-conversation-notice" data-notice-code={code}>
                <p>{t("conversation.error.agent-exited")}</p>
                {exit === undefined ? null : (
                  <p className="agent-conversation-detail">{t("conversation.notice.agent-exited.exit").replace("{code}", () => exit)}</p>
                )}
              </div>
            );
          }
          // T609: the broker's templates are said from the locale (or left out when they only repeat the title).
          const hint = modelUnreachableHint(props.agent, t);
          const words = text === "" ? undefined : isErrorCode(code) ? errorDetailWords(text, t) : noticeWords(code, text, t);
          return (
            <div key={item.key} className="agent-conversation-notice" data-notice-code={code}>
              {isErrorCode(code) ?<p>{t(`conversation.error.${code}`)}</p> : null}
              {own === undefined ? null : <p>{t(own)}</p>}
              {words === undefined ? null : <p className="agent-conversation-detail">{words}</p>}
              {code === "agent-model-unreachable" && hint !== undefined ? <p className="agent-conversation-detail">{hint}</p> : null}
            </div>
          );
        })}
        {showLive ? <LiveLine key="live" live={live} waitingFor={props.waitingFor} t={t} /> : null}
      </div>
      {away ? (
        <button type="button" className="agent-conversation-jump" onClick={jump}>
          <DownIcon />
          {t("conversation.jumpLatest")}
        </button>
      ) : null}
    </div>
  );
}
