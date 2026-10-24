import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IDLE,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, installTabStorage, withConversation, type FakeTabStorage } from "./helpers/conversation-fixtures.js";

/**
 * 019/T543 - two tabs, external consent always on top (D-019-3, US7, FR-282 - FR-284).
 *
 * Sessions is the connection line and the session cards (024 R-381: it was Connections & sites, and
 * a tab remembered under that name reads as Sessions); Conversation is new. A consent card from an
 * external agent must never be hidden in the tab the owner is not looking at - a hidden card has
 * timed out on the owner before - so the question slot stays above the tab bar on both tabs, and
 * the Connections tab counts what is waiting there while the other tab is shown.
 */

const PENDING = { agentId: "agent-9", displayName: "New Agent", origin: "stdio:local" };
const CHOICE = { requestId: "choice-1", agentName: "Other Agent", raisedAt: "2026-10-19T00:00:05.000Z" };

const tab = (key: string) => screen.getByRole("tab", { name: new RegExp(`^${ui(key)}`) });
const tablist = () => screen.getByRole("tablist");
/** Lets the panel's storage read settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const isAbove = (first: Element, second: Element) =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("T543 the side panel's two tabs", () => {
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

  it("offers Conversation and Sessions, opening on Conversation when nothing is remembered", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(tab("agent.tabs.conversation").getAttribute("aria-selected")).toBe("true");
    expect(tab("agent.tabs.sessions").getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("agent.tabs.conversation").id);
    // Today's composition is not on the Conversation tab.
    expect(screen.queryByText(ui("agent.status.connected"))).toBeNull();
  });

  it("shows exactly the connection line and the session cards on Sessions", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY, {
      ...IDLE,
      sessions: [{ sessionId: "s-1", agentId: "agent-1", tabs: [], state: "working" }],
    }));
    await settle();
    fireEvent.click(tab("agent.tabs.sessions"));

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("agent.tabs.sessions").id);
    expect(within(panel).getByText(ui("agent.status.connected"))).toBeTruthy();
    expect(panel.querySelector("[data-session-id='s-1']")).not.toBeNull();
    // 024 R-381: the site list is on the settings page now.
    expect(within(panel).queryByText("No site has been decided on yet.")).toBeNull();
    expect(within(panel).getByRole("button", { name: ui("agent.status.menu") })).toBeTruthy();
    // Nothing of the Conversation tab.
    expect(within(panel).queryByRole("group", { name: ui("conversation.chips.label") })).toBeNull();
    expect(within(panel).queryByRole("button", { name: ui("conversation.header.list") })).toBeNull();
  });

  it("keeps an external consent card above the tab bar on both tabs", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY, { ...IDLE, pending: PENDING }));
    await settle();

    for (const key of ["agent.tabs.conversation", "agent.tabs.sessions"]) {
      fireEvent.click(tab(key));
      const card = screen.getByRole("dialog", { name: ui("agent.pairingTitle") });
      expect(isAbove(card, tablist())).toBe(true);
      expect(card.closest("[role='tabpanel']")).toBeNull();
    }
  });

  it("keeps the non-blocking notice above the tab bar on both tabs", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY, {
      ...IDLE,
      sessions: [{
        sessionId: "s-1",
        agentId: "agent-1",
        tabs: [],
        state: "working",
        notice: { at: Date.now(), kind: "dialog-accepted", dialogText: "Delete 3 orders?", action: "click" },
      }],
    }));
    await settle();

    for (const key of ["agent.tabs.conversation", "agent.tabs.sessions"]) {
      fireEvent.click(tab(key));
      const notice = document.querySelector(".agent-notice");
      expect(notice).not.toBeNull();
      expect(isAbove(notice as Element, tablist())).toBe(true);
    }
  });

  it("counts what waits in Sessions on its tab while Conversation is shown, and only then", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY, { ...IDLE, pending: PENDING, browserChoice: CHOICE }));
    await settle();

    const connections = tab("agent.tabs.sessions");
    expect(connections.querySelector("[data-tab-count]")?.textContent).toBe("2");
    expect(connections.textContent).toContain(ui("agent.tabs.waiting").replace("{count}", "2"));

    fireEvent.click(connections);
    expect(tab("agent.tabs.sessions").querySelector("[data-tab-count]")).toBeNull();

    fireEvent.click(tab("agent.tabs.conversation"));
    project(port, withConversation(CONVERSATION_READY));
    expect(tab("agent.tabs.sessions").querySelector("[data-tab-count]")).toBeNull();
  });

  it("reopens on the tab used last, from agentPanelTab", async () => {
    storage.stored = "sessions";
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(tab("agent.tabs.sessions").getAttribute("aria-selected")).toBe("true");
  });

  it("reads a tab remembered under the old name, connections, as Sessions (024 R-381)", async () => {
    storage.stored = "connections";
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(tab("agent.tabs.sessions").getAttribute("aria-selected")).toBe("true");
    expect(tab("agent.tabs.conversation").getAttribute("aria-selected")).toBe("false");
  });

  it("remembers the tab the owner chose in agentPanelTab", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    fireEvent.click(tab("agent.tabs.sessions"));
    fireEvent.click(tab("agent.tabs.conversation"));

    expect(storage.writes).toEqual([{ agentPanelTab: "sessions" },{ agentPanelTab: "conversation" }]);
  });

  it("ignores a remembered value that is not a tab", async () => {
    storage.stored = "made-up";
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(tab("agent.tabs.conversation").getAttribute("aria-selected")).toBe("true");
  });

  it("still works when storage throws on read and on write", async () => {
    storage.failGet = true;
    storage.failSet = true;
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(tab("agent.tabs.conversation").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("agent.tabs.sessions"));
    expect(tab("agent.tabs.sessions").getAttribute("aria-selected")).toBe("true");
  });

  it("moves between the tabs with the arrow keys, Home and End, focus following", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    const conversation = tab("agent.tabs.conversation");
    expect(conversation.tabIndex).toBe(0);
    expect(tab("agent.tabs.sessions").tabIndex).toBe(-1);

    fireEvent.keyDown(conversation, { key: "ArrowRight" });
    expect(tab("agent.tabs.sessions").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("agent.tabs.sessions"));

    fireEvent.keyDown(tab("agent.tabs.sessions"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("agent.tabs.conversation"));

    fireEvent.keyDown(tab("agent.tabs.conversation"), { key: "End" });
    expect(document.activeElement).toBe(tab("agent.tabs.sessions"));
    fireEvent.keyDown(tab("agent.tabs.sessions"), { key: "Home" });
    expect(document.activeElement).toBe(tab("agent.tabs.conversation"));
  });

  it("names the tabs in zh-TW", async () => {
    renderShell("zh-TW");
    project(port, withConversation(CONVERSATION_READY));
    await settle();

    expect(screen.getByRole("tab", { name: "對話" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "工作階段" })).toBeTruthy();
  });

  it("shows today's panel without a tab bar when the worker sends no conversation part", async () => {
    renderShell();
    project(port, IDLE);
    await settle();

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText(ui("agent.status.connected"))).toBeTruthy();
  });
});
