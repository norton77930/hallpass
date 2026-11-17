import { describe, expect, it } from "vitest";
import type { AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import {
  advanceFolds,
  clockOfMs,
  groupSessions,
  isOpen,
  needsOwner,
  noFolds,
  primaryAction,
  rowsOf,
  sitesOf,
  toggleFold,
} from "../src/side-panel/agent/session-card-model.js";

/**
 * 036 - the session card's parts, made from the picture the worker already sends (FR-557).
 *
 * Pure rules only: which sites a card lists and with what marks (R-534, FR-545, FR-546), the activity
 * rows with Stop/Resume pairs and the site-plan answer folded (R-535, FR-549, FR-550), and which cards
 * need the owner, in which group, open or folded (R-536, R-537, FR-538 - FR-540).
 */
type Session = AgentPanelState["sessions"][number];
type Activity = NonNullable<Session["activity"]>[number];

const MARKET = "https://market.test";
const DASH = "https://dash.test";
const ACCESS = "https://access.test";
const en = (key: string): string => lookup(key, "en-US");
const zh = (key: string): string => lookup(key, "zh-TW");

const session = (over: Partial<Session> = {}): Session =>
  ({ sessionId: "s-1", agentId: "agent-1", tabs: [], sites: [], state: "idle", ...over }) as Session;
const tab = (url?: string, tabId = 1): Session["tabs"][number] =>
  ({ tabId, ...(url === undefined ? {} : { url }), title: "", active: false, holder: "this" }) as Session["tabs"][number];

describe("sitesOf (R-534, FR-545, FR-546)", () => {
  it("lists held sites first, then sites with grants, then the rest of the plan, each once", () => {
    const rows = sitesOf(
      session({
        tabs: [tab(`${MARKET}/cart`, 1), tab(`${MARKET}/pay`, 2)],
        sites: ["market.test"],
        grants: [
          { site: DASH, kind: "page-actions", source: "browser" },
          { site: MARKET, kind: "page-actions", source: "browser" },
          { site: MARKET, kind: "diagnostics", source: "client" },
        ],
        sitePlan: { origins: [DASH, ACCESS] },
      }),
    );

    expect(rows.map((row) => row.origin)).toEqual([MARKET, DASH, ACCESS]);
    expect(rows.map((row) => [row.tabHere, row.inPlan])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    expect(rows[0]?.grants).toEqual([
      { kind: "page-actions", source: "browser" },
      { kind: "diagnostics", source: "client" },
    ]);
    expect(rows[1]?.grants).toEqual([{ kind: "page-actions", source: "browser" }]);
    expect(rows[2]?.grants).toEqual([]);
  });

  it("shows a host with no scheme, keeping a port that is not the default", () => {
    const rows = sitesOf(
      session({
        tabs: [tab("http://localhost:3100/app")],
        sites: ["localhost:3100"],
        grants: [{ site: "https://fixtures.test:19443", kind: "diagnostics", source: "client" }],
      }),
    );

    expect(rows.map((row) => row.host)).toEqual(["localhost:3100", "fixtures.test:19443"]);
    expect(rows.map((row) => row.origin)).toEqual(["http://localhost:3100", "https://fixtures.test:19443"]);
    for (const row of rows) expect(row.host).not.toContain("://");
  });

  it("shows an internationalised host in both forms, without the scheme", () => {
    const [row] = sitesOf(session({ grants: [{ site: "https://xn--r8jz45g.jp", kind: "page-actions", source: "browser" }] }));

    expect(row?.origin).toBe("https://xn--r8jz45g.jp");
    expect(row?.host).toBe("例え.jp (xn--r8jz45g.jp)");
  });

  it("lists a held host whose tab url did not parse by its host, with no origin", () => {
    const rows = sitesOf(session({ tabs: [tab(undefined, 21), tab("not a url", 22)], sites: ["github.com"] }));

    expect(rows).toEqual([{ host: "github.com", tabHere: true, inPlan: false, grants: [] }]);
  });

  it("gives a hostless held row its origin when a grant names the same host, never listing it twice", () => {
    const rows = sitesOf(
      session({
        tabs: [tab(undefined)],
        sites: ["github.com"],
        grants: [{ site: "https://github.com", kind: "page-actions", source: "browser" }],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: "https://github.com",
      host: "github.com",
      tabHere: true,
      grants: [{ kind: "page-actions", source: "browser" }],
    });
  });

  it("matches origins by exact string, so http and https on one host are two sites", () => {
    const rows = sitesOf(
      session({ grants: [{ site: "https://a.test", kind: "page-actions", source: "browser" }], sitePlan: { origins: ["http://a.test"] } }),
    );

    expect(rows.map((row) => row.origin)).toEqual(["https://a.test", "http://a.test"]);
  });

  it("lists the site the worker says the session acts on, once, after the held ones (024 FR-393)", () => {
    const rows = sitesOf(session({ tabs: [tab(`${MARKET}/a`)], site: MARKET }));
    expect(rows.map((row) => [row.origin, row.tabHere])).toEqual([[MARKET, true]]);

    const acting = sitesOf(session({ site: DASH }));
    expect(acting.map((row) => [row.origin, row.tabHere, row.inPlan])).toEqual([[DASH, false, false]]);
  });

  it("is empty for a session with no tab, grant or plan", () => {
    expect(sitesOf(session())).toEqual([]);
  });
});

describe("rowsOf (R-535, FR-549, FR-550, FR-555)", () => {
  const at = (n: number): number => 1_700_000_000_000 + n * 60_000;
  const hold = (n: number): Activity => ({ at: at(n), kind: "hold", outcome: "held" }) as Activity;
  const resume = (n: number): Activity => ({ at: at(n), kind: "resume", outcome: "resumed" }) as Activity;

  it("reads a Stop directly followed by its Resume as one row, newest item first", () => {
    const rows = rowsOf([resume(5), hold(4), { at: at(1), kind: "interrupt", outcome: "interrupted" } as Activity], en);

    expect(rows.map((row) => row.text)).toEqual([
      "You stopped it from the page, then resumed",
      "You interrupted a step",
    ]);
    expect(rows[0]).toMatchObject({ at: at(5), kind: "hold-resume", count: 1 });
    // The sentence says what happened, so no second outcome word follows it.
    expect(rows.map((row) => row.result)).toEqual([undefined, undefined]);
  });

  it("reads k such pairs in a row as one row with the count, in both languages", () => {
    const items = [resume(9), hold(8), resume(7), hold(6), resume(5), hold(4)];

    expect(rowsOf(items, en)[0]).toMatchObject({ kind: "hold-resume", count: 3, text: "You stopped and resumed it from the page 3 times" });
    expect(rowsOf(items, zh)[0]?.text).toBe("你從頁面停止又繼續了 3 次");
    expect(rowsOf(items, zh)).toHaveLength(1);
  });

  it("keeps a Stop alone and a Resume alone as their own rows, in the second person", () => {
    expect(rowsOf([hold(2)], en).map((row) => row.text)).toEqual(["You pressed Stop on the page"]);
    expect(rowsOf([resume(2)], en).map((row) => row.text)).toEqual(["You resumed the session"]);
    expect(rowsOf([hold(2)], zh)[0]?.text).toBe("你在頁面按了「停止」");
    // a Resume whose older neighbour is not a Stop is not a pair
    expect(rowsOf([resume(3), { at: at(2), kind: "interrupt" } as Activity], en)).toHaveLength(2);
  });

  it("folds a site-plan event and the consent answer for that plan at the same moment into one row", () => {
    const rows = rowsOf(
      [
        { at: at(3), kind: "site-plan", outcome: "approved", message: "2" },
        { at: at(3) + 800, kind: "consent", question: "site-plan", site: DASH, channel: "browser", answer: "session" },
        { at: at(1), kind: "interrupt" },
      ] as Activity[],
      en,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "site-plan", text: "Site plan for 2 sites", result: "Approved by you", tone: "ok", place: "browser" });
  });

  it("does not fold a consent answer for another question or from another moment into the plan row", () => {
    const rows = rowsOf(
      [
        { at: at(3), kind: "site-plan", outcome: "approved", message: "2" },
        { at: at(3), kind: "consent", question: "effect", site: DASH, channel: "browser", answer: "once" },
        { at: at(2), kind: "site-plan", outcome: "withdrawn", message: "2" },
        { at: at(2) - 5_000, kind: "consent", question: "site-plan", site: DASH, channel: "browser", answer: "session" },
      ] as Activity[],
      en,
    );

    expect(rows).toHaveLength(4);
  });

  it("reads a consent answer as the question and site, the answer as the result, and where it was given", () => {
    const rows = rowsOf(
      [
        { at: at(3), kind: "consent", question: "effect", site: "https://shop.test:8443", channel: "client", answer: "once" },
        { at: at(2), kind: "consent", question: "transition", site: "https://shop.test", channel: "browser", answer: "deny" },
        { at: at(1), kind: "consent", question: "effect", site: "https://shop.test", channel: "none", answer: "timed-out" },
      ] as Activity[],
      en,
    );

    expect(rows.map((row) => row.text)).toEqual(["Page actions · shop.test:8443", "Site change · shop.test", "Page actions · shop.test"]);
    expect(rows.map((row) => [row.result, row.tone, row.place])).toEqual([
      ["Allowed once", "ok", "client"],
      ["Refused", "danger", "browser"],
      ["No answer (timed out)", "warn", undefined],
    ]);
  });

  it("passes every other kind through with its own sentence, its outcome word and a tone, and no scheme (FR-549: only allowed is success; others muted)", () => {
    const rows = rowsOf(
      [
        { at: at(6), kind: "dialog", outcome: "accepted", site: "https://shop.test", message: "Delete?" },
        { at: at(5), kind: "dialog", outcome: "dismissed", site: "https://shop.test", message: "Leave?" },
        { at: at(4), kind: "upload", outcome: "delivered", site: "https://shop.test", message: "input" },
        { at: at(3), kind: "restore", outcome: "restored", message: "maximized" },
        { at: at(2), kind: "viewport", outcome: "set", message: "800x600" },
        { at: at(1), kind: "dialog", outcome: "refused", site: "https://shop.test", message: "No" },
      ] as Activity[],
      en,
    );

    expect(rows.map((row) => row.text)).toEqual([
      "shop.test says: Delete?",
      "shop.test says: Leave?",
      "File put into a form on shop.test",
      "Window put back to maximized",
      "Viewport set to 800x600",
      "shop.test says: No",
    ]);
    expect(rows.map((row) => [row.result, row.tone])).toEqual([
      ["OK pressed", "muted"],
      ["Cancelled", "muted"],
      ["Delivered", "muted"],
      ["Restored", "muted"],
      ["Set", "muted"],
      ["You refused", "danger"],
    ]);
    for (const row of rows) expect(row.text).not.toContain("https://");
  });

  it("reads an unknown kind from a newer worker as today's something-happened sentence", () => {
    const [row] = rowsOf([{ at: at(1), kind: "teleport" } as unknown as Activity], en);

    expect(row?.text).toBe("Something happened");
    expect(row?.tone).toBe("muted");
    expect(row?.result).toBeUndefined();
  });

  it("makes a row for every item that is not folded, so the count after Show all is the row count", () => {
    const items = [resume(9), hold(8), { at: at(7), kind: "interrupt" }, { at: at(6), kind: "other" }] as Activity[];

    expect(rowsOf(items, en)).toHaveLength(3);
    expect(rowsOf([], en)).toEqual([]);
  });

  it("reads the time of a row as the owner's local HH:mm", () => {
    const ms = new Date(2026, 10, 17, 9, 5).getTime();

    expect(clockOfMs(ms)).toBe("09:05");
  });
});

describe("what needs the owner (R-536, FR-538, FR-542)", () => {
  it("needs the owner while waiting, working, or stopped from the page - and not while idle", () => {
    expect(needsOwner(session({ state: "waiting" }))).toBe(true);
    expect(needsOwner(session({ state: "working" }))).toBe(true);
    expect(needsOwner(session({ state: "idle", heldAt: "2026-11-17T08:00:00.000Z" }))).toBe(true);
    expect(needsOwner(session({ state: "idle" }))).toBe(false);
    // a projection from before 016 carries no state and reads as working, as it always did
    expect(needsOwner(session({ state: undefined }))).toBe(true);
  });

  it("offers one primary action: answer, else resume, else interrupt, else none", () => {
    expect(primaryAction(session({ state: "waiting" }))).toBe("answer");
    expect(primaryAction(session({ state: "waiting", heldAt: "2026-11-17T08:00:00.000Z" }))).toBe("answer");
    expect(primaryAction(session({ state: "working", heldAt: "2026-11-17T08:00:00.000Z" }))).toBe("resume");
    expect(primaryAction(session({ state: "idle", heldAt: "2026-11-17T08:00:00.000Z" }))).toBe("resume");
    expect(primaryAction(session({ state: "working" }))).toBe("interrupt");
    expect(primaryAction(session({ state: "idle" }))).toBeUndefined();
  });

  it("splits sessions into attention and idle, each newest activity first, a missing time last", () => {
    const list = [
      session({ sessionId: "idle-old", lastActivityAt: "2026-11-17T08:00:00.000Z" }),
      session({ sessionId: "working-old", state: "working", lastActivityAt: "2026-11-17T08:10:00.000Z" }),
      session({ sessionId: "idle-new", lastActivityAt: "2026-11-17T09:00:00.000Z" }),
      session({ sessionId: "waiting-new", state: "waiting", lastActivityAt: "2026-11-17T09:30:00.000Z" }),
      session({ sessionId: "held", heldAt: "2026-11-17T07:00:00.000Z", lastActivityAt: "2026-11-17T08:20:00.000Z" }),
      session({ sessionId: "idle-none" }),
    ];

    const groups = groupSessions(list);

    expect(groups.attention.map((s) => s.sessionId)).toEqual(["waiting-new", "held", "working-old"]);
    expect(groups.idle.map((s) => s.sessionId)).toEqual(["idle-new", "idle-old", "idle-none"]);
    expect(list.map((s) => s.sessionId)[0]).toBe("idle-old");
  });
});

describe("open and folded (R-537, FR-539, FR-540)", () => {
  const idle = session({ sessionId: "i" });
  const working = session({ sessionId: "w", state: "working" });
  const waiting = session({ sessionId: "q", state: "waiting" });

  it("opens a card that needs the owner or is the only session, and folds the rest", () => {
    expect(isOpen(working, undefined, false)).toBe(true);
    expect(isOpen(waiting, undefined, false)).toBe(true);
    expect(isOpen(session({ heldAt: "2026-11-17T08:00:00.000Z" }), undefined, false)).toBe(true);
    expect(isOpen(idle, undefined, false)).toBe(false);
    expect(isOpen(idle, undefined, true)).toBe(true);
  });

  it("lets the owner's choice win", () => {
    expect(isOpen(working, false, false)).toBe(false);
    expect(isOpen(idle, true, false)).toBe(true);
  });

  it("toggles to the opposite of what is shown, and the choice sticks across pictures", () => {
    let folds = advanceFolds(noFolds, [idle, working]);
    folds = toggleFold(folds, idle, false);
    folds = toggleFold(folds, working, false);

    expect(folds.choices.get("i")).toBe(true);
    expect(folds.choices.get("w")).toBe(false);
    expect(advanceFolds(folds, [idle, working])).toBe(folds);
    expect(toggleFold(folds, idle, false).choices.get("i")).toBe(false);
  });

  it("clears the choice when a session starts to need the owner, so it opens", () => {
    let folds = advanceFolds(noFolds, [idle]);
    folds = toggleFold(folds, idle, false); // opened by the owner
    folds = toggleFold(folds, idle, false); // folded again
    expect(folds.choices.get("i")).toBe(false);

    folds = advanceFolds(folds, [{ ...idle, state: "waiting" }]);

    expect(folds.choices.has("i")).toBe(false);
    expect(isOpen({ ...idle, state: "waiting" }, folds.choices.get("i"), false)).toBe(true);
  });

  it("keeps a card the owner folded while it needed them folded until it next needs them", () => {
    let folds = advanceFolds(noFolds, [working]);
    folds = toggleFold(folds, working, false);
    expect(folds.choices.get("w")).toBe(false);

    folds = advanceFolds(folds, [{ ...working, state: "idle" }]);
    expect(folds.choices.get("w")).toBe(false);
    folds = advanceFolds(folds, [working]);
    expect(folds.choices.has("w")).toBe(false);
  });

  it("keeps an open card open when its session stops needing the owner", () => {
    let folds = advanceFolds(noFolds, [working]);
    const stopped = { ...working, state: "idle" as const };

    folds = advanceFolds(folds, [stopped]);

    expect(folds.choices.get("w")).toBe(true);
    expect(isOpen(stopped, folds.choices.get("w"), false)).toBe(true);
  });

  it("forgets choices for sessions that are no longer in the picture", () => {
    let folds = advanceFolds(noFolds, [idle, working]);
    folds = toggleFold(folds, idle, false);

    folds = advanceFolds(folds, [working]);

    expect(folds.choices.has("i")).toBe(false);
    expect(folds.seen.has("i")).toBe(false);
  });

  it("does not read the first sight of a session as a change", () => {
    const seeded = { choices: new Map([["q", false]]), seen: new Map<string, boolean>() };

    expect(advanceFolds(seeded, [waiting]).choices.get("q")).toBe(false);
  });
});
