import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE, installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 020/T608 (Y1), 036 FR-542, FR-551 - a session card's controls: the one primary action is in the header,
 * the footer has Take back tabs on the left and End session on the right as a text button, and the state
 * line stays on one line whatever the state says. (016 FR-232's "End session first" is superseded by FR-551.)
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  let declarations = "";
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) declarations += `${match[2] ?? ""};`;
  }
  return declarations;
};

const TWO_TABS = [
  { tabId: 7, url: "https://shop.test/cart", title: "Cart", active: false, holder: "this" as const },
  { tabId: 8, url: "https://localhost:3100/", title: "Dev", active: false, holder: "this" as const },
];
const SESSION = {
  sessionId: "0123abcd-4567-89ef-0123-456789abcdef",
  agentId: "agent-1",
  tabs: TWO_TABS,
  sites: ["shop.test", "localhost:3100"],
  state: "working" as const,
  inFlight: 1,
  startedAt: new Date(2026, 8, 27, 14, 2, 0).toISOString(),
  lastActivityAt: new Date().toISOString(),
};

describe("T608 Y1 a session card's controls", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const card = () => document.querySelector<HTMLElement>("[data-session-id]")!;
  const header = () => card().querySelector<HTMLElement>(".agent-session-head")!;
  const footer = () => within(card().querySelector<HTMLElement>(".agent-session-foot")!).getAllByRole("button").map((button) => button.textContent);

  it("puts Interrupt in the header and Take back tabs, then End session in the footer", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [SESSION] });
    expect(within(header()).getByRole("button", { name: "Interrupt" })).toBeTruthy();
    expect(footer()).toEqual(["Take back tabs (2)", "End session"]);
    expect(card().querySelector(".agent-session-spacer")).toBeNull();
  });

  it("lays the footer out as a row with End session pushed to the right, as a text button", () => {
    expect(rule(".agent-session-foot")).toMatch(/display:\s*flex/);
    expect(rule(".agent-session-end")).toMatch(/margin-left:\s*auto/);
    expect(rule(".agent-shell .agent-session-textbutton")).toMatch(/border:\s*0/);
    expect(rule(".agent-shell .agent-session-textbutton[data-tone=\"danger\"]")).toMatch(/color:\s*var\(--danger\)/);
  });

  it("keeps the state line on one line and gives the title room to ellipsise", () => {
    expect(rule(".agent-shell .agent-session-sub")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".agent-shell .agent-session-sub")).toMatch(/overflow:\s*hidden/);
    expect(rule(".agent-session-name")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".agent-session-name")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".agent-session-headmain")).toMatch(/display:\s*grid/);
    expect(rule(".agent-session-headmain")).toMatch(/minmax\(0,\s*1fr\)/);
  });
});
