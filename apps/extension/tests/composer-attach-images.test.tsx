import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 022 T622, US1 (FR-325 - FR-328, FR-335, FR-336, FR-341): pictures in the composer - the "+" menu
 * and its hint, paste and drop, the five-picture limit, removing a chip, and a message that is only
 * a picture. The browser's decoder and canvas are faked; the ladder itself is prepare-image.test.ts.
 */

type Deferred = { resolve: () => void };
let decodes: Deferred[] = [];
let holdDecode = false;

function installImageFakes(): void {
  decodes = [];
  holdDecode = false;
  vi.stubGlobal("createImageBitmap", (blob: Blob) => {
    if (blob.type === "image/broken") return Promise.reject(new DOMException("bad", "InvalidStateError"));
    const bitmap = { width: 6000, height: 4000, close: () => undefined };
    if (!holdDecode) return Promise.resolve(bitmap);
    return new Promise((resolve) => decodes.push({ resolve: () => resolve(bitmap) }));
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect: () => undefined, drawImage: () => undefined };
      }
      convertToBlob(options: { type: string }) {
        return Promise.resolve(new Blob([new Uint8Array(this.width <= 160 ? 30 : 3000)], { type: options.type }));
      }
    },
  );
}

const picture = (name = "error.png", type = "image/png") => new File([new Uint8Array(40)], name, { type });

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const area = () => document.querySelector<HTMLElement>(".agent-conversation-composer")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const plus = () => screen.getByRole("button", { name: ui("conversation.attach.button") });
const chips = () => screen.queryAllByRole("listitem").filter((item) => item.closest("[data-attachments]") !== null);

function paste(files: File[], text = ""): boolean {
  return fireEvent.paste(box(), {
    clipboardData: { files, types: text === "" ? ["Files"] : ["text/plain", "Files"], getData: () => text },
  });
}
function drop(files: File[]): void {
  fireEvent.dragOver(area(), { dataTransfer: { files, types: ["Files"] } });
  fireEvent.drop(area(), { dataTransfer: { files, types: ["Files"] } });
}

