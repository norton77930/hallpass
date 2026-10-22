import { useEffect, useId, useRef, type KeyboardEvent, type ReactElement } from "react";
import { CONVERSATION_MODES, type ConversationAgent, type ConversationMode } from "@hallpass/contracts";
import { useOutsidePress } from "./outside-press.js";

/**
 * 020 T597, FR-320 (was 019's ModeSwitch): what the mode chip opens - the two modes and nothing
 * else, each explained.
 *
 * 019 FR-292, D-019-2: the choices are the contract's own list, so no mode the panel could name
 * approves every action without asking (SC-140). The selection is the mode the broker last reported
 * (or, before a conversation starts, the chip's); a choice only asks for the switch. FR-293: for
 * Codex the strict choice carries the note that Codex works read-only and asks, and what its own
 * rules still allow. The agent's own review wears the warning colour while it is on (D-020-6).
 *
 * Native radios, so arrows move the choice; the chosen one has the focus when the menu opens, and
 * Escape closes it with the focus back on the chip.
 */
export function ModeMenu(props: {
  id: string;
  agent: ConversationAgent;
  /** The agent's name in the panel's language, for the restart note. */
  agentName: string;
  mode: ConversationMode;
  t: (key: string) => string;
  onChange: (mode: ConversationMode) => void;
  onClose: () => void;
  /** T600: a press outside the menu closes it and leaves the focus where the press put it. */
  onDismiss: () => void;
}): ReactElement {
  const { t } = props;
  const name = useId();
  const explainId = useId();
  const restartId = useId();
  // 021 D-021-8: Hermes takes its mode at launch, so changing it restarts the agent. DeepSeek's mode is
  // fixed once its conversation started (D-021-16): its menu is only ever offered before the start.
  const restarts = props.agent === "hermes";
  const root = useRef<HTMLDivElement>(null);
  useOutsidePress(root, props.id, props.onDismiss);

  useEffect(() => {
    root.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  }, []);

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.onClose();
  };

  return (
    <div ref={root} id={props.id} className="agent-conversation-mode" onKeyDown={onKey}>
      <div role="radiogroup" aria-label={t("conversation.mode.label")}>
        {CONVERSATION_MODES.map((mode) => {
          const explained = `${explainId}-${mode}`;
          const codexNote = mode === "strict" && props.agent === "codex";
          // 021 D-021-5: Hermes has no folder boundary for commands once it runs without asking first.
          const hermesNote = mode === "agent-review" && props.agent === "hermes";
          const described = [explained, ...(codexNote ? [`${explained}-codex`] : []), ...(hermesNote ? [`${explained}-hermes`] : []), ...(restarts ? [restartId] : [])];
          return (
            <div
              key={mode}
              className="agent-conversation-mode-option"
              data-mode={mode}
              data-warn={mode === "agent-review" && props.mode === mode ? "" : undefined}
            >
              <label>
                <input
                  type="radio"
                  name={name}
                  value={mode}
                  checked={props.mode === mode}
                  aria-describedby={described.join(" ")}
                  onChange={() => {
                    if (mode !== props.mode) props.onChange(mode);
                  }}
                />
                {t(`conversation.mode.${mode}`)}
              </label>
              <p id={explained} className="agent-conversation-mode-explain">
                {t(`conversation.mode.explain.${mode}`)}
              </p>
              {codexNote ? (
                <p id={`${explained}-codex`} className="agent-conversation-note">
                  {t("conversation.mode.codexStrictNote")}
                </p>
              ) : null}
              {hermesNote ? (
                <p id={`${explained}-hermes`} className="agent-conversation-note">
                  {t("conversation.mode.hermesAutomaticNote")}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {restarts ? (
        <p id={restartId} className="agent-conversation-note">
          {t("conversation.mode.restartNote").replace("{agent}", () => props.agentName)}
        </p>
      ) : null}
    </div>
  );
}
