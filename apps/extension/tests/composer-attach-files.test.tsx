import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPanelCommandSchema, type ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, VIEW, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 022 T624, US4 (panel side; FR-328, FR-332, FR-336, FR-339; R-337, R-338): files in the composer
 * and their transfer. A file is checked against the limits when it is added; at Send it leaves in
 * pieces of at most 512 KiB, each awaited before the next, and only then does the send name it. Any
 * failure - a refused piece, no answer within 30 s, the conversation left, the panel closed - cancels
 * every attachment already begun, keeps the words and the chips, and sends nothing.
 */

const MB = 1024 * 1024;
const KIB_512 = 512 * 1024;

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const area = () => document.querySelector<HTMLElement>(".agent-conversation-composer")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const chips = () => screen.queryAllByRole("listitem").filter((item) => item.closest("[data-attachments]") !== null);
const refusal = () => document.querySelector("[data-attach-refusal]")?.textContent ?? "";

type Sent = { type: string; commandId?: string; payload: Record<string, unknown> };
const sentOf = (port: FakeAgentPort, type: string): Sent[] => (port.sent as Sent[]).filter((message) => message.type === type);

function file(name: string, bytes: number, type = "text/csv"): File {
  return new File([new Uint8Array(bytes).fill(65)], name, { type });
}
/** A file that says it is this big without holding the bytes (the limits read `size`). */
function bigFile(name: string, size: number): File {
  const made = new File([new Uint8Array(1)], name, { type: "application/octet-stream" });
  Object.defineProperty(made, "size", { value: size });
  return made;
}
function drop(files: File[]): void {
  fireEvent.dragOver(area(), { dataTransfer: { files, types: ["Files"] } });
  fireEvent.drop(area(), { dataTransfer: { files, types: ["Files"] } });
}
function pick(files: File[]): void {
  fireEvent.change(document.querySelector<HTMLInputElement>("input[type=file][data-attach-input]")!, { target: { files } });
}
function answer(port: FakeAgentPort, commandId: string, ok = true, code = "attachment-write-failed"): void {
  act(() =>
    port.emit({
      type: "conversation-result",
      payload: ok ? { commandId, ok: true } : { commandId, ok: false, error: { code, detail: "The file could not be written." } },
    }),
  );
}

