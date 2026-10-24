import { forwardRef, useId, type ReactElement, type Ref } from "react";
import type { ConversationAgent, ConversationAgentAvailability } from "@hallpass/contracts";
import {
  AGENT_DOWNLOAD_MINUTES,
  DOWNLOAD_SIZE,
  agentState,
  agentWarnings,
  canBeDefault,
  downloadKind,
  installedByOwner,
  isReadyState,
  toolsStatus,
  type AgentState,
  type ToolsStatus,
} from "../agent-model.js";
import { useSettings } from "../context.js";
import { Avatar, Mark, Switch, type MarkKind } from "../parts.js";
import { AgentTest } from "./AgentTest.js";
import { InstallProgress, MiniProgress } from "./InstallProgress.js";

const STATE_BADGE: Record<AgentState, string> = {
  ready: "ok",
  readyWarnings: "warn",
  needsDownload: "action",
  downloading: "busy",
  notInstalled: "off",
};

/** The tools status of the card's check row and of the Browser tools table: one mark and one message each. */
export const TOOLS_STATUS_VIEW: Record<ToolsStatus, { mark: MarkKind; key: string }> = {
  available: { mark: "ok", key: "settings.toolStatus.available" },
  needsComponent: { mark: "warn", key: "settings.toolStatus.needsComponent" },
  notSupported: { mark: "muted", key: "settings.toolStatus.notSupported" },
  afterHelper: { mark: "muted", key: "settings.toolStatus.afterHelper" },
  unknown: { mark: "muted", key: "settings.toolStatus.afterHelper" },
};

/**
 * 024 FR-377, FR-378, D-024-7: one agent as a collapsible card - a row when closed (name, state,
 * default mark or Make default, Enabled switch, and while relevant a small bar or the warning count),
 * its details when open. The name is the disclosure button.
 */
