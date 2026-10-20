import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookup } from "../src/locales/catalog.js";
import { IDLE, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 020/T606 B1 - B4 - the Connections & sites tab as drawn: one line per site (its mode a chip that
 * opens the three modes, the rest behind a "more" button), short explanations, session cards with a
 * dot, a bold name and a state pill, and one upload folder per line. The same commands leave as
 * before; only where the controls sit changed.
 */

const SITE = "https://fixtures.test:19443";
const OPEN = "https://open.test";
const CONFIG = "C:\\Users\\owner\\AppData\\Local\\hallpass\\config.json";
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8");

const row = (site: string) => document.querySelector<HTMLElement>(`li[data-site="${site}"]`)!;
const chip = (site: string) => screen.getByRole("button", { name: ui("agent.siteModeLabel").replace("{site}", site) });
const more = (site: string) => screen.getByRole("button", { name: ui("agent.siteMore").replace("{site}", site) });

describe("T606 the Connections & sites tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  function show() {
    renderShell();
    project(port, {
      ...IDLE,
      sites: [
        { site: SITE, mode: "ask", diagnosticsGranted: false },
        { site: OPEN, mode: "skip-checks", diagnosticsGranted: true, changedBy: "panel-agent", changedAt: "2026-10-19T08:00:00.000Z" },
      ],
      uploadRoots: { roots: ["D:\\photos"], path: CONFIG },
    });
  }

  it("B1: a site is one line - its name, its mode as a chip, and a more button; nothing else until asked", () => {
    show();
    const open = row(OPEN);
    // T607 (S4): https is not written on the row; the whole origin is its title.
    expect(open.querySelector(".agent-site-name")?.textContent).toBe("open.test");
    expect(open.querySelector(".agent-site-name")?.getAttribute("title")).toBe(OPEN);
    expect(chip(OPEN).textContent).toContain(ui("agent.modeSkipChecks"));
    expect(chip(OPEN).getAttribute("data-mode")).toBe("skip-checks");
    expect(chip(OPEN).getAttribute("aria-haspopup")).toBe("menu");
    expect(chip(SITE).hasAttribute("data-permissive")).toBe(false);
    expect(chip(OPEN).getAttribute("data-permissive")).toBe("true");
    expect(open.querySelector("select")).toBeNull();
    expect(open.querySelector("input[type=checkbox]")).toBeNull();
    expect(open.querySelector(".agent-site-author")).toBeNull();
    expect(within(open).queryByRole("button", { name: ui("agent.siteRevoke").replace("{site}", OPEN) })).toBeNull();
  });

  it("B1: the chip's menu offers the three modes and sends the one chosen", () => {
    show();
    fireEvent.click(chip(SITE));
    expect(chip(SITE).getAttribute("aria-expanded")).toBe("true");
    const menu = within(row(SITE)).getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([ui("agent.modeAsk"), ui("agent.modeFollowAPlan"), ui("agent.modeSkipChecks")]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[1]!);
    expect(port.sent).toEqual([{ type: "ui.agent.site-mode", payload: { site: SITE, mode: "follow-a-plan" } }]);
    expect(within(row(SITE)).queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip(SITE));
  });

  it("B1: choosing the mode a site already has sends nothing", () => {
    show();
    fireEvent.click(chip(SITE));
    fireEvent.click(within(row(SITE)).getAllByRole("menuitemradio")[0]!);
    expect(port.sent).toEqual([]);
  });

  it("B1: Escape closes a menu and gives the focus back to its button; a press elsewhere closes it", () => {
    show();
    fireEvent.click(chip(SITE));
    fireEvent.keyDown(within(row(SITE)).getByRole("menu"), { key: "Escape" });
    expect(within(row(SITE)).queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip(SITE));

    fireEvent.click(chip(SITE));
    fireEvent.pointerDown(document.body);
    expect(within(row(SITE)).queryByRole("menu")).toBeNull();

    fireEvent.click(more(OPEN));
    expect(more(OPEN).getAttribute("aria-expanded")).toBe("true");
    const panel = row(OPEN).querySelector<HTMLElement>(".agent-site-more")!;
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(row(OPEN).querySelector(".agent-site-more")).toBeNull();
    expect(document.activeElement).toBe(more(OPEN));

    fireEvent.click(more(OPEN));
    // A press on the panel itself keeps it; one elsewhere closes it.
    fireEvent.pointerDown(row(OPEN).querySelector(".agent-site-more")!);
    expect(row(OPEN).querySelector(".agent-site-more")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(row(OPEN).querySelector(".agent-site-more")).toBeNull();
  });

  it("B1: the more button holds the diagnostics grant, who changed the site last, and Revoke", () => {
    show();
    fireEvent.click(more(OPEN));
    const panel = row(OPEN).querySelector<HTMLElement>(".agent-site-more")!;
    expect(panel.querySelector(".agent-site-author")?.textContent).toBe(ui("agent.siteChangedBy.panel-agent"));

    const checkbox = within(panel).getByRole("checkbox", { name: ui("agent.diagnosticsLabel").replace("{site}", OPEN) });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(port.sent).toEqual([{ type: "ui.agent.set-diagnostics", payload: { site: OPEN, granted: false } }]);

    const revoke = within(panel).getByRole("button", { name: ui("agent.siteRevoke").replace("{site}", OPEN) });
    expect(revoke.textContent).toBe(ui("agent.siteRevokeText"));
    fireEvent.click(revoke);
    expect(port.sent[1]).toEqual({ type: "ui.agent.site-clear", payload: { site: OPEN } });
  });

  it("B1: draws the act-without-asking chip in the warning colour", () => {
    expect(css).toMatch(/\[data-site-mode\]\[data-permissive="true"\]\s*\{[^}]*color:\s*var\(--warn\)/);
  });

  it("B2: the list file's path is in the status row's menu, not under the folders", () => {
    show();
    expect(document.querySelector(".agent-upload-roots .agent-upload-roots-path")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ui("agent.status.menu") }));
    expect(document.querySelector("[data-status-row] .agent-upload-roots-path")?.textContent).toBe(
      ui("agent.uploadRootsPath").replace("{path}", CONFIG),
    );
  });

  it.each(["en-US", "zh-TW"] as const)("B2: in %s the explanations are one short line each", (locale) => {
    for (const key of ["agent.panelConsent.granted", "agent.panelConsent.withdrawn", "agent.panelConsent.unknown", "agent.uploadRootsIntro"]) {
      expect(lookup(key, locale).length, key).toBeLessThanOrEqual(locale === "en-US" ? 80 : 40);
    }
  });

  it("B3: the sections are headed Agent sessions, Sites and Allowed upload folders", () => {
    show();
    const headings = [...document.querySelectorAll(".agent-section-heading")].map((heading) => heading.textContent);
    expect(headings).toEqual(expect.arrayContaining([ui("agent.sitesTitle"), ui("agent.uploadRootsTitle")]));
    expect(ui("agent.sitesTitle")).toBe("Sites");
    expect(ui("agent.uploadRootsTitle")).toBe("Allowed upload folders");
    expect(lookup("agent.sitesTitle", "zh-TW")).toBe("網站");
  });

  it("B4: one folder per line, forgotten with an x button that keeps its words as its name", () => {
    show();
    const folder = document.querySelector<HTMLElement>("li[data-upload-root]")!;
    expect(folder.querySelector(".agent-upload-root-path")?.textContent).toBe("D:\\photos");
    const forget = within(folder).getByRole("button", { name: ui("agent.uploadRootRevoke").replace("{root}", "D:\\photos") });
    expect(forget.classList.contains("agent-icon-button")).toBe(true);
    expect(forget.querySelector("svg")).not.toBeNull();
    act(() => {
      fireEvent.click(forget);
    });
    expect(port.sent).toEqual([{ type: "ui.agent.upload-root-clear", payload: { root: "D:\\photos" } }]);
    expect(folder.textContent).toContain(ui("agent.uploadRootPending"));
  });
});

