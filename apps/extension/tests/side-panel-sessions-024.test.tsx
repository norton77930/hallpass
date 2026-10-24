import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import {
  IDLE,
  NOT_PAIRED,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, commandsSent, installTabStorage, withConversation, type FakeTabStorage } from "./helpers/conversation-fixtures.js";

/**
 * 024/T781 - the side panel's second tab is Sessions (US8, D-024-11, D-024-18, R-381, FR-392 - FR-394).
 *
 * It holds the connection state, the not-connected view with Retry and the session cards, unchanged in
 * behaviour. The standing permissions (site list, upload folders, the paired agents with Unpair, the
 * browser's name, the side-panel-agent switch) are on the settings page and are not here; a card that
 * acts on a site links to that site's permissions, and a tab with no session says so and links to the
 * page. Every link is one `ui.agent.open-settings` command.
 */

const SITE = "https://fixtures.test:19443";
const WORKING = { sessionId: "s-1", agentId: "agent-1", tabs: [], state: "working" as const };
const sessionsTab = () => screen.getByRole("tab", { name: new RegExp(`^${ui("agent.tabs.sessions")}`) });
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};

describe("T781 the Sessions tab", () => {
  let port: FakeAgentPort;
  let storage: FakeTabStorage;

  beforeEach(() => {
    port = installAgentPort();
    storage = installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function show(state = IDLE, tab: "conversation" | "sessions" = "sessions") {
    renderShell();
    project(port, withConversation(CONVERSATION_READY, state));
    await settle();
    if (tab === "sessions") fireEvent.click(sessionsTab());
  }

  it("is the second tab, after Conversation", async () => {
    await show(IDLE, "conversation");

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([ui("agent.tabs.conversation"), ui("agent.tabs.sessions")]);
  });

  it("holds the connection line and the session cards, and none of the standing permissions", async () => {
    await show({
      ...IDLE,
      sessions: [WORKING],
      sites: [{ site: SITE, mode: "skip-checks", diagnosticsGranted: false }],
      transitions: [{ from: SITE, to: "https://b.test", allowedAt: "2026-09-20T09:00:00.000Z" }],
      uploadRoots: { roots: ["D:\\photos"], path: "C:\\Users\\owner\\AppData\\Local\\hallpass\\config.json" },
      browser: { name: "Work Chrome", defaultName: "Chrome", kind: "chrome", others: 1 },
    });

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(ui("agent.status.connected"))).toBeTruthy();
    expect(panel.querySelector("[data-session-id='s-1']")).not.toBeNull();
    // Nothing of what moved to the settings page.
    expect(panel.querySelector("[data-site]")).toBeNull();
    expect(panel.querySelector(".agent-sites")).toBeNull();
    expect(panel.querySelector(".agent-upload-roots")).toBeNull();
    expect(panel.querySelector("[data-browser-row]")).toBeNull();
    expect(within(panel).queryByRole("switch")).toBeNull();
    expect(within(panel).queryByRole("button", { name: ui("agent.unpair") })).toBeNull();
    expect(panel.textContent).not.toContain("Work Chrome");
    expect(panel.textContent).not.toContain("hallpass\\config.json");
  });

  it("keeps the overflow menu to one entry, Settings, which opens the page at the agents", async () => {
    await show({ ...IDLE, sessions: [WORKING] });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.status.menu") }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([ui("agent.status.settings")]);
    expect(within(screen.getByRole("menu")).queryByRole("button", { name: /Unpair/ })).toBeNull();

    fireEvent.click(items[0]!);
    expect(commandsSent(port)).toEqual([{ type: "ui.agent.open-settings", payload: { route: "#agents" } }]);
    expect(screen.queryByRole("menu")).toBeNull();
    expectValidCommands(port);
  });

  it("still shows the not-connected view with Retry", async () => {
    await show({ ...NOT_PAIRED, bridge: "disconnected" });

    const panel = screen.getByRole("tabpanel");
    fireEvent.click(within(panel).getByRole("button", { name: ui("agent.retry") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.agent.retry-bridge", payload: {} }]);
    expect(panel.querySelector("[data-browser-row]")).toBeNull();
    expect(within(panel).queryByRole("switch")).toBeNull();
  });

  describe("a session card that acts on a site", () => {
    it("offers 'Manage this site's permissions' and opens the page at that site", async () => {
      await show({ ...IDLE, sessions: [{ ...WORKING, site: SITE }] });

      const card = document.querySelector<HTMLElement>("[data-session-id='s-1']")!;
      const link = within(card).getByRole("button", {
        name: ui("agent.session.manageSiteLabel").replace("{site}", SITE),
      });
      expect(link.textContent).toBe(ui("agent.session.manageSite"));
      fireEvent.click(link);

      expect(commandsSent(port)).toEqual([
        { type: "ui.agent.open-settings", payload: { route: `#sites?site=${encodeURIComponent(SITE)}` } },
      ]);
      expectValidCommands(port);
    });

    it("offers no link on a card that acts on no site, and keeps Stop where it was", async () => {
      await show({ ...IDLE, sessions: [WORKING] });

      const card = document.querySelector<HTMLElement>("[data-session-id='s-1']")!;
      expect(within(card).queryByRole("button", { name: new RegExp(ui("agent.session.manageSite").slice(0, 10)) })).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: ui("agent.session.stop") }));
      expect(commandsSent(port)).toEqual([{ type: "ui.agent.session-stop", payload: { sessionId: "s-1" } }]);
    });
  });

  describe("with no session", () => {
    it("says no agent is acting on this browser, keeps the connection line, and links to the settings page", async () => {
      await show(IDLE);

      const panel = screen.getByRole("tabpanel");
      expect(within(panel).getByText(ui("agent.status.connected"))).toBeTruthy();
      expect(within(panel).getByText(ui("agent.sessions.empty"))).toBeTruthy();
      fireEvent.click(within(panel).getByRole("button", { name: ui("agent.sessions.openSettings") }));

      expect(commandsSent(port)).toEqual([{ type: "ui.agent.open-settings", payload: { route: "#agents" } }]);
      expectValidCommands(port);
    });

    it("does not say it while a session is running", async () => {
      await show({ ...IDLE, sessions: [WORKING] });

      expect(screen.queryByText(ui("agent.sessions.empty"))).toBeNull();
    });
  });

  it("reads a remembered 'connections' as the Sessions tab, and remembers 'sessions' from now on", async () => {
    storage.stored = "connections";
    await show(IDLE, "conversation");

    expect(sessionsTab().getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${ui("agent.tabs.conversation")}`) }));
    fireEvent.click(sessionsTab());
    expect(storage.writes).toEqual([{ agentPanelTab: "conversation" }, { agentPanelTab: "sessions" }]);
  });
});
