import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { selectLocale, type AppLocale } from "../locales/catalog.js";

/**
 * The panel's shell, loaded lazily (003 M2 review A7, 006 S1).
 *
 * `lazy` keeps the shell in its own chunk rather than inside `side-panel.js`. Nothing depends on
 * the split any more now that the archived remote panel is gone, but the chunking is left as it
 * was: changing it here would change the artefact's file list for no behavioural reason.
 */
const AgentShell = lazy(async () => ({ default: (await import("./agent/AgentShell.js")).AgentShell }));

function selectUiLocale(): AppLocale {
  return selectLocale(
    typeof chrome !== "undefined" && chrome.i18n?.getUILanguage ? chrome.i18n.getUILanguage() : "en-US",
  );
}

/**
 * The panel (006 FR-088, D-006-2): status, consent and control for the local agent bridge, and
 * nothing of the archived remote path - no service status, no sign-in, no task workspace.
 */
export function App(): ReactElement {
  const [locale] = useState(selectUiLocale);
  // The document declares the language it is rendered in, or a screen reader reads reviewed zh-TW
  // copy with an en-US voice (review M16).
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <main className="app-shell">
      <Suspense fallback={null}>
        <AgentShell locale={locale} />
      </Suspense>
    </main>
  );
}
