import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * 037 FR-558, FR-559, R-542: the warm paper palette, and one palette in three places. tokens.css follows the
 * browser's scheme; appearance.css (the panel) and settings.css (the settings page) pin the owner's choice and
 * repeat the palette on purpose (024 D-024-20), so a value changed in one place and not the others fails here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(resolve(here, path), "utf8");
const TOKENS = read("../src/side-panel/agent/tokens.css");
const APPEARANCE = read("../src/side-panel/agent/appearance.css");
const SETTINGS = read("../src/settings/settings.css");

/** The colour declarations of the first block that starts at `opener`. */
function colours(css: string, opener: string): Map<string, string> {
  const start = css.indexOf(opener);
  expect(start, `a block starting with ${opener}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + opener.length, css.indexOf("}", start));
  const found = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) found.set(match[1]!, match[2]!.toLowerCase());
  return found;
}

const browserLight = colours(TOKENS, ":root {");
const browserDark = colours(TOKENS.slice(TOKENS.indexOf("@media (prefers-color-scheme: dark)")), ":root {");

const LIGHT: Record<string, string> = {
  "bg": "#f9f7f2",
  "surface": "#f2efe7",
  "surface-2": "#ebe7dd",
  "code": "#efebe1",
  "line": "#e4dfd3",
  "line-strong": "#d6cfc0",
  "line-soft": "#ece8dd",
  "text": "#1e1d1a",
  "text-2": "#4d4940",
  "text-3": "#686356",
  "accent": "#3a3e9e",
  "accent-text": "#ffffff",
  "accent-soft": "#e9e8f4",
  "accent-line": "#c9c8e6",
  "ok": "#2c7443",
  "warn": "#95560f",
  "warn-soft": "#f7ecd8",
  "danger": "#a33128",
  "danger-soft": "#f8e6e2",
  "focus": "#3a3e9e",
};
const DARK: Record<string, string> = {
  "bg": "#1b1916",
  "surface": "#23211d",
  "surface-2": "#2c2925",
  "code": "#25231f",
  "line": "#3a362f",
  "line-strong": "#463f37",
  "line-soft": "#2f2c27",
  "text": "#efebe3",
  "text-2": "#c4bdb0",
  "text-3": "#a39b8d",
  "accent": "#a4a6f2",
  "accent-text": "#14152e",
  "accent-soft": "#2c2b45",
  "accent-line": "#4d4c86",
  "ok": "#7fcf96",
  "warn": "#eeb466",
  "warn-soft": "#3a2c17",
  "danger": "#f19a8f",
  "danger-soft": "#3b201c",
  "focus": "#a4a6f2",
};

describe("037 warm paper palette", () => {
  it("gives the browser-scheme palette the FR-558 values in light and dark", () => {
    for (const [name, value] of Object.entries(LIGHT)) expect(browserLight.get(name), `light --${name}`).toBe(value);
    for (const [name, value] of Object.entries(DARK)) expect(browserDark.get(name), `dark --${name}`).toBe(value);
  });

  it.each([
    ["appearance.css", APPEARANCE],
    ["settings.css", SETTINGS],
  ])("pins every colour of tokens.css with the same value in %s (FR-559)", (_name, css) => {
    const pinnedLight = colours(css, ':root[data-theme="light"] {');
    const pinnedDark = colours(css, ':root[data-theme="dark"] {');
    for (const [name, value] of browserLight) expect(pinnedLight.get(name), `pinned light --${name}`).toBe(value);
    for (const [name, value] of browserDark) expect(pinnedDark.get(name), `pinned dark --${name}`).toBe(value);
  });
});
