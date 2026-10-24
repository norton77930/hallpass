import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME, AGENT_SETTINGS_PORT_NAME, settingsMessageSchema } from "@hallpass/contracts";
import { createAgentPanelPort, type AgentPanelPortLike } from "../src/service-worker/agent-panel-port.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { decideGate } from "../src/service-worker/agent-tools/gate.js";
import { AGENT_APPEARANCE_STORAGE_KEY } from "../src/service-worker/agent-appearance.js";
import { createSettingsPort, isTrustedSettingsSender } from "../src/service-worker/settings-port.js";

/**
 * 024 T746, T748, T778 (R-373, contracts/frames.md, data-model "Settings projection") - the settings
 * page's own port.
 *
 * A second extension document gets the power to change standing permissions, so who it is has to be
 * proven: this extension, the top frame of a tab, at `settings.html` (any route). It never counts as
 * a panel - not for "seen", the badge or the pairing bounds - it is told a projection without
 * prompts, cards or sessions, and it may send only the closed settings union, each command reaching
 * the very handler the panel's does.
 */

const EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/side-panel.html`;
const SETTINGS_URL = `chrome-extension://${EXTENSION_ID}/settings.html`;
const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
const SITE = "https://fixtures.test:19443";
const READ_AT = "2026-10-24T00:00:00.000Z";
const SETTINGS_SENDER = { id: EXTENSION_ID, url: `${SETTINGS_URL}#agents`, frameId: 0, tab: { id: 31, windowId: 900 } };

type FakePort = AgentPanelPortLike & { sent: unknown[]; disconnected: boolean; emit(message: unknown): void; drop(): void };

function fakePort(overrides: { name?: string; sender?: unknown } = {}): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  const dropListeners: Array<() => void> = [];
  return {
    name: overrides.name ?? AGENT_SETTINGS_PORT_NAME,
    sender: (overrides.sender ?? SETTINGS_SENDER) as FakePort["sender"],
    sent: [],
    disconnected: false,
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => void dropListeners.push(cb) },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
    drop() {
      for (const listener of dropListeners) listener();
    },
  };
}
const panelPort = () => fakePort({ name: AGENT_PANEL_PORT_NAME, sender: { id: EXTENSION_ID, url: PANEL_URL } });

