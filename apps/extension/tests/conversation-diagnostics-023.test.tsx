import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { lookup } from "../src/locales/catalog.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 023/T728 (US5, D-023-8, R-367, FR-371, FR-372, FR-373) - the conversation's "Agent output": on
 * request the panel asks the broker for the last lines the agent printed about itself and shows them in
 * a monospace, scrollable, keyboard-reachable block; none yet says so. Memory only, nothing is asked
 * until the owner presses the button.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const reply = (port: FakeAgentPort, lines: string[], conversationId = CONVERSATION_ID) =>
  act(() => port.emit({ type: "conversation-diagnostics", payload: { conversationId, lines } }));
const outputButton = () => screen.getByRole("button", { name: new RegExp(ui("conversation.output.button")) });
const block = () => document.querySelector<HTMLElement>("[data-agent-output]");

describe("023 agent output in the conversation details", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  }

  it("asks nothing until the owner presses the button, and then asks for this conversation's output", async () => {
    await open();
    expect(commandsSent(port)).toEqual([]);
    expect(block()).toBeNull();
    expect(outputButton().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(outputButton());

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.diagnostics", payload: { conversationId: CONVERSATION_ID } }]);
    expect(outputButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the reply's lines in a monospace block the keyboard can reach and scroll", async () => {
    await open();
    fireEvent.click(outputButton());
    reply(port, ["INFO starting", "WARN <b>not markup</b>", "ERROR something failed"]);

    const lines = block()!;
    expect(lines.tagName).toBe("PRE");
    expect(lines.textContent).toBe("INFO starting\nWARN <b>not markup</b>\nERROR something failed");
    expect(lines.querySelector("b")).toBeNull();
    expect(lines.getAttribute("tabindex")).toBe("0");
    expect(lines.classList.contains("agent-conversation-output")).toBe(true);
    // A name for the block, so a screen reader says what it has landed in.
    expect(screen.getByRole("region", { name: ui("conversation.output.title") })).toBeTruthy();
    expect(lines.closest("[role='log'], [aria-live]")).toBeNull();
  });

  it("says so when the agent has printed nothing yet", async () => {
    await open();
    fireEvent.click(outputButton());
    reply(port, []);

    expect(block()).toBeNull();
    expect(screen.getByText("No output from the agent yet.")).toBeTruthy();
  });

  it("waits for the reply before it shows anything, and takes only its own conversation's", async () => {
    await open();
    fireEvent.click(outputButton());
    expect(screen.getByText(ui("conversation.output.loading"))).toBeTruthy();
    reply(port, ["someone else's line"], "conv-other-0123456789");
    expect(block()).toBeNull();
    reply(port, ["own line"]);
    expect(block()!.textContent).toBe("own line");
  });

  it("asks again on Refresh and shows the newer lines", async () => {
    await open();
    fireEvent.click(outputButton());
    reply(port, ["one"]);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.output.refresh") }));
    expect(commandsSent(port)).toHaveLength(2);
    reply(port, ["one", "two"]);
    expect(block()!.textContent).toBe("one\ntwo");
  });

  it("closes again from the same button, and the next opening asks afresh", async () => {
    await open();
    fireEvent.click(outputButton());
    reply(port, ["one"]);
    fireEvent.click(outputButton());
    expect(block()).toBeNull();
    expect(outputButton().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(outputButton());
    expect(commandsSent(port)).toHaveLength(2);
  });

  it("says it in zh-TW", async () => {
    await open("zh-TW");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(lookup("conversation.output.button", "zh-TW")) }));
    reply(port, []);
    expect(document.body.textContent).toContain(lookup("conversation.output.empty", "zh-TW"));
    expect(lookup("conversation.output.empty", "zh-TW")).not.toBe(ui("conversation.output.empty"));
  });

  it("stops saying Loading… when no reply comes (a refused request, or output wiped by a restart)", async () => {
    await open();
    vi.useFakeTimers();
    try {
      fireEvent.click(outputButton());
      expect(screen.getByText(ui("conversation.output.loading"))).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByText(ui("conversation.output.loading"))).toBeNull();
      expect(screen.getByText(ui("conversation.output.empty"))).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
