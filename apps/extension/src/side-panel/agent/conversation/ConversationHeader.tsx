import { useEffect, useId, useRef, useState, type ReactElement, type Ref } from "react";
import { BackIcon, ListIcon, NewIcon, OutputIcon } from "./icons.js";

/** 023 FR-372: how long "Agent output" says Loading… for a reply that may never come. */
const OUTPUT_WAIT_MS = 10_000;

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
  /**
   * 023 T728 (D-023-8, FR-372): "Agent output" in an open conversation's details. `lines` are the last
   * reply to `onRequest` (undefined until one came); the request is made only when the owner presses.
   */
  output?: { lines: readonly string[] | undefined; onRequest: () => void };
}): ReactElement {
  const { t, details } = props;
  const listName = t("conversation.header.list");
  const outputName = t("conversation.output.button");
  const output = props.output;
  const [outputOpen, setOutputOpen] = useState(false);
  /** The reply this opening is waiting for: the lines it started from, until another set arrives. */
  const [waitingFrom, setWaitingFrom] = useState<{ lines: readonly string[] | undefined } | undefined>(undefined);
  const outputId = useId();
  const outputButton = useRef<HTMLButtonElement>(null);
  const requestOutput = (): void => {
    if (output === undefined) return;
    setWaitingFrom({ lines: output.lines });
    output.onRequest();
  };
  // A refused request, or output wiped by a restart, sends no reply: the wait is bounded, then the
  // block says what it has (none yet, or the older lines).
  useEffect(() => {
    if (waitingFrom === undefined) return;
    const timer = setTimeout(() => setWaitingFrom(undefined), OUTPUT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waitingFrom]);
  const waiting = waitingFrom !== undefined && output?.lines === waitingFrom.lines;
  return (
    <>
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
        {output === undefined ? null : (
          <button
            ref={outputButton}
            type="button"
            className="agent-icon-button"
            title={outputName}
            aria-expanded={outputOpen}
            aria-controls={outputOpen ? outputId : undefined}
            onClick={() => {
              if (!outputOpen) requestOutput();
              setOutputOpen(!outputOpen);
            }}
          >
            <OutputIcon />
            <span className="agent-sr-only">{outputName}</span>
          </button>
        )}
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
      {output === undefined || !outputOpen ? null : (
        // 023 D-023-8, FR-372: what the agent printed about itself, on request, as inert text. Escape
        // closes it and gives the focus back to the button; the block itself is a tab stop, so the
        // keyboard can scroll it.
        <section
          id={outputId}
          className="agent-conversation-output-panel"
          aria-label={t("conversation.output.title")}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOutputOpen(false);
            outputButton.current?.focus();
          }}
        >
          <p className="agent-conversation-detail">{t("conversation.output.note")}</p>
          {waiting ? (
            <p className="agent-conversation-detail" role="status">
              {t("conversation.output.loading")}
            </p>
          ) : output.lines === undefined || output.lines.length === 0 ? (
            <p className="agent-conversation-detail">{t("conversation.output.empty")}</p>
          ) : (
            <pre className="agent-conversation-output" data-agent-output="" tabIndex={0} aria-label={t("conversation.output.title")}>
              {output.lines.join("\n")}
            </pre>
          )}
          <button type="button" className="agent-conversation-output-refresh" onClick={requestOutput}>
            {t("conversation.output.refresh")}
          </button>
        </section>
      )}
    </>
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
