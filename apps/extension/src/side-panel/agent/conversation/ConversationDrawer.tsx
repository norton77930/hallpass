import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { CONVERSATION_LIST_NOTICES, type ConversationPanelState, type ConversationView } from "@hallpass/contracts";
import { groupByLastUse, shortLastUse, titleMatches } from "./conversation-groups.js";
import { AGENT_MARK } from "./agent-mark.js";
import { folderName } from "./folder-name.js";
import { CloseIcon } from "./icons.js";

/**
 * 020 US5, FR-321 (T598), folding in 019 US6, FR-304, T563's list: the owner's conversations in a
 * drawer over the open one.
 *
 * The list is the worker's projection of the broker's index (title, agent, folder, last use - never
 * content), so everything here is a view and every press is one command: open an entry, or remove
 * it from the list. Removing takes the entry off the list and nothing else; the copy says the
 * agent's own record stays, because that is the truth and the owner may well have a transcript they
 * care about in the agent itself. Entries are grouped Today / Last 7 days / Earlier by last use on
 * the owner's calendar and can be narrowed by part of their title.
 *
 * A modal dialog: the focus goes to the search when it opens, Tab stays inside it, and Escape, the
 * Close button or a press on the backdrop close it. Where the focus goes then is the tab's call.
 *
 * Titles and paths come from the owner's own sessions and are shown as inert text.
 */

type T = (key: string) => string;

/**
 * Why the list may look short, in the owner's words. Non-blocking: it sits beside the message box in
 * the empty conversation and at the top of the drawer, and stops nothing.
 */
export function ConversationListNotice(props: { notice?: ConversationPanelState["notice"]; t: T }): ReactElement | null {
  // Literal keys per notice, never a built one: the locale contract test scans for literal lookups.
  if (props.notice === undefined || !(CONVERSATION_LIST_NOTICES as readonly string[]).includes(props.notice)) return null;
  return (
    <p role="status" aria-label={props.t("conversation.list.label")} className="agent-conversation-notice">
      {props.t("conversation.list.notice.index-unreadable")}
    </p>
  );
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]";

export function ConversationDrawer(props: {
  id: string;
  conversations: readonly ConversationView[];
  notice?: ConversationPanelState["notice"];
  locale: string;
  t: T;
  agentName: (agent: ConversationView["agent"]) => string;
  /** T606 (C9): the conversation open behind the drawer, if one is. */
  current?: string | undefined;
  onChoose: (conversationId: string) => void;
  onRemove: (conversationId: string) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = props;
  const [query, setQuery] = useState("");
  const titleId = useId();
  const groupId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const now = new Date();
  const groups = groupByLastUse(
    props.conversations.filter((entry) => titleMatches(entry, query)),
    now,
  );

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // The drawer is modal: Tab and Shift+Tab go round inside it. Filtered from every element rather
    // than one grouped selector, so the order is the document's whatever the selector engine does.
    const inside = [...(dialog.current?.querySelectorAll<HTMLElement>("*") ?? [])].filter((element) => element.matches(FOCUSABLE));
    const first = inside[0];
    const last = inside.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="agent-conversation-drawer-backdrop"
      onPointerDown={(event) => {
        // A press beside the drawer closes it, as Escape does.
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialog}
        id={props.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="agent-conversation-drawer"
        onKeyDown={onKey}
      >
        <div className="agent-conversation-drawer-head">
          <h2 id={titleId}>{t("conversation.list.label")}</h2>
          <button type="button" className="agent-icon-button" title={t("conversation.drawer.close")} onClick={props.onClose}>
            <CloseIcon />
            <span className="agent-sr-only">{t("conversation.drawer.close")}</span>
          </button>
        </div>
        <input
          ref={search}
          type="search"
          className="agent-conversation-drawer-search"
          aria-label={t("conversation.drawer.search")}
          placeholder={t("conversation.drawer.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ConversationListNotice {...(props.notice === undefined ? {} : { notice: props.notice })} t={t} />
        {props.conversations.length === 0 ? (
          <p className="agent-conversation-detail">{t("conversation.drawer.empty")}</p>
        ) : groups.length === 0 ? (
          <p role="status" className="agent-conversation-detail">
            {t("conversation.drawer.noMatch").replace("{query}", () => query.trim())}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.group} className="agent-conversation-group">
              <h3 id={`${groupId}-${group.group}`}>{t(`conversation.group.${group.group}`)}</h3>
              <ul aria-labelledby={`${groupId}-${group.group}`} className="agent-conversation-entries">
                {group.entries.map((entry) => (
                  <li key={entry.conversationId} data-conversation-id={entry.conversationId}>
                    <button
                      type="button"
                      className="agent-conversation-entry"
                      // T606 (C9): the conversation open behind the drawer.
                      aria-current={entry.conversationId === props.current ? "true" : undefined}
                      onClick={() => props.onChoose(entry.conversationId)}
                    >
                      <span className="agent-conversation-agent-badge" aria-hidden="true">
                        {AGENT_MARK[entry.agent]}
                      </span>
                      {/* The badge, then one column: title, meta and any label - the row is one line wide. */}
                      <span className="agent-conversation-entry-text">
                        <span className="agent-conversation-entry-title">{entry.title}</span>
                        {/* T607 (G1): agent and folder give way (an ellipsis); the time is never cut. */}
                        <span className="agent-conversation-entry-meta">
                          <span className="agent-conversation-entry-where">
                            {props.agentName(entry.agent)} ·{" "}
                            <span
                              className="agent-conversation-folder"
                              title={entry.folder.kind === "project" ? entry.folder.path : undefined}
                            >
                              {entry.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(entry.folder.path)}
                            </span>
                          </span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={entry.lastUsedAt} className="agent-conversation-entry-time">
                            {shortLastUse(entry.lastUsedAt, now, props.locale)}
                          </time>
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
                      </span>
                    </button>
                    {/* T605: a muted icon button; its name stays the words, with the title. */}
                    <button
                      type="button"
                      className="agent-icon-button agent-conversation-entry-remove"
                      title={t("conversation.list.removeShort")}
                      onClick={() => props.onRemove(entry.conversationId)}
                    >
                      <CloseIcon size={14} />
                      <span className="agent-sr-only">{t("conversation.list.remove").replace("{title}", () => entry.title)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {props.conversations.length === 0 ? null : <p className="agent-conversation-detail">{t("conversation.list.removeNote")}</p>}
      </div>
    </div>
  );
}
