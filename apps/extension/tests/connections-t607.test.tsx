import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE, NOT_PAIRED, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 020/T607 - the defects of the full shot review that sit in the Connections & sites tab: what it
 * says when the helper cannot be reached, one open menu at a time, upload folders and site names on
 * short lines.
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  let declarations = "";
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) declarations += `${match[2] ?? ""};`;
  }
  return declarations;
};

const SITE = "https://fixtures.test:19443";
const OPEN = "https://open.test";
const LOCAL = "http://localhost:3000";
const SHOP = "C:\\Users\\owner\\uploads\\customer-exports";
const row = (site: string) => document.querySelector<HTMLElement>(`li[data-site="${site}"]`)!;
const chip = (site: string) => screen.getByRole("button", { name: ui("agent.siteModeLabel").replace("{site}", site) });
const more = (site: string) => screen.getByRole("button", { name: ui("agent.siteMore").replace("{site}", site) });
const statusMenuButton = () => screen.getByRole("button", { name: ui("agent.status.menu") });
/** Open menus of the Connections tab: the mode menus, the more groups and the status menu. */
const openMenus = () => document.querySelectorAll("[role=menu], .agent-site-more").length;

describe("T607 the Connections & sites tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage("connections");
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const SITES = [
    { site: SITE, mode: "ask" as const, diagnosticsGranted: false },
    { site: OPEN, mode: "skip-checks" as const, diagnosticsGranted: true, changedBy: "panel-agent" as const, changedAt: "2026-10-19T08:00:00.000Z" },
    { site: LOCAL, mode: "follow-a-plan" as const, diagnosticsGranted: false },
  ];

  async function show(locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, { ...IDLE, sites: SITES, uploadRoots: { roots: [SHOP], path: "D:\\hallpass\\config.json" } });
    // The remembered tab is read from storage: wait until the Connections tab is the one on screen.
    await screen.findByRole("heading", { name: ui("agent.sitesTitle") });
  }

  describe("Q1 the helper cannot be reached", () => {
    const DOWN = { ...CONVERSATION_READY, available: false, reason: "broker-unavailable" as const, consent: "unknown" as const };

    it.each(["en-US", "zh-TW"] as const)("in %s says so, with what to do, instead of 'no agent is connected'", async (locale) => {
      installTabStorage("conversation");
      renderShell(locale);
      project(port, withConversation(DOWN, NOT_PAIRED));
      // The Conversation tab's button leads to the Connections tab.
      fireEvent.click(await screen.findByRole("button", { name: lookup("conversation.error.goConnections", locale) }));

      expect(screen.getByRole("heading", { name: lookup("agent.helperDown.title", locale) })).toBeTruthy();
      expect(screen.getByText(lookup("agent.helperDown.body", locale))).toBeTruthy();
      expect(screen.queryByRole("heading", { name: lookup("agent.notPaired.title", locale) })).toBeNull();
      expect(screen.getByRole("button", { name: lookup("agent.retry", locale) })).toBeTruthy();
    });

    it("keeps the generic card for a browser whose helper is fine", async () => {
      renderShell();
      project(port, withConversation({ ...CONVERSATION_READY, consent: "unknown" }, NOT_PAIRED));
      expect(await screen.findByRole("heading", { name: ui("agent.notPaired.title") })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: ui("agent.helperDown.title") })).toBeNull();
    });
  });

  describe("S1 one menu open at a time", () => {
    it("closes the other menu when the owner opens one with the pointer", async () => {
      await show();
      const press = (button: HTMLElement) => {
        fireEvent.pointerDown(button);
        fireEvent.click(button);
      };
      press(chip(SITE));
      expect(openMenus()).toBe(1);
      press(more(OPEN));
      expect(openMenus()).toBe(1);
      expect(row(OPEN).querySelector(".agent-site-more")).not.toBeNull();
      press(statusMenuButton());
      expect(openMenus()).toBe(1);
      expect(document.querySelector("[data-status-row] [role=menu]")).not.toBeNull();
      press(chip(LOCAL));
      expect(openMenus()).toBe(1);
      expect(row(LOCAL).querySelector("[role=menu]")).not.toBeNull();
    });

    it("closes the other menu when the owner opens one from the keyboard (a click with no press before it)", async () => {
      await show();
      fireEvent.click(chip(SITE));
      fireEvent.click(more(OPEN));
      expect(openMenus()).toBe(1);
      expect(row(OPEN).querySelector(".agent-site-more")).not.toBeNull();
      fireEvent.click(statusMenuButton());
      expect(openMenus()).toBe(1);
      expect(row(OPEN).querySelector(".agent-site-more")).toBeNull();
      fireEvent.click(chip(LOCAL));
      expect(openMenus()).toBe(1);
      expect(document.querySelector("[data-status-row] [role=menu]")).toBeNull();
    });
  });

  describe("S3 an upload folder is its name over its path", () => {
    it("shows the name on one line and the path on one ellipsized line, the whole path as its title", async () => {
      await show();
      const item = document.querySelector<HTMLElement>("li[data-upload-root]")!;
      expect(item.querySelector(".agent-upload-root-name")?.textContent).toBe("customer-exports");
      const path = item.querySelector(".agent-upload-root-path")!;
      expect(path.textContent).toBe(SHOP);
      expect(path.getAttribute("title")).toBe(SHOP);
      expect(rule(".agent-upload-root-text > .agent-upload-root-path")).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule(".agent-upload-root-text > .agent-upload-root-path")).toMatch(/white-space:\s*nowrap/);
      expect(rule(".agent-upload-root-name")).toMatch(/white-space:\s*nowrap/);
    });
  });

  describe("S4 a site is shown without https://", () => {
    it("drops the https prefix, keeps http and the port, and keeps the whole origin as the title", async () => {
      await show();
      const name = (site: string) => row(site).querySelector<HTMLElement>(".agent-site-name")!;
      expect(name(SITE).textContent).toBe("fixtures.test:19443");
      expect(name(SITE).getAttribute("title")).toBe(SITE);
      expect(name(OPEN).textContent).toBe("open.test");
      expect(name(OPEN).getAttribute("title")).toBe(OPEN);
      expect(name(LOCAL).textContent).toBe(LOCAL);
      expect(name(LOCAL).getAttribute("title")).toBe(LOCAL);
    });
  });
});
