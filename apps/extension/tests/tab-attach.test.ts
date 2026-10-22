import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PANEL_PORT_NAME,
  CONVERSATION_FILE_MAX_BYTES,
  tabCaptureResultMessageSchema,
  type TabCaptureResult,
} from "@hallpass/contracts";
import { createTabAttach, type TabAttachDeps } from "../src/service-worker/tab-attach.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import type { AgentRuntime } from "../src/service-worker/agent-runtime.js";
import { visibleTextOf } from "../src/content-runtime/visible-text.js";

/**
 * 022 T619/T620 (R-342, FR-329, FR-330): the viewed tab, captured for the owner's composer.
 *
 * The owner's own action: no site consent card, no site-mode gate - only restricted browser pages
 * are refused, by the rule the page binding uses. The answer goes to the panel document that asked,
 * under the requestId it asked with.
 */

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;

type FakeTab = { id: number; windowId: number; active: boolean; url: string; title?: string; incognito?: boolean };

type FakeChrome = {
  tabs: Record<number, FakeTab>;
  frameTexts: Record<number, string>;
  contentType: string;
  scriptCalls: number;
  /** Frames whose text read throws (a document that does not answer). */
  silentFrames?: number[];
};

function installChrome(seed: Partial<FakeChrome> & { tabs: Record<number, FakeTab> }): FakeChrome {
  const state: FakeChrome = { frameTexts: { 0: "" }, contentType: "text/html", scriptCalls: 0, ...seed };
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs[tabId];
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return tab;
      },
    },
    scripting: {
      async executeScript(injection: {
        target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
        func: (...args: unknown[]) => unknown;
        args?: unknown[];
      }) {
        state.scriptCalls += 1;
        const tab = state.tabs[injection.target.tabId];
        if (injection.target.allFrames) {
          // `enumerateTabFrames`: one top document, no children.
          return [{ frameId: 0, result: { url: tab?.url ?? "", path: [] } }];
        }
        const frameId = injection.target.frameIds?.[0] ?? 0;
        if (injection.func === visibleTextOf) {
          if (state.silentFrames?.includes(frameId)) throw new Error("Frame with ID " + frameId + " was removed.");
          return [{ frameId, result: state.frameTexts[frameId] ?? "" }];
        }
        // The content-type question about the top document.
        return [{ frameId, result: state.contentType }];
      },
    },
  };
  return state;
}

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function captureDeps(overrides: { jpeg?: string; width?: number } = {}): NonNullable<TabAttachDeps["captureDeps"]> {
  return {
    captureVisibleTab: async () => PNG_DATA_URL,
    measure: async () => ({ width: overrides.width ?? 1200, height: 800 }),
    encodeJpeg: async () => overrides.jpeg ?? "/9j/AAAA",
  };
}

function pdfResponse(bytes: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes).fill(0x25), {
    status: 200,
    headers: { "content-type": "application/pdf", ...headers },
  });
}

describe("022 tab-attach: screenshot", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("captures the visible part of the active tab as an image within the bound", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/a" } } });
    const attach = createTabAttach({ captureDeps: captureDeps() });

    const result = await attach.capture({ tabId: 7, what: "screenshot" });

    expect(result).toEqual({ ok: true, kind: "image", mimeType: "image/jpeg", data: "/9j/AAAA", width: 1200, height: 800 });
    expect(tabCaptureResultMessageSchema.safeParse({ type: "tab-capture-result", requestId: "r", result }).success).toBe(true);
  });

  it("refuses a picture still over the image bound as too-large", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/a" } } });
    const attach = createTabAttach({ captureDeps: captureDeps({ jpeg: "A".repeat(700_004) }) });

    const result = await attach.capture({ tabId: 7, what: "screenshot" });

    expect(result).toMatchObject({ ok: false, code: "too-large" });
  });

  it("refuses a tab that is not the active one of its window, without capturing", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: false, url: "https://example.test/a" } } });
    const captureVisibleTab = vi.fn(async () => PNG_DATA_URL);
    const attach = createTabAttach({ captureDeps: { ...captureDeps(), captureVisibleTab } });

    const result = await attach.capture({ tabId: 7, what: "screenshot" });

    expect(result).toMatchObject({ ok: false, code: "not-active" });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    ["a browser page", "chrome://settings/"],
    ["the Web Store", "https://chromewebstore.google.com/detail/x/abc"],
    ["the old Web Store", "https://chrome.google.com/webstore/detail/abc"],
    ["another extension", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/page.html"],
    ["a local file", "file:///C:/notes.html"],
    ["a data: page", "data:text/html,<p>hi</p>"],
    ["a blob: page", "blob:https://example.test/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"],
  ])("refuses %s as restricted for both kinds", async (_label, url) => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url } } });
    const captureVisibleTab = vi.fn(async () => PNG_DATA_URL);
    const fetchPdf = vi.fn();
    const attach = createTabAttach({ captureDeps: { ...captureDeps(), captureVisibleTab }, fetch: fetchPdf });

    expect(await attach.capture({ tabId: 7, what: "screenshot" })).toMatchObject({ ok: false, code: "restricted" });
    expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "restricted" });
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("refuses an incognito tab as restricted for both kinds", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/a", incognito: true } } });
    const captureVisibleTab = vi.fn(async () => PNG_DATA_URL);
    const attach = createTabAttach({ captureDeps: { ...captureDeps(), captureVisibleTab } });

    expect(await attach.capture({ tabId: 7, what: "screenshot" })).toMatchObject({ ok: false, code: "restricted" });
    expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "restricted" });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("answers a tab that is gone as failed with a message", async () => {
    installChrome({ tabs: {} });
    const attach = createTabAttach({ captureDeps: captureDeps() });

    const result = await attach.capture({ tabId: 99, what: "screenshot" });

    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });
});

