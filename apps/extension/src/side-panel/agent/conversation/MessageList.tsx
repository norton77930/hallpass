import type { ReactElement } from "react";
import { CONVERSATION_ERROR_CODES } from "@hallpass/contracts";
import { CONVERSATION_NOTICE_KEYS } from "../../agent-panel-keys.js";
import { ActionList } from "./ActionList.js";
import type { TimelineItem } from "./conversation-log.js";

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
 */
export function MessageList(props: {
  timeline: readonly TimelineItem[];
  agentName: string;
  t: (key: string) => string;
}): ReactElement {
  const { t } = props;
  return (
    <div role="log" aria-live="polite" aria-label={t("conversation.messages.label")} className="agent-conversation-log">
      {props.timeline.map((item) => {
        if (item.kind === "text") {
          return (
            <div key={item.key} className="agent-conversation-message" data-message-role={item.role}>
              <span className="agent-conversation-who">
                {item.role === "owner" ? t("conversation.role.owner") : props.agentName}
              </span>
              <p>{item.text}</p>
            </div>
          );
        }
        if (item.kind === "actions") {
          return <ActionList key={item.key} actions={item.actions} t={t} />;
        }
        const { code, text } = item.notice;
        const own = noticeKey(code);
        return (
          <div key={item.key} className="agent-conversation-notice" data-notice-code={code}>
            {isErrorCode(code) ? <p>{t(`conversation.error.${code}`)}</p> : null}
            {own === undefined ? null : <p>{t(own)}</p>}
            {text === "" ? null : <p className="agent-conversation-detail">{text}</p>}
          </div>
        );
      })}
    </div>
  );
}
