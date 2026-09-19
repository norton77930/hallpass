import type { ReactElement } from "react";
import type { SiteMode, SiteModeRecord } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import { MODE_KEYS } from "../agent-panel-keys.js";
import type { SendCommand } from "./AgentShell.js";

/**
 * The site list (006 FR-086, D-006-7): one row per site the owner has decided about, its mode as a
 * switch among the three, and a revoke that forgets the decision.
 *
 * The permissive mode is marked on the row (`permissive`) rather than only named in the switch,
 * because "acts without asking" is the one setting the owner should find without reading. The
 * diagnostics grant stays a control of its own on the row (004 US6, FR-049): it is a different
 * consent from the mode, and revoking it is what takes Chrome's debugging bar off the screen.
 */

const MODE_ORDER: readonly SiteMode[] = ["ask", "follow-a-plan", "skip-checks"];

export function SiteList(props: { sites: SiteModeRecord[]; locale: string; send: SendCommand }): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);

  return (
    <section className="agent-sites" aria-labelledby="agent-sites-title">
      <h2 id="agent-sites-title">{t("agent.sitesTitle")}</h2>
      {props.sites.length === 0 ? (
        <p>{t("agent.sitesNone")}</p>
      ) : (
        <ul>
          {props.sites.map((record) => (
            <li
              key={record.site}
              data-site={record.site}
              className={record.mode === "skip-checks" ? "agent-site permissive" : "agent-site"}
            >
              <div className="agent-site-head">
                <span className="agent-site-name">{record.site}</span>
                {record.mode === "skip-checks" ? (
                  <span className="agent-site-flag">{t("agent.sitePermissive")}</span>
                ) : null}
              </div>
              {/* The label names the control for assistive technology; on screen the site name
                  above it already says which site, so the text is visually hidden. */}
              <label className="agent-site-mode">
                <span className="agent-sr-only">{t("agent.siteModeLabel").replace("{site}", record.site)}</span>
                <select
                  value={record.mode}
                  onChange={(event) => {
                    props.send({
                      type: "ui.agent.site-mode",
                      payload: { site: record.site, mode: event.target.value as SiteMode },
                    });
                  }}
                >
                  {MODE_ORDER.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(MODE_KEYS[mode])}
                    </option>
                  ))}
                </select>
              </label>
              <div className="agent-site-tools">
              <label className="agent-site-diagnostics">
                <input
                  type="checkbox"
                  checked={record.diagnosticsGranted}
                  onChange={(event) => {
                    props.send({
                      type: "ui.agent.set-diagnostics",
                      payload: { site: record.site, granted: event.target.checked },
                    });
                  }}
                />
                {t("agent.diagnosticsLabel").replace("{site}", record.site)}
              </label>
              <button
                type="button"
                className="agent-quiet"
                onClick={() => {
                  props.send({ type: "ui.agent.site-clear", payload: { site: record.site } });
                }}
              >
                {t("agent.siteRevoke").replace("{site}", record.site)}
              </button>
              </div>
              {record.diagnosticsGranted ? <p>{t("agent.diagnosticsGranted")}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
