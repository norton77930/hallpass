import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { activityText } from "../src/side-panel/agent/SessionCard.js";
import {
  IDLE,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 006/T191 — one card per live session (FR-087, US3).
 *
 * The card answers the owner's three questions about an agent at work - which agent, where, and
 * is it waiting on me - and offers the two things they can do about it. Stop and Release tabs are
 * sent for the session the card is about and no other, which is the whole reason there is a card
 * per session rather than one Stop for the browser.
 */
describe("T191 session card", () => {
  let port: FakeAgentPort;
  const SESSIONS: AgentPanelState = {
    ...IDLE,
    paired: [
      ...IDLE.paired,
      { agentId: "agent-2", displayName: "Second Agent", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" },
    ],
    sessions: [
      {
        sessionId: "session-a",
        agentId: "agent-1",
        tabs: [
          { tabId: 7, url: "https://shop.test/cart", title: "Cart - Shop", active: false, holder: "this" },
          { tabId: 8, url: "https://shop.test/pay", title: "Pay - Shop", active: false, holder: "this" },
        ],
        sites: ["shop.test"],
        state: "working",
        lastActivityAt: "2026-09-13T00:00:02.000Z",
      },
      {
        sessionId: "session-b",
        agentId: "agent-2",
        tabs: [{ tabId: 9, url: "https://docs.test/", title: "Docs", active: true, holder: "this" }],
        sites: ["docs.test", "api.test"],
        state: "waiting",
        lastActivityAt: "2026-09-13T00:00:01.000Z",
      },
    ],
  };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const card = (sessionId: string): HTMLElement => {
    const node = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (!(node instanceof HTMLElement)) throw new Error(`no card for ${sessionId}`);
    return node;
  };

  it("names the agent and the session, and lists the sites it holds tabs on - never a title", () => {
    renderShell();
    project(port, SESSIONS);

    const a = card("session-a");
    expect(a.textContent).toContain("Claude Code");
    expect(a.textContent).toContain(ui("agent.session.sites").replace("{sites}", "shop.test"));
    expect(a.textContent).not.toContain("Cart - Shop");
    expect(a.textContent).not.toContain("https://shop.test/cart");
    const b = card("session-b");
    expect(b.textContent).toContain("Second Agent");
    expect(b.textContent).toContain(ui("agent.session.sites").replace("{sites}", "docs.test, api.test"));
  });

  it("names each session by its own greeting, and falls back to the paired name only when the projection carries none", () => {
    // One agent id serves every MCP client on the machine (FR-087 follow-up, measured 2026-09-14):
    // two sessions of agent-1 are Cursor and Claude Code, and the paired record says only one name.
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        { sessionId: "session-a", agentId: "agent-1", agentName: "Cursor", tabs: [], sites: [], state: "working" },
        { sessionId: "session-c", agentId: "agent-1", tabs: [], sites: [], state: "working" },
      ],
    });

    expect(within(card("session-a")).getByRole("heading").textContent).toContain("Cursor");
    expect(within(card("session-a")).getByRole("heading").textContent).not.toContain("Claude Code");
    expect(within(card("session-c")).getByRole("heading").textContent).toContain("Claude Code");
  });

  it("says working or waiting for you, from the projection", () => {
    renderShell();
    project(port, SESSIONS);

    expect(card("session-a").textContent).toContain(ui("agent.session.working"));
    expect(card("session-b").textContent).toContain(ui("agent.session.waiting"));
    expect(card("session-a").getAttribute("data-session-state")).toBe("working");
    expect(card("session-b").getAttribute("data-session-state")).toBe("waiting");
  });

  it("stops exactly the session whose card was pressed", () => {
    renderShell();
    project(port, SESSIONS);

    fireEvent.click(within(card("session-b")).getByRole("button", { name: ui("agent.session.stop") }));

    expect(port.sent).toEqual([{ type: "ui.agent.session-stop", payload: { sessionId: "session-b" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("releases exactly the session whose card was pressed", () => {
    renderShell();
    project(port, SESSIONS);

    fireEvent.click(within(card("session-a")).getByRole("button", { name: ui("agent.session.release") }));

    expect(port.sent).toEqual([{ type: "ui.agent.session-release", payload: { sessionId: "session-a" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  /**
   * 014/T358 — 中斷 beside 停止 (FR-178).
   *
   * Three claims, and the third is the one that is easy to get wrong. The control names one
   * session, as every control on this card does. It reads as available exactly when the worker
   * says that session has a call in flight. And it is *pressable* either way: the count is a
   * picture that can be a moment old, so a press that finds nothing running says so rather than
   * doing nothing at all (US1 scenario 5).
   */
  it("interrupts exactly the session whose card was pressed, while it has a call in flight", () => {
    renderShell();
    project(port, {
      ...SESSIONS,
      sessions: [
        { ...SESSIONS.sessions[0]!, inFlight: 1 },
        { ...SESSIONS.sessions[1]!, inFlight: 0 },
      ],
    });

    const button = within(card("session-a")).getByRole("button", { name: ui("agent.session.interrupt") });
    expect(button.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(button);

    expect(port.sent).toEqual([{ type: "ui.agent.session-interrupt", payload: { sessionId: "session-a" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("says nothing was running rather than sending a command, when the session is idle", () => {
    renderShell();
    project(port, {
      ...SESSIONS,
      sessions: [{ ...SESSIONS.sessions[0]!, inFlight: 0 }],
    });

    const idle = within(card("session-a")).getByRole("button", { name: ui("agent.session.interrupt") });
    expect(idle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(idle);

    expect(port.sent, "a session with nothing running was sent an interrupt").toEqual([]);
    expect(card("session-a").textContent).toContain(ui("agent.session.nothingToInterrupt"));
  });

  it("reads a projection from before the count as nothing in flight", () => {
    renderShell();
    project(port, SESSIONS);

    const button = within(card("session-a")).getByRole("button", { name: ui("agent.session.interrupt") });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("says a session holds no tabs rather than listing nothing", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [{ sessionId: "session-c", agentId: "agent-1", tabs: [], sites: [], state: "working" }],
    });

    expect(card("session-c").textContent).toContain(ui("agent.session.noSites"));
  });

  /**
   * 008/T222 — the recording line (FR-108, FR-109).
   *
   * Three states and one silence. A card says how many frames while the recording runs, says the
   * cap is reached when it is - because "waiting for export" is the thing the owner can act on -
   * and names the file after the recording is gone, which is the only trace left of it. A session
   * that never recorded says nothing at all: a line reading "no recording" would be a fact about
   * nothing on every card the owner ever sees.
   */
  it("says how a session's recording stands, and nothing when there is none", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-r",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          recording: { state: "recording", frames: 12, skipped: 0, full: false },
        },
        {
          sessionId: "session-f",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          recording: { state: "stopped", frames: 200, skipped: 0, full: true },
        },
        {
          sessionId: "session-e",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          recording: { state: "none", frames: 0, skipped: 0, full: false, lastExport: "TC-1234.gif" },
        },
        { sessionId: "session-n", agentId: "agent-1", tabs: [], sites: [], state: "working" },
      ],
    });

    expect(card("session-r").textContent).toContain(ui("agent.session.recording").replace("{frames}", "12"));
    expect(card("session-f").textContent).toContain(ui("agent.session.recordingFull").replace("{frames}", "200"));
    expect(card("session-e").textContent).toContain(
      ui("agent.session.recordingExported").replace("{filename}", "TC-1234.gif"),
    );
    expect(card("session-n").querySelector(".agent-session-recording")).toBeNull();
  });

  /**
   * 008/T227 — the card's activity list (FR-113, US3 scenario 1).
   *
   * Every dialog is recorded here whatever the mode decided, because the owner may be looking
   * elsewhere when one is answered in a moment. The page's words are shown as the page wrote them,
   * and the outcome beside them is the panel's own reviewed sentence - never the worker's English.
   */
  it("lists what happened on the session's tabs, newest first, with the page's own words", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-x",
          agentId: "agent-1",
          tabs: [],
          sites: ["shop.test"],
          state: "working",
          activity: [
            { at: 1_700_000_002_000, kind: "dialog", outcome: "accepted-chained", site: "shop.test", message: "Delete 3 orders?" },
            { at: 1_700_000_001_000, kind: "dialog", outcome: "dismissed", site: "shop.test", message: "Leave without saving?" },
          ],
        },
        { sessionId: "session-none", agentId: "agent-1", tabs: [], sites: [], state: "working" },
      ],
    });

    const items = within(card("session-x")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(
      ui("agent.activity.dialog").replace("{site}", "shop.test").replace("{message}", "Delete 3 orders?"),
    );
    expect(items[0]?.textContent).toContain(ui("agent.activity.accepted-chained"));
    expect(items[1]?.textContent).toContain(ui("agent.activity.dismissed"));
    // A session nothing has happened on says nothing: an empty list is a fact about nothing.
    expect(card("session-none").querySelector(".agent-session-activity")).toBeNull();
  });

  /**
   * 008/T230 (S4 review): two things can happen in the same millisecond and end the same way - a
   * page that opens two dialogs at once, answered in one turn - and the timestamp and the outcome
   * were the whole of the key. React then has two children claiming the same identity, which it
   * reports and which makes what the owner sees depend on the order they arrived in.
   */
  it("keeps two items of the same millisecond and outcome apart", () => {
    const complaints: string[] = [];
    const seen = console.error;
    console.error = (...args: unknown[]) => void complaints.push(String(args[0]));
    try {
      renderShell();
      project(port, {
        ...IDLE,
        sessions: [
          {
            sessionId: "session-k",
            agentId: "agent-1",
            tabs: [],
            sites: ["shop.test"],
            state: "working",
            activity: [
              { at: 1_700_000_004_000, kind: "dialog", outcome: "accepted", site: "shop.test", message: "First?" },
              { at: 1_700_000_004_000, kind: "dialog", outcome: "accepted", site: "shop.test", message: "Second?" },
            ],
          },
        ],
      });

      const items = within(card("session-k")).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain("First?");
      expect(items[1]?.textContent).toContain("Second?");
      expect(complaints.join(" ")).not.toContain("same key");
    } finally {
      console.error = seen;
    }
  });

  /**
   * 008/T232 — a restore is not a dialog, and the card may not read it as one (FR-119).
   *
   * The worker sends the pieces (the state word) and the panel writes the sentence, as every other
   * line of this card does; without its own template the item would come out as the dialog
   * sentence with two empty holes in it.
   */
  it("says a window was given back, in the panel's own words", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-w",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          activity: [{ at: 1_700_000_003_000, kind: "restore", outcome: "restored", message: "maximized" }],
        },
      ],
    });

    const item = within(card("session-w")).getAllByRole("listitem")[0];
    expect(item?.textContent).toContain(
      ui("agent.activity.restore").replace("{state}", ui("agent.activity.windowMaximized")),
    );
    expect(item?.textContent).toContain(ui("agent.activity.restored"));
    expect(item?.textContent).not.toContain("{site}");
  });

  /**
   * 012/T308 — the emulated viewport, on the card (FR-159).
   *
   * The owner has no other way of knowing: the window is untouched and the page simply looks
   * different, so the line is what tells them a session is laying one of their tabs out at a size
   * it chose - and that it gave the page back. The worker sends `"WxH"`, the panel writes the
   * sentence, as it does for every other kind.
   */
  it("says a tab was given an emulated viewport, and that it was cleared", () => {
    const t = (key: string): string => lookup(key, "en-US");
    // The two templates, written from the pieces the worker sends: a size for the set and nothing
    // at all for the clear, which is a fact about the tab rather than about a size.
    expect(activityText({ at: 1_700_000_003_000, kind: "viewport", outcome: "set", message: "375x812" }, t)).toBe(
      "Viewport set to 375x812",
    );
    expect(activityText({ at: 1_700_000_004_000, kind: "viewport", outcome: "cleared" }, t)).toBe("Viewport cleared");

    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-v",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          activity: [
            { at: 1_700_000_004_000, kind: "viewport", outcome: "cleared" },
            { at: 1_700_000_003_000, kind: "viewport", outcome: "set", message: "375x812" },
          ],
        },
      ],
    });

    const items = within(card("session-v")).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Viewport cleared");
    expect(items[1]?.textContent).toContain("Viewport set to 375x812");
    expect(items[1]?.textContent).not.toContain("{size}");
  });

  /** 014/T358 — the line for the step the owner ended themselves (FR-182). */
  it("says the owner interrupted a step", () => {
    const t = (key: string): string => lookup(key, "en-US");
    const INTERRUPTED = { at: 1_700_000_006_000, kind: "interrupt", outcome: "interrupted" } as const;
    // No site and no message: the owner pressed a control on this card, and what the step was is
    // not something the panel should claim to know afterwards.
    expect(activityText(INTERRUPTED, t)).toBe("You interrupted a step");

    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        { sessionId: "session-i", agentId: "agent-1", tabs: [], sites: [], state: "working", activity: [INTERRUPTED] },
      ],
    });

    const item = within(card("session-i")).getAllByRole("listitem")[0];
    expect(item?.textContent).toContain(ui("agent.activity.interrupt"));
    expect(item?.textContent).toContain(ui("agent.activity.interrupted"));
  });

  /**
   * 013/T337 — the picture a session put into the owner's page, on the card (FR-174).
   *
   * FR-174 asks for it beside the consent card: an upload the owner waved through in `skip-checks`
   * is over in a moment, and this line is the only trace of it afterwards. Two sentences, because
   * a file handed to a form and a file dropped on a page are two different things to read about;
   * the worker sends the delivery word and the host name, and the panel writes both sentences.
   */
  it("says a file was put into a form, and that a screenshot was dropped on a page", () => {
    const t = (key: string): string => lookup(key, "en-US");
    const DELIVERED = { at: 1_700_000_005_000, kind: "upload", outcome: "delivered" } as const;
    /**
     * 014/T385: the `input` sentence is no longer only a screenshot's.
     *
     * `file_upload` earns the same line now (FR-196), and it puts one of the owner's *own* files
     * into the form - so a sentence that said "Screenshot" would be the panel telling them
     * something that is not true about their own upload. The drop sentence keeps the word: only
     * `upload_image` can drop, and what it drops is always a picture this session took.
     */
    expect(activityText({ ...DELIVERED, site: "fixtures.test", message: "input" }, t)).toBe(
      "File put into a form on fixtures.test",
    );
    expect(activityText({ ...DELIVERED, site: "fixtures.test", message: "drop" }, t)).toBe(
      "Screenshot dropped on fixtures.test",
    );
    // A site the worker could not name leaves no hole: the panel has its own word for the page.
    expect(activityText({ ...DELIVERED, message: "drop" }, t)).toBe("Screenshot dropped on the page");

    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-u",
          agentId: "agent-1",
          tabs: [],
          sites: [],
          state: "working",
          activity: [{ ...DELIVERED, site: "fixtures.test", message: "input" }],
        },
      ],
    });

    const item = within(card("session-u")).getAllByRole("listitem")[0];
    expect(item?.textContent).toContain("File put into a form on fixtures.test");
    expect(item?.textContent).toContain(ui("agent.activity.delivered"));
    expect(item?.textContent).not.toContain("{site}");
  });

  it("renders the card in zh-TW without English", () => {
    renderShell("zh-TW");
    project(port, SESSIONS);

    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(2);
    expect(screen.queryByText(ui("agent.session.working"))).toBeNull();
    expect(card("session-b").textContent).toContain("等你決定");
  });
});
