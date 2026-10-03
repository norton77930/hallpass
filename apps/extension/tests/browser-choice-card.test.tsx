import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import {
  IDLE,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 018/T509 — the "Use this browser?" card (FR-274, R-273).
 *
 * Several browsers run Hallpass and an agent asked the owner to pick one in the browser itself. The
 * card names the agent (its own stated name, inert text) and this browser's name, so the owner
 * knows which window they are answering in; both answers are one command with the request's id.
 */
describe("018 browser choice card", () => {
  let port: FakeAgentPort;
  const CHOICE = { requestId: "req-1", agentName: "Claude Code", raisedAt: "2026-10-03T00:00:05.000Z" };
  const BROWSER = { name: "Work Chrome", defaultName: "Chrome", kind: "chrome" as const, others: 1 };
  const STATE = { ...IDLE, browser: BROWSER, browserChoice: CHOICE };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const card = (): HTMLElement => screen.getByRole("dialog");

  it("names the agent and this browser, and sends the owner's answer either way", () => {
    renderShell();
    project(port, STATE);

    expect(card().getAttribute("data-prompt")).toBe("browser-choice");
    expect(card().textContent).toContain(ui("agent.browserChoice.title").replace("{agent}", "Claude Code"));
    expect(card().textContent).toContain(ui("agent.browser.this").replace("{name}", "Work Chrome"));

    fireEvent.click(screen.getByRole("button", { name: ui("agent.browserChoice.confirm") }));
    fireEvent.click(screen.getByRole("button", { name: ui("agent.browserChoice.decline") }));
    expect(port.sent).toEqual([
      { type: "ui.agent.browser-choice-decide", payload: { requestId: "req-1", confirm: true } },
      { type: "ui.agent.browser-choice-decide", payload: { requestId: "req-1", confirm: false } },
    ]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("shows the agent's name as text, never as markup", () => {
    renderShell();
    project(port, { ...STATE, browserChoice: { ...CHOICE, agentName: "<b>Evil</b>" } });
    expect(card().querySelector("b")).toBeNull();
    expect(card().textContent).toContain("<b>Evil</b>");
  });

  it("takes focus on its first button and keeps the tab order: Use this browser, then Not this one", () => {
    renderShell();
    project(port, STATE);
    const buttons = [...card().querySelectorAll<HTMLButtonElement>("button")];
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons.map((button) => button.textContent)).toEqual([
      ui("agent.browserChoice.confirm"),
      ui("agent.browserChoice.decline"),
    ]);
    for (const button of buttons) expect(button.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("shares the one question place by arrival: an earlier question stays on top", () => {
    renderShell();
    const earlier = {
      promptId: "prompt-1",
      site: "https://fixtures.test:19443",
      tool: "click" as const,
      argsSummary: "click a page element",
      raisedAt: "2026-10-03T00:00:01.000Z",
    };
    project(port, { ...STATE, prompt: earlier });
    expect(card().getAttribute("data-prompt")).toBe("consent");

    project(port, { ...STATE, prompt: { ...earlier, raisedAt: "2026-10-03T00:00:09.000Z" } });
    expect(card().getAttribute("data-prompt")).toBe("browser-choice");
  });

  it("renders in zh-TW", () => {
    renderShell("zh-TW");
    project(port, STATE);
    expect(card().textContent).toContain(lookup("agent.browserChoice.title", "zh-TW").replace("{agent}", "Claude Code"));
    expect(card().textContent).toContain(lookup("agent.browser.this", "zh-TW").replace("{name}", "Work Chrome"));
    expect(screen.getByRole("button", { name: lookup("agent.browserChoice.confirm", "zh-TW") })).toBeTruthy();
    expect(screen.getByRole("button", { name: lookup("agent.browserChoice.decline", "zh-TW") })).toBeTruthy();
    expect(lookup("agent.browserChoice.confirm", "zh-TW")).toMatch(/[一-鿿]/);
  });
});
