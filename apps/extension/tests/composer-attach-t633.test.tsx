import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, CONVERSATION_READY, VIEW, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 022 T633 (review of S2 + S3; FR-335, FR-339, R-342): what the composer keeps while the owner looks
 * elsewhere - the other panel tab, another browser tab - and how long it waits for the worker.
 */

const TAB_ID = 7;

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const area = () => document.querySelector<HTMLElement>(".agent-conversation-composer")!;
const chips = () => screen.queryAllByRole("listitem").filter((item) => item.closest("[data-attachments]") !== null);
const refusal = () => document.querySelector("[data-attach-refusal]")?.textContent ?? "";
const plus = () => screen.getByRole("button", { name: ui("conversation.attach.button") });
const entry = (key: string) => screen.getByRole("menuitem", { name: new RegExp(ui(key)) });
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") });
const panelTab = (name: "conversation" | "connections") =>
  screen.getByRole("tab", { name: new RegExp(ui(name === "conversation" ? "agent.tabs.conversation" : "agent.tabs.connections")) });

type Sent = { type: string; requestId?: string; commandId?: string; payload: Record<string, unknown> };
const sentOf = (port: FakeAgentPort, type: string): Sent[] => (port.sent as Sent[]).filter((message) => message.type === type);

const csv = (name = "data.csv") => new File([new Uint8Array(12).fill(66)], name, { type: "text/csv" });
function drop(files: File[]): void {
  fireEvent.dragOver(area(), { dataTransfer: { files, types: ["Files"] } });
  fireEvent.drop(area(), { dataTransfer: { files, types: ["Files"] } });
}

type Listener = (...args: unknown[]) => void;
/** The viewed tab, with the two events a panel follows it by. */
function installActiveTab(initial: { id: number; url?: string; active?: boolean }) {
  const current = { tab: { active: true, ...initial } };
  const activated: Listener[] = [];
  const updated: Listener[] = [];
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};
  chromeGlobal.tabs = {
    query: () => Promise.resolve([current.tab]),
    onActivated: { addListener: (cb: Listener) => activated.push(cb), removeListener: () => undefined },
    onUpdated: { addListener: (cb: Listener) => updated.push(cb), removeListener: () => undefined },
  };
  return {
    navigate(url: string) {
      current.tab = { ...current.tab, url };
      for (const listener of updated) listener(current.tab.id, { url }, current.tab);
    },
  };
}

/** A canvas whose every encode is 900 bytes (30 for a thumbnail), so a re-encode is visible. */
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

function reply(port: FakeAgentPort, result: Record<string, unknown>, asked = sentOf(port, "ui.tab.capture").at(-1)!): void {
  act(() => port.emit({ type: "tab-capture-result", requestId: asked.requestId, result }));
}

async function open(port: FakeAgentPort, conversation: ConversationPanelState = CONVERSATION_OPEN): Promise<void> {
  renderShell();
  project(port, withConversation(conversation));
  await settle();
}

describe("022 T633 the composer outlives a switch to Connections & sites", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
    installImageFakes();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
    vi.unstubAllGlobals();
  });

  it("a message whose piece is still unanswered keeps going while the other tab is shown, and is sent", async () => {
    await open(port);
    fireEvent.change(box(), { target: { value: "chart it" } });
    drop([csv()]);
    await settle();
    fireEvent.click(sendButton());
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;

    fireEvent.click(panelTab("connections"));
    await settle();
    act(() => port.emit({ type: "conversation-result", payload: { commandId: piece.commandId, ok: true } }));
    await settle();
    expect(sentOf(port, "ui.conversation.attach-cancel")).toHaveLength(0);
    const send = sentOf(port, "ui.conversation.send");
    expect(send.map((message) => message.payload)).toEqual([
      { conversationId: VIEW.conversationId, text: "chart it", attachments: [piece.payload.attachmentId] },
    ]);
    act(() => port.emit({ type: "conversation-result", payload: { commandId: send[0]!.commandId, ok: true } }));
    await settle();

    fireEvent.click(panelTab("conversation"));
    await settle();
    expect(box().value).toBe("");
    expect(chips()).toHaveLength(0);
  });

  it("unsent words, chips, a refusal and a capture under way are all there on return", async () => {
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    await open(port);
    fireEvent.change(box(), { target: { value: "keep me" } });
    drop([csv("a.csv")]);
    await settle();
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    const asked = sentOf(port, "ui.tab.capture").at(-1)!;

    fireEvent.click(panelTab("connections"));
    await settle();
    reply(port, { ok: true, kind: "page", url: "https://example.test/", title: "Page", text: "x", cut: false }, asked);
    await settle();
    fireEvent.click(panelTab("conversation"));
    await settle();

    expect(box().value).toBe("keep me");
    expect(chips().map((chip) => chip.getAttribute("data-attachment-kind"))).toEqual(["file", "tab"]);
    // A refusal said before the switch is still said after it.
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    reply(port, { ok: true, kind: "page", url: "https://example.test/", title: "Page", text: "x", cut: false });
    await settle();
    fireEvent.click(panelTab("connections"));
    fireEvent.click(panelTab("conversation"));
    await settle();
    expect(refusal()).toContain(ui("conversation.attach.refused.oneTab"));
  });
});

