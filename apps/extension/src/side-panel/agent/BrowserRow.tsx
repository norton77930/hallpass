import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { AGENT_BROWSER_NAME_MAX_CHARS, type AgentPanelState } from "@hallpass/contracts";
import { normalizeBrowserName } from "../../browser-name.js";
import { lookup } from "../../locales/catalog.js";

/**
 * "This browser" (018 FR-268, FR-279): which browser this panel belongs to, a rename, and - when
 * other browsers are connected - how many, with nothing else about them (no tabs, sites or names).
 *
 * The rename is inline: Rename turns the name into a text field that takes focus; Enter (or Save)
 * sends one `ui.agent.browser-rename`, Escape (or Cancel) puts the name back and returns focus to
 * Rename. The field is stripped and trimmed here only so an empty name can be refused in place; the
 * worker does the same again before storing, and the next projection carries the name it kept.
 * Whether the field is open and what is typed in it is UI state (R-125); it decides nothing.
 */
export function BrowserRow(props: {
  browser: NonNullable<AgentPanelState["browser"]>;
  locale: string;
  onRename: (name: string) => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  /** Focus goes back to Rename only after an edit the owner ended, never on first render. */
  const returnFocus = useRef(false);
  const errorId = useId();
  const { name, others } = props.browser;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      renameRef.current?.focus();
    }
  }, [editing]);

  const close = (): void => {
    returnFocus.current = true;
    setEditing(false);
    setInvalid(false);
  };

  const save = (): void => {
    const next = normalizeBrowserName(draft);
    if (next === undefined) {
      setInvalid(true);
      return;
    }
    if (next !== name) props.onRename(next);
    close();
  };

  return (
    <div className="agent-browser" data-browser-row="">
      {editing ? (
        <form
          className="agent-browser-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            className="agent-browser-input"
            aria-label={t("agent.browser.nameLabel")}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            maxLength={AGENT_BROWSER_NAME_MAX_CHARS}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <button type="submit">{t("agent.browser.save")}</button>
          <button type="button" onClick={close}>
            {t("agent.browser.cancel")}
          </button>
          {invalid ? (
            <p id={errorId} role="alert" className="agent-browser-error">
              {t("agent.browser.nameInvalid")}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="agent-browser-line">
          {/* The name is the owner's own text: rendered as text, never as markup. */}
          <span className="agent-browser-name">{t("agent.browser.this").replace("{name}", () => name)}</span>
          <button
            ref={renameRef}
            type="button"
            aria-label={t("agent.browser.renameLabel")}
            onClick={() => {
              setDraft(name);
              setInvalid(false);
              setEditing(true);
            }}
          >
            {t("agent.browser.rename")}
          </button>
        </div>
      )}
      {others > 0 ? (
        <p className="agent-browser-others" data-browser-others="">
          {others === 1 ? t("agent.browser.othersOne") : t("agent.browser.others").replace("{n}", String(others))}
        </p>
      ) : null}
    </div>
  );
}
