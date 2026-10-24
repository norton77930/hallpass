import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  commandsSent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 019/T554, T555 - the panel's half of a panel session (FR-306, FR-309, D-019-11).
 *
 * The consent "Side-panel agent may use this browser" is given once, on the first-use card; a message
 * names the tab the owner was viewing when they sent it, so the agent starts there.
 *
 * 024 R-381: the switch that took the consent back moved to the settings page (Connection), so the
 * Sessions tab no longer carries it.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("T555 the panel consent switch is no longer in the panel", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it.each(["granted", "withdrawn"] as const)("shows no consent switch on the Sessions tab with the consent %s", async (consent) => {
    renderShell();
    project(port, withConversation({ ...CONVERSATION_READY, consent }));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: ui("agent.tabs.sessions") }));

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Off. The next conversation asks again.")).toBeNull();
    expect(commandsSent(port)).toEqual([]);
  });
});

describe("T554 a message names the tab the owner is viewing (FR-306)", () => {
  let port: FakeAgentPort;
  let active: number | undefined;
  let activated: Array<() => void>;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
    active = 7;
    activated = [];
    const chromeGlobal = (globalThis as { chrome: Record<string, unknown> }).chrome;
    chromeGlobal.tabs = {
      query: async (query: { active?: boolean; currentWindow?: boolean }) => {
        expect(query).toEqual({ active: true, currentWindow: true });
        return active === undefined ? [] : [{ id: active }];
      },
      onActivated: {
        addListener: (listener: () => void) => void activated.push(listener),
        removeListener: (listener: () => void) => {
          activated = activated.filter((candidate) => candidate !== listener);
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  function sendMessage(text: string) {
    const box = screen.getByRole("textbox", { name: ui("conversation.composer.label").replace("{agent}", "Claude Code") });
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
  }

  it("sends the active tab of the panel's window, and follows the owner to another tab", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();

    sendMessage("summarise this table");
    active = 9;
    await act(async () => {
      for (const listener of activated) listener();
      await Promise.resolve();
    });
    sendMessage("and this one");

    expect(commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.send")).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "summarise this table", activeTabId: 7 } },
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "and this one", activeTabId: 9 } },
    ]);
  });

  it("sends no tab when the window has none it can name", async () => {
    active = undefined;
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();

    sendMessage("hello");

    expect(commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.send")).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "hello" } },
    ]);
  });
});
