import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, VIEW, installTabStorage, lastCommandId, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T610 - opening a listed conversation switches at once. The worker moves the open conversation
 * as soon as the open leaves and shows it `starting` until the broker answers (its replay can take
 * seconds); a `cannot-resume` refusal keeps it open on its own ended page, any other refusal goes
 * back (conversation-relay.test.ts). The panel shows what it is projected - and drops the refusal it
 * showed on the conversation the owner left.
 */

const B: ConversationView = { ...VIEW, conversationId: "conv-bbbbbbbbbbbbbbbb", title: "Explain the relay handshake", state: "stopped" };
const BOTH: ConversationPanelState = { ...CONVERSATION_OPEN, conversations: [VIEW, B] };

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const title = () => document.querySelector(".agent-conversation-title")?.textContent;
const notices = () => [...document.querySelectorAll("[data-notice-code]")].map((element) => element.getAttribute("data-notice-code"));

describe("T610 a conversation chosen from the list is shown at once", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function refusedOnA(): Promise<void> {
    renderShell();
    project(port, withConversation(BOTH));
    await settle();
    // A refusal on the open conversation (A).
    fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: "and now?" } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId: lastCommandId(port), ok: false, error: { code: "busy", detail: "Still answering." } } });
    });
    expect(notices()).toEqual(["busy"]);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Explain the relay handshake/ }));
  }

  it("shows the chosen conversation starting, without the refusal shown on the one left", async () => {
    await refusedOnA();
    // What the worker projects while the open is under way.
    project(port, withConversation({ ...BOTH, active: B.conversationId, conversations: [VIEW, { ...B, state: "starting" }] }));
    await settle();

    expect(title()).toBe("Explain the relay handshake");
    expect(screen.getByText(ui("conversation.state.startingTimed").replace("{agent}", "Claude Code"))).toBeTruthy();
    expect(notices()).toEqual([]);
  });

  it("refused as cannot-resume: the chosen conversation's own ended page, with the refusal on it", async () => {
    await refusedOnA();
    const open = lastCommandId(port);
    project(port, withConversation({ ...BOTH, active: B.conversationId, conversations: [VIEW, { ...B, resumable: false }] }));
    act(() => {
      port.emit({
        type: "conversation-result",
        payload: { commandId: open, ok: false, error: { code: "cannot-resume", detail: "Claude Code no longer has this conversation." } },
      });
    });
    await settle();

    expect(title()).toBe("Explain the relay handshake");
    expect(screen.getByText(ui("conversation.cannotResume.body"))).toBeTruthy();
    expect(notices()).toEqual(["cannot-resume"]);
  });

  it("any other refusal: back on the conversation open before, the refusal shown there", async () => {
    await refusedOnA();
    const open = lastCommandId(port);
    project(port, withConversation({ ...BOTH, active: B.conversationId, conversations: [VIEW, { ...B, state: "starting" }] }));
    await settle();
    project(port, withConversation(BOTH));
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId: open, ok: false, error: { code: "too-many-running", detail: "No room." } } });
    });
    await settle();

    expect(title()).toBe(VIEW.title);
    expect(notices()).toEqual(["too-many-running"]);
  });

  it("an unsent draft stays with its conversation, not with the one chosen next", async () => {
    renderShell();
    project(port, withConversation(BOTH));
    await settle();
    fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: "half a thought" } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Explain the relay handshake/ }));
    project(port, withConversation({ ...BOTH, active: B.conversationId }));
    await settle();

    expect(title()).toBe("Explain the relay handshake");
    expect(document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!.value).toBe("");
  });
});