describe("022 T633 the viewed tab is followed", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("a navigation of the viewed tab updates its address (here: to a PDF, which turns 'Attach this tab' on)", async () => {
    const tab = installActiveTab({ id: TAB_ID, url: "https://example.test/" });
    const noContext: ConversationPanelState = {
      ...CONVERSATION_OPEN,
      conversations: [{ ...VIEW, accepts: { image: true, context: false } }],
    };
    await open(port, noContext);
    fireEvent.click(plus());
    expect(entry("conversation.attach.tab").getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    act(() => tab.navigate("https://example.test/report.pdf"));
    await settle();
    fireEvent.click(plus());
    expect(entry("conversation.attach.tab").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("022 T633 how long a capture is waited for", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    port = installAgentPort();
    installTabStorage();
    installImageFakes();
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("a page capture is waited for longer than 30 s, given up at 90 s, and a late answer adds nothing", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await tick(0);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.tab"));
    const asked = sentOf(port, "ui.tab.capture").at(-1)!;

    await tick(31_000);
    expect(chips().map((chip) => chip.getAttribute("data-attachment-state"))).toEqual(["preparing"]);
    await tick(60_000);
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.capture.failed"));

    reply(port, { ok: true, kind: "page", url: "https://example.test/", title: "Late", text: "x", cut: false }, asked);
    await tick(0);
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.capture.failed"));
  });

  it("a screenshot is given up at 30 s, and a late picture adds nothing", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await tick(0);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.screenshot"));
    const asked = sentOf(port, "ui.tab.capture").at(-1)!;

    await tick(30_000);
    expect(chips()).toHaveLength(0);
    expect(refusal()).toContain(ui("conversation.attach.capture.failed"));
    reply(port, { ok: true, kind: "image", mimeType: "image/jpeg", data: btoa("pixels"), width: 1280, height: 720 }, asked);
    await tick(0);
    expect(chips()).toHaveLength(0);
  });
});

describe("022 T633 a worker screenshot that already fits", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
    installImageFakes();
    installActiveTab({ id: TAB_ID, url: "https://example.test/" });
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
    vi.unstubAllGlobals();
  });

  it("goes as the worker encoded it, with a thumbnail made for the bubble", async () => {
    await open(port);
    fireEvent.click(plus());
    fireEvent.click(entry("conversation.attach.screenshot"));
    const data = btoa("worker-jpeg-bytes");
    reply(port, { ok: true, kind: "image", mimeType: "image/jpeg", data, width: 1280, height: 720 });
    await settle();
    expect(chips()[0]!.getAttribute("data-attachment-state")).toBe("ready");

    fireEvent.click(sendButton());
    await settle();
    const piece = sentOf(port, "ui.conversation.attach")[0]!;
    expect(piece.payload).toMatchObject({ kind: "image", mimeType: "image/jpeg", size: atob(data).length, data });
    expect(typeof piece.payload.thumbnail).toBe("string");
  });
});

describe("022 T633 a removed conversation's draft goes with it", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("words and chips of a conversation that left the list are not kept", async () => {
    const B: ConversationView = { ...VIEW, conversationId: "conv-bbbbbbbbbbbbbbbb", title: "Other" };
    await open(port, { ...CONVERSATION_READY, conversations: [VIEW, B], active: VIEW.conversationId });
    fireEvent.change(box(), { target: { value: "for a" } });
    drop([csv("for-a.csv")]);
    await settle();
    expect(chips()).toHaveLength(1);

    // Removed: the list no longer has it.
    project(port, withConversation({ ...CONVERSATION_READY, conversations: [B], active: B.conversationId }));
    await settle();
    // The same id listed again (a resync that brings it back) finds nothing of the old draft.
    project(port, withConversation({ ...CONVERSATION_READY, conversations: [VIEW, B], active: VIEW.conversationId }));
    await settle();
    expect(box().value).toBe("");
    expect(chips()).toHaveLength(0);
  });
});
