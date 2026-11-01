import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentSkillLocation, AgentSkillState } from "@hallpass/contracts";
import { useSettings } from "../context.js";

/**
 * 026 (D-026-2, FR-417..FR-420): "Skill for your coding agents" - each of the two user-level folders
 * (D-026-1) with its state. Install and Update write on the owner's click; a copy the owner changed, or
 * one Hallpass cannot read, is replaced only after a confirmation. The helper decides the state again
 * after every write, so the row follows the next projection.
 */
export function SkillSection(props: { skills: readonly AgentSkillState[] }): ReactElement {
  const { t } = useSettings();
  const [confirming, setConfirming] = useState<AgentSkillLocation | undefined>(undefined);
  return (
    <section className="skill-section" data-section="agent-skill" aria-labelledby="skill-title">
      <h3 id="skill-title">{t("settings.skill.title")}</h3>
      <p className="meta">{t("settings.skill.intro")}</p>
      <ul className="skill-rows">
        {props.skills.map((entry) => (
          <SkillRow
            key={entry.location}
            entry={entry}
            confirming={confirming === entry.location}
            onConfirm={(on) => setConfirming(on ? entry.location : undefined)}
          />
        ))}
      </ul>
    </section>
  );
}

function SkillRow(props: { entry: AgentSkillState; confirming: boolean; onConfirm: (on: boolean) => void }): ReactElement {
  const { t, run, notify } = useSettings();
  const { location, state, folder, detail } = props.entry;
  const name = t(`settings.skill.location.${location}`);
  const replace = useRef<HTMLButtonElement>(null);
  const confirmYes = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // As a site's revoke: the confirmation takes the focus, and Keep gives it back to Replace.
  useEffect(() => {
    if (props.confirming) confirmYes.current?.focus();
    else if (wasConfirming.current) replace.current?.focus();
    wasConfirming.current = props.confirming;
  }, [props.confirming]);

  const install = (replaceChanged: boolean): void => {
    void run(
      { type: "ui.conversation.install-skill", payload: { location, ...(replaceChanged ? { replaceChanged: true as const } : {}) } },
      () => notify(t("settings.skill.installed", { location: name })),
    );
  };

  const changed = state === "changed" || state === "unreadable";
  return (
    <li className="skill-row" data-location={location} data-state={state}>
      <span className="skill-name">{name}</span>
      <span className="skill-state">{t(`settings.skill.state.${state}`)}</span>
      {state === "not-installed" || state === "update-available" ? (
        <button type="button" className="btn" onClick={() => install(false)}>
          {t(state === "not-installed" ? "settings.skill.install" : "settings.skill.update")}
        </button>
      ) : null}
      {changed ? (
        <button ref={replace} type="button" className="btn quiet" onClick={() => props.onConfirm(true)}>
          {t("settings.skill.replace")}
        </button>
      ) : null}
      <span className="meta skill-folder">{folder}</span>
      {state === "unreadable" && detail !== undefined ? <span className="meta skill-detail">{detail}</span> : null}
      {props.confirming ? (
        <div className="site-confirm" role="alert">
          <span>{t("settings.skill.replaceConfirm")}</span>
          <button
            ref={confirmYes}
            type="button"
            className="btn danger"
            onClick={() => {
              props.onConfirm(false);
              install(true);
            }}
          >
            {t("settings.skill.replace")}
          </button>
          <button type="button" className="btn" onClick={() => props.onConfirm(false)}>
            {t("settings.skill.keep")}
          </button>
        </div>
      ) : null}
    </li>
  );
}
