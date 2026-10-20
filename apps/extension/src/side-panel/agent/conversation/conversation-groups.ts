import type { ConversationView } from "@hallpass/contracts";

/**
 * 020 T598, FR-321: how the conversation drawer orders and finds the owner's conversations.
 *
 * Groups go by last use on the owner's local calendar: Today is the current local day (a time ahead
 * of the clock counts as today), Last 7 days the seven local days before it, Earlier the rest (and a
 * time the browser cannot read). Inside a group the newest use comes first; the id breaks a tie so
 * the order holds across projections. Pure, so the boundaries are tested with a fixed "now".
 */

export type ConversationGroupName = "today" | "week" | "earlier";
export type ConversationGroup = { group: ConversationGroupName; entries: ConversationView[] };

const ORDER: readonly ConversationGroupName[] = ["today", "week", "earlier"];

/** ISO strings sort as text; the tie-break keeps the order stable across projections. */
function newestFirst(left: ConversationView, right: ConversationView): number {
  return right.lastUsedAt.localeCompare(left.lastUsedAt) || left.conversationId.localeCompare(right.conversationId);
}

function groupOf(lastUsedAt: string, startOfToday: number, startOfWeek: number): ConversationGroupName {
  const time = new Date(lastUsedAt).getTime();
  if (Number.isNaN(time)) return "earlier";
  if (time >= startOfToday) return "today";
  return time >= startOfWeek ? "week" : "earlier";
}

export function groupByLastUse(conversations: readonly ConversationView[], now: Date): ConversationGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Calendar days, not 7 x 24 h, so a daylight-saving change does not move the edge.
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  const buckets = new Map<ConversationGroupName, ConversationView[]>(ORDER.map((name) => [name, []]));
  for (const entry of [...conversations].sort(newestFirst)) {
    buckets.get(groupOf(entry.lastUsedAt, today.getTime(), weekStart.getTime()))?.push(entry);
  }
  return ORDER.flatMap((group) => {
    const entries = buckets.get(group) ?? [];
    return entries.length === 0 ? [] : [{ group, entries }];
  });
}

/** The drawer's search: part of the title, case ignored; an empty search keeps every entry. */
export function titleMatches(entry: ConversationView, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  return wanted === "" || entry.title.toLocaleLowerCase().includes(wanted);
}

/**
 * T602: a drawer entry's last use, short enough for one line: the time for today, month and day
 * earlier this year, and month, day and year before that (local calendar). A time the browser cannot
 * read is shown as it came.
 */
export function shortLastUse(iso: string, now: Date, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameYear = at.getFullYear() === now.getFullYear();
  const options: Intl.DateTimeFormatOptions =
    sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
      ? { timeStyle: "short" }
      : sameYear
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" };
  try {
    return new Intl.DateTimeFormat(locale, options).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(at);
  }
}