describe("022 tab-attach: page", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers the address, title and visible text of a tab that need not be active", async () => {
    installChrome({
      tabs: { 7: { id: 7, windowId: 3, active: false, url: "https://example.test/a", title: "Example" } },
      frameTexts: { 0: "Hello page" },
    });
    const attach = createTabAttach({});

    const result = await attach.capture({ tabId: 7, what: "page" });

    expect(result).toEqual({ ok: true, kind: "page", url: "https://example.test/a", title: "Example", text: "Hello page", cut: false });
  });

  it("cuts the text at 50 000 characters and says so", async () => {
    installChrome({
      tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/a", title: "Long" } },
      frameTexts: { 0: "x".repeat(60_000) },
    });
    const attach = createTabAttach({});

    const result = await attach.capture({ tabId: 7, what: "page" });

    expect(result).toMatchObject({ ok: true, kind: "page", cut: true });
    expect((result as { text: string }).text).toHaveLength(50_000);
    expect(tabCaptureResultMessageSchema.safeParse({ type: "tab-capture-result", requestId: "r", result }).success).toBe(true);
  });

  it("attaches a PDF tab (by its path) as a file fetched by the worker", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/docs/report%20q3.pdf", title: "Q3" } } });
    const fetchPdf = vi.fn(async () => pdfResponse(10));
    const attach = createTabAttach({ fetch: fetchPdf });

    const result = await attach.capture({ tabId: 7, what: "page" });

    expect(fetchPdf).toHaveBeenCalledWith("https://example.test/docs/report%20q3.pdf", expect.anything());
    expect(result).toEqual({
      ok: true,
      kind: "file",
      name: "report q3.pdf",
      mimeType: "application/pdf",
      data: btoa("%".repeat(10)),
      size: 10,
    });
  });

  it("attaches a PDF tab known by its content type, named after its title", async () => {
    installChrome({
      tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/view/", title: "Annual report" } },
      contentType: "application/pdf",
    });
    const attach = createTabAttach({ fetch: async () => pdfResponse(4) });

    const result = await attach.capture({ tabId: 7, what: "page" });

    expect(result).toMatchObject({ ok: true, kind: "file", name: "Annual report.pdf", size: 4 });
  });

  it("refuses a PDF over 25 MB as too-large", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/big.pdf" } } });
    const attach = createTabAttach({
      fetch: async () => pdfResponse(16, { "content-length": String(CONVERSATION_FILE_MAX_BYTES + 1) }),
    });

    expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "too-large" });
  });

  it("refuses a PDF whose bytes run over 25 MB even without a length header", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/big.pdf" } } });
    const attach = createTabAttach({ fetch: async () => pdfResponse(CONVERSATION_FILE_MAX_BYTES + 1) });

    expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "too-large" });
  });

  it("stops reading a PDF body once it passes 25 MB when the length header is absent or wrong (T633)", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/big.pdf" } } });
    const chunk = 1024 * 1024;
    const total = CONVERSATION_FILE_MAX_BYTES * 2;
    for (const headers of [{}, { "content-length": "10" }]) {
      let pulled = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= total) {
            controller.close();
            return;
          }
          pulled += chunk;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          cancelled = true;
        },
      });
      const attach = createTabAttach({ fetch: async () => new Response(body, { status: 200, headers }) });

      expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "too-large" });
      // Not the whole body: at most the bound and the piece that crossed it (plus the stream's read-ahead).
      expect(pulled).toBeLessThanOrEqual(CONVERSATION_FILE_MAX_BYTES + 2 * chunk);
      expect(cancelled).toBe(true);
    }
  });

  it("answers a PDF fetch that failed as failed", async () => {
    installChrome({ tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/x.pdf" } } });
    const attach = createTabAttach({ fetch: async () => new Response("no", { status: 404 }) });

    expect(await attach.capture({ tabId: 7, what: "page" })).toMatchObject({ ok: false, code: "failed" });
  });
});

