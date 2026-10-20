import type { ReactElement, Ref } from "react";
import { BackIcon, ListIcon, NewIcon } from "./icons.js";

/**
 * 019 FR-286, US1 scenario 1; 020 US5, FR-321 (T598): the top of the Conversation tab.
 *
 * T605 (the planned layout): one compact row - the list button on the left, which opens the drawer
 * of conversations; the conversation's title in the middle with "agent · folder" under it; and on
 * the right the new-conversation button (FR-315) in an open conversation, or Back while a new one is
 * written over it. The buttons are icons whose names are words for assistive technology (and for a
 * hover). The mode is not repeated here: its chip in the message box carries it (FR-320). The folder
 * never changes (FR-303), so it is shown, never offered as a choice; a project path is the owner's
 * own and is shown as inert text.
 */
export function ConversationHeader(props: {
  t: (key: string) => string;
  /** The list button: the drawer gives the focus back to it on Escape. */
  listRef: Ref<HTMLButtonElement>;
  drawerOpen: boolean;
  drawerId: string;
  onList: () => void;
  /** Present while a conversation is open (FR-315: another agent or folder is a new conversation). */
  onNew?: () => void;
  /** Present while a new conversation is written over an open one. */
  onBack?: () => void;
  /** What the row names: the conversation's title, and the agent and folder it runs with. */
  details: { title: string; agentName: string; folder: string; /** T607 (A1): the whole path, the hover of a project folder's name. */ folderPath?: string };
}): ReactElement {
  const { t, details } = props;
  const listName = t("conversation.header.list");
  return (
    <section className="agent-conversation-header" aria-label={t("conversation.header.label")}>
      <button
        ref={props.listRef}
        type="button"
        className="agent-icon-button agent-conversation-list-button"
        title={listName}
        aria-haspopup="dialog"
        aria-expanded={props.drawerOpen}
        aria-controls={props.drawerOpen ? props.drawerId : undefined}
        onClick={props.onList}
      >
        <ListIcon />
        <span className="agent-sr-only">{listName}</span>
      </button>
      <div className="agent-conversation-heading">
        <span className="agent-conversation-title">{details.title}</span>
        <span className="agent-conversation-subtitle">
          <span className="agent-conversation-header-value">{details.agentName}</span>
          {" · "}
          <span className="agent-conversation-header-value agent-conversation-folder" title={details.folderPath}>
            {details.folder}
          </span>
        </span>
      </div>
      {props.onBack === undefined ? null : (
        <IconButton label={t("conversation.back")} onClick={props.onBack}>
          <BackIcon />
        </IconButton>
      )}
      {props.onNew === undefined ? null : (
        <IconButton label={t("conversation.new")} onClick={props.onNew}>
          <NewIcon />
        </IconButton>
      )}
    </section>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: ReactElement }): ReactElement {
  return (
    <button type="button" className="agent-icon-button" title={props.label} onClick={props.onClick}>
      {props.children}
      <span className="agent-sr-only">{props.label}</span>
    </button>
  );
}
