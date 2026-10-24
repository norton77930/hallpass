import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { SITE_MODES, type SiteModeRecord } from "@hallpass/contracts";
import { useSettings } from "../context.js";
import { formatWhen } from "../format.js";
import type { SettingsRoute } from "../routes.js";
import { siteLabel } from "./site-label.js";

/**
 * 024 FR-385, R-372: the sites the owner has decided about - the mode changes at once, a revoke asks
 * first and can be undone for a few seconds, and `#sites?site=<origin>` marks one row (or says it is
 * no longer listed). Each row also carries what the side panel's row did (FR-385): the diagnostics
 * grant, a consent of its own (004 US6, FR-049) whose revoke also takes Chrome's debugging bar away,
 * and who made the site's last change (019 FR-308, R-328).
 */
export function SiteRows(props: { route: SettingsRoute }): ReactElement {
  const { state, t } = useSettings();
  const headingId = useId();
  const named = props.route.site;
  const listed = named === undefined ? undefined : state.sites.some((record) => record.site === named);
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const marked = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (named === undefined || listed !== true) return;
    marked.current?.scrollIntoView?.({ block: "center" });
  }, [named, listed]);

  return (
    <section className="blk" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("settings.sites.title")}</h3>
      {named === undefined ? null : (
        <p className="note info" role="status">
          {listed === true ? t("settings.sites.marked", { site: siteLabel(named) }) : t("settings.sites.gone", { site: siteLabel(named) })}
        </p>
      )}
      {state.sites.length === 0 ? (
        <p className="empty">{t("settings.sites.empty")}</p>
      ) : (
        <ul className="site-list">
          {state.sites.map((record) => (
            <SiteItem
              key={record.site}
              record={record}
              flash={record.site === named}
              itemRef={record.site === named ? marked : undefined}
              confirming={confirming === record.site}
              onConfirm={(on) => setConfirming(on ? record.site : undefined)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SiteItem(props: {
  record: SiteModeRecord;
  flash: boolean;
  itemRef: React.RefObject<HTMLLIElement | null> | undefined;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
}): ReactElement {
  const { t, run, notify } = useSettings();
  const { site, mode: current, diagnosticsGranted, changedBy } = props.record;
  const label = siteLabel(site);
  const helpId = useId();
  const revoke = useRef<HTMLButtonElement>(null);
  const confirmYes = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // The confirmation takes the focus when it opens and gives it back to Revoke when Keep closes it.
  useEffect(() => {
    if (props.confirming) confirmYes.current?.focus();
    else if (wasConfirming.current) revoke.current?.focus();
    wasConfirming.current = props.confirming;
  }, [props.confirming]);

  return (
    <li ref={props.itemRef} className={`site${props.flash ? " flash" : ""}`} data-site={site} aria-current={props.flash ? "true" : undefined}>
      <span className="site-host" title={label}>
        {label}
      </span>
      <fieldset className="seg" role="radiogroup" aria-describedby={helpId}>
        <legend>{t("settings.sites.modeFor", { site: label })}</legend>
        {SITE_MODES.map((mode) => (
          <label key={mode} className={mode} title={t(`settings.mode.${mode}.meaning`)}>
            <input
              type="radio"
              name={`mode-${site}`}
              value={mode}
              checked={current === mode}
              onChange={() => {
                if (mode === current) return;
                void run({ type: "ui.agent.site-mode", payload: { site, mode } }, () =>
                  notify(t("settings.sites.modeChanged", { site: label, mode: t(`settings.mode.${mode}`) })),
                );
              }}
            />
            {t(`settings.mode.${mode}`)}
          </label>
        ))}
      </fieldset>
      <button
        ref={revoke}
        type="button"
        className="btn quiet"
        aria-label={t("settings.sites.revokeLabel", { site: label })}
        onClick={() => props.onConfirm(true)}
      >
        {t("settings.sites.revoke")}
      </button>
      <p className="mode-help" id={helpId}>
        {t(`settings.mode.${current}.meaning`)}
      </p>
      <div className="site-extra">
        {/* 004 FR-049: a consent of its own, never set by a mode; the site rides in its accessible name. */}
        <label className="site-diagnostics">
          <input
            type="checkbox"
            aria-label={t("settings.sites.diagnosticsLabel", { site: label })}
            checked={diagnosticsGranted}
            onChange={(event) => {
              void run({ type: "ui.agent.set-diagnostics", payload: { site, granted: event.target.checked } });
            }}
          />
          {t("settings.sites.diagnostics")}
        </label>
        {/* 019 FR-308, R-328: who made the last change; a record from before 019 names nobody. */}
        {changedBy === undefined ? null : <span className="meta site-author">{t(`settings.sites.changedBy.${changedBy}`)}</span>}
      </div>
      {props.confirming ? (
        <div className="site-confirm" role="alert">
          <span>{t("settings.sites.revokeConfirm", { site: label })}</span>
          <button
            ref={confirmYes}
            type="button"
            className="btn danger"
            onClick={() => {
              const was = current;
              const wasGranted = diagnosticsGranted;
              props.onConfirm(false);
              void run({ type: "ui.agent.site-clear", payload: { site } }, () =>
                notify(t("settings.sites.revoked", { site: label }), {
                  action: {
                    label: t("settings.sites.undo"),
                    // The decision comes back as it was: the mode it had, then - its own consent, and
                    // only if it was on - the diagnostics grant the revoke took with the record.
                    run: () => {
                      void run({ type: "ui.agent.site-mode", payload: { site, mode: was } }).then((ok) => {
                        if (ok && wasGranted) void run({ type: "ui.agent.set-diagnostics", payload: { site, granted: true } });
                      });
                    },
                  },
                }),
              );
            }}
          >
            {t("settings.sites.revoke")}
          </button>
          <button type="button" className="btn" onClick={() => props.onConfirm(false)}>
            {t("settings.sites.keep")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** 014 FR-191: the moves the owner said "always" to, each with a way to forget it. Absent when there are none. */
export function RememberedMoves(): ReactElement | null {
  const { state, t, run, locale, now } = useSettings();
  const headingId = useId();
  const moves = state.transitions ?? [];
  if (moves.length === 0) return null;
  return (
    <section className="blk" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("settings.transitions.title")}</h3>
      <ul className="site-list">
        {moves.map((move) => {
          const from = siteLabel(move.from);
          const to = siteLabel(move.to);
          return (
            <li key={`${move.from}→${move.to}`} className="row-item" data-transition={`${move.from}→${move.to}`}>
              <span className="grow">
                <strong>{t("settings.transitions.row", { from, to })}</strong>
                <br />
                <span className="meta">
                  {move.lastUsedAt === undefined
                    ? t("settings.transitions.neverUsed")
                    : t("settings.transitions.lastUsed", { time: formatWhen(move.lastUsedAt, locale, now()) })}
                </span>
              </span>
              <button
                type="button"
                className="btn quiet"
                aria-label={t("settings.transitions.forget", { from, to })}
                onClick={() => {
                  void run({ type: "ui.agent.transition-clear", payload: { from: move.from, to: move.to } });
                }}
              >
                {t("settings.sites.revoke")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
