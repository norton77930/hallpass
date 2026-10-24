import { useId, useState, type ReactElement } from "react";
import type { SettingsState } from "@hallpass/contracts";
import { normalizeBrowserName } from "../../browser-name.js";
import { AGENT_ORDER } from "../agent-model.js";
import { useSettings } from "../context.js";
import { Mark, type MarkKind } from "../parts.js";
import { AgentOutputs } from "./AgentOutputs.js";
import { writeClipboard } from "./clipboard.js";

type HelperStatus = "connected" | "notConnected" | "needsUpdate";

const HELPER_TEXT: Record<HelperStatus, { key: string; mark: MarkKind }> = {
  connected: { key: "settings.connection.helperConnected", mark: "ok" },
  notConnected: { key: "settings.connection.helperNotConnected", mark: "bad" },
  needsUpdate: { key: "settings.connection.helperNeedsUpdate", mark: "warn" },
};

/** FR-395: not connected first; then too old (the host said so, or the pair does not match); else connected. */
export function helperStatus(state: SettingsState): HelperStatus {
  if (state.bridge !== "connected") return "notConnected";
  if (state.agentsUnavailable === "host-outdated" || (state.versions.host !== undefined && !state.versions.match)) return "needsUpdate";
  return "connected";
}

/**
 * 024 FR-387, FR-395, D-024-17: whether the helper is there, the versions, the browsers connected to
 * this computer with this one marked, this browser's name with Rename (the 018 effect), a copy of these
 * details - without any user path - and each agent's last lines, read only when asked.
 *
 * Everything but the agents' lines comes from the extension, so a missing helper takes away only those
 * (and says why); the page does not stop.
 */
export function ConnectionSection(): ReactElement {
  const { state, t, notify } = useSettings();
  const status = helperStatus(state);
  const helper = HELPER_TEXT[status];
  const versionsText =
    state.versions.host === undefined
      ? t("settings.connection.versionsUnknown", { extension: state.versions.extension })
      : t(state.versions.match ? "settings.connection.versionsMatched" : "settings.connection.versionsMismatched", {
          extension: state.versions.extension,
          helper: state.versions.host,
        });
  const browsers = state.browsers ?? (state.browser === undefined ? [] : [{ browserId: "self", name: state.browser.name, kind: state.browser.kind, self: true }]);
  const thisName = state.browser?.name ?? browsers.find((browser) => browser.self)?.name;
  const helperMissing = state.agentsUnavailable !== undefined || state.agents.length === 0;
  const browsersId = useId();

  const copy = (): void => {
    // What a person asked for help would need - and no path of this computer (the helper's config file, the upload folders).
    const text = [
      `${t("settings.connection.helper")}: ${t(helper.key)}`,
      `${t("settings.connection.versions")}: ${versionsText}`,
      `${t("settings.connection.browsers")}: ${browsers.map((browser) => (browser.self ? `${browser.name} (${t("settings.connection.thisBrowser")})` : browser.name)).join(", ")}`,
    ].join("\n");
    void writeClipboard(text).then(
      () => notify(t("settings.toast.copied")),
      () => notify(t("settings.error.generic")),
    );
  };

  return (
    <div className="stack narrow" data-section-body="connection">
      <section className="blk" aria-labelledby={browsersId}>
        <h3 id={browsersId}>{t("settings.connection.title")}</h3>
        <dl className="checks">
          <dt>{t("settings.connection.helper")}</dt>
          <dd>
            <Mark kind={helper.mark} />
            <span>{t(helper.key)}</span>
          </dd>
          <dt>{t("settings.connection.versions")}</dt>
          <dd>
            <span>{versionsText}</span>
          </dd>
          <dt id={`${browsersId}-list`}>{t("settings.connection.browsers")}</dt>
          <dd>
            {browsers.length === 0 ? (
              <Mark kind="muted" />
            ) : (
              <ul aria-labelledby={`${browsersId}-list`} className="browser-list">
                {browsers.map((browser) => (
                  <li key={browser.browserId} data-browser-self={browser.self}>
                    {browser.name}{" "}
                    {browser.self ? <span className="chip">{t("settings.connection.thisBrowser")}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        {thisName === undefined ? null : <RenameBrowser current={thisName} />}
        <div>
          <button type="button" className="btn quiet" onClick={copy}>
            {t("settings.connection.copy")}
          </button>
        </div>
      </section>
      <DiagnosticsSection missing={helperMissing} agents={AGENT_ORDER.filter((agent) => state.agents.some((entry) => entry.agent === agent))} />
    </div>
  );
}

function DiagnosticsSection(props: { missing: boolean; agents: Parameters<typeof AgentOutputs>[0]["agents"] }): ReactElement {
  const { t } = useSettings();
  const headingId = useId();
  return (
    <section className="blk" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("settings.diag.title")}</h3>
      {props.missing ? <p className="note warn">{t("settings.helper.missingBody")}</p> : <AgentOutputs agents={props.agents} />}
    </section>
  );
}

/** 018 FR-268 (the effect): one `ui.agent.browser-rename`, the name stripped and trimmed here only to refuse an empty one in place. */
function RenameBrowser(props: { current: string }): ReactElement {
  const { t, run, notify } = useSettings();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const shown = draft ?? props.current;

  return (
    <form
      className="rename blk-sub"
      onSubmit={(event) => {
        event.preventDefault();
        const next = normalizeBrowserName(shown);
        if (next === undefined) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        if (next === props.current) {
          setDraft(undefined);
          return;
        }
        void run({ type: "ui.agent.browser-rename", payload: { name: next } }, () => {
          setDraft(undefined);
          notify(t("settings.connection.renamed", { name: next }));
        });
      }}
    >
      <label htmlFor={inputId} className="meta">
        {t("settings.connection.browserName")}
      </label>
      <span className="rename-row">
        <input
          id={inputId}
          type="text"
          className="sel"
          value={shown}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
        />
        <button type="submit" className="btn">
          {t("settings.connection.rename")}
        </button>
      </span>
      <span id={hintId} className="meta">
        {t("settings.connection.nameHint")}
      </span>
      {invalid ? (
        <p id={errorId} role="alert" className="note bad">
          {t("settings.connection.nameInvalid")}
        </p>
      ) : null}
    </form>
  );
}