describe("T606 B3 a session card as drawn", () => {
  let port: FakeAgentPort;
  const base = {
    sessionId: "0123abcd-4567-89ef-0123-456789abcdef",
    agentId: "agent-1",
    tabs: [],
    sites: [],
    state: "waiting" as const,
    colour: "blue" as const,
    startedAt: new Date(2026, 9, 20, 14, 2, 0).toISOString(),
  };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("puts a dot, the name in bold with agent and start under it, and the state as a pill under them, the buttons in a row below", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [{ ...base, label: "shop-frontend" }] });
    const card = document.querySelector<HTMLElement>("[data-session-id]")!;
    const head = card.querySelector<HTMLElement>(".agent-session-head")!;
    expect(head.querySelector(".agent-session-stripe")?.getAttribute("data-colour")).toBe("blue");
    expect(head.querySelector("h2")?.textContent).toBe("shop-frontend");
    expect(head.querySelector(".agent-session-meta")?.textContent).toBe("Claude Code · started 14:02");
    expect(head.querySelector(".agent-session-state")?.textContent).toBe(ui("agent.session.waiting"));
    expect(head.lastElementChild?.classList.contains("agent-session-state")).toBe(true);
    expect(card.querySelector(".agent-session-actions")?.compareDocumentPosition(head)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it("names the agent in bold when no folder was reported, with only the start under it", () => {
    renderShell("zh-TW");
    project(port, { ...IDLE, sessions: [base] });
    const head = document.querySelector<HTMLElement>("[data-session-id] .agent-session-head")!;
    expect(head.querySelector("h2")?.textContent).toBe("Claude Code");
    expect(head.querySelector(".agent-session-meta")?.textContent).toBe("14:02 開始");
  });
});
