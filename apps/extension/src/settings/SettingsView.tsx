import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  AGENT_APPEARANCE_LANGUAGES,
  AGENT_APPEARANCE_THEMES,
  type AgentAppearance,
  type ConversationAgent,
  type SettingsResult,
  type SettingsState,
  type SettingsToast,
} from "@hallpass/contracts";
import { summarize } from "./agent-model.js";
import { AgentsSection } from "./agents/AgentsSection.js";
import {
  SettingsContext,
  type AgentOutput,
  type NoticeOptions,
  type SendSettingsCommand,
  type SettingsCommandInput,
  type SettingsContextValue,
} from "./context.js";
import { ConnectionSection } from "./connection/ConnectionSection.js";
import { BrowserToolsSection } from "./tools/BrowserToolsSection.js";
import { SitesSection } from "./sites/SitesSection.js";
import { SETTINGS_SECTIONS, type SettingsRoute, type SettingsSection } from "./routes.js";
import { makeTranslate, resolveLocale } from "./settings-text.js";
import "../side-panel/agent/tokens.css";
import "./settings.css";

export type SettingsViewProps = {
  state: SettingsState;
  send: SendSettingsCommand;
  route: SettingsRoute;
  appearance: AgentAppearance;
  onNavigate?: (route: SettingsRoute) => void;
  /** The browser's UI language, for System. */
  systemLanguage?: string;
  output?: Partial<Record<ConversationAgent, AgentOutput>>;
  /** The latest `worker.settings.toast`; `seq` changes with each one so the same toast twice is two toasts. */
  toast?: (SettingsToast & { seq: number }) | undefined;
  now?: () => Date;
  /** The connector gave up reconnecting: said at the top, above whatever was last shown. */
  lost?: boolean;
};

type Notice = { id: number; text: string; action?: NonNullable<NoticeOptions["action"]> };

/** How long a notice stays: the Undo of a revoke gets a few seconds more (FR-385). */
const NOTICE_MS = 3_000;
const NOTICE_WITH_ACTION_MS = 7_000;

const SECTION_KEYS: Record<SettingsSection, { nav: string; desc: string }> = {
  agents: { nav: "settings.nav.agents", desc: "settings.agents.desc" },
  sites: { nav: "settings.nav.sites", desc: "settings.sites.desc" },
  tools: { nav: "settings.nav.tools", desc: "settings.tools.desc" },
  connection: { nav: "settings.nav.connection", desc: "settings.connection.desc" },
};

/**
 * 024 FR-375, FR-376, D-024-7 (layout A): the settings page as a pure view of the projection - a top
 * bar (title, theme, language), a left navigation of four sections with counts and a warning mark, and
 * the section on the right. Nothing here touches `chrome.*`: it gets the projection, a way to send a
 * command and learn its result, the route and the appearance, and says what happened in a polite
 * notice. The connector (`SettingsConnector`) is the one that owns the port.
 */
