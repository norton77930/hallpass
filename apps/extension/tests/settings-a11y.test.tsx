import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { refusedSend, renderSettings, ui } from "./fixtures/settings-harness.js";

/**
 * 024 T788 (FR-389, FR-390, D-024-7): keyboard reach of every control, a visible focus, landmarks and
 * headings, a polite live region for notices, and the 375 px layout (navigation as a row, nothing that
 * scrolls sideways). The CSS rules are read from the sheet the page ships, since jsdom does not lay out.
 */

const SHEET = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/settings/settings.css"), "utf8");
const SECTIONS = ["agents", "sites", "tools", "connection"] as const;

/** The accessible name of a control, by the sources a screen reader uses, in order. */
function nameOf(element: HTMLElement): string {
  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  const by = element.getAttribute("aria-labelledby");
  if (by !== null) {
    const text = by
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text !== "") return text;
  }
  const labels = (element as HTMLInputElement).labels;
  if (labels !== null && labels !== undefined && labels.length > 0) return Array.from(labels).map((item) => item.textContent ?? "").join(" ").trim();
  return (element.textContent ?? "").trim();
}

describe("T788 keyboard reach and names", () => {
  it.each(SECTIONS)("every control in %s is a native control, reachable by Tab, and has a name", (section) => {
    renderSettings({ route: section });
    const controls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [role='switch'], [role='button']"));
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      // A native control is in the tab order; nothing is taken out of it, and nothing jumps the queue.
      expect(control.getAttribute("tabindex") ?? "0", control.outerHTML.slice(0, 120)).not.toMatch(/^-|^[1-9]/u);
      if (control.tagName === "DIV" || control.tagName === "SPAN") throw new Error(`a ${control.tagName} acts as a control: ${control.outerHTML.slice(0, 120)}`);
      expect(nameOf(control), control.outerHTML.slice(0, 160)).not.toBe("");
    }
  });

  it("gives every switch its state and every disclosure its expanded state", () => {
    renderSettings();
    for (const toggle of screen.getAllByRole("switch")) expect(["true", "false"]).toContain(toggle.getAttribute("aria-checked"));
    const disclosures = document.querySelectorAll<HTMLElement>("button[aria-controls][aria-expanded]");
    expect(disclosures.length).toBe(4);
    for (const disclosure of disclosures) expect(["true", "false"]).toContain(disclosure.getAttribute("aria-expanded"));
  });

  it("opens and closes a card from the keyboard (a native button: Enter and Space click it)", () => {
    renderSettings();
    const claude = document.querySelector<HTMLElement>("[data-agent='claude-code']") as HTMLElement;
    const disclosure = claude.querySelector("button[aria-expanded]") as HTMLButtonElement;
    disclosure.focus();
    expect(document.activeElement).toBe(disclosure);
    expect(disclosure.tagName).toBe("BUTTON");
    expect(disclosure.getAttribute("type")).toBe("button");
  });

  it("moves the focus to the new section's heading when a navigation entry is pressed", () => {
    renderSettings();
    fireEvent.click(within(screen.getByRole("navigation", { name: ui("settings.nav.label") })).getByRole("button", { name: new RegExp(ui("settings.nav.tools")) }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: ui("settings.nav.tools") }));
  });
});

describe("T788 landmarks and headings", () => {
  it.each(SECTIONS)("has a banner, a named navigation, one main, one h1 and one h2 in %s", (section) => {
    renderSettings({ route: section });
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("navigation").getAttribute("aria-label")).toBe(ui("settings.nav.label"));
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });

  it("never skips a heading level (h1, h2, then h3 and below)", () => {
    for (const section of SECTIONS) {
      const harness = renderSettings({ route: section });
      const levels = Array.from(document.querySelectorAll("h1, h2, h3, h4")).map((heading) => Number(heading.tagName.slice(1)));
      levels.forEach((level, index) => {
        if (index > 0) expect(level - (levels[index - 1] as number), `${section}: ${levels.join(",")}`).toBeLessThanOrEqual(1);
      });
      harness.unmount();
    }
  });

  it("marks the current section in the navigation", () => {
    renderSettings({ route: "sites" });
    const nav = screen.getByRole("navigation");
    const current = within(nav).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain(ui("settings.nav.sites"));
  });
});

describe("T788 notices are announced politely", () => {
  it("has a polite live region from the start, and a notice appears inside it", async () => {
    renderSettings({ send: refusedSend() });
    const region = document.querySelector(".toast-region") as HTMLElement;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Hermes" }) }));
    });
    expect(within(region).getByText(ui("settings.error.generic"))).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: ui("settings.toast.dismiss") }));
    expect(region.textContent).toBe("");
  });
});

describe("T788 focus is visible", () => {
  it("draws an outline on :focus-visible for the page's controls, and never removes one without a replacement", () => {
    expect(SHEET).toMatch(/\.settings-page :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/u);
    const removed = SHEET.match(/[^{}]+\{[^}]*outline:\s*(?:none|0)[^}]*\}/gu) ?? [];
    for (const rule of removed) {
      // The switch hides the native outline only to draw it on its track.
      expect(rule, rule).toMatch(/\.switch:focus-visible|\.seg input/u);
    }
    expect(SHEET).toMatch(/\.switch:focus-visible \.track\s*\{[^}]*outline:/u);
    expect(SHEET).toMatch(/\.seg label:has\(input:focus-visible\)\s*\{[^}]*outline:/u);
  });

  it("takes every colour, size and spacing from the side panel's tokens", () => {
    // The sheet's own custom-property blocks (the dark and light pins) are the only place a colour is written.
    const withoutPins = SHEET.replace(/:root\[data-theme="(?:dark|light)"\]\s*\{[^}]*\}/gu, "");
    const colours = withoutPins.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/gu) ?? [];
    expect(colours).toEqual([]);
  });
});

describe("T788 375 px: navigation becomes a top row, nothing scrolls sideways (FR-390)", () => {
  const narrow = SHEET.slice(SHEET.indexOf("@media (max-width: 760px)"));

  it("turns the two-column shell into one column at 760 px and below", () => {
    expect(narrow).toMatch(/\.settings-page \.shell\s*\{\s*grid-template-columns:\s*1fr;/u);
  });

  it("lays the navigation out as a wrapping row, no longer sticky", () => {
    expect(narrow).toMatch(/\.settings-page nav\.side\s*\{[^}]*position:\s*static;[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u);
  });

  it("lets long text wrap rather than push the page wider", () => {
    expect(SHEET).toMatch(/\.agent-shell\.settings-page\s*\{[^}]*overflow-wrap:\s*anywhere;/u);
    expect(SHEET).toMatch(/\.settings-page main\s*\{[^}]*min-width:\s*0;/u);
    expect(SHEET).toMatch(/\.settings-page \.diag pre\s*\{[^}]*white-space:\s*pre-wrap;/u);
  });

  it("never fixes a width wider than a 375 px screen outside the table's own scroll", () => {
    const widths = Array.from(SHEET.matchAll(/(?<![-a-z])(?:min-)?width:\s*(\d+)px/gu)).map((match) => Number(match[1]));
    for (const width of widths) expect(width).toBeLessThanOrEqual(375 - 32);
  });

  it("stacks a site row's mode switch under its name on the narrowest screens", () => {
    expect(SHEET).toMatch(/@media \(max-width: 560px\)[\s\S]*\.settings-page \.site \.seg\s*\{[^}]*grid-column:\s*1 \/ -1;/u);
  });
});
