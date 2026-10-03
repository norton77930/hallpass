import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type AgentPanelState } from "@hallpass/contracts";
import {
  IDLE,
  NOT_PAIRED,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 018/T501 — "This browser" in the panel (FR-268, FR-279, FR-281).
 *
 * The owner reads which browser this is and renames it here, and nowhere else: the rename leaves as
 * one closed command the worker validates again. When other browsers are connected the panel says
 * how many, and nothing about them - no tabs, no sites, no names.
 */

const BROWSER = { name: "Chrome", defaultName: "Chrome", kind: "chrome", others: 0 } as const;
const withBrowser = (browser: Partial<NonNullable<AgentPanelState["browser"]>> = {}, base: AgentPanelState = IDLE): AgentPanelState => ({
  ...base,
  browser: { ...BROWSER, ...browser },
});

describe("T501 this browser's row", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("names this browser, and shows no row when the worker sent no browser", () => {
    renderShell();
    project(port, IDLE);
    expect(screen.queryByRole("button", { name: ui("agent.browser.renameLabel") })).toBeNull();

    project(port, withBrowser({ name: "Work laptop" }));
    expect(screen.getByText(ui("agent.browser.this").replace("{name}", "Work laptop"))).toBeTruthy();
    expect(screen.getByRole("button", { name: ui("agent.browser.renameLabel") })).toBeTruthy();
  });

  it("is there before any agent pairs, so the owner can name the browser first", () => {
    renderShell();
    project(port, withBrowser({}, NOT_PAIRED));
    expect(screen.getByText(ui("agent.browser.this").replace("{name}", "Chrome"))).toBeTruthy();
  });

  it("renames inline: Enter sends the trimmed, stripped name as one closed command", () => {
    renderShell();
    project(port, withBrowser());

    fireEvent.click(screen.getByRole("button", { name: ui("agent.browser.renameLabel") }));
    const input = screen.getByRole("textbox", { name: ui("agent.browser.nameLabel") }) as HTMLInputElement;
    expect(input.value).toBe("Chrome");
    expect(input.maxLength).toBe(40);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "  Lab\u0007 box " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(input.closest("form")!);

    expect(port.sent).toEqual([{ type: "ui.agent.browser-rename", payload: { name: "Lab box" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
    // Back to reading: the next projection carries the new name.
    expect(screen.queryByRole("textbox", { name: ui("agent.browser.nameLabel") })).toBeNull();
  });

  it("refuses an empty name with a message, and Escape cancels without sending", () => {
    renderShell();
    project(port, withBrowser());

    fireEvent.click(screen.getByRole("button", { name: ui("agent.browser.renameLabel") }));
    const input = screen.getByRole("textbox", { name: ui("agent.browser.nameLabel") });
    fireEvent.change(input, { target: { value: " \u0007 " } });
    fireEvent.submit(input.closest("form")!);
    expect(port.sent).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(ui("agent.browser.nameInvalid"));
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(port.sent).toEqual([]);
    expect(screen.queryByRole("textbox", { name: ui("agent.browser.nameLabel") })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: ui("agent.browser.renameLabel") }));
  });

  it("hides the others row at zero and counts the others without naming them", () => {
    renderShell();
    project(port, withBrowser({ others: 0 }));
    expect(screen.queryByText(ui("agent.browser.othersOne"))).toBeNull();
    expect(document.querySelector("[data-browser-others]")).toBeNull();

    project(port, withBrowser({ others: 1 }));
    expect(screen.getByText(ui("agent.browser.othersOne"))).toBeTruthy();

    project(port, withBrowser({ others: 2 }));
    expect(screen.getByText(ui("agent.browser.others").replace("{n}", "2"))).toBeTruthy();
  });

  it("speaks zh-TW", () => {
    renderShell("zh-TW");
    project(port, withBrowser({ name: "工作用", others: 2 }));
    expect(screen.getByText("這個瀏覽器：工作用")).toBeTruthy();
    expect(screen.getByText("另有 2 個瀏覽器已連線")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新命名這個瀏覽器" })).toBeTruthy();
  });
});
