import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent, type ReactElement } from "react";
import type { ConversationModelEntry } from "@hallpass/contracts";
import { CheckIcon } from "./icons.js";
import type { ModelOfferView } from "./model-words.js";
import { useOutsidePress } from "./outside-press.js";

/**
 * 025 FR-398 - FR-400, D-025-9, R-407: what the model chip opens - the models the agent offers (its
 * default first, the current one checked) and, where it offers reasoning efforts, a divider and the
 * efforts as a row of choices. One popup for both, so a model and its effort are changed in one visit:
 * a choice is sent (or kept for the start) at once and the popup stays open.
 *
 * Two radiogroups of buttons. The arrows move the focus within a group and a press chooses, so a pass
 * over the list asks the agent for nothing; Tab goes from the models to the efforts; the checked one
 * has the focus when the menu opens. Escape closes it with the focus back on the chip, a press or a
 * Tab outside closes it where the press or the Tab put the focus. A name that does not fit is
 * ellipsised, with the whole name as the title and as the accessible name.
 *
 * `offer` is undefined when nothing is remembered for the agent (FR-400): the popup then has the one
 * choice, the agent's default, and says the list comes once the conversation starts.
 */

type T = (key: string) => string;

export function ModelMenu(props: {
  id: string;
  t: T;
  offer: ModelOfferView | undefined;
  /** The model value the agent is on (or will start on); `undefined` before anything is known. */
  model: string | undefined;
  effort: string | undefined;
  onChange: (change: { model: string } | { effort: string }) => void;
  /** Escape: the menu closes and the focus goes back to the chip. */
  onClose: () => void;
  /** A press or a Tab outside the menu closes it and leaves the focus where it went. */
  onDismiss: () => void;
}): ReactElement {
  const { t, offer } = props;
  const root = useRef<HTMLDivElement>(null);
  const modelTitle = useId();
  const effortTitle = useId();
  useOutsidePress(root, props.id, props.onDismiss);

  useEffect(() => {
    const menu = root.current;
    (menu?.querySelector<HTMLButtonElement>("[role=radio][aria-checked=true]") ?? menu?.querySelector<HTMLButtonElement>("[role=radio]"))?.focus();
  }, []);

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const group = (event.target as HTMLElement).closest<HTMLElement>("[role=radiogroup]");
    if (group === null) return;
    event.preventDefault();
    const all = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? all.length - 1
      : forward ? (at + 1) % all.length
      : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    // Tab (or Shift+Tab) to something outside: the menu is done. A blur to nothing is a press, which
    // the outside-press rule already treats; one to the chip that controls the menu is that chip's
    // own press (its click toggles the menu), so it is left alone.
    const next = event.relatedTarget;
    if (!(next instanceof Element) || root.current?.contains(next) === true) return;
    for (let at: Element | null = next; at !== null; at = at.parentElement) {
      if (at.getAttribute("aria-controls") === props.id) return;
    }
    props.onDismiss();
  };

  const models: readonly ConversationModelEntry[] = offer?.models ?? [{ value: "default", name: t("conversation.model.default") }];
  const efforts = offer?.efforts ?? [];
  // The checked model, or - nothing known, or a value the offer does not list - the first, so the group has one tab stop.
  const checkedModel = models.some((entry) => entry.value === props.model) ? props.model : offer === undefined ? "default" : undefined;
  const modelStop = checkedModel ?? models[0]?.value;
  const effortStop = efforts.some((entry) => entry.value === props.effort) ? props.effort : efforts[0]?.value;

  return (
    <div ref={root} id={props.id} className="agent-conversation-model" onKeyDown={onKey} onBlur={onBlur}>
      <div className="agent-conversation-model-section">
        <div id={modelTitle} className="agent-conversation-model-title">
          {t("conversation.model.label")}
        </div>
        <div role="radiogroup" aria-labelledby={modelTitle} className="agent-conversation-model-list">
          {models.map((entry) => (
            <ModelOption
              key={entry.value}
              entry={entry}
              checked={entry.value === checkedModel}
              tabStop={entry.value === modelStop}
              describedBy={`${props.id}-${models.indexOf(entry)}-description`}
              onChoose={() => {
                if (entry.value !== checkedModel) props.onChange({ model: entry.value });
              }}
            />
          ))}
        </div>
        {offer === undefined ? <p className="agent-conversation-model-hint">{t("conversation.model.noList")}</p> : null}
      </div>
      {efforts.length === 0 ? null : (
        <>
          <div className="agent-conversation-model-divider" data-model-divider="" role="presentation" />
          <div className="agent-conversation-model-section">
            <div id={effortTitle} className="agent-conversation-model-title">
              {t("conversation.model.effortLabel")}
            </div>
            <div role="radiogroup" aria-labelledby={effortTitle} className="agent-conversation-model-efforts">
              {efforts.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="radio"
                  aria-checked={entry.value === props.effort}
                  tabIndex={entry.value === effortStop ? 0 : -1}
                  data-value={entry.value}
                  title={entry.description === undefined ? entry.name : `${entry.name}\n${entry.description}`}
                  className="agent-conversation-model-pill"
                  onClick={() => {
                    if (entry.value !== props.effort) props.onChange({ effort: entry.value });
                  }}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ModelOption(props: {
  entry: ConversationModelEntry;
  checked: boolean;
  tabStop: boolean;
  describedBy: string;
  onChoose: () => void;
}): ReactElement {
  const { entry } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      aria-label={entry.name}
      aria-describedby={entry.description === undefined ? undefined : props.describedBy}
      tabIndex={props.tabStop ? 0 : -1}
      data-value={entry.value}
      title={entry.name}
      className="agent-conversation-model-option"
      onClick={props.onChoose}
    >
      <span className="agent-conversation-model-text">
        <span className="agent-conversation-model-name">{entry.name}</span>
        {entry.description === undefined ? null : (
          <span id={props.describedBy} className="agent-conversation-model-description">
            {entry.description}
          </span>
        )}
      </span>
      <span className="agent-conversation-model-check" aria-hidden="true">
        {props.checked ? <CheckIcon size={14} /> : null}
      </span>
    </button>
  );
}
