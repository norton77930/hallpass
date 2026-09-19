import { describe, expect, it } from "vitest";
import { FALLBACK_LOCALE, lookup, lookupSafety, renderInertText, selectLocale } from "../src/locales/catalog.js";
import { messages as en } from "../src/locales/en-US.js";
import { messages as zh } from "../src/locales/zh-TW.js";

/**
 * Moved out of `tests/e2e/` by WP10 (review L16). These cases import modules directly and never
 * drove a browser, so running them under Playwright claimed journey evidence they do not provide
 * (FR-003). The assertions are unchanged; only the runner and the import depth are.
 */

describe("T079 accessibility localization", () => {
  it("keeps bilingual keys and falls back to English", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(selectLocale("zh-TW")).toBe("zh-TW");
    expect(selectLocale("zh-CN")).toBe("en-US");
    expect(FALLBACK_LOCALE).toBe("en-US");
    expect(lookup("workspace.title", "xx-XX")).not.toBe("workspace.title");
    expect(lookupSafety("missing.safety.key", "zh-TW").ok).toBe(false);
  });

  it("renders hostile remote text as inert", () => {
    const hostile = "<script>alert(1)</script>";
    expect(renderInertText(hostile)).toBe(hostile);
  });
});
