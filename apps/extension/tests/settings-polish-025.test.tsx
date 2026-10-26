import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { lookup } from "../src/locales/catalog.js";
import { SETTINGS_KEYS } from "../src/settings/settings-keys.js";
import { NOW, refusedSend, renderSettings, ui, withAgent } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/**
 * 025 R-409 (#18, #19): DeepSeek's download size on its card, and the settings page's polish points -
 * the time left on a collapsed download row, a toast close button that can be seen and hit, "Not known
 * yet" for input types an agent has not reported, visible Theme / Language labels, and 代理程式 for
 * "Agent" in the zh-TW running text.
 */

const SHEET = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/settings/settings.css"), "utf8");

const card = (container: HTMLElement, agent: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-agent="${agent}"]`);
  if (found === null) throw new Error(`no card for ${agent}`);
  return found;
};
const disclosure = (cardElement: HTMLElement): HTMLElement => {
  const found = cardElement.querySelector<HTMLElement>("button[aria-expanded]");
  if (found === null) throw new Error("no disclosure button");
  return found;
};

describe("#18 DeepSeek names its download size", () => {
  it("says about 730 MB on the download button and in the note", () => {
    const state = withAgent(prototypeAState(NOW), "deepseek", (entry) => {
      const { install: _install, installing: _installing, ...rest } = entry;
      return { ...rest, availability: "needs-install" };
    });
    const { container } = renderSettings({ state });
    const deepseek = card(container, "deepseek");
    expect(within(deepseek).getByRole("button", { name: ui("settings.action.downloadAgent", { size: "730 MB" }) })).toBeTruthy();
    expect(within(deepseek).getByText(ui("settings.note.notInstalled", { size: "730 MB", estimate: "5–6" }))).toBeTruthy();
    expect(deepseek.textContent).toContain("730 MB");
  });
});

describe("#19 time left while downloading", () => {
  it("shows the estimate on the collapsed row too, and nothing when the worker has none", () => {
    const { container, project } = renderSettings();
    // 191 s: about three minutes.
    expect(within(card(container, "deepseek")).getByText(ui("settings.progress.timeLeft", { minutes: 3 }))).toBeTruthy();
    project(withAgent(prototypeAState(NOW), "deepseek", (entry) => ({ ...entry, install: { ...entry.install!, etaSeconds: 40 } })));
    expect(within(card(container, "deepseek")).getByText(ui("settings.progress.timeLeftShort"))).toBeTruthy();
    project(withAgent(prototypeAState(NOW), "deepseek", (entry) => ({ ...entry, install: { ...entry.install!, etaSeconds: null } })));
    expect(within(card(container, "deepseek")).queryByText(/left/u)).toBeNull();
    expect(within(card(container, "deepseek")).queryByText(/剩/u)).toBeNull();
  });

  it("words it for zh-TW", () => {
    expect(ui("settings.progress.timeLeft", { minutes: 3 }, "zh-TW")).toBe("預估約剩 3 分鐘");
    expect(ui("settings.progress.timeLeftShort", {}, "zh-TW")).toBe("預估不到 1 分鐘");
  });
});

describe("#19 the toast's close button", () => {
  it("is a dedicated control with a name, a 24 px hit area and its own focus ring", async () => {
    renderSettings({ send: refusedSend() });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Hermes" }) }));
    });
    const region = document.querySelector(".toast-region") as HTMLElement;
    const close = within(region).getByRole("button", { name: ui("settings.toast.dismiss") });
    expect(close.classList.contains("toast-close")).toBe(true);
    expect(SHEET).toMatch(/\.settings-page \.toast \.toast-close\s*\{[^}]*min-width:\s*24px[^}]*\}/u);
    expect(SHEET).toMatch(/\.settings-page \.toast \.toast-close\s*\{[^}]*min-height:\s*24px[^}]*\}/u);
    expect(SHEET).toMatch(/\.settings-page \.toast \.toast-close:focus-visible\s*\{[^}]*outline:\s*2px solid[^}]*\}/u);
  });
});

describe("#19 the Accepts row", () => {
  it("says Not known yet for an agent that has not reported its input types", () => {
    const state = withAgent(prototypeAState(NOW), "claude-code", (entry) => {
      const { accepts: _accepts, ...rest } = entry;
      return rest;
    });
    const { container } = renderSettings({ state });
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude));
    const label = within(claude).getByText(ui("settings.check.attach"));
    expect(label.nextElementSibling?.textContent).toBe("Not known yet");
    expect(ui("settings.attach.unknown", {}, "zh-TW")).toBe("尚未得知");
  });
});

describe("#19 the Theme and Language selects", () => {
  it("show their labels, with System as a value only", () => {
    renderSettings({ appearance: { theme: "system", language: "system" } });
    for (const [id, text] of [
      ["settings-theme", "Theme"],
      ["settings-language", "Language"],
    ] as const) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`)!;
      expect(label.textContent).toBe(text);
      expect(label.classList.contains("sr-only")).toBe(false);
      expect(screen.getByLabelText(text)).toBe(document.getElementById(id));
    }
    expect(ui("settings.themeLabel", {}, "zh-TW")).toBe("主題");
    expect(ui("settings.languageLabel", {}, "zh-TW")).toBe("語言");
    expect(ui("settings.theme.system", {}, "zh-TW")).toBe("跟隨系統");
  });
});

describe("#19 zh-TW says 代理程式, not Agent, in running text", () => {
  // Labels of one word (the navigation entry and the tools table column), and the site row text shared with the panel, keep the English word.
  const LABELS = new Set([
    "settings.nav.agents",
    "settings.tools.col.agent",
    // Pinned to the side panel row (agent.siteChangedBy.panel-agent), whose words the 019 gate reads.
    "settings.sites.changedBy.panel-agent",
    "settings.sites.changedBy.external-agent",
  ]);
  it("has no English 'agent' in a settings sentence", () => {
    const offenders = SETTINGS_KEYS.filter((key) => !LABELS.has(key)).filter((key) =>
      /agent/iu.test(lookup(key, "zh-TW").replace(/\{[a-zA-Z]+\}/gu, "")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("FR-412 the settings page gains no model or effort setting (D-025-10)", () => {
  it("shows nothing of a remembered model list or choice the overview carries", () => {
    const offer = {
      source: "config" as const,
      configIds: { model: "model", effort: "effort" },
      models: [
        { value: "default", name: "Default (recommended)" },
        { value: "model-beta", name: "Model Beta" },
      ],
      efforts: [
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
      defaultModel: "default",
      defaultEffort: "default",
    };
    const state = withAgent(prototypeAState(NOW), "claude-code", (entry) => ({
      ...entry,
      models: { offer, choice: { model: "model-beta", effort: "high" } },
    }));
    const { container } = renderSettings({ state });
    expect(container.textContent).not.toContain("Model Beta");
    expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.label") })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: ui("conversation.model.effortLabel") })).toBeNull();
    expect(container.querySelector('[data-chip="model"], .agent-conversation-model')).toBeNull();
  });
});
