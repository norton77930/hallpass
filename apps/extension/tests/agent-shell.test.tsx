import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import {
  IDLE,
  NOT_PAIRED,
  PAIRED,
  installAgentPort,
  project,
  renderShell,
  shellState,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 006/T191 — the four compositions, derived from the projection alone (FR-081, R-125).
 *
 * Which page the owner sees is a function of three facts the worker sends - is the bridge up, is
 * anything paired, is anything running - and nothing the panel remembers. So each case here pushes
 * one projection and reads the composition off the shell, then checks that the *other* compositions
 * are not on screen: the not-paired page with a site list under it is exactly the two-generation
 * stack this feature removes.
 */
describe("T191 the shell derives its composition from the projection", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("shows the not-paired page, and nothing else, while nothing has ever paired", () => {
    renderShell();
    project(port, NOT_PAIRED);

    expect(shellState()).toBe("not-connected");
    expect(screen.getByRole("heading", { name: ui("agent.notPaired.title") })).toBeTruthy();
    expect(screen.getByText(ui("agent.notPaired.body"))).toBeTruthy();
    // No site list, no session section, no status row, no tab list.
    expect(screen.queryByText(ui("agent.sitesTitle"))).toBeNull();
    expect(screen.queryByText(ui("agent.sitesNone"))).toBeNull();
    expect(screen.queryByText(ui("agent.status.connected"))).toBeNull();
    expect(screen.queryByText(ui("agent.tab.title"))).toBeNull();
    expect(screen.queryByRole("button", { name: ui("agent.session.stop") })).toBeNull();
  });

  it("shows the bridge-lost variant, with the last disconnect under technical details, when the link is down but an agent is paired", () => {
    renderShell();
    project(port, {
      ...IDLE,
      bridge: "disconnected",
      diagnostics: {
        relayPid: 4242,
        recordPath: "C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json",
        lastDisconnect: { at: "2026-09-13T01:02:03.000Z", reason: "Native host has exited." },
      },
    });

    expect(shellState()).toBe("not-connected");
    expect(screen.getByRole("heading", { name: ui("agent.bridgeLost.title") })).toBeTruthy();
    expect(screen.queryByText(ui("agent.notPaired.title"))).toBeNull();
    // Folded away, but there: a <details> the owner can open, with the rings' facts inside.
    const details = screen.getByText(ui("agent.details.title")).closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(ui("agent.details.relayPid").replace("{pid}", "4242"));
    // The path the relay named in its greeting (FR-082), backslashes and all.
    expect(details?.textContent).toContain(
      ui("agent.details.recordPath").replace("{path}", "C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json"),
    );
    expect(details?.textContent).toContain(ui("agent.details.lastDisconnectReason").replace("{reason}", "Native host has exited."));
    expect(details?.textContent).toContain("2026-09-13T01:02:03.000Z");
  });

  it("asks the worker to re-check the bridge on Retry", () => {
    renderShell();
    project(port, { ...NOT_PAIRED, bridge: "unavailable" });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.retry") }));

    expect(port.sent).toEqual([{ type: "ui.agent.retry-bridge", payload: {} }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("says nothing is recorded when the diagnostics are empty", () => {
    renderShell();
    project(port, { ...NOT_PAIRED, diagnostics: {} });

    expect(screen.getByText(ui("agent.details.none"))).toBeTruthy();
  });

  it("shows the status row and the site list, and no session section, while paired and idle", () => {
    renderShell();
    project(port, IDLE);

    expect(shellState()).toBe("idle");
    const row = screen.getByText(ui("agent.status.connected")).closest("[data-status-row]");
    expect(row).toBeTruthy();
    expect(screen.getByText(ui("agent.sitesNone"))).toBeTruthy();
    expect(screen.queryByText(ui("agent.notPaired.title"))).toBeNull();
    expect(screen.queryByRole("button", { name: ui("agent.session.stop") })).toBeNull();
    expect(screen.queryByText(ui("agent.session.none"))).toBeNull();
  });

  it("keeps unpair behind the overflow menu and sends it for the paired agent", () => {
    renderShell();
    project(port, IDLE);

    const unpair = ui("agent.status.unpairAgent").replace("{agent}", PAIRED.displayName);
    expect(screen.queryByRole("menuitem", { name: unpair })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ui("agent.status.menu") }));
    fireEvent.click(screen.getByRole("menuitem", { name: unpair }));

    expect(port.sent).toEqual([{ type: "ui.agent.unpair", payload: { agentId: PAIRED.agentId } }]);
  });

  it("shows one card per live session above the site list, newest activity first", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        { sessionId: "session-old", agentId: "agent-1", tabs: [], sites: [], state: "working", lastActivityAt: "2026-09-13T00:00:01.000Z" },
        { sessionId: "session-new", agentId: "agent-1", tabs: [], sites: [], state: "working", lastActivityAt: "2026-09-13T00:00:09.000Z" },
      ],
    });

    expect(shellState()).toBe("sessions");
    const cards = [...document.querySelectorAll("[data-session-id]")].map((card) => card.getAttribute("data-session-id"));
    expect(cards).toEqual(["session-new", "session-old"]);
    // The status row stays, and so does the site list: a session is live the moment its server
    // greets the relay, and the owner switches a site's mode while one is (SC-045).
    expect(screen.getByText(ui("agent.status.connected"))).toBeTruthy();
    expect(screen.getByText(ui("agent.sitesNone"))).toBeTruthy();
  });

  /**
   * 016/T439 — the status row says how much is going on, and whom the owner can unpair
   * (US1, FR-223 – FR-224, contracts/panel.md).
   *
   * The browser's own side-panel header already names the product, so the panel does not say it a
   * second time. The row used to name `paired[0]` - one agent's name for a browser that may be
   * serving several - and its one unpair unpaired every one of them. Now it counts the sessions and
   * never names an agent, and the menu is where each paired agent is named, with its own unpair.
   */
  it("carries no in-panel heading, in either locale (FR-224)", () => {
    renderShell("zh-TW");
    project(port, IDLE);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(document.body.textContent).not.toContain(ui("agent.appTitle"));
    cleanup();

    renderShell();
    project(port, { ...IDLE, sessions: [{ sessionId: "s-1", agentId: "agent-1", tabs: [], state: "idle" }] });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  const session = (sessionId: string) => ({ sessionId, agentId: "agent-1", agentName: "Cursor", tabs: [], state: "working" as const });
  const statusText = (): string => document.querySelector("[data-status-row] .agent-status-text")?.textContent ?? "";

  it.each([
    ["en-US", 0, "Connected · no sessions"],
    ["en-US", 1, "Connected · 1 session"],
    ["en-US", 3, "Connected · 3 sessions"],
    ["zh-TW", 0, "已連線 · 沒有工作階段"],
    ["zh-TW", 1, "已連線 · 1 個工作階段"],
    ["zh-TW", 3, "已連線 · 3 個工作階段"],
  ] as const)("the %s status row reads the session count %i as %s, and never an agent name", (locale, count, text) => {
    renderShell(locale);
    project(port, { ...IDLE, sessions: Array.from({ length: count }, (_, index) => session(`s-${index}`)) });

    expect(statusText()).toBe(text);
    const row = document.querySelector("[data-status-row]")?.textContent ?? "";
    expect(row).not.toContain("Claude Code");
    expect(row).not.toContain("Cursor");
  });

  it("lists every paired agent in the menu, each with its own unpair that sends one command", () => {
    const second = { agentId: "agent-2", displayName: "Second Agent", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" };
    renderShell();
    project(port, { ...IDLE, paired: [PAIRED, second] });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.status.menu") }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Unpair Claude Code", "Unpair Second Agent"]);
    expect(screen.getByRole("menu").textContent).toContain("Claude Code");
    expect(screen.getByRole("menu").textContent).toContain("Second Agent");
    expect(items.map((item) => item.textContent)).toEqual(["Unpair", "Unpair"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Unpair Second Agent" }));

    expect(port.sent).toEqual([{ type: "ui.agent.unpair", payload: { agentId: "agent-2" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("names the menu's unpair in zh-TW", () => {
    renderShell("zh-TW");
    project(port, IDLE);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    const item = screen.getByRole("menuitem", { name: "解除與 Claude Code 的配對" });
    expect(item.textContent).toBe("解除配對");
  });

  it("keeps the last projection it could trust when one does not parse", () => {
    renderShell();
    project(port, IDLE);
    project(port, { ...IDLE, bridge: "made-up" as never });

    expect(shellState()).toBe("idle");
  });
});
