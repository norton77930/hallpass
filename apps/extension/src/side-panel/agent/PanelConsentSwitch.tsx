import { useId, type ReactElement } from "react";
import type { ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import type { SendCommand } from "./AgentShell.js";

/**
 * 019 FR-309, D-019-11, T555: the one-time consent "Side-panel agent may use this browser", where
 * the owner can see it and take it back.
 *
 * Given on the first-use card; here it is a switch. Turning it off is a withdrawal: the worker tears
 * every panel session down the way an unpair does and refuses their next call, and the next panel
 * conversation asks again. It touches no external agent - those are the status row's. The switch
 * shows what the worker last projected; a press only asks.
 */
export function PanelConsentSwitch(props: {
  consent: ConversationPanelState["consent"];
  locale: string;
  send: SendCommand;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const noteId = useId();
  const granted = props.consent === "granted";
  const note =
    props.consent === "granted"
      ? "agent.panelConsent.granted"
      : props.consent === "withdrawn"
        ? "agent.panelConsent.withdrawn"
        : "agent.panelConsent.unknown";
  return (
    <section className="agent-panel-consent" data-consent={props.consent}>
      <label className="agent-panel-consent-switch">
        <input
          type="checkbox"
          role="switch"
          checked={granted}
          aria-describedby={noteId}
          onChange={() => {
            props.send({ type: "ui.conversation.consent", payload: { granted: !granted } });
          }}
        />
        {t("agent.panelConsent.label")}
      </label>
      <p id={noteId} className="agent-panel-consent-note">
        {t(note)}
      </p>
    </section>
  );
}
