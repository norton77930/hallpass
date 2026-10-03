import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type AgentPanelState } from "@hallpass/contracts";
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
 * 017/T476, T478 — the site-plan card (FR-251, FR-252, FR-260, FR-264).
 *
 * One question that is about more than one site: the proposing session is named the way its session
 * card names it, every proposed origin has a tick box (all ticked), and the owner's answer is the
 * ticked subset or a decline. The worker does the answering; this card only renders and sends.
 */
describe("017 site-plan card", () => {
  let port: FakeAgentPort;
  const SHOP = "https://shop.test";
  const DOCS = "https://docs.test:8443";
  const API = "https://api.test";
  const SESSION = {
    sessionId: "session-a",
    agentId: "agent-1",
    tabs: [],
    sites: [],
    state: "waiting" as const,
    label: "shop-frontend",
    startedAt: "2026-09-13T00:00:00.000Z",
    lastActivityAt: "2026-09-13T00:00:02.000Z",
  };
  const SITE_PLAN = {
    proposalId: "proposal-1",
    sessionId: "session-a",
    origins: [SHOP, DOCS, API],
    purpose: "Compare prices across the three shops",
    steps: ["Search for the item", "Open each result"],
    raisedAt: "2026-09-13T10:00:00.000Z",
  };
  const STATE: AgentPanelState = { ...IDLE, sessions: [SESSION], sitePlan: SITE_PLAN };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const card = (): HTMLElement => screen.getByRole("dialog");
  const box = (origin: string): HTMLInputElement => within(card()).getByRole("checkbox", { name: new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

  it("names the session as its card does, lists every origin ticked, with the purpose and steps", () => {
    renderShell();
    project(port, STATE);

    const dialog = card();
    expect(dialog.getAttribute("data-prompt")).toBe("site-plan");
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    // 016 title: the session's own agent name, then its folder label.
    const heading = within(dialog).getByRole("heading");
    expect(heading.textContent).toContain("Claude Code · shop-frontend");
    expect(heading.textContent).toContain(ui("agent.sitePlan.title"));
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);

    for (const origin of SITE_PLAN.origins) {
      expect(box(origin).checked).toBe(true);
      expect(dialog.textContent).toContain(origin);
    }
    expect(dialog.textContent).toContain(SITE_PLAN.purpose);
    for (const step of SITE_PLAN.steps) expect(dialog.textContent).toContain(step);
    expect(dialog.textContent).not.toContain(ui("agent.sitePlan.alreadyApproved"));
  });

  it("falls back to the start time when the session has no folder label", () => {
    renderShell();
    const { label: _label, ...unlabelled } = SESSION;
    project(port, { ...STATE, sessions: [unlabelled] });
    expect(within(card()).getByRole("heading").textContent).toMatch(/^Claude Code · /);
    expect(within(card()).getByRole("heading").textContent).not.toContain("shop-frontend");
  });

  it("marks the origins a replacing proposal already has approved", () => {
    renderShell();
    project(port, { ...STATE, sitePlan: { ...SITE_PLAN, alreadyApproved: [DOCS] } });

    const marked = ui("agent.sitePlan.alreadyApproved");
    const rows = [...card().querySelectorAll("li[data-origin]")];
    expect(rows.map((row) => row.getAttribute("data-origin"))).toEqual(SITE_PLAN.origins);
    expect(rows.filter((row) => row.textContent?.includes(marked)).map((row) => row.getAttribute("data-origin"))).toEqual([DOCS]);
  });

  it("states the steering warning, in both languages", () => {
    renderShell();
    project(port, STATE);
    expect(card().textContent).toContain(
      "Web pages can try to steer an agent into asking for more. Approve only the sites this task needs.",
    );
    expect(lookup("agent.sitePlan.warning", "zh-TW")).not.toBe(lookup("agent.sitePlan.warning", "en-US"));
    expect(lookup("agent.sitePlan.warning", "zh-TW")).toMatch(/[一-鿿]/);
  });

  it("approves with the ticked origins only, as a command the worker's schema accepts", () => {
    renderShell();
    project(port, STATE);
    fireEvent.click(box(DOCS));
    fireEvent.click(screen.getByRole("button", { name: ui("agent.sitePlan.approve") }));

    expect(port.sent).toEqual([
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: true, origins: [SHOP, API] } },
    ]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("shows an IDN origin in both forms, and still approves it by its ASCII origin (017 follow-up)", () => {
    const IDN = "https://xn--r8jz45g.jp";
    renderShell();
    project(port, { ...STATE, sitePlan: { ...SITE_PLAN, origins: [IDN] } });

    const row = card().querySelector(`li[data-origin="${IDN}"]`) as HTMLElement;
    expect(row.querySelector(".agent-siteplan-origin")?.textContent).toBe("https://例え.jp (xn--r8jz45g.jp)");
    fireEvent.click(screen.getByRole("button", { name: ui("agent.sitePlan.approve") }));
    expect(port.sent).toEqual([
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: true, origins: [IDN] } },
    ]);
  });

  it("disables Approve while nothing is ticked, and enables it again with one tick", () => {
    renderShell();
    project(port, STATE);
    for (const origin of SITE_PLAN.origins) fireEvent.click(box(origin));

    const approve = screen.getByRole("button", { name: ui("agent.sitePlan.approve") }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(port.sent).toEqual([]);

    fireEvent.click(box(API));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(port.sent).toEqual([
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: true, origins: [API] } },
    ]);
  });

  it("declines with no origins, whatever was ticked", () => {
    renderShell();
    project(port, STATE);
    fireEvent.click(box(SHOP));
    fireEvent.click(screen.getByRole("button", { name: ui("agent.sitePlan.decline") }));

    expect(port.sent).toEqual([
      { type: "ui.agent.site-plan-decide", payload: { proposalId: "proposal-1", approve: false, origins: [] } },
    ]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("starts a second proposal with everything ticked again", () => {
    renderShell();
    project(port, STATE);
    fireEvent.click(box(SHOP));
    project(port, { ...STATE, sitePlan: { ...SITE_PLAN, proposalId: "proposal-2" } });
    expect(box(SHOP).checked).toBe(true);
  });

  it("focuses its first control and keeps the tab order: boxes, then Approve, then Decline", () => {
    renderShell();
    project(port, STATE);

    const controls = [...card().querySelectorAll<HTMLElement>("button, input")];
    expect(document.activeElement).toBe(controls[0]);
    expect(controls.map((control) => control.tagName)).toEqual(["INPUT", "INPUT", "INPUT", "BUTTON", "BUTTON"]);
    expect(controls.slice(3).map((control) => control.textContent)).toEqual([
      ui("agent.sitePlan.approve"),
      ui("agent.sitePlan.decline"),
    ]);
    for (const control of controls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("styles itself from tokens only, so it follows the light and the dark theme (FR-264)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, "../src/side-panel/agent/agent.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]*\.agent-(?:siteplan|session-site-plan)[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const [, selector, body] of rules) {
      for (const declaration of (body ?? "").split(";")) {
        // No literal colour: a hex or rgb() value would be the same in both themes.
        expect(declaration, `${selector?.trim()}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      }
    }
  });

  it("renders in zh-TW with the same structure", () => {
    renderShell("zh-TW");
    project(port, STATE);
    expect(within(card()).getByRole("button", { name: lookup("agent.sitePlan.approve", "zh-TW") })).toBeTruthy();
    expect(within(card()).getByRole("button", { name: lookup("agent.sitePlan.decline", "zh-TW") })).toBeTruthy();
    expect(card().textContent).toContain(lookup("agent.sitePlan.warning", "zh-TW"));
  });
});
