/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { snapshotDocument } from "../src/content-runtime/collector.js";
import { bindAgentContentRuntime } from "../src/content-runtime/agent-entry.js";
import {
  applyIndicator,
  INDICATOR_GLOW_ATTRIBUTE,
  INDICATOR_MARKER_ATTRIBUTE,
  INDICATOR_PILL_ATTRIBUTE,
} from "../src/content-runtime/indicator.js";

/**
 * 004/T106 — the in-page indicator (US3, FR-062, R-117).
 *
 * Every tab a session holds says so on the page itself, with one control that brings the session's
 * main tab forward. Two of the claims here are not about what the owner sees:
 *
 * - the control acts on a **trusted** click only. A page script can call `click()` on anything in
 *   its own document, so a control that answered a synthetic event would let the page steer the
 *   owner's focus - the indicator would become an attack the extension installed.
 * - the indicator is never part of a collection. It is the extension's own furniture; an agent
 *   reading its own indicator back out of `read_page` would be reading its own tail.
 */

type Sent = Array<{ type: string }>;

function host(): { doc: Document; sent: Sent; send: (message: { type: string }) => void } {
  const sent: Sent = [];
  return { doc: document, sent, send: (message) => void sent.push(message) };
}

function control(): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}] button`);
  expect(found, "the indicator must offer one control").not.toBeNull();
  return found as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("T106 the in-page indicator", () => {
  it("renders on show and is gone again on hide", () => {
    const page = host();

    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back to the agent" }, page);

    const element = document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(element, "the indicator must be in the document").not.toBeNull();
    expect(element?.textContent).toContain("Agent is working");
    expect(control().textContent).toContain("Back to the agent");

    // Shown twice is still one indicator: the worker re-states the label on every claim, and a
    // second element would stack on the first for as long as the session held the tab.
    applyIndicator({ type: "indicator", show: true, label: "Agent is still working", action: "Back" }, page);
    expect(document.querySelectorAll(`[${INDICATOR_PILL_ATTRIBUTE}]`).length).toBe(1);
    expect(document.querySelectorAll(`[${INDICATOR_GLOW_ATTRIBUTE}]`).length, "and one glow").toBe(1);

    applyIndicator({ type: "indicator", show: false }, page);
    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`), "the glow goes with the banner").toBeNull();
  });

  it("stays out of the page's way except for its own control", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    const element = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(element?.style.position).toBe("fixed");
    expect(element?.style.pointerEvents).toBe("none");
    expect(control().style.pointerEvents).toBe("auto");
  });

  it("sends ui.agent.focus-main for the owner's own click and for nothing else", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    // What a page script can do: it can reach the element and click it, by either route. Every
    // event a script makes is untrusted, and that is the whole difference the control turns on.
    control().click();
    control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.sent, "a synthetic click must move nobody's focus").toEqual([]);

    /**
     * The owner's own click, which no test can forge: jsdom defines `isTrusted` as an
     * unforgeable own getter, exactly as the browser does. So the trust question is asked through
     * one seam whose default *is* `event.isTrusted`, and the trusted half is driven by replacing
     * that seam and dispatching the very same real click - which leaves the trust check as the
     * only difference between the two halves of this test.
     */
    const trusting = { ...host(), isTrustedEvent: () => true };
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, trusting);
    control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(trusting.sent).toEqual([{ type: "ui.agent.focus-main" }]);
  });

  it("is never part of a collection", () => {
    const page = host();
    document.body.innerHTML = '<p>Ordinary page text</p><button id="real">Real button</button>';
    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back to the agent" }, page);

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");

    expect(snapshot.visibleText).toContain("Ordinary page text");
    expect(snapshot.visibleText, "the indicator's own copy is not page text").not.toContain("Agent is working");
    // 004/T117d: the page's own paragraph and button - the walk sees prose now - and nothing of the
    // indicator, which is what this test is about.
    expect(snapshot.targets.map((target) => target.role), "the page's own elements, and only them").toEqual([
      "paragraph",
      "button",
    ]);
    expect(snapshot.targets.find((target) => target.role === "button")?.text).toContain("Real button");
    expect(snapshot.controls).toEqual([]);
  });
});

/**
 * 2026-09-16 — the glow around the page while an agent holds the tab (owner's choice: keep the
 * pill and the tab group, add the four-edge inset glow the reference draws).
 */
describe("the page-edge glow", () => {
  it("lights the four edges as a fixed, click-through layer, in the pointer's red", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    const glow = document.querySelector<HTMLElement>(`[${INDICATOR_GLOW_ATTRIBUTE}]`);
    expect(glow, "the glow is drawn with the banner").not.toBeNull();
    expect(glow?.style.position).toBe("fixed");
    expect(glow?.style.inset).toMatch(/^0(px)?$/);
    expect(glow?.style.pointerEvents).toBe("none");
    expect(glow?.style.boxShadow).toContain("inset");
    expect(glow?.style.boxShadow).toContain("rgba(255, 59, 48");
    expect(glow?.getAttribute(INDICATOR_MARKER_ATTRIBUTE), "excluded from every collection").toBe("");
    expect(glow?.getAttribute("aria-hidden")).toBe("true");
    expect(glow?.children.length, "nothing inside it to read or click").toBe(0);
  });

  it("is the page's edge, so a child frame draws the pill but never a glow", () => {
    const framed = { ...host(), isTopFrame: false };
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, framed);

    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).not.toBeNull();
    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`), "one page, one glow").toBeNull();
  });

  it("goes down with the banner and leaves the pointer alone", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);
    // The pointer wears the same exclusion marker; the banner's removal is by the banner's names.
    const pointer = document.createElement("div");
    pointer.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
    pointer.setAttribute("data-hallpass-cursor", "");
    document.body.appendChild(pointer);

    applyIndicator({ type: "indicator", show: false }, page);

    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector("[data-hallpass-cursor]"), "the pointer has its own lifetime").not.toBeNull();
  });

  it("is never part of a collection either", () => {
    const page = host();
    document.body.innerHTML = '<p>Ordinary page text</p><button id="real">Real button</button>';
    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back" }, page);

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");

    expect(snapshot.targets.map((target) => target.role)).toEqual(["paragraph", "button"]);
  });
});

/**
 * 004/T107b — the page's half of "the page asks".
 *
 * A navigation reloads this script at `document_start` and the indicator goes with the old
 * document. Rather than have the worker watch every navigation, the freshly loaded script says it
 * is there and the worker answers with that tab's state - the same shape as T107a's lesson, and it
 * heals a worker that was evicted just as well as a page that navigated.
 */
describe("T107b the content script announces itself", () => {
  it("announces on load so the worker can re-raise the indicator", () => {
    const sent: unknown[] = [];
    const runtime = {
      id: "hallpass-test-extension",
      sendMessage: (message: unknown) => void sent.push(message),
      onMessage: { addListener: () => undefined },
    };

    bindAgentContentRuntime(runtime, document);

    expect(sent).toEqual([{ type: "ui.agent.announce" }]);
  });

  it("says nothing when there is no extension runtime to say it to", () => {
    const sent: unknown[] = [];
    const runtime = { sendMessage: (message: unknown) => void sent.push(message) };

    bindAgentContentRuntime(runtime, document);

    expect(sent).toEqual([]);
  });
});
