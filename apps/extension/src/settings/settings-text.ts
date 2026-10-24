import { lookup, selectLocale, type AppLocale } from "../locales/catalog.js";

/**
 * 024: the page's way of reading a message. A placeholder is `{name}` and is replaced with a function,
 * so a value holding `$&` or `$1` (an agent's own stated name, a folder) is inserted as written.
 */
export type TextVars = Record<string, string | number>;
export type Translate = (key: string, vars?: TextVars) => string;

export function makeTranslate(locale: AppLocale): Translate {
  return (key, vars) => {
    const text = lookup(key, locale);
    if (vars === undefined) return text;
    return text.replace(/\{([a-zA-Z]+)\}/gu, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
  };
}

/**
 * The language the page is shown in: the owner's choice, or - for System - the browser's UI language.
 * `selectLocale` is the panel's own rule (zh-TW, else English).
 */
export function resolveLocale(language: "system" | AppLocale, systemLanguage: string): AppLocale {
  return language === "system" ? selectLocale(systemLanguage) : language;
}
