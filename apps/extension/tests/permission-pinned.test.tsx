import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_PERMISSION_CLOSURES } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T596 - a permission question cannot be missed (US4, FR-319, SC-144).
 *
 * The waiting card sits directly above the message box, in the composer area that stays in view
 * while the conversation scrolls; while it waits the box sends nothing and offers Stop only; once
 * the broker says the card closed, one line in the conversation records how.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const ask = (port: FakeAgentPort, seq = 1) =>
  emitEvent(port, seq, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "edit", title: "Write table.csv", detail: "+3 lines" });

describe("T596 the waiting permission card", () => {
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("sits directly above the message box, outside the scrolling log", async () => {
    ask(port);
    const card = screen.getByRole("group", { name: /Write table\.csv/ });
    expect(card.closest(".agent-conversation-log")).toBeNull();
    expect(card.parentElement?.classList.contains("agent-conversation-composer-area")).toBe(true);
    expect(card.nextElementSibling?.classList.contains("agent-conversation-composer")).toBe(true);
  });

  it("while it waits, Enter and submit send nothing and the box offers Stop only", async () => {
    ask(port);
    fireEvent.change(box(), { target: { value: "and also the totals" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.submit(box().closest("form")!);

    expect(commandsSent(port)).toEqual([]);
    expect(screen.queryByRole("button", { name: ui("conversation.composer.send") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.stop") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } }]);

    // The words stay for after the answer.
    expect(box().value).toBe("and also the totals");
  });

  it.each(CONVERSATION_PERMISSION_CLOSURES)("records a card closed as %s with one line in the conversation", async (answer) => {
    ask(port);
    emitEvent(port, 2, { type: "permission-closed", requestId: "r-1", answer });

    expect(screen.queryByRole("group", { name: /Write table\.csv/ })).toBeNull();
    const log = screen.getByRole("log", { name: ui("conversation.messages.label") });
    const lines = log.querySelectorAll(".agent-conversation-answer");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe(ui(`conversation.answered.${answer}`).replace("{title}", "Write table.csv"));
    expect(screen.getByRole("button", { name: ui("conversation.composer.send") })).toBeTruthy();
  });

  it("records nothing for a close of a card it never showed", async () => {
    emitEvent(port, 1, { type: "permission-closed", requestId: "r-elsewhere", answer: "reject" });
    expect(document.querySelectorAll(".agent-conversation-answer")).toHaveLength(0);
  });
});
