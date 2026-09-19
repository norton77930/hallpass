import { describe, expect, it } from "vitest";
import { classifyPageSupport } from "../src/chrome-adapters/tabs.js";

/**
 * Moved out of `tests/e2e/` by WP10 (review L16). These cases import modules directly and never
 * drove a browser, so running them under Playwright claimed journey evidence they do not provide
 * (FR-003). The assertions are unchanged; only the runner and the import depth are.
 */

const excluded = [
  { name: "iframe-only", input: { isTopFrame: true, hasIframeOnlyContent: true } },
  { name: "Shadow-DOM-only", input: { isTopFrame: true, hasShadowOnlyContent: true } },
  { name: "PDF", input: { isTopFrame: true, isPdf: true } },
  { name: "Chrome internal", input: { isTopFrame: true, isChromeInternal: true, protocol: "chrome:" } },
  { name: "extension-origin", input: { isTopFrame: true, isExtensionOrigin: true, protocol: "chrome-extension:" } },
  { name: "Web Store", input: { isTopFrame: true, isWebStore: true, hostname: "chrome.google.com" } },
  { name: "file/data/blob", input: { isTopFrame: true, isFileUrl: true, protocol: "file:" } },
  { name: "incognito", input: { isTopFrame: true, incognito: true } },
  { name: "canvas-WebGL-only", input: { isTopFrame: true, isCanvasOnly: true } },
] as const;

describe("T048 US2 page understanding", () => {
  for (const fixture of excluded) {
    it(`${fixture.name} is unsupported with zero protected read`, () => {
      expect(classifyPageSupport({ protocol: "https:", ...fixture.input })).toBe(
        "unsupported",
      );
    });
  }

  it("ordinary top-level https HTML is supported", () => {
    expect(
      classifyPageSupport({
        isTopFrame: true,
        protocol: "https:",
        contentType: "text/html",
        incognito: false,
      }),
    ).toBe("supported");
  });

});
