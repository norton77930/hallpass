import {
  CONVERSATION_FILE_MAX_BYTES,
  CONVERSATION_IMAGE_MAX_CHARS,
  CONVERSATION_TAB_TEXT_MAX_CHARS,
  CONVERSATION_TAB_TITLE_MAX_CHARS,
  CONVERSATION_TAB_URL_MAX_CHARS,
  type TabCaptureResult,
} from "@hallpass/contracts";
import { captureTab, type CaptureDeps } from "../chrome-adapters/capture.js";
import { classifyPageSupport } from "../chrome-adapters/tabs.js";
import { enumerateTabFrames } from "../chrome-adapters/scripting.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "../content-runtime/indicator-marker.js";
import { visibleTextOf } from "../content-runtime/visible-text.js";
import { tabSupportInput } from "./content-broker.js";
import { mergePageText, tabFrames, type FrameEnumerator } from "./agent-tools/frames.js";

/**
 * The tab the owner is looking at, for an attachment in the composer (022 R-342, FR-329, FR-330).
 *
 * The owner's own action, so nothing here asks for site consent or consults a site mode (D-022-2,
 * D-022-3, spec Edge Cases): a site the agent site list blocks is still the owner's to attach. What
 * is refused is what the page binding refuses for everyone - browser pages, the Web Store, other
 * extensions, files, incognito - through the same classification (`tabSupportInput`), so the two
 * lists cannot drift.
 *
 * No session, no content-runtime binding: the page text is the content runtime's own visible-text
 * definition run through `chrome.scripting`, because a probe from a new conversation would drop
 * every ref an agent session holds on the same tab.
 */

export type TabCaptureRequest = { tabId: number; what: "screenshot" | "page" };

export type TabAttachDeps = {
  /** The picture's seams (`captureTab`'s); absent are the real `chrome.tabs` and canvas. */
  captureDeps?: CaptureDeps;
  enumerateFrames?: FrameEnumerator;
  /** The worker's `fetch`, for a PDF tab's bytes. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
};

export type TabAttach = {
  capture(request: TabCaptureRequest): Promise<TabCaptureResult>;
};

function refuse(code: "restricted" | "not-active" | "too-large" | "failed", message: string): TabCaptureResult {
  return { ok: false, code, message: message.slice(0, 600) || code };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "the tab could not be captured";
}

/** Runs in the top document: what the browser says the document is. */
function documentContentType(): string {
  return document.contentType;
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * A response body of at most `limit` bytes, or undefined once it runs past it (T633): read piece by
 * piece and given up at the first piece over the bound, so a body whose length header is absent or
 * wrong is never held whole in the worker's memory.
 */
async function boundedBody(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? undefined : bytes;
  }
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    pieces.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
}

/** The URL's last path segment, else the title, as a `.pdf` name of at most 255 characters. */
function pdfName(url: URL, title: string | undefined): string {
  const raw = url.pathname.split("/").pop() ?? "";
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    // A malformed escape keeps the segment as written.
  }
  const base = segment.trim() || title?.trim() || "document";
  const named = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
  return named.length <= 255 ? named : `${named.slice(0, 251)}.pdf`;
}

