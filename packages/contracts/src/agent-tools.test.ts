import { describe, expect, it } from "vitest";
import {
  agentEffectPromptSchema,
  agentFindResultSchema,
  agentLinkFrameSchema,
  agentPanelCommandSchema,
  agentPanelMessageSchema,
  agentReadPageResultSchema,
} from "./agent-tools.js";

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

/**
 * 030 T887 - the frame field on a prompt, and the site on frames, nodes and find matches
 * (contracts/prompt-and-reads.md, R-445, R-448).
 */
describe("030", () => {
  const prompt = (extra: Record<string, unknown> = {}) => ({
    promptId: "p-1",
    site: "https://shop.test",
    tool: "click",
    argsSummary: "press Pay",
    ...extra,
  });
  const parsePrompt = (extra?: Record<string, unknown>) => agentEffectPromptSchema.safeParse(prompt(extra)).success;

  it("a prompt without frame parses unchanged", () => {
    const parsed = agentEffectPromptSchema.parse(prompt());
    expect(parsed).toEqual(prompt());
    expect("frame" in parsed).toBe(false);
  });

  it("frame takes a site or unknown: true", () => {
    expect(parsePrompt({ frame: { site: "https://pay.test" } })).toBe(true);
    expect(parsePrompt({ frame: { site: "https://localhost:19443" } })).toBe(true);
    expect(parsePrompt({ frame: { unknown: true } })).toBe(true);
  });

  it("frame refuses unknown: false, site with unknown, extra keys, an empty frame and a non-origin site", () => {
    expect(parsePrompt({ frame: { unknown: false } })).toBe(false);
    expect(parsePrompt({ frame: { site: "https://pay.test", unknown: true } })).toBe(false);
    expect(parsePrompt({ frame: { unknown: true, url: "https://pay.test/x" } })).toBe(false);
    expect(parsePrompt({ frame: { site: "https://pay.test", extra: 1 } })).toBe(false);
    expect(parsePrompt({ frame: {} })).toBe(false);
    expect(parsePrompt({ frame: { site: "https://pay.test/path" } })).toBe(false);
    expect(parsePrompt({ frame: { site: "unknown" } })).toBe(false);
    expect(parsePrompt({ frame: { site: "" } })).toBe(false);
  });

  it("frame refuses the page's own site: a frame of the page's site is decided as the page (R-445)", () => {
    expect(parsePrompt({ frame: { site: "https://shop.test" } })).toBe(false);
    expect(parsePrompt({ frame: { site: "https://shop.test:8443" } })).toBe(true);
  });

  const frameEntry = (extra: Record<string, unknown> = {}) => ({
    frame: "f1",
    parent: "0",
    url: "https://pay.test/embed",
    readable: true,
    ...extra,
  });
  const parseFrames = (frame: Record<string, unknown>) =>
    agentReadPageResultSchema.safeParse({ frames: [frame], nodes: [], truncated: false }).success;

  it("a read_page frame requires site, an origin or unknown", () => {
    expect(parseFrames(frameEntry())).toBe(false);
    expect(parseFrames(frameEntry({ site: "https://pay.test" }))).toBe(true);
    expect(parseFrames(frameEntry({ site: "unknown" }))).toBe(true);
    expect(parseFrames(frameEntry({ site: "https://pay.test/embed" }))).toBe(false);
    expect(parseFrames(frameEntry({ site: "pay.test" }))).toBe(false);
  });

  const parseNode = (extra: Record<string, unknown>) =>
    agentReadPageResultSchema.safeParse({ nodes: [{ role: "button", depth: 0, ...extra }], truncated: false }).success;

  it("a read_page node site is optional and validated", () => {
    expect(parseNode({})).toBe(true);
    expect(parseNode({ site: "https://pay.test" })).toBe(true);
    expect(parseNode({ site: "unknown" })).toBe(true);
    expect(parseNode({ site: "https://pay.test/embed" })).toBe(false);
    expect(parseNode({ site: "" })).toBe(false);
  });

  const parseMatch = (extra: Record<string, unknown>) =>
    agentFindResultSchema.safeParse({ outcome: "resolved", matches: [{ ref: "e1", ...extra }] }).success;

  it("a find match site is optional and validated", () => {
    expect(parseMatch({})).toBe(true);
    expect(parseMatch({ site: "https://pay.test" })).toBe(true);
    expect(parseMatch({ site: "unknown" })).toBe(true);
    expect(parseMatch({ site: "https://pay.test/embed" })).toBe(false);
    expect(parseMatch({ site: "" })).toBe(false);
  });
});
