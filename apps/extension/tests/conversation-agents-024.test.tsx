import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_AGENTS,
  agentPanelCommandSchema,
  type AgentChoices,
  type ConversationAgent,
  type ConversationAgentAvailability,
  type ConversationPanelState,
} from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_READY, VIEW, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 024/T774 - the side panel's agent picker follows the owner's choices (US4, FR-384, FR-391, D-024-2,
 * D-024-3, R-380).
 *
 * The picker lists the enabled agents, a new conversation starts on the default, a change made on the
 * settings page arrives in the projection and is followed without a reload, a conversation already
 * open keeps its agent, and an enabled agent that cannot start says why once and links to its card -
 * nothing is downloaded or installed from a conversation.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const agentChip = () => document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const rows = () => within(screen.getByRole("menu")).getAllByRole("menuitemradio");
const rowNames = () => rows().map((row) => row.querySelector(".agent-conversation-agent-name")?.textContent);

const ready = (agent: ConversationAgent): ConversationAgentAvailability => ({ agent, availability: "ready", version: "1.0.0" });
const AGENTS = (overrides: Partial<Record<ConversationAgent, ConversationAgentAvailability>> = {}): ConversationAgentAvailability[] =>
  CONVERSATION_AGENTS.map((agent) => overrides[agent] ?? ready(agent));
const choices = (off: readonly ConversationAgent[], def: ConversationAgent | null): AgentChoices => ({
  enabled: Object.fromEntries(CONVERSATION_AGENTS.map((agent) => [agent, !off.includes(agent)])) as AgentChoices["enabled"],
  default: def,
});
const conversation = (
  chosen: AgentChoices,
  agents: ConversationAgentAvailability[] = AGENTS(),
  extra: Partial<ConversationPanelState> = {},
): ConversationPanelState => ({ ...CONVERSATION_READY, agents, choices: chosen, ...extra });
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};