describe("022 tab-attach: a page that does not answer", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers failed when the top document's text cannot be read (T633)", async () => {
    installChrome({
      tabs: { 7: { id: 7, windowId: 3, active: true, url: "https://example.test/a", title: "A" } },
      frameTexts: { 0: "never read" },
      silentFrames: [0],
    });
    const attach = createTabAttach({});

    const result = await attach.capture({ tabId: 7, what: "page" });

    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(tabCaptureResultMessageSchema.safeParse({ type: "tab-capture-result", requestId: "r", result }).success).toBe(true);
  });
});

describe("022 tab-attach: in-page text collection", () => {
  it("drops controls, hidden parts and Hallpass's own indicator, like get_page_text", () => {
    const removed: string[] = [];
    const clone = {
      textContent: "  visible  ",
      querySelectorAll(selector: string) {
        removed.push(selector);
        return [] as Array<{ remove?: () => void }>;
      },
    };
    const text = visibleTextOf("data-hallpass-indicator", { cloneNode: () => clone });
    expect(text).toBe("visible");
    expect(removed[0]).toContain('[aria-hidden="true"]');
    expect(removed[0]).toContain("[data-hallpass-indicator]");
  });
});

/* ------------------------------------------------------------------------------------------- */

type FakePanelPort = AgentPanelPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePanelPort(): FakePanelPort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    name: AGENT_PANEL_PORT_NAME,
    sender: { id: EXTENSION_ID, url: PANEL_URL } as chrome.runtime.MessageSender,
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

/** A runtime whose every owner decision is a spy: a tab capture must reach none of them. */
function spyRuntime() {
  const prompts = { decide: vi.fn(), decidePlan: vi.fn(), decideSitePlan: vi.fn() };
  const runtime = {
    subscribe: vi.fn(),
    projection: vi.fn(async () => {
      throw new Error("not under test");
    }),
    conversation: { onPanelMessage: vi.fn(), command: vi.fn() },
    prompts,
    pairing: { decide: vi.fn(), ignore: vi.fn() },
    setSiteMode: vi.fn(),
    setDiagnostics: vi.fn(),
  };
  return { runtime: runtime as unknown as AgentRuntime, spies: runtime };
}

describe("022 ui.tab.capture routing", () => {
  beforeEach(() => {
    installChrome({ tabs: {} });
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers only the panel document that asked, under its requestId, with no consent or gate", async () => {
    const { runtime, spies } = spyRuntime();
    const answer: TabCaptureResult = { ok: true, kind: "page", url: "https://a.test/", title: "A", text: "t", cut: false };
    const tabCapture = vi.fn(async () => answer);
    const panel = createAgentPanelPort({ extensionId: EXTENSION_ID, sidePanelUrl: PANEL_URL, runtime, tabCapture });
    const asker = fakePanelPort();
    const other = fakePanelPort();
    panel.accept(asker);
    panel.accept(other);

    asker.emit({ type: "ui.tab.capture", requestId: "req-42", payload: { tabId: 7, what: "page" } });

    await vi.waitFor(() =>
      expect(asker.sent).toContainEqual({ type: "tab-capture-result", requestId: "req-42", result: answer }),
    );
    expect(tabCapture).toHaveBeenCalledWith({ tabId: 7, what: "page" });
    expect(other.sent.filter((m) => (m as { type?: string }).type === "tab-capture-result")).toEqual([]);
    for (const spy of [
      spies.prompts.decide,
      spies.prompts.decidePlan,
      spies.prompts.decideSitePlan,
      spies.pairing.decide,
      spies.setSiteMode,
      spies.setDiagnostics,
      spies.conversation.command,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("answers failed when the capture itself throws", async () => {
    const { runtime } = spyRuntime();
    const panel = createAgentPanelPort({
      extensionId: EXTENSION_ID,
      sidePanelUrl: PANEL_URL,
      runtime,
      tabCapture: async () => {
        throw new Error("boom");
      },
    });
    const asker = fakePanelPort();
    panel.accept(asker);

    asker.emit({ type: "ui.tab.capture", requestId: "req-9", payload: { tabId: 7, what: "screenshot" } });

    await vi.waitFor(() => {
      const reply = asker.sent.find((m) => (m as { type?: string }).type === "tab-capture-result");
      expect(reply).toMatchObject({ requestId: "req-9", result: { ok: false, code: "failed" } });
      expect(tabCaptureResultMessageSchema.safeParse(reply).success).toBe(true);
    });
  });
});
