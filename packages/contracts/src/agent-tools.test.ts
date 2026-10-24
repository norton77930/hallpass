import { describe, expect, it } from "vitest";
import { agentLinkFrameSchema, agentPanelCommandSchema, agentPanelMessageSchema } from "./agent-tools.js";

/**
 * 022 T612 - the panel <-> worker messages for the viewed tab (contracts/attachments.md, R-342):
 * `ui.tab.capture` from the panel and `tab-capture-result` back. Panel and worker only - neither
 * is a link frame.
 */

const capture = (payload: Record<string, unknown>) => ({ type: "ui.tab.capture", requestId: "req-1", payload });
const result = (value: Record<string, unknown>) => ({ type: "tab-capture-result", requestId: "req-1", result: value });

describe("022 ui.tab.capture", () => {
  it("asks for a screenshot or the page of one tab", () => {
    expect(agentPanelCommandSchema.safeParse(capture({ tabId: 7, what: "screenshot" })).success).toBe(true);
    expect(agentPanelCommandSchema.safeParse(capture({ tabId: 7, what: "page" })).success).toBe(true);
  });

  it("refuses another kind, a missing request id and extra fields", () => {
    expect(agentPanelCommandSchema.safeParse(capture({ tabId: 7, what: "pdf" })).success).toBe(false);
    expect(agentPanelCommandSchema.safeParse({ type: "ui.tab.capture", payload: { tabId: 7, what: "page" } }).success).toBe(false);
    expect(agentPanelCommandSchema.safeParse(capture({ tabId: 7, what: "page", url: "https://x.test" })).success).toBe(false);
  });

  it("is not a link frame", () => {
    expect(agentLinkFrameSchema.safeParse(capture({ tabId: 7, what: "page" })).success).toBe(false);
  });
});

describe("022 tab-capture-result", () => {
  it("carries an image, a page or a PDF file", () => {
    for (const value of [
      { ok: true, kind: "image", mimeType: "image/jpeg", data: "AAAA", width: 1280, height: 720 },
      { ok: true, kind: "page", url: "https://example.test/a", title: "A page", text: "words", cut: false },
      { ok: true, kind: "file", name: "paper.pdf", mimeType: "application/pdf", data: "AAAA", size: 3 },
    ]) {
      expect(agentPanelMessageSchema.safeParse(result(value)).success, value.kind).toBe(true);
    }
  });

  it("carries the refusals restricted, not-active, too-large and failed", () => {
    for (const code of ["restricted", "not-active", "too-large", "failed"]) {
      expect(agentPanelMessageSchema.safeParse(result({ ok: false, code, message: "why" })).success).toBe(true);
    }
    expect(agentPanelMessageSchema.safeParse(result({ ok: false, code: "other", message: "why" })).success).toBe(false);
  });

  it("bounds the image to 700 000 characters and the page text to 50 000", () => {
    expect(
      agentPanelMessageSchema.safeParse(
        result({ ok: true, kind: "image", mimeType: "image/png", data: "A".repeat(700_004), width: 1, height: 1 }),
      ).success,
    ).toBe(false);
    expect(
      agentPanelMessageSchema.safeParse(result({ ok: true, kind: "page", url: "https://x.test", title: "t", text: "x".repeat(50_001), cut: true }))
        .success,
    ).toBe(false);
    expect(
      agentPanelMessageSchema.safeParse(result({ ok: true, kind: "file", name: "a.pdf", mimeType: "text/plain", data: "AAAA", size: 3 })).success,
    ).toBe(false);
  });
});

/**
 * 024 T744 - the panel projection additions (contracts/frames.md "Panel projection additions"):
 * `conversation.choices` (AgentChoices, R-380) and a session card's `site` for the permissions link.
 * Both optional, so a 0.15 projection still parses.
 */
describe("024 panel projection additions", () => {
  const base = { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected" };
  const conversation = { available: true, consent: "granted", conversations: [], agents: [], folders: [] };
  const choices = { enabled: { "claude-code": true, codex: false, hermes: true, deepseek: true }, default: "hermes" };
  const session = { sessionId: "s-1", agentId: "a-1", tabs: [] };
  const state = (payload: Record<string, unknown>) => agentPanelMessageSchema.safeParse({ type: "worker.agent.state", payload }).success;

  it("conversation carries the owner's choices, and still parses without them", () => {
    expect(state({ ...base, conversation })).toBe(true);
    expect(state({ ...base, conversation: { ...conversation, choices } })).toBe(true);
    expect(state({ ...base, conversation: { ...conversation, choices: { ...choices, default: "codex" } } })).toBe(false);
  });

  it("a session names the canonical origin it acts on, or nothing", () => {
    expect(state({ ...base, sessions: [session] })).toBe(true);
    expect(state({ ...base, sessions: [{ ...session, site: "https://example.test" }] })).toBe(true);
    expect(state({ ...base, sessions: [{ ...session, site: "https://example.test/path" }] })).toBe(false);
  });
});

/**
 * 024 T753 - the panel's link into the settings page (R-372): `ui.agent.open-settings { route }`,
 * with the routes R-372 lists and nothing else, so a panel command can never open another page.
 */
describe("024 ui.agent.open-settings", () => {
  const open = (route: unknown) => agentPanelCommandSchema.safeParse({ type: "ui.agent.open-settings", payload: { route } }).success;

  it("takes each route R-372 lists", () => {
    for (const route of [
      "#agents",
      "#agents/claude-code",
      "#agents/codex",
      "#agents/hermes",
      "#agents/deepseek",
      "#sites",
      "#sites?site=https://github.com",
      "#sites?site=http://localhost:5173",
      `#sites?site=${encodeURIComponent("https://docs.example.test")}`,
      "#tools",
      "#connection",
    ]) {
      expect(open(route), route).toBe(true);
    }
  });

  it("refuses another page, an unknown agent or section, a site that is not a canonical origin, and extra fields", () => {
    for (const route of [
      "",
      "agents",
      "#",
      "#agents/other",
      "#agents/",
      "#sessions",
      "#sites?site=",
      "#sites?site=https://github.com/path",
      "#sites?site=https://github.com&x=1",
      "#sites?other=https://github.com",
      "#tools/extra",
      "https://evil.test/#agents",
      "side-panel.html#agents",
      `#sites?site=https://${"a".repeat(600)}.test`,
    ]) {
      expect(open(route), route).toBe(false);
    }
    expect(open(7)).toBe(false);
    expect(
      agentPanelCommandSchema.safeParse({ type: "ui.agent.open-settings", payload: { route: "#agents", url: "https://evil.test" } }).success,
    ).toBe(false);
  });
});
