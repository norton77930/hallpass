import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import {
  installAgentPort,
  NOT_PAIRED,
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
 * The consent "Side-panel agent may use this browser" is given once, on the first-use card, and
 * lives on as a switch in Connections & sites, where the owner can take it back; a message names the
 * tab the owner was viewing when they sent it, so the agent starts there.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const toConnections = () => {
  fireEvent.click(screen.getByRole("tab", { name: ui("agent.tabs.connections") }));
};
const consentSwitch = () => screen.getByRole("switch", { name: ui("agent.panelConsent.label") }) as HTMLInputElement;

describe("T555 the panel consent switch in Connections & sites", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("shows the consent as given and withdraws it with the closed command", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();
    toConnections();

    expect(consentSwitch().checked).toBe(true);
    fireEvent.click(consentSwitch());

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: false } }]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("gives it back from the switch, and says what withdrawing does", async () => {
    renderShell();
    project(port, withConversation({ ...CONVERSATION_READY, consent: "withdrawn" }));
    await settle();
    toConnections();

    expect(consentSwitch().checked).toBe(false);
    expect(screen.getByText(ui("agent.panelConsent.withdrawn"))).toBeTruthy();
    fireEvent.click(consentSwitch());

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);
  });

  it("is there before any external agent has paired, and reads in zh-TW", async () => {
    renderShell("zh-TW");
    project(port, withConversation(CONVERSATION_READY, NOT_PAIRED));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: lookup("agent.tabs.connections", "zh-TW") }));

    expect(screen.getByRole("switch", { name: lookup("agent.panelConsent.label", "zh-TW") })).toBeTruthy();
  });

  it("is absent for a worker without conversations", async () => {
    renderShell();
    project(port, { ...NOT_PAIRED });
    await settle();

    expect(screen.queryByRole("switch", { name: ui("agent.panelConsent.label") })).toBeNull();
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
