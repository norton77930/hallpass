/**
 * Throwaway palette prototype (not production): the REAL AgentShell twice, side by side, on a fake
 * chrome port - left the Conversation tab with a consent card on top, right the Sessions tab with
 * the status row and cards. `?scheme=light|dark&locale=zh-TW|en-US`.
 */
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import "../../src/side-panel/agent/tokens.css";
import "../../src/side-panel/agent/appearance.css";
import "../../src/side-panel/agent/agent.css";
import { AgentShell } from "../../src/side-panel/agent/AgentShell.js";

const params = new URLSearchParams(location.search);
const locale = (params.get("locale") ?? "zh-TW") as "zh-TW" | "en-US";
const CONV = "conv-0123456789abcdef";

const base = {
  paired: [{ agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" }],
  agentName: "Claude Code",
  tabs: [],
  sites: [{ site: "https://shop.test", mode: "ask", diagnosticsGranted: false }],
  bridge: "connected",
  diagnostics: { relayPid: 4242 },
};
const conversation = {
  available: true,
  consent: "granted",
  conversations: [
    {
      conversationId: CONV,
      agent: "claude-code",
      title: "Summarise this table",
      folder: { kind: "scratch" },
      mode: "strict",
      createdAt: "2026-10-19T00:00:00.000Z",
      lastUsedAt: "2026-10-19T00:00:01.000Z",
      resumable: true,
      state: "idle",
    },
  ],
  active: CONV,
  agents: [{ agent: "claude-code", availability: "ready", version: "2.1.0" }, { agent: "codex", availability: "ready", version: "0.50.0" }],
  folders: [],
};
const sessions = [
  { sessionId: "sess-aaaa1111", agentId: "agent-1", tabs: [{ tabId: 3, url: "https://shop.test/", title: "Shop", active: true, holder: "this" }], sites: ["shop.test"], state: "waiting", label: "shop-frontend", colour: "cyan", startedAt: "2026-09-13T00:00:00.000Z", lastActivityAt: new Date().toISOString() },
  { sessionId: "sess-bbbb2222", agentId: "agent-1", tabs: [{ tabId: 4, url: "https://github.com/", title: "GitHub", active: false, holder: "this" }], sites: ["github.com"], state: "working", inFlight: 1, label: "docs-refresh", colour: "green", startedAt: "2026-09-13T00:00:00.000Z", lastActivityAt: new Date().toISOString() },
  { sessionId: "sess-cccc3333", agentId: "agent-1", tabs: [], sites: ["market.test"], state: "idle", label: "integration-v1", colour: "purple", startedAt: "2026-09-13T00:00:00.000Z", lastActivityAt: new Date(Date.now() - 3_600_000).toISOString() },
];
const prompt = { promptId: "prompt-1", site: "https://shop.test", tool: "click", argsSummary: "click", targetLabel: "Save", targetRole: "button" };

const events = [
  { type: "text", role: "owner", text: locale === "zh-TW" ? "幫我整理這張表格的重點" : "Summarise the key points of this table" },
  { type: "text", role: "agent", text: locale === "zh-TW" ? "好的，我先讀取頁面內容。重點如下：\n\n- 本週營收成長 12%\n- 退貨率下降\n\n```ts\nconst total = rows.reduce((sum, row) => sum + row.amount, 0);\n```\n\n需要我再匯出成 `CSV` 嗎？" : "Sure, reading the page first. Key points:\n\n- Revenue grew 12% this week\n- Return rate fell\n\n```ts\nconst total = rows.reduce((sum, row) => sum + row.amount, 0);\n```\n\nShould I export it as `CSV`?" },
  { type: "tool", toolCallId: "t-1", kind: "read", title: "Read table", inputSummary: "table#weekly", status: "done" },
  { type: "tool", toolCallId: "t-2", kind: "execute", title: "Run export", inputSummary: "export.csv", status: "running" },
];

function fakePort() {
  const listeners: ((m: unknown) => void)[] = [];
  return {
    name: "hallpass-agent-panel",
    postMessage() {},
    disconnect() {},
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l), removeListener() {} },
    onDisconnect: { addListener() {}, removeListener() {} },
    emit: (m: unknown) => listeners.forEach((l) => l(m)),
  };
}
const ports = [fakePort(), fakePort()];
const tabs = ["conversation", "sessions"];
let connects = 0;
let reads = 0;
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { id: "adgpccmmbgnchnphfaoabfflfcepbopd", connect: () => ports[Math.min(connects++, 1)] },
  storage: { local: { get: (k: string) => Promise.resolve({ [k]: tabs[Math.min(reads++, 1)] }), set: () => Promise.resolve() } },
};

const root = createRoot(document.getElementById("root")!);
root.render(
  createElement(
    "div",
    { style: { display: "contents" } },
    createElement("div", null, createElement(AgentShell, { locale })),
    createElement("div", null, createElement(AgentShell, { locale })),
  ),
);
setTimeout(() => {
  ports[0]!.emit({ type: "worker.agent.state", payload: { ...base, sessions: [], prompt, conversation } });
  events.forEach((event, i) => ports[0]!.emit({ type: "conversation-event", payload: { conversationId: CONV, seq: i + 1, event } }));
  ports[1]!.emit({ type: "worker.agent.state", payload: { ...base, sessions, conversation } });
}, 300);
