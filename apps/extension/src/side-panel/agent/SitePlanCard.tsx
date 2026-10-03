import type { ReactElement, Ref } from "react";
import type { AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import type { SendCommand } from "./AgentShell.js";
import { displayOrigin } from "./display-origin.js";
import { SessionTitle } from "./SessionCard.js";

/**
 * The question a session's site-plan proposal raises (017 FR-251, FR-252, FR-260, R-247).
 *
 * One question about several sites at once. The card names the proposing session the way its session
 * card does, lists every proposed origin with a tick box (all ticked to begin with, so the owner
 * narrows rather than builds), and answers with the ticked subset or a decline. The agent's purpose
 * and steps are its own words and are shown as inert text, beside a warning that a page can steer an
 * agent into asking for more - the one fact the owner needs in order to untick anything.
 *
 * The panel cannot add a site and does not decide: it sends what is left ticked, and the worker
 * accepts only origins that were in the proposal (FR-253). Which boxes are ticked is panel-local
 * until Approve is pressed (held by the PromptCard), and keyed by the proposal so a second one never
 * inherits the first's.
 */
export function SitePlanCard(props: {
  sitePlan: NonNullable<AgentPanelState["sitePlan"]>;
  /** The proposing session as the projection has it; absent when the worker no longer lists it. */
  session: AgentPanelState["sessions"][number] | undefined;
  /** The name to fall back to when the session names itself nothing (the paired agent's). */
  agentName: string;
  locale: string;
  send: SendCommand;
  cardRef: Ref<HTMLElement>;
  /**
   * 017 follow-up: the unticked origins live in the PromptCard, which stays mounted when an earlier
   * question takes the slot and this card unmounts - so the owner's unticks survive the swap.
   */
  unticked: { proposalId: string; origins: string[] };
  setUnticked: (next: { proposalId: string; origins: string[] }) => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const { sitePlan, session, unticked, setUnticked } = props;
  const left = unticked.proposalId === sitePlan.proposalId ? unticked.origins : [];
  const ticked = sitePlan.origins.filter((origin) => !left.includes(origin));
  const approved = sitePlan.alreadyApproved ?? [];

  const answer = (approve: boolean): void => {
    props.send({
      type: "ui.agent.site-plan-decide",
      // A refusal runs nothing, so which boxes were ticked is not part of that answer.
      payload: { proposalId: sitePlan.proposalId, approve, origins: approve ? ticked : [] },
    });
    setUnticked({ proposalId: "", origins: [] });
  };

  return (
    <section
      ref={props.cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="agent-prompt-title"
      className="agent-prompt"
      data-prompt="site-plan"
    >
      <h2 id="agent-prompt-title">
        <SessionTitle
          agentName={session?.agentName ?? props.agentName}
          label={session?.label}
          startedAt={session?.startedAt}
          t={t}
        />
        <span className="agent-siteplan-question">{t("agent.sitePlan.title")}</span>
      </h2>
      <p>{t("agent.sitePlan.purpose").replace("{purpose}", () => sitePlan.purpose)}</p>
      {sitePlan.steps === undefined || sitePlan.steps.length === 0 ? null : (
        <>
          <p className="agent-siteplan-heading">{t("agent.sitePlan.stepsTitle")}</p>
          <ol className="agent-siteplan-steps">
            {sitePlan.steps.map((step, index) => (
              <li key={`${sitePlan.proposalId}-${index}`}>{step}</li>
            ))}
          </ol>
        </>
      )}
      <p className="agent-siteplan-heading">{t("agent.sitePlan.originsTitle")}</p>
      <ul className="agent-siteplan-origins">
        {sitePlan.origins.map((origin) => (
          <li key={origin} data-origin={origin}>
            <label>
              <input
                type="checkbox"
                checked={!left.includes(origin)}
                onChange={(event) => {
                  setUnticked({
                    proposalId: sitePlan.proposalId,
                    origins: event.target.checked ? left.filter((other) => other !== origin) : [...left, origin],
                  });
                }}
              />
              {/* An origin is the agent's word: inert text, never a link. */}
              <span className="agent-siteplan-origin">{displayOrigin(origin)}</span>
              {approved.includes(origin) ? (
                <span className="agent-siteplan-approved"> ({t("agent.sitePlan.alreadyApproved")})</span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
      <p className="agent-siteplan-warning">{t("agent.sitePlan.warning")}</p>
      <div className="agent-prompt-actions">
        <button type="button" className="agent-primary" disabled={ticked.length === 0} onClick={() => answer(true)}>
          {t("agent.sitePlan.approve")}
        </button>
        <button type="button" onClick={() => answer(false)}>
          {t("agent.sitePlan.decline")}
        </button>
      </div>
    </section>
  );
}