export const AgentCard = forwardRef(function AgentCard(
  props: {
    agent: ConversationAgent;
    entry: ConversationAgentAvailability;
    open: boolean;
    onToggle: () => void;
    /** Moves the focus to the name after the card's own Make default control became the mark. */
    onMadeDefault: () => void;
  },
  disclosure: Ref<HTMLButtonElement>,
): ReactElement {
  const { agent, entry, open } = props;
  const { state: projection, t, run, nameOf } = useSettings();
  const name = nameOf(agent);
  const enabled = projection.choices.enabled[agent] !== false;
  const isDefault = projection.choices.default === agent;
  const kind = agentState(entry, name);
  const warnings = agentWarnings(entry, name);
  const defaultable = canBeDefault(kind, enabled);
  const ids = { body: useId(), heading: useId(), reason: useId(), consent: useId() };
  const warned = enabled ? warnings.length : 0;

  const makeDefaultReason = defaultable ? undefined : t(isReadyState(kind) ? "settings.card.defaultReason.off" : "settings.card.defaultReason.notReady");

  const meta = [entry.version === undefined ? "—" : `v${entry.version}`, installedByOwner(agent) ? t("settings.card.installedByYou") : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

  return (
    <article
      className={`acard${open ? " is-open" : ""}${isDefault ? " is-default" : ""}${enabled ? "" : " is-off"}`}
      aria-labelledby={ids.heading}
      data-agent={agent}
      data-state={kind}
      data-enabled={enabled}
    >
      <div className="acard-head">
        <Avatar agent={agent} name={name} />
        <h3 className="acard-name" id={ids.heading}>
          <button
            ref={disclosure}
            type="button"
            className="disc"
            aria-expanded={open}
            aria-controls={ids.body}
            data-fid={`disc-${agent}`}
            onClick={props.onToggle}
          >
            <span className="chev" aria-hidden="true" />
            <span>{name}</span>
            <span className="sr-only">, {t("settings.card.details")}</span>
          </button>
        </h3>
        <span className={`badge ${STATE_BADGE[kind]}`}>{t(`settings.state.${kind}`)}</span>
        <span className="acard-grow" />
        <span className="acard-ctl">
          {isDefault ? (
            <span className="badge def">{t("settings.card.default")}</span>
          ) : (
            <button
              type="button"
              className="btn quiet mkdef"
              disabled={!defaultable}
              title={makeDefaultReason}
              aria-label={t("settings.card.makeDefaultLabel", { agent: name })}
              aria-describedby={makeDefaultReason === undefined ? undefined : ids.reason}
              data-fid={`mkdef-${agent}`}
              onClick={() => {
                props.onMadeDefault();
                void run({ type: "ui.settings.choices-set", payload: { default: agent } });
              }}
            >
              {t("settings.card.makeDefault")}
            </button>
          )}
          {makeDefaultReason === undefined ? null : (
            <span id={ids.reason} className="sr-only">
              {makeDefaultReason}
            </span>
          )}
          <Switch
            checked={enabled}
            label={t("settings.card.enabledLabel", { agent: name })}
            data-fid={`toggle-${agent}`}
            onChange={(next) => {
              void run({ type: "ui.settings.choices-set", payload: { enabled: { [agent]: next } } });
            }}
          >
            {t("settings.card.enabled")}
          </Switch>
        </span>
      </div>
      {open || (kind !== "downloading" && warned === 0) ? null : (
        <div className="acard-sub">
          {kind === "downloading" ? <MiniProgress agent={agent} name={name} install={entry.install} t={t} /> : null}
          {warned === 0 ? null : (
            <span className="acard-warn">
              <span aria-hidden="true">!</span> {t(warned === 1 ? "settings.card.warningsOne" : "settings.card.warnings", { count: warned })}
            </span>
          )}
        </div>
      )}
      <div className="acard-body" id={ids.body} role="region" aria-labelledby={ids.heading} hidden={!open}>
        {open ? <CardBody agent={agent} entry={entry} kind={kind} enabled={enabled} meta={meta} consentId={ids.consent} /> : null}
      </div>
    </article>
  );
});

function CardBody(props: {
  agent: ConversationAgent;
  entry: ConversationAgentAvailability;
  kind: AgentState;
  enabled: boolean;
  meta: string;
  consentId: string;
}): ReactElement {
  const { agent, entry, kind, enabled } = props;
  const { state: projection, t, nameOf } = useSettings();
  const name = nameOf(agent);
  const warnings = agentWarnings(entry, name);
  return (
    <>
      <p className="meta">{props.meta}</p>
      {kind === "downloading" ? <InstallProgress agent={agent} name={name} install={entry.install} t={t} /> : null}
      <Notes agent={agent} entry={entry} kind={kind} enabled={enabled} warnings={warnings} />
      <Checks agent={agent} entry={entry} kind={kind} />
      {installedByOwner(agent) && entry.setupSteps !== undefined ? <SetupSteps entry={entry} /> : null}
      <div className="divider" />
      <div className="card-actions">
        <PrimaryAction agent={agent} entry={entry} kind={kind} enabled={enabled} consent={projection.consent === "granted"} consentId={props.consentId} />
      </div>
      <AgentTest agent={agent} entry={entry} available={enabled && isReadyState(kind)} />
    </>
  );
}

function Notes(props: {
  agent: ConversationAgent;
  entry: ConversationAgentAvailability;
  kind: AgentState;
  enabled: boolean;
  warnings: ReturnType<typeof agentWarnings>;
}): ReactElement | null {
  const { agent, entry, kind } = props;
  const { t, nameOf } = useSettings();
  const name = nameOf(agent);
  const infos: string[] = [];
  const bad: string[] = [];
  if (kind === "needsDownload" && props.enabled) {
    infos.push(
      downloadKind(agent) === "helper"
        ? t("settings.note.helperWhy", { agent: name, size: DOWNLOAD_SIZE[agent] ?? "" })
        : t("settings.note.notInstalled", { estimate: AGENT_DOWNLOAD_MINUTES }),
    );
  }
  if (kind === "needsDownload") {
    if (entry.install?.phase === "interrupted") infos.push(t("settings.progress.interrupted"));
    if (entry.install?.phase === "failed") {
      bad.push(t("settings.progress.failed", { reason: entry.install.error ?? t("settings.error.generic") }), t("settings.progress.failedHint"));
    }
  }
  if (kind === "notInstalled" && props.enabled) {
    if (entry.availability === "version-problem") {
      infos.push(entry.version === undefined || entry.detail === undefined ? t("settings.warning.versionUnreadable", { agent: name }) : entry.detail);
    } else {
      infos.push(t("settings.note.programMissing", { agent: name }));
    }
  }
  if (infos.length === 0 && bad.length === 0 && props.warnings.length === 0) return null;
  return (
    <div className="notes">
      {infos.map((text) => (
        <p key={text} className="note info">
          {text}
        </p>
      ))}
      {bad.map((text) => (
        <p key={text} className="note bad">
          {text}
        </p>
      ))}
      {props.warnings.map((warning) => (
        <p key={warning.key} className="note warn">
          <span className="mark" aria-hidden="true">
            !
          </span>
          <span>{t(warning.key, warning.vars)}</span>
        </p>
      ))}
    </div>
  );
}

/** FR-378: the checks - from the local check only (FR-397). */
function Checks(props: { agent: ConversationAgent; entry: ConversationAgentAvailability; kind: AgentState }): ReactElement {
  const { agent, entry, kind } = props;
  const { t } = useSettings();
  const ready = isReadyState(kind);
  const version: { mark: MarkKind; text: string } = entry.version === undefined ? { mark: "muted", text: "—" } : { mark: "ok", text: entry.version };

  let prereq: { mark: MarkKind; text: string };
  if (agent === "deepseek") {
    prereq = ready ? { mark: "ok", text: t("settings.check.nothingNeeded") } : { mark: "muted", text: t("settings.check.afterDownload") };
  } else if (agent === "hermes") {
    const git = entry.setupSteps?.find((step) => step.step === "git")?.found;
    prereq =
      git === true
        ? { mark: "ok", text: t("settings.check.found", { item: "Git" }) }
        : git === false
          ? { mark: "warn", text: `${t("settings.hermes.git")} — ${t("settings.hermes.notDone")}` }
          : { mark: "muted", text: "—" };
  } else if (ready) {
    prereq = { mark: "ok", text: t("settings.check.helperInstalled") };
  } else if (kind === "needsDownload") {
    prereq = { mark: "bad", text: t("settings.check.helperMissing") };
  } else {
    // Only an agent that needs the download is missing the helper; a missing program waits for it.
    prereq = { mark: "muted", text: t("settings.check.afterDownload") };
  }

  const model: { mark: MarkKind; text: string } =
    entry.lastTest === undefined
      ? { mark: "muted", text: t("settings.check.modelNotChecked") }
      : entry.lastTest.model.answered
        ? { mark: "ok", text: t("settings.check.modelAnswered") }
        : { mark: "bad", text: t("settings.check.modelFailed") };

  const tools = TOOLS_STATUS_VIEW[toolsStatus(entry)];
  const chips: Array<[string, boolean | undefined]> = [
    [t("settings.attach.images"), entry.accepts?.image],
    [t("settings.attach.tab"), entry.accepts?.context],
    [t("settings.attach.files"), entry.accepts?.context],
  ];

  return (
    <dl className="checks">
      <Row label={t("settings.check.version")} mark={version.mark} text={version.text} />
      <Row label={t("settings.check.prereq")} mark={prereq.mark} text={prereq.text} />
      <Row label={t("settings.check.model")} mark={model.mark} text={model.text} />
      <Row label={t("settings.check.tools")} mark={tools.mark} text={t(tools.key)} />
      <dt>{t("settings.check.attach")}</dt>
      <dd>
        {entry.accepts === undefined ? (
          <Mark kind="muted" />
        ) : (
          chips.map(([label, accepted]) => (
            <span key={label} className={`chip${accepted === true ? "" : " no"}`}>
              <span aria-hidden="true">{accepted === true ? "✓ " : "✕ "}</span>
              {label}
              <span className="sr-only">: {t(accepted === true ? "settings.attach.accepted" : "settings.attach.refused")}</span>
            </span>
          ))
        )}
      </dd>
    </dl>
  );
}

function Row(props: { label: string; mark: MarkKind; text: string }): ReactElement {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>
        <Mark kind={props.mark} />
        <span>{props.text}</span>
      </dd>
    </>
  );
}

