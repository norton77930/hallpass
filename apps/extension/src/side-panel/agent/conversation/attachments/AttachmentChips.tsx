import type { ReactElement } from "react";
import type { ConversationAttachmentSummary } from "@hallpass/contracts";
import { CloseIcon, FileIcon, ImageIcon, TabIcon } from "../icons.js";
import { formatSize, refusalWords, type DraftAttachment, type Refusal } from "./model.js";

/**
 * 022 FR-335, FR-338, FR-341: attachments as chips - above the words inside the composer card (with
 * a remove button named for the attachment, and their preparing / ready / refused state), and in
 * the owner's bubble once sent (thumbnails for pictures, name chips for files and the tab).
 *
 * Every name is inert text. A thumbnail is the panel's own JPEG (or the broker's copy of it), shown
 * from a `data:` address; the bubble's `alt` is the picture's name.
 */

type T = (key: string) => string;

const thumbnailSrc = (thumbnail: string): string => `data:image/jpeg;base64,${thumbnail}`;

function KindMark(props: { kind: DraftAttachment["kind"]; thumbnail?: string | undefined }): ReactElement {
  if (props.kind === "image" && props.thumbnail !== undefined) {
    return <img className="agent-attachment-thumb" src={thumbnailSrc(props.thumbnail)} alt="" />;
  }
  return (
    <span className="agent-attachment-icon" aria-hidden="true">
      {props.kind === "image" ? <ImageIcon /> : props.kind === "tab" ? <TabIcon /> : <FileIcon />}
    </span>
  );
}

/** "cut": the tab's text was shortened to 50 000 characters (FR-330). */
function CutMark(props: { t: T }): ReactElement {
  return (
    <span className="agent-attachment-cut" data-cut="" title={props.t("conversation.attachment.cutLong")}>
      {props.t("conversation.attachment.cut")}
    </span>
  );
}

/** The composer's chips, above the words. */
export function ComposerAttachments(props: {
  attachments: readonly DraftAttachment[];
  t: T;
  /** While the message is held or on its way, chips cannot be removed. */
  locked?: boolean;
  onRemove: (localId: string) => void;
}): ReactElement | null {
  const { t } = props;
  if (props.attachments.length === 0) return null;
  return (
    <ul className="agent-attachments" data-attachments="" aria-label={t("conversation.attachments.label")}>
      {props.attachments.map((attachment) => {
        const kindWord = t(`conversation.attachment.kind.${attachment.kind}`);
        return (
          <li
            key={attachment.localId}
            className="agent-attachment"
            data-attachment-kind={attachment.kind}
            data-attachment-state={attachment.state}
            title={attachment.tab?.url ?? attachment.name}
          >
            <KindMark kind={attachment.kind} thumbnail={attachment.thumbnail} />
            <span className="agent-attachment-text">
              <span className="agent-sr-only">{kindWord}: </span>
              <span className="agent-attachment-name">{attachment.name}</span>
              <span className="agent-attachment-meta">
                {attachment.state === "preparing"
                  ? t("conversation.attachment.preparing")
                  : attachment.state === "refused" && attachment.refusal !== undefined
                    ? refusalWords(attachment.refusal, t).join(" ")
                    : formatSize(attachment.size)}
                {attachment.tab?.cut === true ? <CutMark t={t} /> : null}
              </span>
            </span>
            <button
              type="button"
              className="agent-icon-button agent-attachment-remove"
              aria-label={t("conversation.attachment.remove").replace("{name}", () => attachment.name)}
              title={t("conversation.attachment.remove").replace("{name}", () => attachment.name)}
              disabled={props.locked === true}
              onClick={() => props.onRemove(attachment.localId)}
            >
              <CloseIcon size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The last refusal, announced as a status - the same pattern as the tab's error notice. */
export function AttachRefusal(props: { refusal: Refusal | undefined; t: T }): ReactElement | null {
  if (props.refusal === undefined) return null;
  return (
    <div className="agent-attach-refusal" role="status" data-attach-refusal="">
      {refusalWords(props.refusal, props.t).map((words) => (
        <p key={words}>{words}</p>
      ))}
    </div>
  );
}

/** The owner's bubble: what the message carried (R-343). */
export function SentAttachments(props: { attachments: readonly ConversationAttachmentSummary[]; t: T }): ReactElement {
  const { t } = props;
  return (
    <ul className="agent-attachments agent-attachments-sent" aria-label={t("conversation.attachments.label")}>
      {props.attachments.map((attachment, index) => {
        if (attachment.kind === "image" && attachment.thumbnail !== undefined) {
          return (
            <li key={index} className="agent-attachment-picture" data-attachment-kind="image">
              <img src={thumbnailSrc(attachment.thumbnail)} alt={attachment.name} title={attachment.name} />
            </li>
          );
        }
        return (
          <li
            key={index}
            className="agent-attachment"
            data-attachment-kind={attachment.kind}
            title={attachment.path ?? attachment.name}
          >
            <KindMark kind={attachment.kind} />
            <span className="agent-attachment-text">
              <span className="agent-sr-only">{t(`conversation.attachment.kind.${attachment.kind}`)}: </span>
              <span className="agent-attachment-name">{attachment.name}</span>
              {attachment.cut === true ? (
                <span className="agent-attachment-meta">
                  <CutMark t={t} />
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
