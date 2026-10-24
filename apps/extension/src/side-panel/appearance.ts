import { useEffect, useState } from "react";
import { agentAppearanceSchema, type AgentAppearance } from "@hallpass/contracts";
import { reportTestDiagnostic } from "../diagnostics.js";
import { selectLocale, type AppLocale } from "../locales/catalog.js";

/**
 * 024 D-024-20, R-382, T787 (panel half): the theme and language the settings page's top bar sets.
 *
 * The record lives in `chrome.storage.local` under `agentAppearance`, written by the service worker
 * alone; the panel only reads it, once when it opens and again on every `chrome.storage.onChanged`, so
 * a choice made on the page lands here without a reload. Nothing stored, or a record that does not
 * parse, is System / System - the panel as it was before the choice existed: the colours follow the
 * browser's scheme (tokens.css) and the words its UI language. Every storage access is wrapped, as the
 * panel's other preferences are: a storage that throws only means System.
 *
 * The key is a literal because the panel bundle imports nothing from the service worker.
 */
export const AGENT_APPEARANCE_STORAGE_KEY = "agentAppearance";
export const SYSTEM_APPEARANCE: AgentAppearance = { theme: "system", language: "system" };

/** The stored value as an appearance, or System / System for anything the schema does not accept. */
export function parseAppearance(value: unknown): AgentAppearance {
  const parsed = agentAppearanceSchema.safeParse(value);
  return parsed.success ? parsed.data : SYSTEM_APPEARANCE;
}

/** The panel's language: the owner's choice, else the browser's UI language (`system`). */
export function appearanceLocale(appearance: AgentAppearance, systemLocale: AppLocale): AppLocale {
  return appearance.language === "system" ? systemLocale : selectLocale(appearance.language);
}

/**
 * `data-theme` on the document element: `light` or `dark` pin the palette (appearance.css), `system`
 * takes the attribute off so the browser's own scheme decides.
 */
export function applyTheme(theme: AgentAppearance["theme"], root: HTMLElement = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** The owner's appearance choice, followed live. */
export function useAppearance(): AgentAppearance {
  const [appearance, setAppearance] = useState<AgentAppearance>(SYSTEM_APPEARANCE);
  useEffect(() => {
    let disposed = false;
    /** A change that arrived before the first read settled wins over it. */
    let changed = false;
    try {
      const read = chrome.storage?.local?.get?.(AGENT_APPEARANCE_STORAGE_KEY) as Promise<Record<string, unknown>> | undefined;
      void Promise.resolve(read)
        .then((items) => {
          if (!disposed && !changed) setAppearance(parseAppearance(items?.[AGENT_APPEARANCE_STORAGE_KEY]));
        })
        .catch(() => reportTestDiagnostic("agent.panel.appearance-unread"));
    } catch {
      reportTestDiagnostic("agent.panel.appearance-unread");
    }
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
      const change = changes[AGENT_APPEARANCE_STORAGE_KEY];
      if (area !== "local" || change === undefined || disposed) return;
      changed = true;
      setAppearance(parseAppearance(change.newValue));
    };
    const events = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
    events?.addListener(onChanged);
    return () => {
      disposed = true;
      events?.removeListener(onChanged);
    };
  }, []);
  return appearance;
}