const STEP_TEXT: Record<string, string> = {
  git: "settings.hermes.git",
  hermes: "settings.hermes.command",
  "mcp-component": "settings.hermes.mcp",
  "key-variable": "settings.hermes.keyVariable",
  "browser-restart": "settings.hermes.restart",
};

/** FR-380, D-021-3: Hermes' setup steps as the check found them; Hallpass installs nothing. */
function SetupSteps(props: { entry: ConversationAgentAvailability }): ReactElement {
  const { t } = useSettings();
  return (
    <div>
      <p className="meta guide-intro">{t("settings.hermes.intro")}</p>
      <ol className="guide">
        {(props.entry.setupSteps ?? []).map((step) => (
          <li key={step.step} data-step={step.step} data-found={step.found}>
            {t(STEP_TEXT[step.step] ?? "settings.hermes.git")} —{" "}
            <span className={step.found ? "done" : "meta"}>{step.found ? `✓ ${t("settings.hermes.found")}` : t("settings.hermes.notDone")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * FR-379, FR-380, FR-299: Download / Cancel / Try again from the card; Check again where there is
 * nothing for Hallpass to download (Hermes, or a program the owner has yet to install). With the
 * side-panel-agent switch off the broker refuses an install (FR-299), so the card offers the switch
 * first and the download waits for it.
 */
function PrimaryAction(props: {
  agent: ConversationAgent;
  entry: ConversationAgentAvailability;
  kind: AgentState;
  enabled: boolean;
  consent: boolean;
  consentId: string;
}): ReactElement | null {
  const { agent, entry, kind } = props;
  const { t, run, notify, latest } = useSettings();
  if (kind === "downloading") {
    return (
      <button
        type="button"
        className="btn"
        data-fid={`cancel-${agent}`}
        onClick={() => {
          void run({ type: "ui.conversation.install-cancel", payload: { agent } }, () => notify(t("settings.toast.downloadCancelled")));
        }}
      >
        {t("settings.action.cancel")}
      </button>
    );
  }

  const checkAgain = (
    <button
      type="button"
      className="btn quiet"
      data-fid={`recheck-${agent}`}
      onClick={() => {
        const before = JSON.stringify({ ...entry, checkedAt: undefined });
        void run({ type: "ui.conversation.check-agents", payload: { agent } }, () => {
          const now = latest().agents.find((item) => item.agent === agent);
          const changed = now !== undefined && JSON.stringify({ ...now, checkedAt: undefined }) !== before;
          notify(t(changed ? "settings.notice.checkedChanged" : "settings.notice.checked"));
        });
      }}
    >
      {t("settings.action.checkAgain")}
    </button>
  );

  if (kind === "needsDownload") {
    const retry = entry.install?.phase === "failed" || entry.install?.phase === "interrupted";
    return (
      <>
        {props.consent ? null : (
          <div className="consent-gate">
            <Switch
              checked={false}
              label={t("settings.tools.switchTitle")}
              describedBy={props.consentId}
              onChange={() => {
                void run({ type: "ui.conversation.consent", payload: { granted: true } });
              }}
            >
              {t("settings.tools.switchTitle")}
            </Switch>
            <span id={props.consentId} className="meta">
              {t("settings.tools.switchDesc")}
            </span>
          </div>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!props.enabled || !props.consent}
          aria-describedby={props.consent ? undefined : props.consentId}
          data-fid={`download-${agent}`}
          onClick={() => {
            void run({ type: "ui.conversation.install", payload: { agent } });
          }}
        >
          {retry
            ? t("settings.action.tryAgain")
            : downloadKind(agent) === "helper"
              ? t("settings.action.downloadHelper", { size: DOWNLOAD_SIZE[agent] ?? "" })
              : t("settings.action.downloadAgent")}
        </button>
        {installedByOwner(agent) ? checkAgain : null}
      </>
    );
  }
  if (installedByOwner(agent) || kind === "notInstalled") return checkAgain;
  return null;
}
