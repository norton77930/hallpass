/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  applyIndicator,
  INDICATOR_GLOW_ATTRIBUTE,
  INDICATOR_PILL_ATTRIBUTE,
} from "../src/content-runtime/indicator.js";

/**
 * 2026-09-23 — the answer that arrives before the page has a body.
 *
 * The agent script runs at `document_start`, announces at once, and the worker answers in well
 * under the time a page takes to parse its `<head>`. An indicator dropped for want of a `<body>`
 * was never drawn again, so a tab that loaded while held showed nothing. The latest answer waits
 * for the body; a later one replaces it, and a hide leaves nothing to draw.
 */

type Sent = Array<{ type: string }>;

function bodiless(): { doc: Document; sent: Sent; send: (message: { type: string }) => void } {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.remove();
  const sent: Sent = [];
  return { doc, sent, send: (message) => void sent.push(message) };
}

async function bodyArrives(doc: Document): Promise<void> {
  doc.documentElement.appendChild(doc.createElement("body"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const count = (doc: Document, attribute: string) => doc.querySelectorAll(`[${attribute}]`).length;

describe("the indicator that arrives before <body>", () => {
  it("draws once the body appears", async () => {
    const page = bodiless();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);
    expect(count(page.doc, INDICATOR_PILL_ATTRIBUTE), "nothing to draw into yet").toBe(0);

    await bodyArrives(page.doc);

    expect(count(page.doc, INDICATOR_GLOW_ATTRIBUTE)).toBe(1);
    expect(count(page.doc, INDICATOR_PILL_ATTRIBUTE)).toBe(1);
  });

  it("draws nothing when a hide came after the show and before the body", async () => {
    const page = bodiless();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);
    applyIndicator({ type: "indicator", show: false }, page);

    await bodyArrives(page.doc);
    page.doc.dispatchEvent(new Event("DOMContentLoaded"));

    expect(count(page.doc, INDICATOR_GLOW_ATTRIBUTE)).toBe(0);
    expect(count(page.doc, INDICATOR_PILL_ATTRIBUTE)).toBe(0);
  });

  it("draws one indicator, the latest, for two shows before the body", async () => {
    const page = bodiless();
    applyIndicator({ type: "indicator", show: true, label: "First", action: "Back" }, page);
    applyIndicator({ type: "indicator", show: true, label: "Latest", action: "Back" }, page);

    await bodyArrives(page.doc);
    // Both cues fire in a real load; the second must find nothing left to do.
    page.doc.dispatchEvent(new Event("DOMContentLoaded"));

    expect(count(page.doc, INDICATOR_GLOW_ATTRIBUTE)).toBe(1);
    expect(count(page.doc, INDICATOR_PILL_ATTRIBUTE)).toBe(1);
    expect(page.doc.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)?.textContent).toContain("Latest");
  });
});