describe("022 US4 files in the composer", () => {
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    uninstallAgentPort();
  });

  it("a dropped CSV becomes a file chip with its name and size", async () => {
    drop([file("data.csv", 3 * 1024)]);
    await settle();
    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.getAttribute("data-attachment-kind")).toBe("file");
    expect(chips()[0]!.textContent).toContain("data.csv");
    expect(chips()[0]!.textContent).toContain("3 KB");
    expect(within(chips()[0]!).getByRole("button", { name: ui("conversation.attachment.remove").replace("{name}", "data.csv") })).toBeTruthy();
  });

  it("a 30 MB file is refused when it is added, with the limit, and nothing leaves (US4 scenario 3)", async () => {
    pick([bigFile("huge.bin", 30 * MB)]);
    await settle();
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.refused.fileTooLarge").replace("{name}", "huge.bin"));
    expect(commandsSent(port)).toEqual([]);
  });

  it("refuses a file that would take the message over 25 MB in all", async () => {
    pick([bigFile("a.bin", 20 * MB)]);
    pick([bigFile("b.bin", 10 * MB)]);
    await settle();
    expect(chips().map((chip) => chip.textContent)).toEqual([expect.stringContaining("a.bin")]);
    expect(refusal()).toContain(ui("conversation.attach.refused.filesTooLarge"));
  });

  it("refuses a sixth file", async () => {
    pick([1, 2, 3, 4, 5, 6].map((n) => file(`f${n}.txt`, 10, "text/plain")));
    await settle();
    expect(chips()).toHaveLength(5);
    expect(refusal()).toContain(ui("conversation.attach.refused.tooManyFiles"));
  });

  it("sends a file in pieces of at most 512 KiB, each awaited, then the send with its id and the words", async () => {
    const size = Math.round(1.2 * MB);
    drop([file("data.csv", size)]);
    fireEvent.change(box(), { target: { value: "chart this" } });
    await settle();
    fireEvent.click(sendButton());
    await settle();
    for (let index = 0; index < 3; index += 1) {
      const pieces = sentOf(port, "ui.conversation.attach");
      expect(pieces).toHaveLength(index + 1);
      const piece = pieces[index]!;
      expect(agentPanelCommandSchema.safeParse(piece).success).toBe(true);
      expect(piece.payload.index).toBe(index);
      expect(piece.payload.final).toBe(index === 2);
      const raw = atob(piece.payload.data as string).length;
      expect(raw).toBe(index < 2 ? KIB_512 : size - 2 * KIB_512);
      if (index === 0) expect(piece.payload).toMatchObject({ kind: "file", name: "data.csv", size });
      else expect(piece.payload.kind).toBeUndefined();
      expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
      answer(port, piece.commandId!);
      await settle();
    }
    const id = sentOf(port, "ui.conversation.attach")[0]!.payload.attachmentId;
    expect(sentOf(port, "ui.conversation.send").map((message) => message.payload)).toEqual([
      { conversationId: CONVERSATION_ID, text: "chart this", attachments: [id] },
    ]);
    // Held until the broker takes the send...
    expect(box().readOnly).toBe(true);
    answer(port, sentOf(port, "ui.conversation.send")[0]!.commandId!);
    await settle();
    // ...then sent: the box is empty again and the chips are gone.
    expect(box().value).toBe("");
    expect(chips()).toHaveLength(0);
  });

  it("a refused piece cancels what began, shows why, keeps the words and chips, and sends nothing (US4 scenario 5)", async () => {
    drop([file("one.csv", 10), file("two.csv", 10)]);
    fireEvent.change(box(), { target: { value: "both please" } });
    await settle();
    fireEvent.click(sendButton());
    await settle();
    answer(port, sentOf(port, "ui.conversation.attach")[0]!.commandId!);
    await settle();
    const second = sentOf(port, "ui.conversation.attach")[1]!;
    answer(port, second.commandId!, false, "attachment-folder-gone");
    await settle();
    const ids = sentOf(port, "ui.conversation.attach").map((piece) => piece.payload.attachmentId);
    expect(sentOf(port, "ui.conversation.attach-cancel").map((message) => message.payload)).toEqual(
      ids.map((attachmentId) => ({ conversationId: CONVERSATION_ID, attachmentId })),
    );
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.error.attachment-folder-gone"));
    expect(box().value).toBe("both please");
    expect(chips()).toHaveLength(2);
    expect(chips().every((chip) => chip.getAttribute("data-attachment-state") === "ready")).toBe(true);
  });

  it("a piece with no answer within 30 s counts as failed: cancelled, said, nothing sent", async () => {
    drop([file("slow.csv", 10)]);
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(sendButton());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sentOf(port, "ui.conversation.attach")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    vi.useRealTimers();
    await settle();
    const id = sentOf(port, "ui.conversation.attach")[0]!.payload.attachmentId;
    expect(sentOf(port, "ui.conversation.attach-cancel").map((message) => message.payload)).toEqual([
      { conversationId: CONVERSATION_ID, attachmentId: id },
    ]);
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.refused.transfer"));
    expect(chips()).toHaveLength(1);
  });

  it("a send the broker refuses after the pieces keeps the words and chips and shows why", async () => {
    drop([file("data.csv", 10)]);
    fireEvent.change(box(), { target: { value: "go" } });
    await settle();
    fireEvent.click(sendButton());
    await settle();
    answer(port, sentOf(port, "ui.conversation.attach")[0]!.commandId!);
    await settle();
    answer(port, sentOf(port, "ui.conversation.send")[0]!.commandId!, false, "attachment-not-accepted");
    await settle();
    expect(refusal()).toContain(ui("conversation.error.attachment-not-accepted"));
    expect(box().value).toBe("go");
    expect(chips()).toHaveLength(1);
  });

  it("leaving the conversation mid-transfer gives the transfer up and cancels what began", async () => {
    const other: ConversationView = { ...VIEW, conversationId: "conv-bbbbbbbbbbbbbbbb", title: "Other" };
    project(port, withConversation({ ...CONVERSATION_OPEN, conversations: [VIEW, other] }));
    await settle();
    drop([file("data.csv", 10)]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    project(port, withConversation({ ...CONVERSATION_OPEN, conversations: [VIEW, other], active: other.conversationId }));
    await settle();
    answer(port, piece.commandId!);
    await settle();
    expect(sentOf(port, "ui.conversation.attach-cancel").map((message) => message.payload)).toEqual([
      { conversationId: CONVERSATION_ID, attachmentId: piece.payload.attachmentId },
    ]);
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
  });

  it("closing the panel mid-transfer cancels what began, best effort", async () => {
    drop([file("data.csv", 10)]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    cleanup();
    expect(sentOf(port, "ui.conversation.attach-cancel").map((message) => message.payload)).toEqual([
      { conversationId: CONVERSATION_ID, attachmentId: piece.payload.attachmentId },
    ]);
  });

  it("a worker that goes away mid-transfer fails the transfer: cancelled, said, nothing sent", async () => {
    drop([file("data.csv", 10)]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    port.drop();
    await settle();
    expect(sentOf(port, "ui.conversation.send")).toHaveLength(0);
    expect(refusal()).not.toBe("");
    expect(chips()).toHaveLength(1);
  });
});
