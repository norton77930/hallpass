import type { AppLocale } from "../locales/catalog.js";

/**
 * 024: a time as the owner reads it. Today shows the clock time, yesterday the locale's own word for
 * it, anything older the date; a value that is not a time is shown as it came.
 */
export function formatWhen(iso: string, locale: AppLocale, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days === 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
  return at.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** The time of a reading or a test, to the second. */
export function formatClock(iso: string, locale: AppLocale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
