/**
 * 036 T1065: a capture fixture for the session cards, not a product entry and not a build input.
 *
 * It renders the REAL `SessionList` - the same grouping, fold state and `SessionCard` the Sessions tab
 * uses - for the six-session fixture the owner chose the layout on, at the side panel width. The
 * locale and the colour scheme come from the query string (`?locale=zh-TW|en-US&scheme=light|dark`),
 * and `capture-session-cards.mjs` takes one screenshot per pair from a running
 * `npx vite --mode agent` (run in apps/extension).
 */
import { createRoot } from "react-dom/client";
import "../../src/side-panel/agent/tokens.css";
import "../../src/side-panel/agent/agent.css";
import { SessionList } from "../../src/side-panel/agent/SessionList.js";
import type { SessionView } from "../../src/side-panel/agent/session-card-model.js";

const base = 1794879540000;
const at = (min: number): number => base + min * 60_000;
const iso = (min: number): string => new Date(at(min)).toISOString();

const MARKET = "https://market-weekly-71p.pages.dev";
const DASH = "https://dash.cloudflare.com";
const ACCESS = "https://polished-tooth-cac5.cloudflareaccess.com";

const NOW = at(70);

const SESSIONS: SessionView[] = [
  {
    sessionId: "s-fixture-1",
    agentId: "a1",
    agentName: "claude-code",
    label: "integration-v1",
    tabs: [{ tabId: 11, title: "", url: MARKET }] as unknown as SessionView["tabs"],
    sites: ["market-weekly-71p.pages.dev"],
    state: "idle",
    startedAt: iso(0),
    colour: "cyan",
    lastActivityAt: iso(58),
    inFlight: 0,
    site: MARKET,
    grants: [
      { site: MARKET, kind: "page-actions", source: "browser" },
      { site: MARKET, kind: "diagnostics", source: "client" },
    ],
    sitePlan: { origins: [DASH, ACCESS] },
    activity: [
      { at: at(58), kind: "resume", outcome: "resumed" },
      { at: at(55), kind: "hold", outcome: "held" },
      { at: at(51), kind: "resume", outcome: "resumed" },
      { at: at(49), kind: "hold", outcome: "held" },
      { at: at(40), kind: "consent", question: "effect", site: MARKET, channel: "client", answer: "once" },
      { at: at(33), kind: "consent", question: "diagnostics", site: MARKET, channel: "client", answer: "session" },
      { at: at(21), kind: "consent", question: "transition", site: ACCESS, channel: "browser", answer: "session" },
      { at: at(14), kind: "consent", question: "effect", site: MARKET, channel: "browser", answer: "session" },
      { at: at(12), kind: "consent", question: "transition", site: MARKET, channel: "browser", answer: "session" },
      { at: at(5), kind: "consent", question: "transition", site: DASH, channel: "browser", answer: "session" },
      { at: at(3), kind: "site-plan", outcome: "approved", message: "2" },
      { at: at(3), kind: "consent", question: "site-plan", site: DASH, channel: "browser", answer: "session" },
    ] as SessionView["activity"],
  },
  {
    sessionId: "s-fixture-2",
    agentId: "a1",
    agentName: "codex",
    label: "docs-refresh",
    tabs: [{ tabId: 21 }, { tabId: 22 }] as unknown as SessionView["tabs"],
    sites: ["github.com"],
    state: "working",
    startedAt: iso(52),
    colour: "green",
    lastActivityAt: iso(70),
    inFlight: 1,
    site: "https://github.com",
    grants: [{ site: "https://github.com", kind: "page-actions", source: "browser" }],
    activity: [
      { at: at(66), kind: "consent", question: "effect", site: "https://github.com", channel: "browser", answer: "session" },
      { at: at(60), kind: "dialog", site: "https://github.com", outcome: "accepted", message: "Leave site? Changes you made may not be saved." },
    ] as SessionView["activity"],
  },
  {
    sessionId: "s-fixture-3",
    agentId: "a1",
    agentName: "claude-code",
    label: "weekly-report",
    tabs: [{ tabId: 31 }] as unknown as SessionView["tabs"],
    sites: ["docs.google.com"],
    state: "waiting",
    startedAt: iso(61),
    colour: "purple",
    lastActivityAt: iso(69),
    inFlight: 1,
    site: "https://docs.google.com",
  },
  ...["hallpass-e2e", "price-scraper", "inbox-triage"].map(
    (label, index): SessionView => ({
      sessionId: `s-fixture-idle-${index}`,
      agentId: "a1",
      agentName: index === 1 ? "hermes" : "claude-code",
      label,
      tabs: [] as unknown as SessionView["tabs"],
      sites: [],
      state: "idle",
      startedAt: iso(-120 - index * 30),
      colour: (["orange", "grey", "blue"] as const)[index],
      lastActivityAt: iso(-40 - index * 25),
      inFlight: 0,
      ...(index === 1 ? { heldAt: iso(-50) } : {}),
      activity: [
        { at: at(-40 - index * 25), kind: "consent", question: "effect", site: "https://localhost:19443", channel: "client", answer: "once" },
      ] as SessionView["activity"],
    }),
  ),
];

const query = new URLSearchParams(window.location.search);
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-TW";
document.documentElement.lang = locale;

const noop = (): void => undefined;

createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="agent-shell" style={{ width: 360, minHeight: "100vh", overflow: "visible" }}>
    <SessionList
      sessions={SESSIONS}
      locale={locale}
      now={NOW}
      agentName={() => "claude-code"}
      // The first card is open, as the layout was chosen on it; every other card keeps the default the shell gives it.
      initialChoices={new Map([["s-fixture-1", true]])}
      handlers={{
        onStop: noop,
        onRelease: noop,
        onInterrupt: noop,
        onResume: noop,
        onWithdrawSitePlan: noop,
        onManageSite: noop,
      }}
    />
  </div>,
);