export function SettingsView(props: SettingsViewProps): ReactElement {
  const { state, appearance, route } = props;
  const locale = resolveLocale(appearance.language, props.systemLanguage ?? "en-US");
  const t = useMemo(() => makeTranslate(locale), [locale]);
  const nameOf = useCallback((agent: ConversationAgent): string => t(`conversation.agent.${agent}`), [t]);
  const nowOf = props.now ?? (() => new Date());

  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const noticeId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const latestState = useRef(state);
  latestState.current = state;
  const sendRef = useRef(props.send);
  sendRef.current = props.send;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const notify = useCallback((text: string, options?: NoticeOptions): void => {
    if (!mounted.current) return;
    noticeId.current += 1;
    const id = noticeId.current;
    setNotice({ id, text, ...(options?.action === undefined ? {} : { action: options.action }) });
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice((current) => (current?.id === id ? undefined : current)), options?.action === undefined ? NOTICE_MS : NOTICE_WITH_ACTION_MS);
  }, []);

  const run = useCallback(
    async (command: SettingsCommandInput, onOk?: (result: SettingsResult) => void): Promise<boolean> => {
      let result: SettingsResult;
      try {
        result = await sendRef.current(command);
      } catch {
        notify(t("settings.error.generic"));
        return false;
      }
      if (!result.ok) {
        notify(t("settings.error.generic"));
        return false;
      }
      if (command.type === "ui.settings.choices-set" && result.defaultMovedTo !== undefined) {
        notify(
          result.defaultMovedTo === null ? t("settings.default.none") : t("settings.default.moved", { agent: nameOf(result.defaultMovedTo) }),
        );
      }
      onOk?.(result);
      return true;
    },
    [nameOf, notify, t],
  );

  // The worker's own word that something finished (FR-379: told once, to every open page).
  const toastSeq = props.toast?.seq;
  useEffect(() => {
    const toast = props.toast;
    if (toast === undefined) return;
    const agent = toast.agent === null ? "" : nameOf(toast.agent);
    notify(
      toast.kind === "install-done"
        ? t("settings.toast.downloadDone", { agent })
        : toast.kind === "install-failed"
          ? t("settings.toast.downloadFailed", { agent })
          : toast.kind === "test-done"
            ? t("settings.toast.testDone", { agent })
            : toast.agent === null
              ? t("settings.default.none")
              : t("settings.default.moved", { agent }),
    );
    // Only a new toast speaks; a re-render with the same one is not another toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastSeq]);

  // D-024-20: the page follows the appearance at once - the theme as `data-theme`, the language as `lang`.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    if (appearance.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", appearance.theme);
    document.title = t("settings.title");
  }, [appearance.theme, locale, t]);

  // Pressing a navigation entry moves the reader to the new heading; opening the page does not.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstSection = useRef(route.section);
  useEffect(() => {
    if (firstSection.current === route.section) return;
    firstSection.current = route.section;
    heading.current?.focus({ preventScroll: true });
  }, [route.section]);

  const value: SettingsContextValue = {
    state,
    appearance,
    locale,
    t,
    send: props.send,
    run,
    notify,
    latest: () => latestState.current,
    nameOf,
    output: props.output ?? {},
    now: nowOf,
  };

  const summary = summarize(state, nameOf);
  const warned = summary.warnings > 0;
  const lines = [
    t("settings.summary.ready", { ready: summary.ready, total: summary.total }),
    ...(summary.downloading > 0 ? [t("settings.summary.downloading", { count: summary.downloading })] : []),
    ...(summary.attention > 0 ? [t("settings.summary.attention", { count: summary.attention })] : []),
    ...(summary.warnings > 0 ? [t("settings.summary.warnings", { count: summary.warnings })] : []),
  ];
  const sites = state.sites.length;
  const go = (section: SettingsSection): void => props.onNavigate?.({ section });

  const setAppearance = (change: Partial<AgentAppearance>): void => {
    void run({ type: "ui.settings.appearance-set", payload: change });
  };

  return (
    <SettingsContext.Provider value={value}>
      <div className="agent-shell settings-page">
        {props.lost === true ? (
          <p className="note bad connection-lost" role="alert">
            {t("settings.connectionLost")}
          </p>
        ) : null}
        <header className="top">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              H
            </span>
            <h1>{t("settings.title")}</h1>
          </span>
          <span className="grow" />
          <div className="prefs">
            <label className="pref-label" htmlFor="settings-theme">
              {t("settings.themeLabel")}
            </label>
            <select
              id="settings-theme"
              className="sel"
              value={appearance.theme}
              onChange={(event) => setAppearance({ theme: event.target.value as AgentAppearance["theme"] })}
            >
              {AGENT_APPEARANCE_THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {t(`settings.theme.${theme}`)}
                </option>
              ))}
            </select>
            <label className="pref-label" htmlFor="settings-language">
              {t("settings.languageLabel")}
            </label>
            <select
              id="settings-language"
              className="sel"
              value={appearance.language}
              onChange={(event) => setAppearance({ language: event.target.value as AgentAppearance["language"] })}
            >
              {AGENT_APPEARANCE_LANGUAGES.map((language) => (
                <option key={language} value={language} lang={language === "system" ? undefined : language}>
                  {t(`settings.language.${language}`)}
                </option>
              ))}
            </select>
          </div>
        </header>
        <div className="shell">
          <nav className="side" aria-label={t("settings.nav.label")}>
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                data-section={section}
                data-fid={`nav-${section}`}
                aria-current={route.section === section ? "page" : undefined}
                onClick={() => go(section)}
              >
                {t(SECTION_KEYS[section].nav)}
                {section === "agents" ? (
                  <>
                    <span className="count" aria-hidden="true">
                      {summary.ready}/{summary.total}
                    </span>
                    {warned ? (
                      <>
                        <span className="dot" aria-hidden="true" />
                        <span className="sr-only">{t("settings.nav.warningMark")}</span>
                      </>
                    ) : null}
                  </>
                ) : null}
                {section === "sites" ? (
                  <>
                    <span className="count" aria-hidden="true">
                      {sites}
                    </span>
                    <span className="sr-only">{t(sites === 1 ? "settings.nav.siteCountOne" : "settings.nav.siteCount", { count: sites })}</span>
                  </>
                ) : null}
              </button>
            ))}
            <div className="side-sum">
              <strong>{lines[0]}</strong>
              {lines.slice(1).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          </nav>
          <main>
            <div className="sec-head">
              <h2 id="sec-title" ref={heading} tabIndex={-1}>
                {t(SECTION_KEYS[route.section].nav)}
              </h2>
              <p>{t(SECTION_KEYS[route.section].desc)}</p>
            </div>
            {route.section === "agents" ? <AgentsSection route={route} /> : null}
            {route.section === "sites" ? <SitesSection route={route} /> : null}
            {route.section === "tools" ? <BrowserToolsSection /> : null}
            {route.section === "connection" ? <ConnectionSection /> : null}
          </main>
        </div>
        <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
          {notice === undefined ? null : (
            <div className="toast" data-notice="">
              <span>{notice.text}</span>
              {notice.action === undefined ? null : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const action = notice.action;
                    setNotice(undefined);
                    action?.run();
                  }}
                >
                  {notice.action.label}
                </button>
              )}
              <button type="button" className="btn toast-close" aria-label={t("settings.toast.dismiss")} onClick={() => setNotice(undefined)}>
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}

