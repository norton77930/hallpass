import { describe, expect, it } from "vitest";
import type { ConversationView } from "@hallpass/contracts";
import { groupByLastUse, shortLastUse, titleMatches } from "../src/side-panel/agent/conversation/conversation-groups.js";

/**
 * 020/T598, FR-321 - the drawer's groups: Today, Last 7 days, Earlier, by last use on the owner's
 * local calendar. The dates are built in local time, so the test holds in any time zone.
 */

const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString();
const entry = (conversationId: string, lastUsedAt: string, title = conversationId): ConversationView => ({
  conversationId,
  agent: "claude-code",
  title,
  folder: { kind: "scratch" },
  mode: "strict",
  createdAt: lastUsedAt,
  lastUsedAt,
  resumable: true,
  state: "idle",
});
const NOW = new Date(2026, 9, 20, 9, 30);
const ids = (groups: ReturnType<typeof groupByLastUse>) =>
  groups.map((group) => [group.group, group.entries.map((item) => item.conversationId)]);

describe("T598 groupByLastUse", () => {
  it("puts today, the last seven days and anything older in that order, newest first in each", () => {
    const groups = groupByLastUse(
      [
        entry("old", at(2026, 10, 1)),
        entry("today-early", at(2026, 10, 20, 0, 5)),
        entry("yesterday", at(2026, 10, 19, 23, 59)),
        entry("today-late", at(2026, 10, 20, 9, 0)),
        entry("week-edge", at(2026, 10, 13, 0, 0)),
        entry("just-before", at(2026, 10, 12, 23, 59)),
      ],
      NOW,
    );
    expect(ids(groups)).toEqual([
      ["today", ["today-late", "today-early"]],
      ["week", ["yesterday", "week-edge"]],
      ["earlier", ["just-before", "old"]],
    ]);
  });

  it("leaves out an empty group", () => {
    expect(ids(groupByLastUse([entry("a", at(2026, 9, 1))], NOW))).toEqual([["earlier", ["a"]]]);
    expect(groupByLastUse([], NOW)).toEqual([]);
  });

  it("counts a time ahead of the clock as today and an unreadable one as earlier", () => {
    expect(ids(groupByLastUse([entry("ahead", at(2026, 10, 21, 8)), entry("bad", "not a date")], NOW))).toEqual([
      ["today", ["ahead"]],
      ["earlier", ["bad"]],
    ]);
  });

  it("breaks a tie on the id, so the order holds across projections", () => {
    const same = at(2026, 10, 20, 8);
    expect(ids(groupByLastUse([entry("b", same), entry("a", same)], NOW))).toEqual([["today", ["a", "b"]]]);
  });
});

describe("T598 titleMatches", () => {
  it("matches part of a title, ignoring case and surrounding spaces; an empty search matches all", () => {
    const item = entry("x", at(2026, 10, 20), "Summarise this Table");
    expect(titleMatches(item, "table")).toBe(true);
    expect(titleMatches(item, "  THIS t ")).toBe(true);
    expect(titleMatches(item, "chart")).toBe(false);
    expect(titleMatches(item, "")).toBe(true);
    expect(titleMatches(item, "   ")).toBe(true);
  });
});

describe("T602 shortLastUse", () => {
  it("says the time for today, month and day this year, and adds the year before that", () => {
    expect(shortLastUse(at(2026, 10, 20, 11, 50), NOW, "en-US")).toBe(new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(2026, 9, 20, 11, 50)));
    expect(shortLastUse(at(2026, 10, 18, 11, 49), NOW, "en-US")).toBe("Oct 18");
    expect(shortLastUse(at(2025, 12, 31, 23, 0), NOW, "en-US")).toBe("Dec 31, 2025");
  });

  it("shows a time it cannot read as it came", () => {
    expect(shortLastUse("not a date", NOW, "en-US")).toBe("not a date");
  });
});
