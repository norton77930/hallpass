import { useId, type ReactElement } from "react";
import { CONVERSATION_MODES, type ConversationAgent, type ConversationMode } from "@hallpass/contracts";

/**
 * 019 FR-292, D-019-2: the two modes and nothing else. The choices are the contract's own list, so
 * no mode the panel could name approves every action without asking (SC-140). The selection is the
 * mode the broker last reported; a press only asks for the switch.
 *
 * FR-293: Codex in strict mode still edits inside its folder without asking, and the owner is told.
 */
export function ModeSwitch(props: {
  agent: ConversationAgent;
  mode: ConversationMode;
  t: (key: string) => string;
  onChange: (mode: ConversationMode) => void;
}): ReactElement {
  const { t } = props;
  const name = useId();
  const labelId = useId();
  return (
    <div className="agent-conversation-mode">
      <span id={labelId} className="agent-conversation-mode-label">
        {t("conversation.mode.label")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId}>
        {CONVERSATION_MODES.map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name={name}
              value={mode}
              checked={props.mode === mode}
              onChange={() => {
                if (mode !== props.mode) props.onChange(mode);
              }}
            />
            {t(`conversation.mode.${mode}`)}
          </label>
        ))}
      </div>
      {props.agent === "codex" && props.mode === "strict" ? (
        <p className="agent-conversation-note">{t("conversation.mode.codexStrictNote")}</p>
      ) : null}
    </div>
  );
}
