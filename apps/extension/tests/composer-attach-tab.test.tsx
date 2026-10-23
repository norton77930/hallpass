import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPanelCommandSchema, type ConversationPanelState } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, CONVERSATION_READY, VIEW, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 022 T626, US2 + US3 (panel side; FR-329, FR-330, FR-334; R-342, R-344): the "+" menu's two tab
 * entries. Each asks the worker for the tab the owner is looking at with `ui.tab.capture` and adds
 * what comes back: a picture, the page (a tab chip, marked when its text was cut), or a PDF as a
 * file. A refusal is said; the entries are disabled, with the reason, when there is no tab or the
 * agent does not take pictures / page context (a PDF tab still goes, as a file).
 */

const TAB_ID = 7;

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const chips = () => screen.queryAllByRole("listitem").filter((item) => item.closest("[data-attachments]") !== null);
const refusal = () => document.querySelector("[data-attach-refusal]")?.textContent ?? "";
const plus = () => screen.getByRole("button", { name: ui("conversation.attach.button") });
const entry = (key: string) => screen.getByRole("menuitem", { name: new RegExp(ui(key)) });

type Sent = { type: string; requestId?: string; commandId?: string; payload: Record<string, unknown> };
const sentOf = (port: FakeAgentPort, type: string): Sent[] => (port.sent as Sent[]).filter((message) => message.type === type);

function installActiveTab(tab: { id: number; url?: string } | undefined): void {
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};
  chromeGlobal.tabs = {
    query: () => Promise.resolve(tab === undefined ? [] : [tab]),
    onActivated: { addListener: () => undefined, removeListener: () => undefined },
  };
}

function installImageFakes(): void {
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 1280, height: 720, close: () => undefined }));
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
        return Promise.resolve(new Blob([new Uint8Array(this.width <= 160 ? 30 : 900)], { type: options.type }));
      }
    },
  );
}

async function open(port: FakeAgentPort, conversation: ConversationPanelState = CONVERSATION_OPEN): Promise<void> {
  renderShell();
  project(port, withConversation(conversation));
  await settle();
}

function reply(port: FakeAgentPort, result: Record<string, unknown>): void {
  const asked = sentOf(port, "ui.tab.capture").at(-1)!;
  act(() => port.emit({ type: "tab-capture-result", requestId: asked.requestId, result }));
}