function fakeNativePort(): AgentPortLike & { sent: unknown[]; emit(message: unknown): void } {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

let local: Record<string, unknown>;

function installChrome(): void {
  local = {};
  const session: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
    async remove(keys: string[]) {
      for (const key of keys) delete store[key];
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    tabs: { async query() { return []; } },
  };
}

function fakeFocus(initial?: number) {
  const listeners: Array<(windowId: number) => void> = [];
  return {
    watch(listener: (windowId: number) => void) {
      listeners.push(listener);
      if (initial !== undefined) listener(initial);
    },
  };
}

const linksAwaitingAck: Array<ReturnType<typeof fakeNativePort>> = [];

function setup(options: { focus?: ReturnType<typeof fakeFocus>; setAttention?: (on: boolean) => void } = {}) {
  const reports: string[] = [];
  const nativePort = fakeNativePort();
  const runtime = composeAgentRuntime({
    connectNative: () => nativePort,
    ...(options.setAttention ? { setAttention: options.setAttention } : {}),
  });
  const panel = createAgentPanelPort({
    extensionId: EXTENSION_ID,
    sidePanelUrl: PANEL_URL,
    runtime,
    ...(options.focus ? { watchFocusedWindow: options.focus.watch } : {}),
  });
  const settings = createSettingsPort({
    extensionId: EXTENSION_ID,
    settingsUrl: SETTINGS_URL,
    runtime,
    extensionVersion: "0.16.0",
    reportDiagnostic: (code) => reports.push(code),
  });
  runtime.bindPanelPresence(panel);
  runtime.start();
  nativePort.emit({ type: "relay-started", relayPid: 4242 });
  linksAwaitingAck.push(nativePort);
  return { runtime, panel, settings, nativePort, reports };
}

const ofType = (port: FakePort, type: string) => port.sent.filter((message) => (message as { type: string }).type === type);
const lastState = (port: FakePort) =>
  (ofType(port, "worker.settings.state").at(-1) as { payload: Record<string, unknown> } | undefined)?.payload;

/** Frames from the host count only once the worker has acknowledged this relay run (link protocol 2). */
async function linkReady(nativePort: ReturnType<typeof fakeNativePort>): Promise<void> {
  await vi.waitFor(() => expect(nativePort.sent.some((frame) => (frame as { type?: string }).type === "relay-ack")).toBe(true));
}

async function brokerUp(nativePort: ReturnType<typeof fakeNativePort>, agents: unknown[] = [{ agent: "claude-code", availability: "ready" }]) {
  await linkReady(nativePort);
  nativePort.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass conversations", role: "broker" });
  nativePort.emit({ type: "conversation-overview", sessionId: BROKER, conversations: [], agents, folders: [] });
}

async function pairAgent(built: ReturnType<typeof setup>): Promise<void> {
  built.nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
  built.nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
  await vi.waitFor(async () => expect((await built.runtime.pairing.state()).pending).toBeDefined());
  await built.runtime.pairing.decide("agent-1", true);
  await vi.waitFor(async () => expect((await built.runtime.pairing.state()).paired).toHaveLength(1));
}

beforeEach(() => {
  installChrome();
});

afterEach(async () => {
  const links = linksAwaitingAck.splice(0);
  await vi.waitFor(() => {
    for (const link of links) expect(link.sent.some((frame) => (frame as { type?: string }).type === "relay-ack")).toBe(true);
  });
  vi.useRealTimers();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("024 T746 settings port trust check", () => {
  it("accepts this extension's settings.html in the top frame of a tab, whatever its route", () => {
    for (const url of [SETTINGS_URL, `${SETTINGS_URL}#agents`, `${SETTINGS_URL}#sites?site=https://github.com`, `${SETTINGS_URL}#`]) {
      expect(isTrustedSettingsSender({ ...SETTINGS_SENDER, url } as chrome.runtime.MessageSender, EXTENSION_ID, SETTINGS_URL), url).toBe(true);
    }
  });

  it("refuses the side panel, other extension pages, another extension, content scripts, iframes and a tabless or unnamed sender", () => {
    const refused: Array<[string, unknown]> = [
      ["the side panel", { id: EXTENSION_ID, url: PANEL_URL, frameId: 0 }],
      ["the side panel in a tab", { id: EXTENSION_ID, url: PANEL_URL, frameId: 0, tab: { id: 31 } }],
      ["another extension page", { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/offscreen.html`, frameId: 0, tab: { id: 31 } }],
      ["another extension", { ...SETTINGS_SENDER, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/settings.html" }],
      ["another extension naming our page", { ...SETTINGS_SENDER, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      ["a content script", { id: EXTENSION_ID, url: "https://evil.test/settings.html", frameId: 0, tab: { id: 31 } }],
      ["a page faking the path", { id: EXTENSION_ID, url: `https://evil.test/${SETTINGS_URL}`, frameId: 0, tab: { id: 31 } }],
      ["an iframe", { ...SETTINGS_SENDER, frameId: 4 }],
      ["no frame id", { id: EXTENSION_ID, url: SETTINGS_URL, tab: { id: 31 } }],
      ["no tab", { id: EXTENSION_ID, url: SETTINGS_URL, frameId: 0 }],
      ["a query string", { ...SETTINGS_SENDER, url: `${SETTINGS_URL}?x=1#agents` }],
      ["a longer path", { ...SETTINGS_SENDER, url: `${SETTINGS_URL}/x` }],
      ["no url", { id: EXTENSION_ID, frameId: 0, tab: { id: 31 } }],
      ["no sender", undefined],
    ];
    for (const [what, sender] of refused) {
      expect(isTrustedSettingsSender(sender as chrome.runtime.MessageSender | undefined, EXTENSION_ID, SETTINGS_URL), what).toBe(false);
    }
  });

  it("disconnects a refused port, sends it nothing and says so; and a settings page on the panel's port is refused there", () => {
    const { settings, panel, reports } = setup();
    const ports = [
      fakePort({ sender: { id: EXTENSION_ID, url: PANEL_URL, frameId: 0 } }),
      fakePort({ sender: { ...SETTINGS_SENDER, frameId: 2 } }),
      fakePort({ name: AGENT_PANEL_PORT_NAME }),
    ];
    for (const port of ports) {
      expect(settings.accept(port).accepted).toBe(false);
      expect(port.disconnected).toBe(true);
      expect(port.sent).toEqual([]);
    }
    expect(reports.filter((code) => code === "agent.settings.connection-rejected")).toHaveLength(3);

    const onPanelPort = fakePort({ name: AGENT_PANEL_PORT_NAME });
    expect(panel.accept(onPanelPort).accepted).toBe(false);
    expect(onPanelPort.disconnected).toBe(true);
  });

  it("never makes the panel seen, never clears the badge and never shortens the pairing bound", async () => {
    vi.useFakeTimers();
    const marks: boolean[] = [];
    const built = setup({ focus: fakeFocus(900), setAttention: (on) => marks.push(on) });
    const presence: boolean[] = [];
    built.panel.onPresenceChange((visible) => presence.push(visible));

    built.nativePort.emit({ type: "hello", sessionId: "session-h1", agentId: "agent-1", displayName: "Claude Code" });
    built.nativePort.emit({ type: "pair-request", agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", sessionId: "session-h1" });
    await vi.waitFor(async () => expect((await built.runtime.pairing.state()).pending).toBeDefined());
    expect(marks.at(-1)).toBe(true);

    // A settings page opens in the window the owner is in.
    const page = fakePort();
    expect(built.settings.accept(page).accepted).toBe(true);
    await vi.waitFor(() => expect(ofType(page, "worker.settings.state")).toHaveLength(1));
    // Even naming the window the way a panel does counts for nothing here.
    page.emit({ type: "ui.agent.panel-window", payload: { windowId: 900 } });

    expect(built.panel.isVisible()).toBe(false);
    expect(built.panel.isConnected()).toBe(false);
    expect(presence).toEqual([]);
    expect(marks.at(-1), "the badge stays on: nobody can see the card").toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(built.nativePort.sent).toContainEqual(
      expect.objectContaining({ type: "prompt-waiting", sessionId: "session-h1", kind: "pairing", panelConnected: false, boundMs: 120_000 }),
    );
    // The card never reached the page either.
    expect(JSON.stringify(page.sent)).not.toContain("pending");
  });
});

describe("024 T748 settings projection and commands", () => {
  it("projects the settings picture on connect, without prompts, cards, sessions or tabs", async () => {
    const built = setup();
    await pairAgent(built);
    void built.runtime.prompts.ask({ callId: "c-1", sessionId: "session-h1", site: SITE, tool: "click", argsSummary: "click Save" });
    await vi.waitFor(() => expect(built.runtime.prompts.current()).toBeDefined());
    await brokerUp(built.nativePort);
    const page = fakePort();

    built.settings.accept(page);
    await vi.waitFor(() => expect(lastState(page)).toMatchObject({ agents: [{ agent: "claude-code", availability: "ready" }] }));

    const state = lastState(page)!;
    expect(settingsMessageSchema.safeParse({ type: "worker.settings.state", payload: state }).success).toBe(true);
    expect(Object.keys(state).sort()).toEqual(
      ["agents", "bridge", "browser", "choices", "consent", "diagnostics", "paired", "sites", "transitions", "versions"].sort(),
    );
    expect(state).toMatchObject({
      bridge: "connected",
      versions: { extension: "0.16.0", match: true },
      paired: [expect.objectContaining({ agentId: "agent-1" })],
      consent: "unknown",
      choices: { enabled: { "claude-code": true, codex: true, hermes: true, deepseek: true }, default: "claude-code" },
    });
    const text = JSON.stringify(page.sent);
    for (const absent of ["promptId", "click Save", "session-h1", "sessions", "\"tabs\"", "pending", "conversations"]) {
      expect(text, absent).not.toContain(absent);
    }
  });

  it("says the agents are unavailable, and the versions do not match, when the host is too old for a broker", async () => {
    vi.useFakeTimers();
    const built = setup();
    const page = fakePort();
    built.settings.accept(page);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(lastState(page)).toMatchObject({ agentsUnavailable: "host-outdated", versions: { match: false } }));
  });

  it("R-386: claims no version match while no host has greeted, and matches once its broker does", async () => {
    const built = setup();
    await linkReady(built.nativePort);
    const page = fakePort();
    built.settings.accept(page);
    await vi.waitFor(() => expect(lastState(page)).toBeDefined());
    expect(lastState(page)!.versions).toEqual({ extension: "0.16.0", match: false });

    await brokerUp(built.nativePort);
    await vi.waitFor(() => expect(lastState(page)!.versions).toEqual({ extension: "0.16.0", match: true }));
  });

  it("routes each shared command to the very runtime operation the panel's command reaches", async () => {
    const built = setup();
    const page = fakePort();
    const panel = panelPort();
    built.settings.accept(page);
    built.panel.accept(panel);
    const spies = {
      setSiteMode: vi.spyOn(built.runtime, "setSiteMode").mockResolvedValue(),
      clearSiteMode: vi.spyOn(built.runtime, "clearSiteMode").mockResolvedValue(),
      clearTransition: vi.spyOn(built.runtime, "clearTransition").mockResolvedValue(),
      unpair: vi.spyOn(built.runtime, "unpair").mockResolvedValue(),
      clearUploadRoot: vi.spyOn(built.runtime, "clearUploadRoot").mockResolvedValue(),
      renameBrowser: vi.spyOn(built.runtime, "renameBrowser").mockResolvedValue("renamed"),
      setDiagnostics: vi.spyOn(built.runtime, "setDiagnostics").mockResolvedValue(),
    };
    const commands = [
      { type: "ui.agent.site-mode", payload: { site: SITE, mode: "skip-checks" } },
      { type: "ui.agent.site-clear", payload: { site: SITE } },
      { type: "ui.agent.transition-clear", payload: { from: SITE, to: "https://b.test" } },
      { type: "ui.agent.unpair", payload: { agentId: "agent-1" } },
      { type: "ui.agent.upload-root-clear", payload: { root: "C:\\Users\\owner\\Pictures" } },
      { type: "ui.agent.browser-rename", payload: { name: "Work Chrome" } },
      // 004 FR-049: the diagnostics grant, a consent of its own, moved with the site row.
      { type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: true } },
      { type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: false } },
    ];

    for (const [index, command] of commands.entries()) page.emit({ ...command, commandId: `s-${index}` });
    const fromPage = Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, [...spy.mock.calls]]));
    for (const spy of Object.values(spies)) spy.mockClear();
    for (const command of commands) panel.emit(command);
    const fromPanel = Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, [...spy.mock.calls]]));

    expect(fromPage).toEqual(fromPanel);
    expect(fromPage).toEqual({
      setSiteMode: [[SITE, "skip-checks"]],
      clearSiteMode: [[SITE]],
      clearTransition: [[SITE, "https://b.test"]],
      unpair: [["agent-1"]],
      clearUploadRoot: [["C:\\Users\\owner\\Pictures"]],
      renameBrowser: [["Work Chrome"]],
      setDiagnostics: [
        [SITE, true],
        [SITE, false],
      ],
    });
    await vi.waitFor(() =>
      expect(ofType(page, "worker.settings.result").map((message) => (message as { payload: unknown }).payload)).toEqual(
        commands.map((_command, index) => ({ commandId: `s-${index}`, ok: true })),
      ),
    );
  });

  it("answers ok: false when the operation fails", async () => {
    const built = setup();
    const page = fakePort();
    built.settings.accept(page);
    vi.spyOn(built.runtime, "setSiteMode").mockRejectedValue(new Error("storage gone"));

    page.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "ask" }, commandId: "s-1" });

    await vi.waitFor(() =>
      expect(ofType(page, "worker.settings.result")).toEqual([
        { type: "worker.settings.result", payload: { commandId: "s-1", ok: false, error: { code: "failed" } } },
      ]),
    );
  });

  it("answers a refused browser name name-refused and a rename that could not be stored failed, never ok", async () => {
    const built = setup();
    await linkReady(built.nativePort);
    const page = fakePort();
    built.settings.accept(page);
    const results = () => ofType(page, "worker.settings.result").map((message) => (message as { payload: unknown }).payload);

    // Whitespace and control characters only: nothing left to store (018 FR-268).
    page.emit({ type: "ui.agent.browser-rename", payload: { name: " \u0007 " }, commandId: "s-1" });
    await vi.waitFor(() => expect(results()).toEqual([{ commandId: "s-1", ok: false, error: { code: "name-refused" } }]));

    const area = (globalThis as unknown as { chrome: { storage: { local: { set: unknown } } } }).chrome.storage.local;
    area.set = async () => Promise.reject(new Error("quota"));
    page.emit({ type: "ui.agent.browser-rename", payload: { name: "Work Chrome" }, commandId: "s-2" });
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(results()[1]).toEqual({ commandId: "s-2", ok: false, error: { code: "failed" } });
    for (const message of page.sent) expect(settingsMessageSchema.safeParse(message).success).toBe(true);
    expect(ofType(built.nativePort as unknown as FakePort, "browser-name")).toEqual([]);
  });

  it("refuses panel-only commands and malformed ones, logs each, and answers ok: false when it can name the command", async () => {
    const built = setup();
    const page = fakePort();
    built.settings.accept(page);
    await vi.waitFor(() => expect(ofType(page, "worker.settings.state")).toHaveLength(1));
    const stop = vi.spyOn(built.runtime, "stopSessionFromOwner").mockResolvedValue();
    const release = vi.spyOn(built.runtime, "releaseSessionTabs").mockResolvedValue();
    const interrupt = vi.spyOn(built.runtime, "interruptSession").mockReturnValue({ interrupted: 0 });
    const decide = vi.spyOn(built.runtime.prompts, "decide");
    const pairDecide = vi.spyOn(built.runtime.pairing, "decide");
    const forwarded = vi.spyOn(built.runtime.conversation, "command");
    const withdraw = vi.spyOn(built.runtime.sitePlans, "withdraw");

    const refused = [
      { type: "ui.agent.session-stop", payload: { sessionId: "session-h1" } },
      { type: "ui.agent.session-release", payload: { sessionId: "session-h1" } },
      { type: "ui.agent.session-interrupt", payload: { sessionId: "session-h1" } },
      { type: "ui.agent.site-plan-withdraw", payload: { sessionId: "session-h1" } },
      { type: "ui.agent.effect-decide", payload: { promptId: "p-1", allow: true } },
      { type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } },
      { type: "ui.conversation.start", payload: { agent: "codex", folder: { kind: "scratch" } } },
      { type: "ui.conversation.send", payload: { conversationId: "conv-aaaaaaaaaaaaaaaa1", text: "hi" } },
      { type: "ui.conversation.answer", payload: { conversationId: "conv-aaaaaaaaaaaaaaaa1", requestId: "r", answer: "allow-once" } },
      { type: "ui.conversation.diagnostics", payload: { conversationId: "conv-aaaaaaaaaaaaaaaa1" } },
      { type: "ui.agent.open-settings", payload: { route: "#agents" } },
      { type: "ui.agent.site-mode", payload: { site: `${SITE}/path`, mode: "skip-checks" } },
    ];
    for (const [index, command] of refused.entries()) page.emit({ ...command, commandId: `s-${index}` });
    // Nothing to answer by: refused and logged only.
    page.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "skip-checks" } });
    page.emit("nonsense");
    page.emit({ type: "ui.agent.unpair", payload: { agentId: "agent-1" }, commandId: 7 });

    for (const spy of [stop, release, interrupt, decide, pairDecide, forwarded, withdraw]) expect(spy).not.toHaveBeenCalled();
    expect(ofType(page, "worker.settings.result").map((message) => (message as { payload: unknown }).payload)).toEqual(
      refused.map((_command, index) => ({ commandId: `s-${index}`, ok: false, error: { code: "command-refused" } })),
    );
    expect(built.reports.filter((code) => code === "agent.settings.command-refused")).toHaveLength(refused.length + 3);
    expect(await built.runtime.siteModes.get(SITE)).toMatchObject({ mode: "ask" });
  });

  it("forwards the broker commands to the relay, answering the asking page alone", async () => {
    const built = setup();
    await brokerUp(built.nativePort);
    const asking = fakePort();
    const other = fakePort({ sender: { ...SETTINGS_SENDER, tab: { id: 32, windowId: 900 } } });
    const panel = panelPort();
    built.settings.accept(asking);
    built.settings.accept(other);
    built.panel.accept(panel);

    const commands = [
      { type: "ui.conversation.check-agents", payload: {} },
      { type: "ui.conversation.install", payload: { agent: "codex" } },
      { type: "ui.conversation.install-cancel", payload: { agent: "codex" } },
      { type: "ui.conversation.test", payload: { agent: "codex" } },
      { type: "ui.conversation.diagnostics", payload: { agent: "codex" } },
    ];
    for (const [index, command] of commands.entries()) asking.emit({ ...command, commandId: `s-${index}` });
    for (const [index, command] of commands.entries()) {
      await vi.waitFor(() =>
        expect(built.nativePort.sent).toContainEqual({ type: "conversation-command", sessionId: BROKER, commandId: `s-${index}`, command }),
      );
      built.nativePort.emit({ type: "conversation-result", sessionId: BROKER, commandId: `s-${index}`, ok: true });
    }
    built.nativePort.emit({ type: "conversation-diagnostics", sessionId: BROKER, agent: "codex", readAt: READ_AT, lines: ["INFO up"] });

    await vi.waitFor(() => expect(ofType(asking, "worker.settings.result")).toHaveLength(commands.length));
    await vi.waitFor(() =>
      expect(ofType(asking, "worker.settings.diagnostics")).toEqual([
        { type: "worker.settings.diagnostics", payload: { agent: "codex", readAt: READ_AT, lines: ["INFO up"] } },
      ]),
    );
    for (const message of asking.sent) expect(settingsMessageSchema.safeParse(message).success).toBe(true);
    expect(ofType(other, "worker.settings.result")).toEqual([]);
    expect(ofType(other, "worker.settings.diagnostics")).toEqual([]);
    expect(ofType(panel, "conversation-result")).toEqual([]);
    expect(ofType(panel, "conversation-diagnostics")).toEqual([]);
  });

  it("the side-panel-agent switch from the page records the owner's answer the way the panel's does", async () => {
    const built = setup();
    await brokerUp(built.nativePort);
    const page = fakePort();
    built.settings.accept(page);

    page.emit({ type: "ui.conversation.consent", payload: { granted: true }, commandId: "s-1" });

    await vi.waitFor(() => expect(lastState(page)).toMatchObject({ consent: "granted" }));
    expect(local.agentPanelConsent).toMatchObject({ granted: true });
    expect(built.nativePort.sent).toContainEqual({
      type: "conversation-command",
      sessionId: BROKER,
      commandId: "s-1",
      command: { type: "ui.conversation.consent", payload: { granted: true } },
    });
  });

  it("keeps two open pages in step, and a page that left is no longer written to", async () => {
    const built = setup();
    const first = fakePort();
    const second = fakePort({ sender: { ...SETTINGS_SENDER, tab: { id: 32, windowId: 900 } } });
    built.settings.accept(first);
    built.settings.accept(second);
    await vi.waitFor(() => expect(ofType(second, "worker.settings.state").length).toBeGreaterThan(0));

    first.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "follow-a-plan" }, commandId: "s-1" });

    for (const page of [first, second]) {
      await vi.waitFor(() => expect(lastState(page)).toMatchObject({ sites: [expect.objectContaining({ site: SITE, mode: "follow-a-plan" })] }));
    }
    second.drop();
    const before = second.sent.length;
    first.emit({ type: "ui.agent.site-clear", payload: { site: SITE }, commandId: "s-2" });
    await vi.waitFor(() => expect(lastState(first)).toMatchObject({ sites: [] }));
    expect(second.sent).toHaveLength(before);
  });

  it("FR-385: a site row carries its diagnostics grant and who changed it last, as the panel's row did (004 FR-049, 019 FR-308)", async () => {
    const built = setup();
    const page = fakePort();
    built.settings.accept(page);
    await vi.waitFor(() => expect(lastState(page)).toBeDefined());

    page.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "follow-a-plan" }, commandId: "s-1" });
    page.emit({ type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: true }, commandId: "s-2" });

    await vi.waitFor(() =>
      expect(lastState(page)!.sites).toEqual([
        expect.objectContaining({ site: SITE, mode: "follow-a-plan", diagnosticsGranted: true, changedBy: "owner" }),
      ]),
    );
    expect(await built.runtime.siteModes.get(SITE)).toMatchObject({ diagnosticsGranted: true });
  });
});

