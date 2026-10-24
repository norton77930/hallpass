import { useId, type ReactElement } from "react";
import type { ConversationAgent, ConversationAgentAvailability } from "@hallpass/contracts";
import { notReadyReason } from "./not-ready.js";

/**
 * 019 US3, FR-299, FR-302, D-019-5, D-019-7: what the owner sees before an agent's first conversation
 * from the panel.
 *
 * 024 FR-384, D-024-2, D-024-3: a download is no longer started from a conversation - an agent that
 * still needs one is "not ready" (`NotReadyCard`) and its card on the settings page has the Download.
 * What is left here is the one-time consent for an agent that is ready: nothing leaves the panel until
 * the owner presses Allow; the card says that the agent runs with the owner's own settings and that it
 * will use this browser under the site rules. Cancel sends nothing. Hallpass never asks for the agent's
 * sign-in (FR-302); the guidance below points at the agent's own setup.
 */

type T = (key: string) => string;

export function FirstUseCard(props: {
  agentName: string;
  /**
   * 021: the agent, for the two whose words differ - Hermes and DeepSeek read their own settings
   * (never a key from Hallpass, FR-355).
   */
  agent?: ConversationAgent;
  /** 021 FR-350: the worker's notes on the agent (`pre-release`). */
  notes?: ConversationAgentAvailability["notes"];
  t: T;
  onAccept: () => void;
  onCancel: () => void;
}): ReactElement {
  const { t } = props;
  const titleId = useId();
  const fill = (key: string): string => t(key).replace("{agent}", () => props.agentName);
  const own = props.agent === "hermes" || props.agent === "deepseek" ? props.agent : undefined;
  return (
    <section aria-labelledby={titleId} className="agent-page agent-conversation-setup" data-setup="first-use">
      <h2 id={titleId}>{fill("conversation.firstUse.title")}</h2>
      {props.notes?.includes("pre-release") === true ? <p>{t("conversation.note.pre-release")}</p> : null}
      <p>{fill(own === undefined ? "conversation.firstUse.settings" : `conversation.firstUse.settings.${own}`)}</p>
      <p>{t("conversation.firstUse.browser")}</p>
      <div className="agent-prompt-actions">
        <button type="button" className="agent-primary" onClick={props.onAccept}>
          {t("conversation.firstUse.allow")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t("conversation.firstUse.cancel")}
        </button>
      </div>
    </section>
  );
}

/**
 * 024 FR-384, D-024-3: the agent on the chip cannot start a conversation - one line saying why and the
 * link that opens the settings page at its card (`#agents/<agent>`; `#agents` when no agent is enabled
 * at all). It sits above the message box while that agent is on the chip, and Send stays off. No
 * download, install or retry is offered here.
 */
export function NotReadyCard(props: {
  /** The worker's entry for the agent on the chip; absent until the worker has reported it. */
  entry: ConversationAgentAvailability | undefined;
  agentName: string;
  t: T;
  onOpenSettings: () => void;
}): ReactElement {
  const { t } = props;
  // An agent that is ready but not enabled (nothing is enabled) has no state to report: the general line.
  const reason = notReadyReason(props.entry, props.agentName, t) ?? notReadyReason(undefined, props.agentName, t);
  const reasonId = useId();
  return (
    <section className="agent-page agent-conversation-setup" data-setup="not-ready" aria-labelledby={reasonId}>
      <p id={reasonId}>{reason}</p>
      <div className="agent-prompt-actions">
        <button type="button" onClick={props.onOpenSettings}>
          {t("conversation.agentMenu.openSettings")}
        </button>
      </div>
    </section>
  );
}
