import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentPanelState } from "@hallpass/contracts";
import {
  IDLE,
  NOT_PAIRED,
  PAIRED,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 006/T198 — the panel is operable and readable (FR-092, FR-093, R-129, R-130).
 *
 * Two halves. The first renders every composition the shell can land on and asks, per control,
 * the two things a screen reader and a keyboard need: a name, and a place in the tab sequence.
 * The names come from testing-library's own role queries, so a control counts as named only if
 * `getByRole` would find it by that name - which is how the e2e fixtures find it too.
 *
 * The second half reads `tokens.css` as text, resolves the light and the dark theme, and checks the
 * contrast of every (text, surface) pair `agent.css` puts on screen with the WCAG formula written
 * out below. The pairs are listed here on purpose: a token added to the stylesheet without a line
 * in this list is not a pair this test vouches for.
 */

const SHOP = "https://shop.test";
const LONG_SITE = "https://a-very-long-host-name.documentation.example.test:8443";
const TWO_SITES: AgentPanelState["sites"] = [
  { site: SHOP, mode: "skip-checks", diagnosticsGranted: false },
  { site: LONG_SITE, mode: "ask", diagnosticsGranted: true },
];

const TWO_SESSIONS: AgentPanelState = {
  ...IDLE,
  paired: [PAIRED, { agentId: "agent-2", displayName: "Second Agent", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" }],
  sessions: [
    { sessionId: "sess-aaaa1111", agentId: "agent-1", tabs: [], sites: ["shop.test"], state: "waiting", lastActivityAt: "2026-09-13T00:00:02.000Z" },
    { sessionId: "sess-bbbb2222", agentId: "agent-2", tabs: [], sites: [], state: "working", lastActivityAt: "2026-09-13T00:00:01.000Z" },
  ],
  sites: TWO_SITES,
};

const PENDING = { agentId: "agent-9", displayName: "New Agent", origin: "stdio:local" };
const SITE = "https://fixtures.test:19443";
const PROMPT = { promptId: "prompt-1", site: SITE, tool: "click" as const, argsSummary: "click", targetLabel: "Save", targetRole: "button" };
const PLAN = { planId: "plan-1", site: SITE, steps: [{ tool: "click" as const, summary: "click" }, { tool: "type" as const, summary: "type" }] };

const CONTROL_SELECTOR = "button, select, input, summary, a, textarea";
/** The roles the shell's controls take: a `<select>` is a combobox, a menu's button a menuitem. */
const CONTROL_ROLES = ["button", "menuitem", "combobox", "checkbox", "link", "textbox"];

function controls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)];
}

/** Every control testing-library can find by a non-empty accessible name. */
function namedControls(): Set<Element> {
  const named = new Set<Element>();
  for (const role of CONTROL_ROLES) {
    for (const element of screen.queryAllByRole(role, { name: /\S/ })) named.add(element);
  }
  return named;
}

function expectNamedAndReachable(): void {
  const all = controls();
  expect(all.length).toBeGreaterThan(0);
  const named = namedControls();
  for (const control of all) {
    const label = `${control.tagName.toLowerCase()} "${control.textContent?.trim() ?? ""}"`;
    if (control.tagName === "SUMMARY") {
      // `<summary>` has no ARIA role testing-library maps; its name is its content.
      expect(control.textContent?.trim(), label).not.toBe("");
    } else {
      expect(named.has(control), `${label} has no accessible name`).toBe(true);
    }
    expect(control.tabIndex, `${label} is out of the tab sequence`).toBeGreaterThanOrEqual(0);
    expect(control.getAttribute("tabindex"), label).not.toBe("-1");
    expect((control as HTMLButtonElement).disabled, label).not.toBe(true);
  }
}

