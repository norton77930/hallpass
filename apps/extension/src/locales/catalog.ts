import { messages as enMessages, type MessageKey } from "./en-US.js";
import { messages as zhMessages } from "./zh-TW.js";

export const FALLBACK_LOCALE = "en-US" as const;
export type AppLocale = "en-US" | "zh-TW";
export const inertRenderMode = "text" as const;

const catalogs: Record<AppLocale, Record<MessageKey, string>> = {
  "en-US": enMessages,
  "zh-TW": zhMessages,
};

const SAFETY_KEYS = [
  "safety.disclosureTitle",
  "safety.purpose",
  "safety.recipient",
  "safety.categoryOrigin",
  "safety.continue",
] as const satisfies readonly MessageKey[];

export function selectLocale(raw: string): AppLocale {
  return raw === "zh-TW" ? "zh-TW" : "en-US";
}

export function lookup(key: string, localeRaw: string): string {
  if (!isMessageKey(key)) {
    return catalogs[FALLBACK_LOCALE]["workspace.title"];
  }
  const locale = selectLocale(localeRaw);
  return catalogs[locale][key] || catalogs[FALLBACK_LOCALE][key];
}

export function lookupSafety(
  key: string,
  localeRaw: string,
): { ok: true; text: string } | { ok: false } {
  if (!isMessageKey(key)) {
    return { ok: false };
  }
  const selected = catalogs[selectLocale(localeRaw)][key].trim();
  const english = catalogs[FALLBACK_LOCALE][key].trim();
  const text = selected || english;
  if (!text) {
    return { ok: false };
  }
  if ((SAFETY_KEYS as readonly string[]).includes(key) && (!selected && !english)) {
    return { ok: false };
  }
  return { ok: true, text };
}

export function renderInertText(value: string): string {
  return value;
}

function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(enMessages, key);
}
