import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PANEL_PORT_NAME } from "@hallpass/contracts";
import { openSettings } from "../src/service-worker/open-settings.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";

/**
 * 024 T753 (R-372, FR-375, FR-384, FR-393, FR-394): the panel's way into the settings page. An open
 * settings tab is brought forward and moved to the route (its hash, so the page is not reloaded);
 * otherwise a new tab opens at `settings.html#<route>`. Only the extension's own page, never another.
 */

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const BASE = `chrome-extension://${EXTENSION_ID}/`;
const SETTINGS_URL = `${BASE}settings.html`;

function fakeBrowser(tabs: Array<{ id: number; url?: string; pendingUrl?: string; windowId: number; active?: boolean }>) {
  const calls: unknown[] = [];
  return {
    calls,
    tabs: {
      async query(query: unknown) {
        calls.push(["query", query]);
        return tabs;
      },
      async update(tabId: number, properties: unknown) {
        calls.push(["update", tabId, properties]);
        return { id: tabId, windowId: tabs.find((tab) => tab.id === tabId)?.windowId };
      },
      async create(properties: unknown) {
        calls.push(["create", properties]);
        return { id: 99, windowId: 1 };
      },
    },
    windows: {
      async update(windowId: number, properties: unknown) {
        calls.push(["window", windowId, properties]);
        return { id: windowId };
      },
    },
    getURL: (path: string) => `${BASE}${path}`,
  };
}

describe("024 T753 openSettings", () => {
  it("opens a new tab at the route when no settings tab is open", async () => {
    const browser = fakeBrowser([{ id: 4, url: "https://example.test/", windowId: 1 }]);
    await openSettings("#agents/codex", browser);
    expect(browser.calls.filter((call) => (call as unknown[])[0] !== "query")).toEqual([["create", { url: `${SETTINGS_URL}#agents/codex` }]]);
  });

  it("focuses an open settings tab, whatever route it shows, and moves it to the new route", async () => {
    const browser = fakeBrowser([
      { id: 4, url: "https://example.test/settings.html", windowId: 1 },
      { id: 7, url: `${SETTINGS_URL}#tools`, windowId: 3 },
    ]);
    await openSettings("#sites?site=https://github.com", browser);
    expect(browser.calls.filter((call) => (call as unknown[])[0] !== "query")).toEqual([
      ["update", 7, { active: true, url: `${SETTINGS_URL}#sites?site=https://github.com` }],
      ["window", 3, { focused: true }],
    ]);
  });

  it("only brings forward a settings tab already at the route, without setting its address (no reload)", async () => {
    const browser = fakeBrowser([{ id: 7, url: `${SETTINGS_URL}#agents/codex`, windowId: 3 }]);
    await openSettings("#agents/codex", browser);
    expect(browser.calls.filter((call) => (call as unknown[])[0] !== "query")).toEqual([
      ["update", 7, { active: true }],
      ["window", 3, { focused: true }],
    ]);
  });

  it("finds a settings tab that is still loading, and never takes another extension page for it", async () => {
    const loading = fakeBrowser([
      { id: 5, url: `${BASE}side-panel.html`, windowId: 1 },
      { id: 6, pendingUrl: SETTINGS_URL, windowId: 2 },
    ]);
    await openSettings("#connection", loading);
    expect(loading.calls.filter((call) => (call as unknown[])[0] !== "query")[0]).toEqual(["update", 6, { active: true, url: `${SETTINGS_URL}#connection` }]);

    const otherPages = fakeBrowser([
      { id: 5, url: `${BASE}side-panel.html`, windowId: 1 },
      { id: 8, url: `${SETTINGS_URL}?x=1`, windowId: 1 },
      { id: 9, url: `chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/settings.html`, windowId: 1 },
    ]);
    await openSettings("#agents", otherPages);
    expect(otherPages.calls.filter((call) => (call as unknown[])[0] !== "query")).toEqual([["create", { url: `${SETTINGS_URL}#agents` }]]);
  });
});

describe("024 T753 ui.agent.open-settings from the panel", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function panelPort(): AgentPanelPortLike & { emit(message: unknown): void } {
    const listeners: Array<(message: unknown) => void> = [];
    return {
      name: AGENT_PANEL_PORT_NAME,
      sender: { id: EXTENSION_ID, url: `${BASE}side-panel.html` },
      postMessage() {},
      disconnect() {},
      onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
      onDisconnect: { addListener: () => undefined },
      emit(message: unknown) {
        for (const listener of listeners) listener(message);
      },
    };
  }

  it("opens the route the panel named, and refuses a route outside the closed set", () => {
    const area = { async get() { return {}; }, async set() {} };
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: area, session: area },
      alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
      tabs: { async query() { return []; } },
    };
    const opened: string[] = [];
    const reports: string[] = [];
    const runtime = composeAgentRuntime({ connectNative: () => undefined });
    const panel = createAgentPanelPort({
      extensionId: EXTENSION_ID,
      sidePanelUrl: `${BASE}side-panel.html`,
      runtime,
      reportDiagnostic: (code) => reports.push(code),
      openSettings: async (route) => void opened.push(route),
    });
    const port = panelPort();
    panel.accept(port);

    port.emit({ type: "ui.agent.open-settings", payload: { route: "#sites?site=https://github.com" } });
    port.emit({ type: "ui.agent.open-settings", payload: { route: "https://evil.test/" } });

    expect(opened).toEqual(["#sites?site=https://github.com"]);
    expect(reports).toContain("agent.panel.command-rejected");
  });
});
