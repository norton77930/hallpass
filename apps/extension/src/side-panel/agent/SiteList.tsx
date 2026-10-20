import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import type { AgentPanelState, SiteMode, SiteModeRecord } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import { MODE_KEYS } from "../agent-panel-keys.js";
import type { SendCommand } from "./AgentShell.js";
import { useExclusiveMenu } from "./conversation/exclusive-menu.js";
import { folderName } from "./conversation/folder-name.js";
import { useOutsidePress } from "./conversation/outside-press.js";
import { CloseIcon, DownIcon, MoreIcon } from "./conversation/icons.js";
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
      {/* T606 (B3): a small heading and a separator, as the sessions have, and no box. */}
      <h2 id="agent-sites-title" className="agent-section-heading">
        {t("agent.sitesTitle")}
      </h2>
      {props.sites.length === 0 ? (
        <p>{t("agent.sitesNone")}</p>
      ) : (
        <ul>
          {props.sites.map((record) => (
            <SiteRow key={record.site} record={record} t={t} send={props.send} />
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
          <h3 id="agent-upload-roots-title" className="agent-section-heading">
            {t("agent.uploadRootsTitle")}
          </h3>
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
                {/* T607 (S3): the folder's name on one line, its path under it on one ellipsized line. */}
                <span className="agent-upload-root-text">
                  <span className="agent-upload-root-name">{folderName(root)}</span>
                  <span className="agent-upload-root-path" title={root}>
                    {root}
                  </span>
                </span>
                {/* T606 (B4): an x at the line's end; its name is still the words. */}
                <button
                  type="button"
                  className="agent-icon-button agent-upload-root-forget"
                  title={t("agent.uploadRootRevoke").replace("{root}", () => root)}
                  onClick={() => {
                    setPending((waiting) => (waiting.includes(root) ? waiting : [...waiting, root]));
                    props.send({ type: "ui.agent.upload-root-clear", payload: { root } });
                  }}
                >
                  <CloseIcon size={14} />
                  <span className="agent-sr-only">{t("agent.uploadRootRevoke").replace("{root}", () => root)}</span>
                </button>
                {pending.includes(root) ? <span className="agent-upload-root-pending">{t("agent.uploadRootPending")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/**
 * 020 T606 (B1): one site on one line - its name in monospace, its mode as a chip, and a "more"
 * button. The chip opens a menu of the three modes; "more" opens the rest of the row: the diagnostics
 * grant (still its own consent, 004 US6), who changed the site last (019 FR-308) and Revoke. Both
 * close on Escape (the focus goes back to their button) and on a press anywhere else. The commands
 * and the accessible names are the ones the row always had.
 */
function SiteRow(props: { record: SiteModeRecord; t: (key: string) => string; send: SendCommand }): ReactElement {
  const { record, t } = props;
  const [open, setOpen] = useState<"mode" | "more" | undefined>(undefined);
  const modeChip = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const ids = { mode: useId(), more: useId(), text: useId(), row: useId() };
  const site = displayOrigin(record.site);
  // T607 (S4): https is the ordinary case and says nothing; http, and any port, stay visible.
  const shownSite = site.startsWith("https://") ? site.slice("https://".length) : site;
  // T607 (S1): one menu open in the tab - this row's (the mode menu or "more") closes when another opens.
  useExclusiveMenu(ids.row, open !== undefined, () => setOpen(undefined));
  const close = (focus: boolean): void => {
    const was = open;
    setOpen(undefined);
    if (focus) (was === "more" ? moreButton : modeChip).current?.focus();
  };
  const toggle = (which: "mode" | "more"): void => setOpen((current) => (current === which ? undefined : which));

  return (
    <li data-site={record.site} className="agent-site">
      <span className="agent-site-name" title={site}>
        {shownSite}
      </span>
      <span className="agent-site-controls">
        <button
          ref={modeChip}
          type="button"
          className="agent-site-mode-chip"
          data-site-mode=""
          data-mode={record.mode}
          // 016 FR-235: acting without asking is marked on the control itself, in the warning colour.
          data-permissive={record.mode === "skip-checks" ? "true" : undefined}
          aria-label={t("agent.siteModeLabel").replace("{site}", () => site)}
          aria-describedby={ids.text}
          aria-haspopup="menu"
          aria-expanded={open === "mode"}
          aria-controls={open === "mode" ? ids.mode : undefined}
          onClick={() => toggle("mode")}
        >
          <span id={ids.text}>{t(MODE_KEYS[record.mode])}</span>
          <DownIcon />
        </button>
        <button
          ref={moreButton}
          type="button"
          className="agent-icon-button agent-site-more-button"
          title={t("agent.siteMore").replace("{site}", () => site)}
          aria-expanded={open === "more"}
          aria-controls={open === "more" ? ids.more : undefined}
          onClick={() => toggle("more")}
        >
          <MoreIcon size={16} />
          <span className="agent-sr-only">{t("agent.siteMore").replace("{site}", () => site)}</span>
        </button>
      </span>
      {open === "mode" ? (
        <SiteModeMenu
          id={ids.mode}
          mode={record.mode}
          t={t}
          onChoose={(mode) => {
            close(true);
            if (mode !== record.mode) props.send({ type: "ui.agent.site-mode", payload: { site: record.site, mode } });
          }}
          onClose={() => close(true)}
          onDismiss={() => close(false)}
        />
      ) : null}
      {open === "more" ? (
        <SiteMore id={ids.more} onClose={() => close(true)} onDismiss={() => close(false)}>
          <label className="agent-site-diagnostics">
            <input
              type="checkbox"
              aria-label={t("agent.diagnosticsLabel").replace("{site}", () => site)}
              checked={record.diagnosticsGranted}
              onChange={(event) => {
                props.send({ type: "ui.agent.set-diagnostics", payload: { site: record.site, granted: event.target.checked } });
              }}
            />
            {t("agent.diagnosticsText")}
          </label>
          {/* 019 FR-308, R-328: who made the last change; a record from before 019 names nobody. */}
          {record.changedBy === undefined ? null : (
            <span className="agent-site-author">{t(`agent.siteChangedBy.${record.changedBy}`)}</span>
          )}
          <button
            type="button"
            className="agent-quiet agent-site-revoke"
            aria-label={t("agent.siteRevoke").replace("{site}", () => site)}
            onClick={() => {
              close(false);
              props.send({ type: "ui.agent.site-clear", payload: { site: record.site } });
            }}
          >
            {t("agent.siteRevokeText")}
          </button>
        </SiteMore>
      ) : null}
    </li>
  );
}

function SiteModeMenu(props: {
  id: string;
  mode: SiteMode;
  t: (key: string) => string;
  onChoose: (mode: SiteMode) => void;
  onClose: () => void;
  onDismiss: () => void;
}): ReactElement {
  const menu = useRef<HTMLUListElement>(null);
  useOutsidePress(menu, props.id, props.onDismiss);
  const items = (): HTMLButtonElement[] => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
  useEffect(() => {
    // The site's mode has the focus when the menu opens, as a menu button's menu does.
    const all = items();
    (all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, []);
  const onKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? all.length - 1
      : event.key === "ArrowDown" ? (at + 1) % all.length
      : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };
  return (
    <ul ref={menu} id={props.id} role="menu" className="agent-site-popup agent-site-mode-menu" onKeyDown={onKey}>
      {MODE_ORDER.map((mode) => (
        <li key={mode} role="none">
          <button type="button" role="menuitemradio" aria-checked={props.mode === mode} data-mode={mode} onClick={() => props.onChoose(mode)}>
            {props.t(MODE_KEYS[mode])}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The rest of a site's row, shown on "more": a small group of controls, not a menu of commands. */
function SiteMore(props: { id: string; onClose: () => void; onDismiss: () => void; children: ReactNode }): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  useOutsidePress(panel, props.id, props.onDismiss);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, []);
  return (
    <div
      ref={panel}
      id={props.id}
      role="group"
      className="agent-site-popup agent-site-more"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        props.onClose();
      }}
    >
      {props.children}
    </div>
  );
}
