import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  commandsSent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 022 T628, US5 (FR-335, FR-337; D-022-5): attachments go where the words go. A first message held
 * by the first-use card holds its attachments too - Allow sends both once the conversation is open,
 * Cancel gives both back - and unsent chips stay with the conversation they were added in.
 */

const NEW_ID = "conv-fedcba9876543210";

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const area = () => document.querySelector<HTMLElement>(".agent-conversation-composer")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const chips = () => screen.queryAllByRole("listitem").filter((item) => item.closest("[data-attachments]") !== null);
const firstUse = () => screen.getByRole("region", { name: ui("conversation.firstUse.title").replace("{agent}", "Claude Code") });

type Sent = { type: string; commandId?: string; payload: Record<string, unknown> };
const sentOf = (port: FakeAgentPort, type: string): Sent[] => (port.sent as Sent[]).filter((message) => message.type === type);

function drop(files: File[]): void {
  fireEvent.dragOver(area(), { dataTransfer: { files, types: ["Files"] } });
  fireEvent.drop(area(), { dataTransfer: { files, types: ["Files"] } });
}
const csv = (name = "data.csv") => new File([new Uint8Array(12).fill(66)], name, { type: "text/csv" });

const CONSENT_ONLY: ConversationPanelState = { ...CONVERSATION_READY, consent: "unknown", agents: [{ agent: "claude-code", availability: "ready" }] };
const opened = (base: ConversationPanelState): ConversationPanelState => ({
  ...base,
  consent: "granted",
  conversations: [{ ...VIEW, conversationId: NEW_ID, title: "New" }],
  active: NEW_ID,
});

describe("022 US5 attachments are held and kept like the words", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("a message held by the first-use card holds its attachment; Allow sends both once open (scenario 1)", async () => {
    renderShell();
    project(port, withConversation(CONSENT_ONLY));
    await settle();
    fireEvent.change(box(), { target: { value: "chart it" } });
    drop([csv()]);
    await settle();
    fireEvent.click(sendButton());
    // Held: the card is up, the bubble shows the words and the attachment, nothing has left.
    expect(firstUse()).toBeTruthy();
    expect(document.querySelector(".agent-conversation-held")?.textContent).toContain("data.csv");
    expect(chips()).toHaveLength(0);
    expect(commandsSent(port)).toEqual([]);

    fireEvent.click(within(firstUse()).getByRole("button", { name: ui("conversation.firstUse.allow") }));
    project(port, withConversation({ ...CONSENT_ONLY, consent: "granted" }));
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
    project(port, withConversation(opened(CONSENT_ONLY)));
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    expect(piece.payload).toMatchObject({ conversationId: NEW_ID, kind: "file", name: "data.csv", size: 12, index: 0, final: true });
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
    act(() => port.emit({ type: "conversation-result", payload: { commandId: piece.commandId, ok: true } }));
    await settle();
    expect(sentOf(port, "ui.conversation.send").map((message) => message.payload)).toEqual([
      { conversationId: NEW_ID, text: "chart it", attachments: [piece.payload.attachmentId] },
    ]);
  });

  it("Cancel on the first-use card gives back the words and the attachments (scenario 1)", async () => {
    renderShell();
    project(port, withConversation(CONSENT_ONLY));
    await settle();
    fireEvent.change(box(), { target: { value: "chart it" } });
    drop([csv()]);
    await settle();
    fireEvent.click(sendButton());
    fireEvent.click(within(firstUse()).getByRole("button", { name: ui("conversation.firstUse.cancel") }));
    await settle();
    expect(box().value).toBe("chart it");
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining("data.csv")]);
    expect(commandsSent(port)).toEqual([]);
  });

  it("a held message whose transfer fails once open comes back to that conversation's box with its chips", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();
    fireEvent.change(box(), { target: { value: "chart it" } });
    drop([csv()]);
    await settle();
    fireEvent.click(sendButton());
    project(port, withConversation(opened(CONVERSATION_READY)));
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    act(() =>
      port.emit({
        type: "conversation-result",
        payload: { commandId: piece.commandId, ok: false, error: { code: "attachment-write-failed", detail: "Could not write." } },
      }),
    );
    await settle();
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
    expect(box().value).toBe("chart it");
    expect(chips()).toHaveLength(1);
    expect(document.querySelector("[data-attach-refusal]")?.textContent).toContain(ui("conversation.error.attachment-write-failed"));
  });

  it("chips stay with their conversation: B never shows A's, and A's are there on return (scenario 2)", async () => {
    const B: ConversationView = { ...VIEW, conversationId: "conv-bbbbbbbbbbbbbbbb", title: "Other" };
    const both = { ...CONVERSATION_OPEN, conversations: [VIEW, B] };
    renderShell();
    project(port, withConversation(both));
    await settle();
    drop([csv("for-a.csv")]);
    await settle();
    expect(chips()).toHaveLength(1);

    project(port, withConversation({ ...both, active: B.conversationId }));
    await settle();
    expect(chips()).toHaveLength(0);

    project(port, withConversation(both));
    await settle();
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining("for-a.csv")]);
  });

  it("the empty conversation's chips are its own, not the open one's", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
    drop([csv("open.csv")]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.new") }));
    await settle();
    expect(chips()).toHaveLength(0);
  });
});