export function createTabAttach(deps: TabAttachDeps = {}): TabAttach {
  const enumerateFrames = deps.enumerateFrames ?? enumerateTabFrames;
  const fetchBytes = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));

  async function screenshot(tab: chrome.tabs.Tab): Promise<TabCaptureResult> {
    // `captureVisibleTab` photographs what the window shows; bringing another tab forward would
    // move the owner's window under them, so only the active tab is offered (R-342).
    if (!tab.active || tab.id === undefined) return refuse("not-active", "the tab is not the one its window shows");
    const image = await captureTab({ tabId: tab.id, windowId: tab.windowId, isActive: true }, deps.captureDeps ?? {});
    if (image.width === undefined || image.height === undefined) {
      return refuse("failed", "the picture's size could not be read");
    }
    if (image.data.length > CONVERSATION_IMAGE_MAX_CHARS) {
      return refuse("too-large", "the picture is larger than one message can carry");
    }
    return { ok: true, kind: "image", mimeType: image.mimeType, data: image.data, width: image.width, height: image.height };
  }

  async function pdf(url: URL, title: string | undefined): Promise<TabCaptureResult> {
    const response = await fetchBytes(url.href, { credentials: "include" });
    if (!response.ok) return refuse("failed", `the PDF could not be fetched (HTTP ${response.status})`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > CONVERSATION_FILE_MAX_BYTES) {
      return refuse("too-large", "the PDF is larger than 25 MB");
    }
    const bytes = await boundedBody(response, CONVERSATION_FILE_MAX_BYTES);
    if (bytes === undefined) return refuse("too-large", "the PDF is larger than 25 MB");
    return {
      ok: true,
      kind: "file",
      name: pdfName(url, title),
      mimeType: "application/pdf",
      data: base64OfBytes(bytes),
      size: bytes.byteLength,
    };
  }

  /** What the top document says it is; unknown when the page cannot be asked. */
  async function topContentType(tabId: number): Promise<string | undefined> {
    try {
      const [entry] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        func: documentContentType,
      });
      return typeof entry?.result === "string" ? entry.result : undefined;
    } catch {
      return undefined;
    }
  }

  async function frameText(tabId: number, frameId: number): Promise<{ text: string; truncated: boolean }> {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "ISOLATED",
      func: visibleTextOf,
      args: [INDICATOR_MARKER_ATTRIBUTE],
    });
    const text = typeof entry?.result === "string" ? entry.result : "";
    return text.length > CONVERSATION_TAB_TEXT_MAX_CHARS
      ? { text: text.slice(0, CONVERSATION_TAB_TEXT_MAX_CHARS), truncated: true }
      : { text, truncated: false };
  }

  async function page(tab: chrome.tabs.Tab, tabId: number, url: URL): Promise<TabCaptureResult> {
    // A PDF by its path, else by what the document says it is (R-342): attached as the file.
    if (/\.pdf$/i.test(url.pathname) || (await topContentType(tabId)) === "application/pdf") {
      return pdf(url, tab.title);
    }
    // The same frame merge `get_page_text` answers with, over the same text definition.
    const frames = await tabFrames(tabId, url.href, enumerateFrames);
    const top = frames.find((frame) => frame.parentFrameId < 0)?.frameId ?? 0;
    let topAnswered = false;
    const merged = await mergePageText(tabId, {
      enumerateFrames: async () => frames,
      readText: async ({ frameId }) => {
        const answer = await frameText(tabId, frameId);
        if (frameId === top) topAnswered = true;
        return answer;
      },
      maxChars: CONVERSATION_TAB_TEXT_MAX_CHARS,
    });
    if (!topAnswered) return refuse("failed", "the page did not answer");
    return {
      ok: true,
      kind: "page",
      url: url.href.slice(0, CONVERSATION_TAB_URL_MAX_CHARS),
      title: (tab.title ?? "").slice(0, CONVERSATION_TAB_TITLE_MAX_CHARS),
      text: merged.text,
      // The chip's "text was cut": the character bound, not a child frame that stayed quiet.
      cut: merged.truncatedBy === "chars",
    };
  }

  return {
    async capture(request) {
      try {
        const tab = await chrome.tabs.get(request.tabId);
        const { url, supportInput } = tabSupportInput(tab);
        // The binding's rule, with a PDF counted as a page: a PDF tab is attached as its file and
        // photographed as what it shows; only where the PDF lives (a file, a browser page) refuses it.
        if (classifyPageSupport({ ...supportInput, isPdf: false }) !== "supported") {
          return refuse("restricted", "this page cannot be attached");
        }
        return request.what === "screenshot" ? await screenshot(tab) : await page(tab, request.tabId, url);
      } catch (error) {
        return refuse("failed", describe(error));
      }
    },
  };
}