describe("T774 the picker follows the owner's choices", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(state: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(state));
    await settle();
  }

  it("lists the enabled agents only, in the contract's order", async () => {
    await open(conversation(choices(["codex", "deepseek"], "hermes")));
    fireEvent.click(agentChip());

    expect(rowNames()).toEqual(["Claude Code", "Hermes"]);
  });

  it("preselects the default in a new conversation, whatever the panel used last", async () => {
    // The fake storage answers every key with this value; a panel that still read its old
    // `conversationLastAgent` would put Codex on the chip.
    installTabStorage("codex");
    await open(conversation(choices(["deepseek"], "hermes")));

    expect(agentChip().textContent).toContain("Hermes");
  });

  it("preselects the first enabled ready agent when there is no default, and writes nothing about the last agent", async () => {
    const storage = installTabStorage();
    await open(conversation(choices(["claude-code"], null), AGENTS({ codex: { agent: "codex", availability: "missing" } })));
    expect(agentChip().textContent).toContain("Hermes");

    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "hermes", folder: { kind: "scratch" } } }]);
    expect(storage.writes).not.toContainEqual({ conversationLastAgent: "hermes" });
    expectValidCommands(port);
  });

  it("follows a change of the default and of the enabled agents without a reload", async () => {
    await open(conversation(choices([], "claude-code")));
    expect(agentChip().textContent).toContain("Claude Code");

    project(port, withConversation(conversation(choices(["deepseek"], "codex"))));
    expect(agentChip().textContent).toContain("Codex");
    fireEvent.click(agentChip());
    expect(rowNames()).toEqual(["Claude Code", "Codex", "Hermes"]);
  });

  it("falls back to the default when the agent the owner put on the chip is switched off", async () => {
    await open(conversation(choices([], "claude-code")));
    fireEvent.click(agentChip());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Hermes/ }));
    expect(agentChip().textContent).toContain("Hermes");

    project(port, withConversation(conversation(choices(["hermes"], "claude-code"))));
    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("starts the next new conversation on the default again, not on the agent picked before", async () => {
    await open(conversation(choices([], "claude-code")));
    fireEvent.click(agentChip());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Codex/ }));
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(sendButton());
    expect(commandsSent(port)[0]).toEqual({ type: "ui.conversation.start", payload: { agent: "codex", folder: { kind: "scratch" } } });

    const NEW_ID = "conv-fedcba9876543210";
    const started = conversation(choices([], "claude-code"), AGENTS(), {
      conversations: [{ ...VIEW, conversationId: NEW_ID, agent: "codex", title: "New" }],
      active: NEW_ID,
    });
    project(port, withConversation(started));
    project(port, withConversation(started));
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.new") }));

    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("keeps the agent of a conversation already open when that agent is switched off (FR-391)", async () => {
    const state = conversation(choices([], "claude-code"), AGENTS(), { conversations: [{ ...VIEW, agent: "codex" }], active: CONVERSATION_ID });
    await open(state);
    expect(document.querySelector(`[data-conversation-id="${CONVERSATION_ID}"]`)?.textContent).toContain("Codex");

    project(port, withConversation({ ...state, choices: choices(["codex"], "claude-code") }));
    const section = document.querySelector(`[data-conversation-id="${CONVERSATION_ID}"]`)!;
    expect(section.textContent).toContain("Codex");
    // It can still be written to: the composer is the open conversation's.
    fireEvent.change(box(), { target: { value: "carry on" } });
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "carry on" } },
    ]);
  });

  describe("an enabled agent that cannot start", () => {
    const NOT_READY = AGENTS({
      codex: { agent: "codex", availability: "missing" },
      hermes: { agent: "hermes", availability: "needs-install" },
      deepseek: { agent: "deepseek", availability: "needs-install", installing: "downloading" },
    });

    it("is listed but cannot be chosen, with one reason line and a link to its card", async () => {
      await open(conversation(choices([], "claude-code"), NOT_READY));
      fireEvent.click(agentChip());

      const items = rows();
      expect(items.map((row) => (row as HTMLButtonElement).disabled)).toEqual([false, true, true, true]);
      const menu = screen.getByRole("menu");
      for (const [agent, name, reason] of [
        ["codex", "Codex", ui("conversation.agentMenu.notReady.missing")],
        ["hermes", "Hermes", ui("conversation.agentMenu.notReady.download")],
        ["deepseek", "DeepSeek", ui("conversation.agentMenu.notReady.downloading")],
      ] as const) {
        expect(menu.textContent).toContain(reason.replace("{agent}", name));
        const item = menu.querySelector(`li[data-agent="${agent}"]`)!;
        expect(item.querySelectorAll(".agent-conversation-reason")).toHaveLength(1);
        expect(within(item as HTMLElement).getAllByRole("menuitem")).toHaveLength(1);
      }
      expect(within(menu.querySelector('li[data-agent="claude-code"]') as HTMLElement).queryByRole("menuitem")).toBeNull();
    });

    it("says a version that does not match in one line and opens the settings page at that agent", async () => {
      await open(conversation(choices([], "claude-code"), AGENTS({ hermes: { agent: "hermes", availability: "version-problem", version: "0.21.0" } })));
      fireEvent.click(agentChip());

      const item = screen.getByRole("menu").querySelector('li[data-agent="hermes"]') as HTMLElement;
      expect(item.textContent).toContain(ui("conversation.agentMenu.notReady.version").replace("{agent}", "Hermes"));
      fireEvent.click(within(item).getByRole("menuitem", { name: new RegExp(ui("conversation.agentMenu.openSettings")) }));

      expect(commandsSent(port)).toEqual([{ type: "ui.agent.open-settings", payload: { route: "#agents/hermes" } }]);
      expectValidCommands(port);
      // The press only opens the page: nothing is chosen, and the menu is closed.
      expect(screen.queryByRole("menu")).toBeNull();
      expect(agentChip().textContent).toContain("Claude Code");
    });

    it("walks the link with the keyboard like any row", async () => {
      await open(conversation(choices(["hermes", "deepseek"], "claude-code"), NOT_READY));
      fireEvent.click(agentChip());

      const menu = screen.getByRole("menu");
      expect(document.activeElement).toBe(rows()[0]);
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows()[0]);
    });

    it("shows the reason and the link above the box when the default itself cannot start, and Send stays off", async () => {
      await open(conversation(choices([], "hermes"), NOT_READY));

      expect(agentChip().textContent).toContain("Hermes");
      const note = document.querySelector("[data-setup=not-ready]")!;
      expect(note.textContent).toContain(ui("conversation.agentMenu.notReady.download").replace("{agent}", "Hermes"));
      fireEvent.change(box(), { target: { value: "hello" } });
      expect(sendButton().disabled).toBe(true);
      fireEvent.click(within(note as HTMLElement).getByRole("button", { name: ui("conversation.agentMenu.openSettings") }));
      expect(commandsSent(port)).toEqual([{ type: "ui.agent.open-settings", payload: { route: "#agents/hermes" } }]);
      expectValidCommands(port);
    });

    it("never offers a download or an install from a conversation", async () => {
      await open(conversation(choices([], "hermes"), NOT_READY, { consent: "unknown" }));
      fireEvent.change(box(), { target: { value: "hello" } });

      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
      expect(screen.queryByRole("region", { name: /Set up/ })).toBeNull();
      expect(commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.install")).toEqual([]);
    });

    it("says the same in zh-TW", async () => {
      await open(conversation(choices([], "claude-code"), NOT_READY), "zh-TW");
      fireEvent.click(agentChip());

      const menu = screen.getByRole("menu");
      expect(menu.textContent).toContain(lookup("conversation.agentMenu.notReady.missing", "zh-TW").replace("{agent}", "Codex"));
      expect(menu.textContent).toContain(lookup("conversation.agentMenu.openSettings", "zh-TW"));
      expect(menu.textContent).not.toContain("is not installed");
      expect(menu.textContent).not.toContain("needs a download first");
    });
  });
});
