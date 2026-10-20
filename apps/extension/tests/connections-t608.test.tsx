import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE, installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 020/T608 (Y1) - a session card's buttons are one left-aligned row that wraps, in one order with
 * "End session" first (016 FR-232), and its "agent - started" line stays on one line whatever the state pill says.
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
  const buttons = () => within(card().querySelector<HTMLElement>(".agent-session-actions")!).getAllByRole("button").map((button) => button.textContent);

  it("keeps End session first (016 FR-232 fixed position), then Interrupt this step and Take back tabs", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [SESSION] });
    expect(buttons()).toEqual(["End session", "Interrupt this step", "Take back tabs (2)"]);
    expect(card().querySelector(".agent-session-spacer")).toBeNull();
  });

  it("lays the buttons out as one left-aligned row that wraps", () => {
    const row = rule(".agent-session-actions");
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    expect(row).not.toMatch(/justify-content:\s*(space-between|flex-end|end|center)/);
    expect(css).not.toMatch(/\.agent-session-spacer/);
  });

  it("keeps the meta line on one line and puts the state pill under the name", () => {
    expect(rule(".agent-session-meta")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".agent-session-meta")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".agent-session-head")).toMatch(/display:\s*grid/);
    expect(rule(".agent-session-head .agent-session-state")).toMatch(/grid-column:\s*2/);
    expect(rule(".agent-session-head .agent-session-state")).toMatch(/justify-self:\s*start/);
  });
});
