import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useExclusiveMenu } from "../exclusive-menu.js";
import { PlusIcon } from "../icons.js";
import { useOutsidePress } from "../outside-press.js";

/**
 * 022 FR-325, FR-334, FR-341: the composer's "+" - a menu button whose menu offers "Add images or
 * files…" (the hidden picker, several files at once), "Screenshot of this tab" and "Attach this
 * tab", with the limits as a hint line under them.
 *
 * An entry that cannot be used here stays in the menu, focusable and marked `aria-disabled`, with
 * the reason under its name (no tab in this window, the agent takes no pictures or no page
 * context). Arrow keys move between the entries, Escape (or Tab) closes the menu with the focus back
 * on "+", and a press anywhere else closes it where the press was.
 */

type T = (key: string) => string;

export type AttachEntry = { disabledReason?: string; onChoose: () => void };

export function AttachMenu(props: {
  t: T;
  /** While the words are held or on their way, nothing can be added. */
  disabled?: boolean;
  /** The picked files, as `File`s. */
  onFiles: (files: File[]) => void;
  screenshot: AttachEntry;
  tab: AttachEntry;
}): ReactElement {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const hintId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const items = (): HTMLButtonElement[] => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];

  useOutsidePress(menu, menuId, () => setOpen(false));
  useExclusiveMenu(menuId, open, () => setOpen(false));
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = (entry: AttachEntry | undefined): void => {
    if (entry?.disabledReason !== undefined) return;
    close();
    if (entry === undefined) input.current?.click();
    else entry.onChoose();
  };
  const onKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? all.length - 1
      : event.key === "ArrowDown" ? (at + 1) % all.length
      : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  const item = (key: string, entry: AttachEntry | undefined): ReactElement => {
    const reason = entry?.disabledReason;
    return (
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="agent-conversation-menu-item agent-conversation-attach-item"
          aria-disabled={reason === undefined ? undefined : true}
          onClick={() => choose(entry)}
        >
          <span className="agent-conversation-menu-text">
            <span>{t(key)}</span>
            {reason === undefined ? null : <span className="agent-conversation-menu-note">{reason}</span>}
          </span>
        </button>
      </li>
    );
  };

  const name = t("conversation.attach.button");
  return (
    <>
      <button
        ref={button}
        type="button"
        className="agent-icon-button agent-conversation-attach"
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={props.disabled === true}
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon />
      </button>
      {/*
        The browser's file picker, opened by "Add images or files…" only. It is no control of the
        panel's (never shown, never focused), so it lives outside the panel's controls, in the body.
      */}
      {createPortal(
        <input
          ref={input}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-attach-input=""
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // The same file picked again must fire again.
            event.target.value = "";
            if (files.length > 0) props.onFiles(files);
          }}
        />,
        document.body,
      )}
      {open ? (
        <div className="agent-conversation-popup agent-conversation-attach-popup" data-popup-frame="">
          <ul
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={t("conversation.attach.menu")}
            aria-describedby={hintId}
            className="agent-conversation-menu"
            onKeyDown={onKey}
          >
            {item("conversation.attach.files", undefined)}
            {item("conversation.attach.screenshot", props.screenshot)}
            {item("conversation.attach.tab", props.tab)}
          </ul>
          {/* D-022-8: the limits, under the entries (the menu's description). */}
          <p id={hintId} className="agent-conversation-attach-hint">
            {t("conversation.attach.hint")}
          </p>
        </div>
      ) : null}
    </>
  );
}
