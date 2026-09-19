import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
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
 * 006/T191 — the site list (FR-086, US2).
 *
 * One row per site the owner has decided about: the site, its mode as a switch among the three,
 * and a revoke that forgets the decision. The permissive mode is marked on the row itself, because
 * "acts without asking" is the one setting the owner should be able to find at a glance.
 */
describe("T191 site list", () => {
  let port: FakeAgentPort;
  const ask = { site: "https://fixtures.test:19443", mode: "ask" as const, diagnosticsGranted: false };
  const open = { site: "https://open.test", mode: "skip-checks" as const, diagnosticsGranted: false };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("switches a site's mode with the closed command", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask] });

    const select = screen.getByLabelText(ui("agent.siteModeLabel").replace("{site}", ask.site)) as HTMLSelectElement;
    expect(select.value).toBe("ask");
    fireEvent.change(select, { target: { value: "follow-a-plan" } });

    expect(port.sent).toEqual([{ type: "ui.agent.site-mode", payload: { site: ask.site, mode: "follow-a-plan" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("revokes a site with the closed command, naming only the site", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask, open] });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.siteRevoke").replace("{site}", open.site) }));

    expect(port.sent).toEqual([{ type: "ui.agent.site-clear", payload: { site: open.site } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("marks a skip-checks row as permissive and no other", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask, open] });

    const rows = [...document.querySelectorAll("[data-site]")];
    expect(rows.map((row) => row.getAttribute("data-site"))).toEqual([ask.site, open.site]);
    expect(rows[0]?.classList.contains("permissive")).toBe(false);
    expect(rows[1]?.classList.contains("permissive")).toBe(true);
    expect(rows[1]?.textContent).toContain(ui("agent.sitePermissive"));
    expect(rows[0]?.textContent).not.toContain(ui("agent.sitePermissive"));
  });

  it("keeps the diagnostics grant as its own control on the row (004 US6)", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask] });

    fireEvent.click(screen.getByLabelText(ui("agent.diagnosticsLabel").replace("{site}", ask.site)));

    expect(port.sent).toEqual([{ type: "ui.agent.set-diagnostics", payload: { site: ask.site, granted: true } }]);
  });

  it("shows one sentence when no site has a decision", () => {
    renderShell();
    project(port, IDLE);

    expect(screen.getByText(ui("agent.sitesNone"))).toBeTruthy();
    expect(document.querySelectorAll("[data-site]")).toHaveLength(0);
  });
});
