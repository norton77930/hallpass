import { useId, type ReactElement } from "react";
import type { ConversationAgent, ConversationAgentAvailability, ConversationInstallPhase } from "@hallpass/contracts";
import { availabilityDetail } from "./broker-words.js";

/**
 * 019 US3, FR-299 - FR-302, D-019-5, D-019-7, R-314: what the owner sees before an agent's first
 * conversation from the panel.
 *
 * Nothing leaves the panel until the owner presses Download (or Allow, for an agent whose connector
 * is already there): the card says what is fetched, about how big, that fetching it is a request to
 * the npm registry the owner's own npm uses, that the agent runs with the owner's own settings, and
 * that it will use this browser under the site rules - the one-time consent. Cancel sends nothing.
 * Hallpass never asks for the agent's sign-in (FR-302); the guidance below points at the agent's
 * own setup.
 */

type T = (key: string) => string;

export function FirstUseCard(props: {
  agentName: string;
  /**
   * 021: the agent, for the two whose words differ - DeepSeek is fetched by Hallpass itself, and
   * Hermes and DeepSeek read their own settings (never a key from Hallpass, FR-355).
   */
  agent?: ConversationAgent;
  /** The `conversation.size.*` key's words; absent when there is nothing to download. */
  size?: string;
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
      {props.size === undefined ? null : (
        <>
          <p>{fill(own === "deepseek" ? "conversation.firstUse.what.deepseek" : "conversation.firstUse.what")}</p>
          <p>{t("conversation.firstUse.size").replace("{size}", () => props.size ?? "")}</p>
          <p>{t("conversation.firstUse.registry")}</p>
        </>
      )}
      {props.notes?.includes("pre-release") === true ? <p>{t("conversation.note.pre-release")}</p> : null}
      <p>{fill(own === undefined ? "conversation.firstUse.settings" : `conversation.firstUse.settings.${own}`)}</p>
      <p>{t("conversation.firstUse.browser")}</p>
      <div className="agent-prompt-actions">
        <button type="button" className="agent-primary" onClick={props.onAccept}>
          {t(props.size === undefined ? "conversation.firstUse.allow" : "conversation.firstUse.download")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t("conversation.firstUse.cancel")}
        </button>
      </div>
    </section>
  );
}

/**
 * FR-301, US3 scenarios 3 and 4: an agent that is not installed, or whose version does not fit.
 * 020 FR-313: shown above the message box while that agent is on the chip, and Send stays off.
 */
export function AgentProblemCard(props: {
  agent: ConversationAgentAvailability;
  agentName: string;
  t: T;
}): ReactElement {
  const { t, agent } = props;
  const titleId = useId();
  const fill = (key: string): string => t(key).replace(/\{agent\}/g, () => props.agentName);
  const missing = agent.availability === "missing";
  return (
    <section aria-labelledby={titleId} className="agent-page agent-conversation-setup" data-setup={agent.availability}>
      <h2 id={titleId}>{fill(missing ? "conversation.missing.title" : "conversation.version.title")}</h2>
      <p>{fill(missing ? (agent.agent === "hermes" ? "conversation.missing.body.hermes" : "conversation.missing.body") : "conversation.version.body")}</p>
      {missing ? <p>{t(`conversation.missing.${agent.agent}`)}</p> : null}
      {!missing && agent.version !== undefined ? (
        <p>{t("conversation.version.installed").replace("{version}", () => agent.version ?? "")}</p>
      ) : null}
      {/* Already redacted by the broker (R-326); T608: its known sentence is said in the panel's language. */}
      {agent.detail === undefined ? null : (
        <p className="agent-conversation-detail">{availabilityDetail(agent.detail, props.agentName, t)}</p>
      )}
    </section>
  );
}

/**
 * R-314: the install's phase, as an indeterminate bar with the expected size - npm's own byte count
 * is not a number the panel is sent. On failure, why, and Retry (FR-300: nothing partial is used).
 */
export function InstallProgress(props: {
  phase: ConversationInstallPhase;
  size: string;
  failure?: string;
  t: T;
  onRetry: () => void;
  onCancel: () => void;
}): ReactElement {
  const { t } = props;
  if (props.failure !== undefined) {
    return (
      <section className="agent-page agent-conversation-setup" data-setup="install-failed" aria-label={t("conversation.install.label")}>
        <p>{t("conversation.install.failed")}</p>
        {/* T608 (L3): the broker's redacted log is for whoever is asked for it - folded, as on the session cards. */}
        <details className="agent-details">
          <summary>{t("agent.details.title")}</summary>
          <p className="agent-conversation-detail">{props.failure}</p>
        </details>
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={props.onRetry}>
            {t("conversation.install.retry")}
          </button>
          <button type="button" onClick={props.onCancel}>
            {t("conversation.firstUse.cancel")}
          </button>
        </div>
      </section>
    );
  }
  const words =
    props.phase === "downloading"
      ? t("conversation.install.downloading").replace("{size}", () => props.size)
      : t(`conversation.install.${props.phase}`);
  return (
    <section className="agent-page agent-conversation-setup" data-setup="installing">
      <div role="progressbar" aria-label={t("conversation.install.label")} aria-valuetext={words} className="agent-conversation-progress" />
      <p role="status">{words}</p>
    </section>
  );
}