describe("T198 every control has a name and a place in the tab order", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("not-paired page", () => {
    renderShell();
    project(port, NOT_PAIRED);
    expectNamedAndReachable();
  });

  it("bridge-lost page", () => {
    renderShell();
    project(port, { ...IDLE, bridge: "disconnected", diagnostics: { relayPid: 1, lastDisconnect: { at: "2026-09-13T01:02:03.000Z", reason: "gone" } } });
    expectNamedAndReachable();
  });

  it("idle: status row with its menu open, and the site list", () => {
    renderShell();
    project(port, { ...IDLE, sites: TWO_SITES });
    fireEvent.click(screen.getByRole("button", { name: ui("agent.status.menu") }));
    expect(screen.getByRole("menuitem", { name: ui("agent.unpair") })).toBeTruthy();
    expectNamedAndReachable();
    // The three-way switch and the diagnostics grant are labelled with the site they are about.
    expect(screen.getByRole("combobox", { name: ui("agent.siteModeLabel").replace("{site}", SHOP) })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: ui("agent.diagnosticsLabel").replace("{site}", LONG_SITE) })).toBeTruthy();
  });

  it("two session cards, each a labelled section with its own two actions", () => {
    renderShell();
    project(port, TWO_SESSIONS);
    expectNamedAndReachable();
    for (const id of ["sess-aaaa1111", "sess-bbbb2222"]) {
      const card = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
      expect(card?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(within(card as HTMLElement).getByRole("button", { name: ui("agent.session.stop") })).toBeTruthy();
      expect(within(card as HTMLElement).getByRole("button", { name: ui("agent.session.release") })).toBeTruthy();
    }
  });

  it.each([
    ["pairing", { ...NOT_PAIRED, pending: PENDING }, ui("agent.pairingTitle")],
    ["consent", { ...IDLE, prompt: PROMPT }, ui("agent.promptTitle")],
    ["plan", { ...IDLE, plan: PLAN }, ui("agent.planTitle")],
  ] as const)("the %s prompt is a named dialog whose first control takes focus", (_kind, state, title) => {
    renderShell();
    project(port, state);
    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expectNamedAndReachable();
    const first = dialog.querySelector<HTMLElement>(CONTROL_SELECTOR);
    expect(first).toBeTruthy();
    expect(document.activeElement).toBe(first);
  });
});

/* ---------- contrast (FR-092): tokens.css parsed as text, WCAG 2.x relative luminance ---------- */

type Theme = Record<string, string>;

function readTokens(): { light: Theme; dark: Theme } {
  // A plain path: under jsdom `new URL()` yields the page's URL class, which `fileURLToPath` rejects.
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/tokens.css"), "utf8");
  const marker = "@media (prefers-color-scheme: dark)";
  const at = css.indexOf(marker);
  expect(at, "tokens.css declares a dark theme under prefers-color-scheme").toBeGreaterThan(0);
  const parse = (block: string): Theme =>
    Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()]));
  const light = parse(css.slice(0, at));
  // The dark block only overrides; anything it leaves alone keeps its light value.
  const dark = { ...light, ...parse(css.slice(at)) };
  return { light, dark };
}

function luminance(hex: string): number {
  const channel = (index: number): number => {
    const c = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every (text, surface) pair agent.css paints. Text first, the surface it sits on second. */
const TEXT_ON_SURFACE: ReadonlyArray<[text: string, surface: string, where: string]> = [
  ["text", "bg", "body copy on the panel ground"],
  ["text", "surface", "body copy on a card"],
  ["text", "surface-2", "body copy on a nested surface (menu, pill, details)"],
  ["text-2", "bg", "secondary copy on the panel ground"],
  ["text-2", "surface", "secondary copy on a card"],
  ["text-2", "surface-2", "secondary copy on a nested surface"],
  ["accent-text", "accent", "label of a filled (primary) button"],
  ["accent", "surface", "accent used as text on a card (outlined button, link)"],
  ["warn", "surface-2", "the permissive mode pill's text on its pill background"],
  ["danger", "surface", "the outlined Stop button on a card"],
  ["ok", "surface", "the connected state on a card"],
  ["ok", "bg", "the connected state on the panel ground"],
];

const REQUIRED_TOKENS = [
  "bg", "surface", "surface-2", "text", "text-2", "line", "accent", "accent-text", "ok", "warn", "danger", "focus",
];

describe("T198 contrast of every text/surface token pair, both themes", () => {
  let themes: ReturnType<typeof readTokens>;

  beforeAll(() => {
    themes = readTokens();
  });

  it.each(["light", "dark"] as const)("%s theme declares every colour token as a 6-digit hex", (name) => {
    for (const token of REQUIRED_TOKENS) {
      expect(themes[name][token], `--${token} (${name})`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(["light", "dark"] as const)("%s theme keeps every text/surface pair at 4.5:1 or better", (name) => {
    const theme = themes[name];
    for (const [text, surface, where] of TEXT_ON_SURFACE) {
      const ratio = contrast(theme[text] ?? "#000000", theme[surface] ?? "#000000");
      expect(ratio, `${where}: --${text} ${theme[text]} on --${surface} ${theme[surface]} (${name}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the focus ring stands out from both the ground and a card in both themes (3:1, non-text)", () => {
    for (const name of ["light", "dark"] as const) {
      const theme = themes[name];
      for (const surface of ["bg", "surface"]) {
        expect(contrast(theme.focus ?? "#000000", theme[surface] ?? "#000000"), `--focus on --${surface} (${name})`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
