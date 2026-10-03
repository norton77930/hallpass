import { useEffect, useState, type ReactElement } from "react";
import type { AgentPanelState, SiteMode, SiteModeRecord } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import { MODE_KEYS } from "../agent-panel-keys.js";
import type { SendCommand } from "./AgentShell.js";
import { displayOrigin } from "./display-origin.js";

/**
 * The site list (006 FR-086, D-006-7): one row per site the owner has decided about, its mode as a
 * switch among the three, and a revoke that forgets the decision.
 *
 * The permissive mode is marked on the switch itself (016 FR-235: `data-permissive`, a border in
 * the warning colour) rather than by a badge beside a switch that already names it, because "acts
 * without asking" is the one setting the owner should find without reading. The diagnostics grant
 * stays a control of its own on the row (004 US6, FR-049): it is a different consent from the mode,
 * and revoking it is what takes Chrome's debugging bar off the screen.
 *
 * 016 FR-236, FR-237: the site is written once, as the row's name. The checkbox and the revoke say
 * what they do on screen and carry the site in their accessible names only, and there is no
 * "granted" line under a checkbox that already shows whether it is granted.
 */

const MODE_ORDER: readonly SiteMode[] = ["ask", "follow-a-plan", "skip-checks"];

export function SiteList(props: {
  sites: SiteModeRecord[];
  /** 014 FR-191: the moves the owner said "always" to; absent or empty means there are none. */
  transitions?: AgentPanelState["transitions"];
  /**
   * 014 FR-191: the directories the local host may read uploads from, as it last reported them.
   *
   * Absent is not empty: an old host - or a link that has not answered yet - says nothing, and a
   * section reading "no directories" would be this panel inventing a fact about the owner's file.
   */
  uploadRoots?: AgentPanelState["uploadRoots"];
  locale: string;
  send: SendCommand;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  const remembered = props.transitions ?? [];
  /**
   * The revokes this panel has asked for and not yet seen answered (014 FR-192).
   *
   * Panel-local, because it is a fact about *this* screen: the owner pressed a button here and is
   * owed a word about what became of it. The row itself is not removed - only the host can say the
   * directory is gone, and it says so by sending a list without it, which the next projection
   * carries. A panel that reopens simply shows the row plainly again, which is the truth: the
   * press is still pending in the worker, which re-sends it on the next link.
   */
  const [pending, setPending] = useState<string[]>([]);
  const roots = props.uploadRoots;
  /**
   * A press is answered by the next list the host sends (S3 review F6).
   *
   * The note used to be cleared by the row leaving the DOM and by nothing else, so a revoke the
   * host answered *without* removing the row - another session's answer put the directory back,
   * the write failed - left "waiting for the local host" standing for the life of the panel, on a
   * row nobody was waiting on. The list arriving is the answer, whatever it says.
   */
  useEffect(() => {
    setPending([]);
  }, [roots]);

  return (
    <section className="agent-sites" aria-labelledby="agent-sites-title">
      <h2 id="agent-sites-title">{t("agent.sitesTitle")}</h2>
      {props.sites.length === 0 ? (
        <p>{t("agent.sitesNone")}</p>
      ) : (
        <ul>
          {props.sites.map((record) => (
            <li key={record.site} data-site={record.site} className="agent-site">
              <div className="agent-site-head">
                <span className="agent-site-name">{displayOrigin(record.site)}</span>
              </div>
              {/* The label names the control for assistive technology; on screen the site name
                  above it already says which site, so the text is visually hidden. */}
              <label className="agent-site-mode">
                <span className="agent-sr-only">{t("agent.siteModeLabel").replace("{site}", () => displayOrigin(record.site))}</span>
                <select
                  value={record.mode}
                  data-permissive={record.mode === "skip-checks" ? "true" : undefined}
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
                    aria-label={t("agent.diagnosticsLabel").replace("{site}", () => displayOrigin(record.site))}
                    checked={record.diagnosticsGranted}
                    onChange={(event) => {
                      props.send({
                        type: "ui.agent.set-diagnostics",
                        payload: { site: record.site, granted: event.target.checked },
                      });
                    }}
                  />
                  {t("agent.diagnosticsText")}
                </label>
                <button
                  type="button"
                  className="agent-quiet"
                  aria-label={t("agent.siteRevoke").replace("{site}", () => displayOrigin(record.site))}
                  onClick={() => {
                    props.send({ type: "ui.agent.site-clear", payload: { site: record.site } });
                  }}
                >
                  {t("agent.siteRevokeText")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {/*
        014 FR-191, FR-192: what the owner allowed for good, and the way to take it back.

        Inside the site list rather than on a settings page of its own (D-014-3): a remembered move
        is a standing permission exactly as a site mode is, and the owner should meet both in the
        same place. The section is absent when nothing is remembered - a heading over an empty list
        is furniture, and this panel has none.
      */}
      {remembered.length === 0 ? null : (
        <section className="agent-transitions" aria-labelledby="agent-transitions-title">
          <h3 id="agent-transitions-title">{t("agent.transitionsTitle")}</h3>
          <ul>
            {remembered.map((pair) => (
              <li key={`${pair.from}→${pair.to}`} data-transition={`${pair.from}→${pair.to}`} className="agent-transition">
                <span className="agent-transition-pair">
                  {t("agent.transitionRow")
                    .replace("{from}", () => displayOrigin(pair.from))
                    .replace("{to}", () => displayOrigin(pair.to))}
                </span>
                {/* When it was last used is what makes a row reviewable a month later; a pair
                    nothing has used says so rather than showing an empty date. */}
                <span className="agent-transition-used">
                  {pair.lastUsedAt === undefined
                    ? t("agent.transitionNeverUsed")
                    : t("agent.transitionLastUsed").replace("{at}", () => pair.lastUsedAt ?? "")}
                </span>
                <button
                  type="button"
                  className="agent-quiet"
                  onClick={() => {
                    props.send({ type: "ui.agent.transition-clear", payload: { from: pair.from, to: pair.to } });
                  }}
                >
                  {t("agent.transitionRevoke")
                    .replace("{from}", () => displayOrigin(pair.from))
                    .replace("{to}", () => displayOrigin(pair.to))}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/*
        014 FR-191, FR-192: the directories on the owner's own disk that an upload may come from.

        A standing permission of the same kind as a site's mode, so it is met in the same place -
        and the one whose list lives outside the browser, which is what makes the revoke a request
        rather than a deletion: the row goes when the host answers with a list that no longer has
        it. The path of the file is shown because the owner may want to edit it by hand; it is a
        fact about their machine, shown to them and to nobody else.
      */}
      {roots === undefined ? null : (
        <section className="agent-upload-roots" aria-labelledby="agent-upload-roots-title">
          <h3 id="agent-upload-roots-title">{t("agent.uploadRootsTitle")}</h3>
          {/* 0.9.0 owner check: what the list governs, and - when it is empty - that nothing is
              allowed and how a directory gets here. A bare title over a file path said neither. */}
          <p className="agent-upload-roots-intro">{t("agent.uploadRootsIntro")}</p>
          {roots.roots.length === 0 ? <p className="agent-upload-roots-empty">{t("agent.uploadRootsEmpty")}</p> : null}
          {/*
            S3 review F4: where the document nobody could read went. It takes the place of the
            older sentence rather than standing beside it - that one says no directory is allowed,
            which is not true of the list written beside the copy - and this panel is the only place
            the owner could learn their file was kept at all.
          */}
          {roots.preserved !== undefined ? (
            <p className="agent-upload-roots-warning">
              {t("agent.uploadRootsPreserved").replace("{name}", () => roots.preserved ?? "")}
            </p>
          ) : roots.malformed ? (
            <p className="agent-upload-roots-warning">{t("agent.uploadRootsMalformed")}</p>
          ) : null}
          {/*
            S3 review F2: what the owner answered "from now on" about that never reached the list.
            One line per directory, because the owner's next move is about that directory - and
            nothing else in the browser can tell them the answer went nowhere.
          */}
          {(roots.notRecorded ?? []).map((root) => (
            <p key={root} className="agent-upload-roots-warning" data-upload-root-not-recorded={root}>
              {t("agent.uploadRootNotRecorded").replace("{root}", () => root)}
            </p>
          ))}
          <ul>
            {roots.roots.map((root) => (
              <li key={root} data-upload-root={root} className="agent-upload-root">
                <span className="agent-upload-root-path">{root}</span>
                <button
                  type="button"
                  className="agent-quiet"
                  onClick={() => {
                    setPending((waiting) => (waiting.includes(root) ? waiting : [...waiting, root]));
                    props.send({ type: "ui.agent.upload-root-clear", payload: { root } });
                  }}
                >
                  {t("agent.uploadRootRevoke").replace("{root}", () => root)}
                </button>
                {pending.includes(root) ? <span className="agent-upload-root-pending">{t("agent.uploadRootPending")}</span> : null}
              </li>
            ))}
          </ul>
          <p className="agent-upload-roots-path">{t("agent.uploadRootsPath").replace("{path}", () => roots.path)}</p>
        </section>
      )}
    </section>
  );
}