describe("022 US2/US3 the tab entries of the + menu", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
    installImageFakes();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("'Screenshot of this tab' asks the worker for the viewed tab and adds a picture chip", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    await open(port);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.screenshot"));
    const asked = sentOf(port, "ui.tab.capture");
    expect(asked).toHaveLength(1);
    expect(agentPanelCommandSchema.safeParse(asked[0]).success).toBe(true);
    expect(asked[0]!.payload).toEqual({ tabId: TAB_ID, what: "screenshot" });
    reply(port, { ok: true, kind: "image", mimeType: "image/png", data: btoa("pixels"), width: 1280, height: 720 });
    await settle();
    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.getAttribute("data-attachment-kind")).toBe("image");
    expect(chips()[0]!.getAttribute("data-attachment-state")).toBe("ready");
    expect(chips()[0]!.textContent).toContain(ui("conversation.attachment.screenshotName"));
  });

  it("'Attach this tab' adds a tab chip with the title, marked when the text was cut, and sends it as a tab", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/article" });
    await open(port);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    expect(sentOf(port, "ui.tab.capture")[0]!.payload).toEqual({ tabId: TAB_ID, what: "page" });
    reply(port, { ok: true, kind: "page", url: "https://example.test/article", title: "A long article", text: "Hello, 世界", cut: true });
    await settle();
    const chip = chips()[0]!;
    expect(chip.getAttribute("data-attachment-kind")).toBe("tab");
    expect(chip.textContent).toContain("A long article");
    expect(chip.querySelector("[data-cut]")?.textContent).toBe(ui("conversation.attachment.cut"));

    expect((screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
    await settle();
    expect(port.sent.map((message) => (message as { type: string }).type)).toContain("ui.conversation.attach");
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    expect(agentPanelCommandSchema.safeParse(piece).error?.issues).toBeUndefined();
    const utf8 = new TextEncoder().encode("Hello, 世界");
    expect(piece.payload).toMatchObject({
      kind: "tab",
      name: "A long article",
      size: utf8.length,
      tab: { url: "https://example.test/article", title: "A long article", cut: true },
      final: true,
    });
    expect(new TextDecoder().decode(Uint8Array.from(atob(piece.payload.data as string), (c) => c.charCodeAt(0)))).toBe("Hello, 世界");
  });

  it("a PDF tab comes back as a file and becomes a file chip", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/report.pdf" });
    await open(port);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    reply(port, { ok: true, kind: "file", name: "report.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.7"), size: 8 });
    await settle();
    expect(chips()[0]!.getAttribute("data-attachment-kind")).toBe("file");
    expect(chips()[0]!.textContent).toContain("report.pdf");
  });

  it("a restricted page is refused with the reason and nothing is attached (US2 scenario 2)", async () => {
    installActiveTab({ id: TAB_ID, url: "chrome://extensions/" });
    await open(port);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.screenshot"));
    reply(port, { ok: false, code: "restricted", message: "This page cannot be captured." });
    await settle();
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.capture.restricted"));
  });

  it("with no tab in this window both tab entries are disabled with the reason", async () => {
    installActiveTab(undefined);
    await open(port);
    fireEvent.click(plus());
    for (const key of ["conversation.attach.screenshot", "conversation.attach.tab"]) {
      const item = entry(key);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain(ui("conversation.attach.noTab"));
      fireEvent.click(item);
    }
    expect(sentOf(port, "ui.tab.capture")).toHaveLength(0);
  });

  it("an open conversation whose agent takes no pictures: the screenshot entry is off, a picture is refused, a file still goes", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    await open(port, { ...CONVERSATION_OPEN, conversations: [{ ...VIEW, accepts: { image: false, context: true } }] });
    fireEvent.click(plus());
    const shot = entry("conversation.attach.screenshot");
    expect(shot.getAttribute("aria-disabled")).toBe("true");
    expect(shot.textContent).toContain(ui("conversation.attach.noImages").replace("{agent}", "Claude Code"));
    expect(entry("conversation.attach.tab").getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const input = document.querySelector<HTMLInputElement>("input[type=file][data-attach-input]")!;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], "notes.txt", { type: "text/plain" })] } });
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], "shot.png", { type: "image/png" })] } });
    await settle();
    expect(chips().map((chip) => chip.getAttribute("data-attachment-kind"))).toEqual(["file"]);
    expect(refusal()).toContain(ui("conversation.attach.noImages").replace("{agent}", "Claude Code"));
  });

  it("023 FR-365: an agent that takes no page context still offers 'Attach this tab' - a page goes as a tab chip, a PDF as a file", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    const noContext = {
      ...CONVERSATION_READY,
      agents: [
        { agent: "claude-code" as const, availability: "ready" as const, version: "2.1.0", accepts: { image: true, context: false } },
        { agent: "codex" as const, availability: "ready" as const, version: "0.50.0" },
      ],
    };
    // No conversation open: the chosen agent's entry decides.
    await open(port, noContext);
    fireEvent.click(plus());
    const tab = entry("conversation.attach.tab");
    expect(tab.getAttribute("aria-disabled")).toBeNull();
    expect(entry("conversation.attach.screenshot").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(tab);
    reply(port, { ok: true, kind: "page", url: "https://example.test/", title: "Page", text: "x", cut: false });
    await settle();
    expect(chips().map((chip) => chip.getAttribute("data-attachment-kind"))).toEqual(["tab"]);
    expect(refusal()).toBe("");
    cleanup();

    installActiveTab({ id: TAB_ID, url: "https://example.test/report.pdf" });
    await open(port, noContext);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    reply(port, { ok: true, kind: "file", name: "report.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.7"), size: 8 });
    await settle();
    expect(chips().map((chip) => chip.getAttribute("data-attachment-kind"))).toEqual(["file"]);
  });

  it("023: for an agent without page context a page the worker cannot read is still refused when captured", async () => {
    installActiveTab({ id: TAB_ID, url: "chrome://extensions/" });
    const noContext = {
      ...CONVERSATION_READY,
      agents: [{ agent: "claude-code" as const, availability: "ready" as const, version: "2.1.0", accepts: { image: true, context: false } }],
    };
    await open(port, noContext);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    reply(port, { ok: false, code: "restricted", message: "This page cannot be captured." });
    await settle();
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.capture.restricted"));
  });

  it("a second tab is refused: one tab per message", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    await open(port);
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(plus());
      fireEvent.click(entry("conversation.attach.tab"));
      reply(port, { ok: true, kind: "page", url: "https://example.test/", title: "Page", text: "x", cut: false });
      await settle();
    }
    expect(chips()).toHaveLength(1);
    expect(refusal()).toContain(ui("conversation.attach.refused.oneTab"));
  });
});
