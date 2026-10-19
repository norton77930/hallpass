import type { ReactElement } from "react";
import { CONVERSATION_LIST_NOTICES, type ConversationPanelState, type ConversationView } from "@hallpass/contracts";

/**
 * 019 US6, FR-304, T563: the owner's recent conversations, newest use first.
 *
 * The list is the worker's projection of the broker's index (title, agent, folder, last use - never
 * content), so everything here is a view and every press is one command: open an entry, remove it
 * from the list, or ask for a new conversation in another folder. Removing takes the entry off the
 * list and nothing else; the copy says the agent's own record stays, because that is the truth and
 * the owner may well have a transcript they care about in the agent itself.
 *
 * Titles and paths come from the owner's own sessions and are shown as inert text.
 */

type T = (key: string) => string;

/** ISO strings sort as text; the tie-break keeps the order stable across projections. */
function newestFirst(conversations: readonly ConversationView[]): ConversationView[] {
  return [...conversations].sort(
    (left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt) || left.conversationId.localeCompare(right.conversationId),
  );
}

/** The last use in the owner's locale; a time the browser cannot read is shown as it came. */
function lastUse(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  } catch {
    return at.toLocaleString();
  }
}

export function ConversationList(props: {
  conversations: readonly ConversationView[];
  notice?: ConversationPanelState["notice"];
  locale: string;
  t: T;
  agentName: (agent: ConversationView["agent"]) => string;
  onOpen: (conversationId: string) => void;
  onRemove: (conversationId: string) => void;
  onNewInFolder: () => void;
  foldersOpen: boolean;
}): ReactElement | null {
  const { t } = props;
  const entries = newestFirst(props.conversations);
  // Literal keys per notice, never a built one: the locale contract test scans for literal lookups.
  const noticeText =
    props.notice === undefined || !(CONVERSATION_LIST_NOTICES as readonly string[]).includes(props.notice)
      ? undefined
      : t("conversation.list.notice.index-unreadable");
  if (entries.length === 0 && noticeText === undefined) {
    return (
      <div className="agent-conversation-list">
        <button type="button" aria-expanded={props.foldersOpen} onClick={props.onNewInFolder}>
          {t("conversation.list.newInFolder")}
        </button>
      </div>
    );
  }
  return (
    <div className="agent-conversation-list">
      {noticeText === undefined ? null : (
        // Non-blocking: the agents above stay usable; this only says why the list may look short.
        <p role="status" aria-label={t("conversation.list.label")} className="agent-conversation-notice">
          {noticeText}
        </p>
      )}
      {entries.length === 0 ? null : (
        <>
          <ul aria-label={t("conversation.list.label")} className="agent-conversation-entries">
            {entries.map((entry) => (
              <li key={entry.conversationId} data-conversation-id={entry.conversationId}>
                <button type="button" className="agent-conversation-entry" onClick={() => props.onOpen(entry.conversationId)}>
                  <span className="agent-conversation-entry-title">{entry.title}</span>
                  <span className="agent-conversation-entry-meta">
                    {props.agentName(entry.agent)} ·{" "}
                    <span className="agent-conversation-folder">
                      {entry.folder.kind === "scratch" ? t("conversation.folder.scratch") : entry.folder.path}
                    </span>{" "}
                    · <time dateTime={entry.lastUsedAt}>{lastUse(entry.lastUsedAt, props.locale)}</time>
                  </span>
                  {entry.resumable ? null : (
                    <span className="agent-conversation-entry-label" data-label="cannot-continue">
                      {t("conversation.list.cannotContinue")}
                    </span>
                  )}
                  {entry.inUseElsewhere === true ? (
                    <span className="agent-conversation-entry-label" data-label="in-use-elsewhere">
                      {t("conversation.list.inUseElsewhere")}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={t("conversation.list.remove").replace("{title}", () => entry.title)}
                  onClick={() => props.onRemove(entry.conversationId)}
                >
                  {t("conversation.list.removeShort")}
                </button>
              </li>
            ))}
          </ul>
          <p className="agent-conversation-detail">{t("conversation.list.removeNote")}</p>
        </>
      )}
      <button type="button" aria-expanded={props.foldersOpen} onClick={props.onNewInFolder}>
        {t("conversation.list.newInFolder")}
      </button>
    </div>
  );
}
