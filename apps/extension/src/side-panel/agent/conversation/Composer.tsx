import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { CONVERSATION_MESSAGE_MAX_CHARS } from "@hallpass/contracts";
import { DownIcon, SendIcon, StopIcon } from "./icons.js";

/**
 * 020 D-020-1, FR-312, FR-314, FR-315 (T588): the message box with the agent, folder and mode chips
 * under it - the same box for a conversation that has not started and for an open one. T602: the
 * chips share one row with Send and Stop, so the box takes as little of a short panel as it can.
 *
 * It decides nothing: the tab says whether the words can go (`sendable`), whether they are held
 * (`readOnly`, while a first-use card is up or the conversation is starting), and what the chips
 * are. Whatever must be read before sending - a first-use card, an agent's install guidance - comes
 * in `above`, so it sits directly over the box. Enter sends, Shift+Enter is a new line.
 *
 * T605 (the planned layout): the box and its row are one rounded card pinned at the bottom of the
 * tab. Send and Stop are icon buttons whose names are words; what a chip opened (`popup`) is drawn
 * over the conversation, upward from the card, and `below` is what stays in view under it.
 */

type T = (key: string) => string;

export function Composer(props: {
  t: T;
  /** The box's accessible name: "Message to {agent}". */
  label: string;
  draft: string;
  onDraft: (text: string) => void;
  sendable: boolean;
  onSend: () => void;
  readOnly?: boolean;
  /** T606 (P1): nothing can be written here at all (a conversation that cannot continue). */
  disabled?: boolean;
  /** T606: what the empty box says, when it is not its name (P1's "cannot continue"). */
  placeholder?: string;
  /** Focus the box when it appears, if nothing else holds the focus. */
  autoFocus?: boolean;
  /** A turn is under way: Stop is offered in Send's place (FR-285, T605). */
  busy?: boolean;
  onStop?: () => void;
  /**
   * 020 FR-319: a permission card waits in `above`. Nothing is sent from the box - Enter and submit
   * do nothing, the words stay - and Stop is the only button it offers.
   */
  waiting?: boolean;
  above?: ReactNode;
  chips: ReactNode;
  /** What a chip opened: the agent menu, the folder chooser, the mode choice - drawn above the box. */
  popup?: ReactNode;
  /** What stays in view under the box (FR-293's Codex note). */
  below?: ReactNode;
}): ReactElement {
  const { t } = props;
  const box = useRef<HTMLTextAreaElement>(null);
  const focusOnOpen = props.autoFocus === true;
  const waiting = props.waiting === true;
  useEffect(() => {
    // FR-312: the empty conversation opens ready to type - unless the owner's focus is somewhere
    // already (the tab bar while they arrow between tabs), which a box must not take away.
    if (!focusOnOpen) return;
    const holder = document.activeElement;
    if (holder === null || holder === document.body) box.current?.focus();
  }, [focusOnOpen]);
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (props.sendable && props.readOnly !== true && props.disabled !== true && !waiting) props.onSend();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };
  const sendName = t("conversation.composer.send");
  const stopName = t("conversation.stop");
  // T605: Stop takes Send's place while a turn is under way or a card waits - never both at once.
  const stoppable = (props.busy === true || waiting) && props.onStop !== undefined;
  return (
    <div className="agent-conversation-composer-area">
      {props.above}
      <form className="agent-conversation-composer" onSubmit={submit}>
        <textarea
          ref={box}
          aria-label={props.label}
          // T606 (A3): while a card waits, the box points at it; its name stays the same.
          placeholder={props.placeholder ?? (waiting ? t("conversation.composer.waiting") : props.label)}
          disabled={props.disabled === true}
          value={props.draft}
          maxLength={CONVERSATION_MESSAGE_MAX_CHARS}
          // T602: two lines to start; agent.css lets it grow with the words up to eight, then scroll.
          rows={2}
          readOnly={props.readOnly === true}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={onKey}
        />
        {/* T602: one row under the box - the chips (which may wrap) and, at its end, Send and Stop. */}
        <div className="agent-conversation-composer-row">
          <div role="group" aria-label={t("conversation.chips.label")} className="agent-conversation-chips">
            {props.chips}
          </div>
          <div className="agent-conversation-composer-actions">
            {waiting || stoppable ? null : (
              <button
                type="submit"
                className="agent-icon-button agent-conversation-send"
                title={sendName}
                disabled={!props.sendable || props.readOnly === true || props.disabled === true}
              >
                <SendIcon />
                <span className="agent-sr-only">{sendName}</span>
              </button>
            )}
            {stoppable ? (
              <button type="button" className="agent-icon-button agent-conversation-stop" title={stopName} onClick={props.onStop}>
                <StopIcon />
                <span className="agent-sr-only">{stopName}</span>
              </button>
            ) : null}
          </div>
        </div>
      </form>
      {props.popup === undefined || props.popup === null || props.popup === false ? null : (
        <div className="agent-conversation-popup" data-popup-frame="">
          {props.popup}
        </div>
      )}
      {props.below}
    </div>
  );
}

/** Which chip it is: T605 keeps the chips on one row, and the folder's gives way first. */
export type ChipKind = "agent" | "folder" | "mode";

/** A chip that opens something: the agent menu, the folder chooser, the mode choice. */
export function Chip(props: {
  kind: ChipKind;
  /** The accessible name, which says what the chip is as well as its value ("Agent: Codex"). */
  label: string;
  /** T607 (A1): the hover, when it says more than the name does (the folder chip's whole path). */
  title?: string;
  text: string;
  /**
   * T605: a short visible label (the mode chip). The full `text` stays in the chip as visually
   * hidden words, so its text and its name still carry the whole value.
   */
  short?: string;
  expanded: boolean;
  controls: string;
  popup?: "menu";
  onToggle: () => void;
  warn?: boolean;
  /** While the words are held for a start, the chips stay as they were sent. */
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}): ReactElement {
  return (
    <button
      ref={props.ref}
      type="button"
      disabled={props.disabled === true}
      className="agent-conversation-chip"
      data-chip={props.kind}
      // A shortened chip still shows its whole value on hover.
      title={props.title ?? props.label}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-haspopup={props.popup}
      aria-controls={props.expanded ? props.controls : undefined}
      data-warn={props.warn === true ? "" : undefined}
      onClick={props.onToggle}
    >
      {props.short === undefined ? (
        <span className="agent-conversation-chip-text">{props.text}</span>
      ) : (
        <>
          <span className="agent-conversation-chip-text agent-sr-only">{props.text}</span>
          <span className="agent-conversation-chip-short" aria-hidden="true">
            {props.short}
          </span>
        </>
      )}
      <DownIcon />
    </button>
  );
}

/** FR-315: agent and folder of an open conversation - shown, never offered as a choice. */
export function FixedChip(props: { kind: ChipKind; label: string; text: string; /** T607 (A1): the whole path behind a folder's name. */ full?: string; note: string }): ReactElement {
  return (
    <span className="agent-conversation-chip" data-chip={props.kind} data-fixed="" title={`${props.full ?? props.text}\n${props.note}`}>
      <span className="agent-sr-only">{props.label} </span>
      <span className="agent-conversation-chip-text">{props.text}</span>
    </span>
  );
}
