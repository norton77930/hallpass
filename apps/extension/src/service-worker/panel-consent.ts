/**
 * 019 D-019-7, D-019-11, FR-299, FR-309, T553: the one-time consent "Side-panel agent may use this
 * browser", as the worker keeps it.
 *
 * The broker keeps its own copy (it decides whether a connector may be downloaded, and the overview
 * carries it so a restarted worker can show it), but admission to this browser is the worker's
 * decision and so reads the worker's own record: a broker cannot admit a panel session by saying the
 * owner agreed. Stored in `chrome.storage.local` because it is the owner's standing decision, as the
 * site modes are. Read fails closed: a missing, unreadable or malformed record is "unknown", which
 * admits nothing.
 */

export const PANEL_CONSENT_KEY = "agentPanelConsent";

export type PanelConsentState = "unknown" | "granted" | "withdrawn";

export type PanelConsentStore = {
  read: () => Promise<PanelConsentState>;
  /** The owner's answer; resolves once written. A failed write leaves the cached answer standing. */
  write: (granted: boolean) => Promise<void>;
  /** The last answer read or written, without waiting; "unknown" before the first read. */
  current: () => PanelConsentState;
};

function storageArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
}

function parse(value: unknown): PanelConsentState {
  if (typeof value !== "object" || value === null) return "unknown";
  const granted = (value as { granted?: unknown }).granted;
  return granted === true ? "granted" : granted === false ? "withdrawn" : "unknown";
}

export function createPanelConsentStore(now: () => string = () => new Date().toISOString()): PanelConsentStore {
  let cached: PanelConsentState | undefined;
  return {
    async read() {
      if (cached !== undefined) return cached;
      const area = storageArea();
      if (!area) return "unknown";
      try {
        const raw = (await area.get([PANEL_CONSENT_KEY])) as Record<string, unknown>;
        // Kept only once read: a failed read is asked again next time rather than remembered.
        cached ??= parse(raw[PANEL_CONSENT_KEY]);
        return cached;
      } catch {
        return "unknown";
      }
    },
    async write(granted) {
      // The answer applies at once - a withdrawal must refuse the very next call (FR-309) even if
      // the storage write is still on its way or fails.
      cached = granted ? "granted" : "withdrawn";
      await storageArea()?.set({ [PANEL_CONSENT_KEY]: { granted, at: now() } });
    },
    current() {
      return cached ?? "unknown";
    },
  };
}