describe("022 US1 pictures in the composer", () => {
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    installImageFakes();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("the + button opens a menu with the three entries and the limits; Escape closes it back onto the button", () => {
    expect(plus().getAttribute("aria-haspopup")).toBe("menu");
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(plus());
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: ui("conversation.attach.menu") });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining(ui("conversation.attach.files")),
      expect.stringContaining(ui("conversation.attach.screenshot")),
      expect.stringContaining(ui("conversation.attach.tab")),
    ]);
    expect(document.getElementById(menu.getAttribute("aria-describedby")!)?.textContent).toBe(ui("conversation.attach.hint"));
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: ui("conversation.attach.menu") })).toBeNull();
    expect(document.activeElement).toBe(plus());
  });

  it("'Add images or files…' opens the hidden picker, which takes several files", () => {
    const input = document.querySelector<HTMLInputElement>("input[type=file][data-attach-input]")!;
    expect(input.multiple).toBe(true);
    const clicked = vi.spyOn(input, "click");
    fireEvent.click(plus());
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(ui("conversation.attach.files")) }));
    expect(clicked).toHaveBeenCalled();
  });

  it("a pasted picture becomes a chip with its thumbnail, name and size, and Send is enabled (US1 scenario 1)", async () => {
    expect(sendButton().disabled).toBe(true);
    paste([picture()]);
    await settle();
    expect(chips()).toHaveLength(1);
    const chip = chips()[0]!;
    expect(chip.getAttribute("data-attachment-state")).toBe("ready");
    expect(chip.textContent).toContain("error.png");
    expect(chip.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    expect(chip.textContent).toMatch(/\d+(\.\d+)? (B|KB|MB)/);
    expect(sendButton().disabled).toBe(false);
  });

  it("pasted text still goes into the box while the picture becomes a chip", async () => {
    // The paste is not taken over: the browser's own paste puts the words in the box.
    expect(paste([picture()], "why does this fail?")).toBe(true);
    await settle();
    expect(chips()).toHaveLength(1);
  });

  it("Send waits while a picture is still being prepared (FR-336)", async () => {
    holdDecode = true;
    fireEvent.change(box(), { target: { value: "look" } });
    paste([picture()]);
    await settle();
    expect(chips()[0]!.getAttribute("data-attachment-state")).toBe("preparing");
    expect(sendButton().disabled).toBe(true);
    decodes.forEach((decode) => decode.resolve());
    await settle();
    expect(chips()[0]!.getAttribute("data-attachment-state")).toBe("ready");
    expect(sendButton().disabled).toBe(false);
  });

  it("a sixth picture dropped is refused with the limit, and the five stay (US1 scenario 3)", async () => {
    drop([1, 2, 3, 4, 5].map((n) => picture(`shot-${n}.png`)));
    await settle();
    expect(chips()).toHaveLength(5);
    drop([picture("shot-6.png")]);
    await settle();
    expect(chips()).toHaveLength(5);
    const refusal = document.querySelector("[data-attach-refusal]")!;
    expect(refusal.getAttribute("role")).toBe("status");
    expect(refusal.textContent).toContain(ui("conversation.attach.refused.tooManyImages"));
  });

  it("a file that does not decode is refused as not a picture", async () => {
    // The decoder refuses what it is given (a renamed file).
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new DOMException("bad", "InvalidStateError")));
    paste([new File([new Uint8Array(4)], "bad.png", { type: "image/png" })]);
    await settle();
    const bad = chips().find((chip) => chip.textContent?.includes("bad.png"));
    expect(bad?.getAttribute("data-attachment-state")).toBe("refused");
    expect(bad?.textContent).toContain(ui("conversation.attach.refused.notImage").replace("{name}", "bad.png"));
  });

  it("removing a chip takes it away and puts the focus in the box (US1 scenario 4)", async () => {
    paste([picture()]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.attachment.remove").replace("{name}", "error.png") }));
    expect(chips()).toHaveLength(0);
    expect(document.activeElement).toBe(box());
  });

  it("a message that is only a picture is sent: its pieces first, then the send naming it (US1 scenario 5)", async () => {
    paste([picture()]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    const piece = port.sent.find((message) => (message as { type: string }).type === "ui.conversation.attach") as {
      commandId: string;
      payload: Record<string, unknown>;
    };
    expect(agentPanelCommandSchema.safeParse(piece).success).toBe(true);
    expect(piece.payload).toMatchObject({
      conversationId: CONVERSATION_ID,
      index: 0,
      final: true,
      kind: "image",
      name: "error.png",
      // A PNG that fits stays PNG (R-341).
      mimeType: "image/png",
      size: 3000,
    });
    expect(typeof piece.payload.thumbnail).toBe("string");
    // R-337: nothing else leaves before this piece is answered.
    expect(commandsSent(port).filter((message) => (message as { type: string }).type === "ui.conversation.send")).toHaveLength(0);
    act(() => port.emit({ type: "conversation-result", payload: { commandId: piece.commandId, ok: true } }));
    await settle();
    const sent = commandsSent(port).filter((message) => (message as { type: string }).type === "ui.conversation.send");
    expect(sent).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "", attachments: [piece.payload.attachmentId] } },
    ]);
  });

  it("names every attachment with an unpredictable id, never a counter", async () => {
    paste([picture("a.png"), picture("b.png")]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    const first = port.sent.find((message) => (message as { type: string }).type === "ui.conversation.attach") as {
      commandId: string;
      payload: { attachmentId: string };
    };
    act(() => port.emit({ type: "conversation-result", payload: { commandId: first.commandId, ok: true } }));
    await settle();
    const ids = port.sent
      .filter((message) => (message as { type: string }).type === "ui.conversation.attach")
      .map((message) => (message as { payload: { attachmentId: string } }).payload.attachmentId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("text-only sending is unchanged: one send, no attach piece (US6)", async () => {
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "hello" } }]);
  });

  it("says the menu, the chips and the refusals in zh-TW too", async () => {
    cleanup();
    port = installAgentPort();
    installTabStorage();
    renderShell("zh-TW");
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
    const { lookup } = await import("../src/locales/catalog.js");
    const zhPlus = screen.getByRole("button", { name: lookup("conversation.attach.button", "zh-TW") });
    expect(lookup("conversation.attach.button", "zh-TW")).not.toBe(ui("conversation.attach.button"));
    fireEvent.click(zhPlus);
    const menu = screen.getByRole("menu");
    expect(document.getElementById(menu.getAttribute("aria-describedby")!)?.textContent).toBe(lookup("conversation.attach.hint", "zh-TW"));
  });
});
