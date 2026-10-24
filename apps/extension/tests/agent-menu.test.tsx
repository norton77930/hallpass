import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_AGENTS, type ConversationAgentAvailability, type ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 021/T669 - Hermes and DeepSeek in the agent menu (US4, FR-343 - FR-345, FR-350, FR-358), as 024
 * leaves it (FR-384, D-024-3).
 *
 * The menu lists the contract's four agents in the contract's order with their state (a worker that
 * sends no choices is read as "all enabled"; the choices themselves are covered in
 * conversation-agents-024.test.tsx). An agent that cannot start says why in one line and links to its
 * card on the settings page - install and version guidance live there now. The worker's notes
 * (`git-missing`, `pre-release`) are said in words, and a ready agent's first use goes through the
 * first-use card.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const agentChip = () => document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const items = () => within(screen.getByRole("menu")).getAllByRole("menuitemradio");

const FOUR = (overrides: Partial<Record<(typeof CONVERSATION_AGENTS)[number], ConversationAgentAvailability>> = {}): ConversationPanelState => ({
  ...CONVERSATION_READY,
  consent: "unknown",
  agents: [
    overrides["claude-code"] ?? { agent: "claude-code", availability: "ready", version: "2.1.0" },
    overrides.codex ?? { agent: "codex", availability: "ready", version: "0.50.0" },
    overrides.hermes ?? { agent: "hermes", availability: "ready", version: "0.22.2" },
    overrides.deepseek ?? { agent: "deepseek", availability: "needs-install", notes: ["pre-release"] },
  ],
});

