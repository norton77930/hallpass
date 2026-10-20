import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationPanelState } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, CONVERSATION_READY, VIEW, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T597 - the mode as a chip with an explaining menu (US4 scenario 3, FR-320; 019 FR-292,
 * FR-293). The chip sits with the agent and folder chips in an open conversation too; its menu
 * offers exactly the two modes, explains each, carries the Codex note for Codex, and wears the
 * warning colour for the agent's own review when that mode is on.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const modeChip = (mode: "strict" | "agent-review") =>
  screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui(`conversation.mode.${mode}`)) });

describe("T597 the mode chip and its menu", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState = CONVERSATION_OPEN) {
    renderShell();
    project(port, withConversation(conversation));
    await settle();
  }

  it("sits with the agent and folder chips, explains both modes, and sends the switch", async () => {
    await open();
    const chips = screen.getByRole("group", { name: ui("conversation.chips.label") });
    const chip = within(chips).getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("radiogroup", { name: ui("conversation.mode.label") });
    expect(chip.getAttribute("aria-controls")).toBe(menu.closest("[id]")?.id);
    const radios = within(menu).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["strict", "agent-review"]);
    expect(radios[0]?.checked).toBe(true);
    expect(document.activeElement).toBe(radios[0]);
    for (const radio of radios) {
      const explained = document.getElementById(radio.getAttribute("aria-describedby") ?? "");
      expect(explained?.textContent).toBe(ui(`conversation.mode.explain.${radio.value}`));
    }
    expect(menu.textContent?.toLowerCase()).not.toMatch(/full|bypass|yolo|never ask/);

    fireEvent.click(radios[1]!);
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.set-mode", payload: { conversationId: CONVERSATION_ID, mode: "agent-review" } },
    ]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("closes on Escape and gives the focus back to the chip", async () => {
    await open();
    fireEvent.click(modeChip("strict"));
    fireEvent.keyDown(screen.getAllByRole("radio")[0]!, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.activeElement).toBe(modeChip("strict"));
  });

  it("carries the Codex note for Codex only (FR-293)", async () => {
    await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, agent: "codex" }] });
    fireEvent.click(modeChip("strict"));
    expect(within(screen.getByRole("radiogroup")).getByText(ui("conversation.mode.codexStrictNote"))).toBeTruthy();
    cleanup();

    await open();
    fireEvent.click(modeChip("strict"));
    expect(screen.queryByText(ui("conversation.mode.codexStrictNote"))).toBeNull();
  });

  it("marks the agent's own review with the warning colour when it is on", async () => {
    await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, mode: "agent-review" }] });
    const chip = modeChip("agent-review");
    expect(chip.hasAttribute("data-warn")).toBe(true);
    fireEvent.click(chip);
    const options = [...document.querySelectorAll(".agent-conversation-mode-option")];
    expect(options.map((option) => option.hasAttribute("data-warn"))).toEqual([false, true]);
    cleanup();

    await open();
    expect(modeChip("strict").hasAttribute("data-warn")).toBe(false);
    fireEvent.click(modeChip("strict"));
    expect([...document.querySelectorAll(".agent-conversation-mode-option")].some((option) => option.hasAttribute("data-warn"))).toBe(false);
  });

  // 020 T600: a press anywhere else closes it, in an open conversation and in the empty one, and
  // leaves the focus to whatever was pressed; a press on its own chip closes it once.
  it("closes on a press outside it without pulling the focus back to the chip", async () => {
    for (const conversation of [CONVERSATION_OPEN, CONVERSATION_READY]) {
      await open(conversation);
      fireEvent.click(modeChip("strict"));
      fireEvent.pointerDown(screen.getAllByRole("radio")[1]!);
      expect(screen.getByRole("radiogroup")).toBeTruthy();

      fireEvent.pointerDown(document.querySelector(".agent-conversation-composer textarea")!);
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(modeChip("strict").getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).not.toBe(modeChip("strict"));

      fireEvent.click(modeChip("strict"));
      fireEvent.pointerDown(modeChip("strict"));
      fireEvent.click(modeChip("strict"));
      expect(screen.queryByRole("radiogroup")).toBeNull();
      cleanup();
    }
  });
});
