import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_BUILD_EXTENSION_ID } from "../src/build-config.js";
import { App } from "../src/side-panel/App.js";

/**
 * 024/T787 (side-panel half) - the panel follows the one appearance choice (D-024-20, R-382, FR-389).
 *
 * The settings page's top bar writes `agentAppearance` (theme System / Light / Dark, language System /
 * English / 繁體中文) through the worker; the panel reads it and follows `chrome.storage.onChanged`, so a
 * change lands without a reload. Nothing stored, or a record the panel cannot read, is System / System -
 * the panel as it was: the colours follow the browser's scheme and the words its UI language.
 */

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>;
type ChangeListener = (changes: Changes, area: string) => void;

/** A `chrome` with the storage the panel reads, the change event, the UI language and a port that says nothing. */
function installChrome(options: { stored?: unknown; uiLanguage?: string } = {}) {
  const listeners = new Set<ChangeListener>();
  const store: { stored: unknown } = { stored: options.stored };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: TEST_BUILD_EXTENSION_ID,
      connect: () => ({
        name: "hallpass-panel",
        postMessage() {},
        disconnect() {},
        onMessage: { addListener() {}, removeListener() {} },
        onDisconnect: { addListener() {}, removeListener() {} },
      }),
    },
    i18n: { getUILanguage: () => options.uiLanguage ?? "en-US" },
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key === "agentAppearance" && store.stored !== undefined ? { [key]: store.stored } : {}),
        set: () => Promise.resolve(),
      },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.add(listener),
        removeListener: (listener: ChangeListener) => listeners.delete(listener),
      },
    },
  };
  return {
    /** The worker writing the record: storage changes, then every listener hears it. */
    write(value: unknown, area = "local", key = "agentAppearance") {
      store.stored = value;
      act(() => {
        for (const listener of [...listeners]) listener({ [key]: { newValue: value } }, area);
      });
    },
    listening: () => listeners.size,
  };
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const theme = () => document.documentElement.getAttribute("data-theme");
const lang = () => document.documentElement.lang;

describe("T787 the side panel follows the appearance", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, "chrome");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.lang = "";
  });

  it("is System / System when nothing is stored: no pinned theme, the browser's language", async () => {
    installChrome({ uiLanguage: "zh-TW" });
    render(<App />);
    await settle();

    expect(theme()).toBeNull();
    expect(lang()).toBe("zh-TW");
  });

  it("applies a stored theme and language", async () => {
    installChrome({ stored: { theme: "dark", language: "zh-TW" }, uiLanguage: "en-US" });
    render(<App />);
    await settle();

    expect(theme()).toBe("dark");
    expect(lang()).toBe("zh-TW");
  });

  it("follows a change at once, and goes back to the system's when set to System", async () => {
    const chrome = installChrome({ uiLanguage: "en-US" });
    render(<App />);
    await settle();

    chrome.write({ theme: "light", language: "zh-TW" });
    expect(theme()).toBe("light");
    expect(lang()).toBe("zh-TW");

    chrome.write({ theme: "dark", language: "en-US" });
    expect(theme()).toBe("dark");
    expect(lang()).toBe("en-US");

    chrome.write({ theme: "system", language: "system" });
    expect(theme()).toBeNull();
    expect(lang()).toBe("en-US");
  });

  it("ignores other keys and other storage areas, and a record it cannot read", async () => {
    const chrome = installChrome({ stored: { theme: "dark", language: "en-US" } });
    render(<App />);
    await settle();

    chrome.write({ theme: "light", language: "en-US" }, "sync");
    chrome.write({ theme: "light", language: "en-US" }, "local", "somethingElse");
    expect(theme()).toBe("dark");

    chrome.write({ theme: "sepia", language: "en-US" });
    expect(theme()).toBeNull();
    chrome.write("dark");
    expect(theme()).toBeNull();
  });

  it("stops listening when the panel goes", async () => {
    const chrome = installChrome();
    const view = render(<App />);
    await settle();
    expect(chrome.listening()).toBe(1);

    view.unmount();
    expect(chrome.listening()).toBe(0);
  });

  it("still opens, as System, when storage is missing or throws", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: TEST_BUILD_EXTENSION_ID, connect: () => ({ postMessage() {}, disconnect() {}, onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} } }) },
      i18n: { getUILanguage: () => "zh-TW" },
      storage: { local: { get: () => { throw new Error("storage unavailable"); } } },
    };
    render(<App />);
    await settle();

    expect(theme()).toBeNull();
    expect(lang()).toBe("zh-TW");
  });

  it("pins the same palettes in appearance.css as tokens.css declares for the browser's two schemes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(resolve(here, "../src/side-panel/agent/tokens.css"), "utf8");
    const pinned = readFileSync(resolve(here, "../src/side-panel/agent/appearance.css"), "utf8");
    const colours = (css: string): Record<string, string> =>
      Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()]));
    const at = tokens.indexOf("@media (prefers-color-scheme: dark)");
    const light = colours(tokens.slice(0, at));
    const dark = { ...light, ...colours(tokens.slice(at)) };
    const darkAt = pinned.indexOf(':root[data-theme="dark"]');
    const lightAt = pinned.indexOf(':root[data-theme="light"]');
    expect(darkAt).toBeGreaterThanOrEqual(0);
    expect(lightAt).toBeGreaterThanOrEqual(0);
    const [pinnedDark, pinnedLight] = darkAt < lightAt
      ? [pinned.slice(darkAt, lightAt), pinned.slice(lightAt)]
      : [pinned.slice(darkAt), pinned.slice(lightAt, darkAt)];
    expect(colours(pinnedDark)).toEqual(dark);
    expect(colours(pinnedLight)).toEqual(light);
  });
});
