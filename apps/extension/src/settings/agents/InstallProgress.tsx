import type { ReactElement } from "react";
import type { ConversationAgent, ConversationInstallState } from "@hallpass/contracts";
import { AGENT_DOWNLOAD_MINUTES, downloadKind } from "../agent-model.js";
import type { Translate } from "../settings-text.js";

/**
 * 024 FR-379, D-024-9, R-376 addendum: a download as the shared install state records it.
 *
 * The percent and the time left are estimates, and say so: no package folder yet is "Preparing" with
 * no percent and no bar fill; the time left is absent until the worker has one (from 10 % on). The line
 * under the bar says what closing the page and closing the browser do.
 */
export function progressText(install: ConversationInstallState | undefined): { percent: number | undefined; minutes: number | undefined } {
  const percent = install?.percent == null || install.phase === "preparing" ? undefined : Math.floor(install.percent);
  const seconds = install?.etaSeconds ?? undefined;
  return { percent, minutes: seconds === undefined ? undefined : Math.max(1, Math.round(seconds / 60)) };
}

/** The time-left line: under a minute says so, else whole minutes; none when the worker has no estimate. */
export function etaText(install: ConversationInstallState | undefined, t: Translate): string {
  const seconds = install?.etaSeconds ?? undefined;
  if (seconds === undefined) return "";
  return seconds < 60 ? t("settings.progress.timeLeftShort") : t("settings.progress.timeLeft", { minutes: progressText(install).minutes ?? 1 });
}

function label(agent: ConversationAgent, name: string, t: Translate): string {
  return downloadKind(agent) === "helper" ? t("settings.progress.helper") : t("settings.progress.agent", { agent: name });
}

/** The full progress block of an open card. */
export function InstallProgress(props: {
  agent: ConversationAgent;
  name: string;
  install: ConversationInstallState | undefined;
  t: Translate;
}): ReactElement {
  const { t, install } = props;
  const { percent } = progressText(install);
  const heading = label(props.agent, props.name, t);
  return (
    <div className="progress" data-progress={props.agent}>
      <div className="row">
        <span>{heading}</span>
        <span className="pct">{percent === undefined ? t("settings.progress.preparing") : `${percent} %`}</span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={heading}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={percent === undefined ? t("settings.progress.preparing") : `${percent} %`}
      >
        <div className="fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <div className="row">
        <span>
          {downloadKind(props.agent) === "agent" ? t("settings.progress.firstDownload", { estimate: AGENT_DOWNLOAD_MINUTES }) : ""}
        </span>
        <span className="eta">{etaText(install, t)}</span>
      </div>
      <div className="row">
        <span>{t("settings.progress.keepsGoing")}</span>
      </div>
    </div>
  );
}

/** The small bar of a collapsed row (FR-377). */
export function MiniProgress(props: {
  agent: ConversationAgent;
  name: string;
  install: ConversationInstallState | undefined;
  t: Translate;
}): ReactElement {
  const { percent } = progressText(props.install);
  const eta = etaText(props.install, props.t);
  const heading = `${label(props.agent, props.name, props.t)}: ${props.name}`;
  return (
    <span className="acard-dl">
      <span
        className="minibar"
        role="progressbar"
        aria-label={heading}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={percent === undefined ? props.t("settings.progress.preparing") : `${percent} %`}
      >
        <span style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="meta">{percent === undefined ? props.t("settings.progress.preparing") : `${percent} %`}</span>
      {eta === "" ? null : <span className="meta">{eta}</span>}
    </span>
  );
}