describe("024 T771 / T787 the page's own records", () => {
  it("choices-set answers with where the default moved, tells every page once, and the panel follows", async () => {
    const built = setup();
    await brokerUp(built.nativePort, [
      { agent: "claude-code", availability: "ready" },
      { agent: "codex", availability: "ready" },
      { agent: "hermes", availability: "missing" },
      { agent: "deepseek", availability: "ready" },
    ]);
    const first = fakePort();
    const second = fakePort({ sender: { ...SETTINGS_SENDER, tab: { id: 32, windowId: 900 } } });
    const panel = panelPort();
    built.settings.accept(first);
    built.settings.accept(second);
    built.panel.accept(panel);
    await vi.waitFor(() => expect(lastState(first)).toMatchObject({ choices: { default: "claude-code" } }));

    first.emit({ type: "ui.settings.choices-set", payload: { enabled: { "claude-code": false } }, commandId: "s-1" });

    await vi.waitFor(() =>
      expect(ofType(first, "worker.settings.result")).toEqual([
        { type: "worker.settings.result", payload: { commandId: "s-1", ok: true, defaultMovedTo: "codex" } },
      ]),
    );
    for (const page of [first, second]) {
      expect(ofType(page, "worker.settings.toast")).toEqual([{ type: "worker.settings.toast", payload: { kind: "default-moved", agent: "codex" } }]);
      await vi.waitFor(() => expect(lastState(page)).toMatchObject({ choices: { default: "codex", enabled: { "claude-code": false } } }));
    }
    await vi.waitFor(() =>
      expect(
        (ofType(panel, "worker.agent.state").at(-1) as { payload: { conversation: { choices?: unknown } } }).payload.conversation.choices,
      ).toEqual({ enabled: { "claude-code": false, codex: true, hermes: true, deepseek: true }, default: "codex" }),
    );

    first.emit({ type: "ui.settings.choices-set", payload: { default: "hermes" }, commandId: "s-2" });
    await vi.waitFor(() =>
      expect(ofType(first, "worker.settings.result").at(-1)).toEqual({
        type: "worker.settings.result",
        payload: { commandId: "s-2", ok: false, error: { code: "agent-not-ready" } },
      }),
    );
    expect(ofType(first, "worker.settings.toast")).toHaveLength(1);
  });

  it("appearance-set writes agentAppearance over the System defaults", async () => {
    const built = setup();
    const page = fakePort();
    built.settings.accept(page);

    page.emit({ type: "ui.settings.appearance-set", payload: { theme: "dark" }, commandId: "s-1" });
    await vi.waitFor(() => expect(local[AGENT_APPEARANCE_STORAGE_KEY]).toEqual({ theme: "dark", language: "system" }));
    page.emit({ type: "ui.settings.appearance-set", payload: { language: "zh-TW" }, commandId: "s-2" });
    await vi.waitFor(() => expect(local[AGENT_APPEARANCE_STORAGE_KEY]).toEqual({ theme: "dark", language: "zh-TW" }));
    await vi.waitFor(() =>
      expect(ofType(page, "worker.settings.result").map((message) => (message as { payload: unknown }).payload)).toEqual([
        { commandId: "s-1", ok: true },
        { commandId: "s-2", ok: true },
      ]),
    );
  });
});