describe("T669 Hermes and DeepSeek in the agent menu", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
    fireEvent.click(agentChip());
  }
  const choose = (name: RegExp) => {
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  };
  const rowOf = (agent: string) => document.querySelector<HTMLElement>(`li[data-agent=${agent}]`)!;

  it("lists the four agents in the contract's order, each with its mark and its state", async () => {
    await open(FOUR());

    expect(CONVERSATION_AGENTS).toEqual(["claude-code", "codex", "hermes", "deepseek"]);
    const rows = items();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector(".agent-conversation-agent-name")?.textContent)).toEqual(["Claude Code", "Codex", "Hermes", "DeepSeek"]);
    expect(rows.map((row) => row.querySelector(".agent-conversation-agent-badge")?.textContent)).toEqual(["C", "X", "H", "D"]);
    expect(rows[2]?.textContent).toContain(ui("conversation.availability.ready"));
    // DeepSeek still needs its one-time download: it says so as a reason and cannot be chosen from here.
    expect(rows[3]?.hasAttribute("disabled")).toBe(true);
    expect(rowOf("deepseek").querySelector(".agent-conversation-reason")?.textContent).toBe(
      ui("conversation.agentMenu.notReady.download").replace("{agent}", "DeepSeek"),
    );
  });

  it("says a Hermes that is not installed is not installed, links to its card, and cannot be sent to", async () => {
    await open(FOUR({ hermes: { agent: "hermes", availability: "missing" } }));

    const row = rowOf("hermes");
    expect(row.querySelector(".agent-conversation-reason")?.textContent).toBe(ui("conversation.agentMenu.notReady.missing").replace("{agent}", "Hermes"));
    // 024 D-024-3: no install steps in a conversation - the card on the settings page has them.
    expect(row.textContent).not.toContain("official Windows installer");
    expect(items()[2]?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(row).getByRole("menuitem", { name: ui("conversation.agentMenu.openSettings") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.agent.open-settings", payload: { route: "#agents/hermes" } }]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says a Hermes of another version does not fit, and cannot be sent to (FR-344)", async () => {
    const mismatch: ConversationAgentAvailability = {
      agent: "hermes",
      availability: "version-problem",
      version: "0.21.0",
      detail: "Hallpass works with Hermes 0.22.2; this computer has Hermes 0.21.0.",
    };
    await open(FOUR({ hermes: mismatch }));

    expect(rowOf("hermes").querySelector(".agent-conversation-reason")?.textContent).toBe(ui("conversation.agentMenu.notReady.version").replace("{agent}", "Hermes"));
    expect(items()[2]?.hasAttribute("disabled")).toBe(true);
    expect(commandsSent(port)).toEqual([]);
  });

  it("says the version problem in zh-TW", async () => {
    await open(
      FOUR({
        hermes: {
          agent: "hermes",
          availability: "version-problem",
          version: "0.21.0",
          detail: "Hallpass works with Hermes 0.22.2; this computer has Hermes 0.21.0.",
        },
      }),
      "zh-TW",
    );

    const text = rowOf("hermes").textContent ?? "";
    expect(text).not.toContain("Hallpass works with");
    expect(text).toContain(lookup("conversation.agentMenu.notReady.version", "zh-TW").replace("{agent}", "Hermes"));
  });

  it("says that Git for Windows is needed when the worker reports git-missing", async () => {
    await open(FOUR({ hermes: { agent: "hermes", availability: "ready", version: "0.22.2", notes: ["git-missing"] } }));

    const row = items()[2]!;
    expect(row.textContent).toContain(ui("conversation.availability.ready"));
    expect(row.textContent).toContain("Git for Windows");
    expect(row.textContent).toContain(ui("conversation.note.git-missing"));
    // Other rows carry no such note.
    expect(items()[0]?.textContent).not.toContain("Git for Windows");
  });

  it("marks a ready DeepSeek pre-release and puts its first use on the first-use card, with no download", async () => {
    await open(FOUR({ deepseek: { agent: "deepseek", availability: "ready", notes: ["pre-release"] } }));

    const row = items()[3]!;
    expect(row.textContent).toContain(ui("conversation.note.pre-release"));
    expect(row.textContent).toContain("Pre-release");

    fireEvent.click(row);
    fireEvent.change(box(), { target: { value: "what is on this page?" } });
    fireEvent.click(sendButton());

    const card = screen.getByRole("region", { name: "Set up DeepSeek for the side panel" });
    const text = card.textContent ?? "";
    expect(text).not.toContain("Download size");
    expect(text).toContain(ui("conversation.note.pre-release"));
    expect(text).toContain("key");
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1); // the message box alone: no key field anywhere
    expect(within(card).queryByRole("button", { name: "Download" })).toBeNull();
    expect(commandsSent(port)).toEqual([]);

    fireEvent.click(within(card).getByRole("button", { name: ui("conversation.firstUse.allow") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);
  });

  it("asks only for the consent on a Hermes that is ready, and says where its settings live", async () => {
    await open(FOUR());
    choose(/^Hermes/);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(sendButton());

    const card = screen.getByRole("region", { name: "Set up Hermes for the side panel" });
    expect(card.textContent).toContain("%LOCALAPPDATA%\\hermes");
    expect(card.textContent).not.toContain("npm registry your own npm is set up for");
    expect(within(card).queryByRole("button", { name: "Download" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: ui("conversation.firstUse.allow") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);
  });

  it("is reachable by keyboard: arrows walk the rows that can be chosen, each named, and Escape gives the chip its focus back", async () => {
    await open(FOUR({ deepseek: { agent: "deepseek", availability: "ready", notes: ["pre-release"] } }));

    const rows = items();
    expect(document.activeElement).toBe(rows[0]);
    for (const row of rows) expect(row.tagName).toBe("BUTTON");
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    const menu = screen.getByRole("menu", { name: ui("conversation.agentMenu.label") });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(rows[3]);
    expect(screen.getByRole("menuitemradio", { name: /^DeepSeek/ })).toBe(rows[3]);
    expect(screen.getByRole("menuitemradio", { name: /^Hermes/ })).toBe(rows[2]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(agentChip());
  });

  it("reads in zh-TW: no row keeps an English placeholder", async () => {
    await open(
      FOUR({
        hermes: { agent: "hermes", availability: "missing" },
        deepseek: { agent: "deepseek", availability: "needs-install", notes: ["pre-release"] },
      }),
      "zh-TW",
    );

    const text = items().map((row) => row.closest("li")?.textContent ?? "").join(" ");
    expect(text).not.toContain("official");
    expect(text).not.toContain("downloaded by Hallpass");
    expect(text).not.toContain("{agent}");
    expect(text).toContain(lookup("conversation.agentMenu.notReady.missing", "zh-TW").replace("{agent}", "Hermes"));
    expect(text).toContain(lookup("conversation.agentMenu.openSettings", "zh-TW"));
  });
});
