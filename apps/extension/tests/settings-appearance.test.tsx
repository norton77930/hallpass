import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSettings, ui } from "./fixtures/settings-harness.js";

/**
 * 024 T787, the page's part (D-024-20, FR-389): the top bar's theme and language choices send
 * `ui.settings.appearance-set`, and the page follows the appearance it is given - `data-theme` on the
 * document and the language of its texts. System follows the OS and the browser's UI language.
 */

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("lang");
});

describe("T787 the top bar's choices", () => {
  it("offers Theme (System, Light, Dark) and Language (System, English, 繁體中文), System selected by default", () => {
    renderSettings({ appearance: { theme: "system", language: "system" } });
    const theme = screen.getByLabelText(ui("settings.themeLabel")) as HTMLSelectElement;
    expect(Array.from(theme.options).map((option) => [option.value, option.textContent])).toEqual([
      ["system", ui("settings.theme.system")],
      ["light", ui("settings.theme.light")],
      ["dark", ui("settings.theme.dark")],
    ]);
    expect(theme.value).toBe("system");
    const language = screen.getByLabelText(ui("settings.languageLabel")) as HTMLSelectElement;
    expect(Array.from(language.options).map((option) => option.value)).toEqual(["system", "en-US", "zh-TW"]);
    expect(language.value).toBe("system");
  });

  it("sends the theme chosen", async () => {
    const { commands } = renderSettings();
    await act(async () => {
      fireEvent.change(screen.getByLabelText(ui("settings.themeLabel")), { target: { value: "dark" } });
    });
    expect(commands()[0]).toMatchObject({ type: "ui.settings.appearance-set", payload: { theme: "dark" } });
  });

  it("sends the language chosen", async () => {
    const { commands } = renderSettings();
    await act(async () => {
      fireEvent.change(screen.getByLabelText(ui("settings.languageLabel")), { target: { value: "zh-TW" } });
    });
    expect(commands()[0]).toMatchObject({ type: "ui.settings.appearance-set", payload: { language: "zh-TW" } });
  });
});

describe("T787 the page follows the appearance", () => {
  it("sets data-theme for Light and Dark and leaves it off for System", () => {
    const harness = renderSettings({ appearance: { theme: "dark", language: "en-US" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    harness.update({ appearance: { theme: "light", language: "en-US" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    harness.update({ appearance: { theme: "system", language: "en-US" } });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("shows its texts in the chosen language, at once", () => {
    const harness = renderSettings();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title"));
    harness.update({ appearance: { theme: "system", language: "zh-TW" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title", {}, "zh-TW"));
    expect(ui("settings.title", {}, "zh-TW")).not.toBe(ui("settings.title"));
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(document.title).toBe(ui("settings.title", {}, "zh-TW"));
  });

  it("follows the browser's UI language for System", () => {
    const zh = renderSettings({ systemLanguage: "zh-TW", appearance: { theme: "system", language: "system" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title", {}, "zh-TW"));
    zh.unmount();
    renderSettings({ systemLanguage: "fr", appearance: { theme: "system", language: "system" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(ui("settings.title"));
  });

  it("keeps the language names in their own language whatever the page language is", () => {
    renderSettings({ appearance: { theme: "system", language: "zh-TW" } });
    const language = screen.getByLabelText(ui("settings.languageLabel", {}, "zh-TW")) as HTMLSelectElement;
    expect(language.options[1]!.getAttribute("lang")).toBe("en-US");
    expect(language.options[2]!.getAttribute("lang")).toBe("zh-TW");
  });
});