describe("024 T765 (worker) toasts", () => {
  const install = (phase: string, startedAt = "2026-10-24T01:00:00.000Z") => ({
    phase,
    percent: phase === "done" ? 100 : 40,
    etaSeconds: null,
    startedAt,
    browserId: "b-12345678",
    ...(phase === "failed" ? { error: "npm could not reach the registry." } : {}),
  });
  const overview = (codex: Record<string, unknown>, deepseek: Record<string, unknown> = {}) => ({
    type: "conversation-overview",
    sessionId: BROKER,
    conversations: [],
    agents: [
      { agent: "codex", availability: "needs-install", ...codex },
      { agent: "deepseek", availability: "needs-install", ...deepseek },
    ],
    folders: [],
  });

  it("tells every open page once when a download finishes or fails and when a test has run", async () => {
    const built = setup();
    await linkReady(built.nativePort);
    built.nativePort.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass conversations", role: "broker" });
    built.nativePort.emit(overview({ install: install("downloading") }, { install: install("downloading") }));
    const first = fakePort();
    const second = fakePort({ sender: { ...SETTINGS_SENDER, tab: { id: 32, windowId: 900 } } });
    built.settings.accept(first);
    built.settings.accept(second);
    await vi.waitFor(() => expect(lastState(second)).toMatchObject({ agents: [expect.objectContaining({ agent: "codex" }), expect.anything()] }));

    built.nativePort.emit(overview({ availability: "ready", install: install("done") }, { install: install("failed") }));
    for (const page of [first, second]) {
      await vi.waitFor(() =>
        expect(ofType(page, "worker.settings.toast").map((message) => (message as { payload: unknown }).payload)).toEqual([
          { kind: "install-done", agent: "codex" },
          { kind: "install-failed", agent: "deepseek" },
        ]),
      );
    }

    // The same picture again tells nobody anything new.
    built.nativePort.emit(overview({ availability: "ready", install: install("done") }, { install: install("failed") }));
    const lastTest = { outcome: "passed", start: "ok", model: { answered: true, ms: 900 }, browserTools: "available", ranAt: READ_AT };
    built.nativePort.emit(overview({ availability: "ready", install: install("done"), lastTest }, { install: install("failed") }));
    for (const page of [first, second]) {
      await vi.waitFor(() => expect(ofType(page, "worker.settings.toast")).toHaveLength(3));
      expect((ofType(page, "worker.settings.toast").at(-1) as { payload: unknown }).payload).toEqual({ kind: "test-done", agent: "codex" });
    }
    built.nativePort.emit(overview({ availability: "ready", install: install("done"), lastTest }, { install: install("failed") }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofType(first, "worker.settings.toast")).toHaveLength(3);
  });

  it("says nothing about what finished before the page opened", async () => {
    const built = setup();
    await linkReady(built.nativePort);
    built.nativePort.emit({ type: "hello", sessionId: BROKER, agentId: "hallpass-broker", displayName: "Hallpass conversations", role: "broker" });
    built.nativePort.emit(overview({ install: install("downloading") }));
    const early = fakePort();
    built.settings.accept(early);
    await vi.waitFor(() => expect(lastState(early)).toBeDefined());
    early.drop();
    built.nativePort.emit(overview({ availability: "ready", install: install("done") }));

    const late = fakePort();
    built.settings.accept(late);
    await vi.waitFor(() => expect(lastState(late)).toMatchObject({ agents: [expect.objectContaining({ availability: "ready" }), expect.anything()] }));
    expect(ofType(late, "worker.settings.toast")).toEqual([]);
  });
});

describe("024 T778 the page's permission changes act on consent prompts as the panel's did", () => {
  async function gate(built: ReturnType<typeof setup>) {
    const { mode } = await built.runtime.siteModes.get(SITE);
    return decideGate({ sessionId: "session-h1", tabId: 7, site: SITE, mode, tool: "click", args: {} }).decision;
  }

  it("a site mode set from the page is the mode the gate reads, exactly as one set from the panel", async () => {
    const fromPage = setup();
    const page = fakePort();
    fromPage.settings.accept(page);
    page.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "skip-checks" }, commandId: "s-1" });
    await vi.waitFor(async () => expect(await gate(fromPage)).toBe("admit"));

    const fromPanel = setup();
    const panel = panelPort();
    fromPanel.panel.accept(panel);
    panel.emit({ type: "ui.agent.site-mode", payload: { site: SITE, mode: "skip-checks" } });
    await vi.waitFor(async () => expect(await gate(fromPanel)).toBe("admit"));

    const strip = (record: Record<string, unknown>) => ({ ...record, changedAt: undefined });
    expect(strip(await fromPage.runtime.siteModes.get(SITE))).toEqual(strip(await fromPanel.runtime.siteModes.get(SITE)));
    expect(await fromPage.runtime.siteModes.get(SITE)).toMatchObject({ changedBy: "owner" });

    // Revoke from the page: the site is undecided again, and the next effect is asked about.
    page.emit({ type: "ui.agent.site-clear", payload: { site: SITE }, commandId: "s-2" });
    await vi.waitFor(async () => expect(await gate(fromPage)).toBe("prompt"));
    panel.emit({ type: "ui.agent.site-clear", payload: { site: SITE } });
    await vi.waitFor(async () => expect(await gate(fromPanel)).toBe("prompt"));
  });

  it("an unpair from the page tells the open session at once and refuses its next call, as the panel's does", async () => {
    const built = setup();
    await pairAgent(built);
    const page = fakePort();
    built.settings.accept(page);

    page.emit({ type: "ui.agent.unpair", payload: { agentId: "agent-1" }, commandId: "s-1" });

    await vi.waitFor(() =>
      expect(built.nativePort.sent).toContainEqual({ type: "pair-result", agentId: "agent-1", sessionId: "session-h1", accepted: false }),
    );
    built.nativePort.emit({ callId: "call-2", sessionId: "session-h1", tool: "tabs_context", args: {} });
    await vi.waitFor(() => expect(built.nativePort.sent).toContainEqual({ callId: "call-2", outcome: "denied", reason: "not-paired" }));
    await vi.waitFor(() => expect(lastState(page)).toMatchObject({ paired: [] }));
  });
});
