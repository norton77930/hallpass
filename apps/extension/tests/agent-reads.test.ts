import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";

/**
 * 003/T034 — the read tools inside the worker (US2, FR-036..FR-039).
 *
 * Two claims run through all of them. Reading never asks the owner anything, so there is no prompt
 * controller here at all and no site mode is consulted - the absence is the assertion. And every
 * read says whether it was cut, because a page reported without that flag is a page the agent would
 * believe it had seen whole.
 *
 * The third claim is about what a read may carry: a role, a name and a handle the worker minted,
 * and never the page's own markup.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;

function installChrome(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        if (frame.type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

type Collected = Awaited<ReturnType<typeof import("../src/service-worker/content-broker.js").collectFromActiveTab>>;

function collection(overrides: Partial<Collected> = {}): Collected {
  return {
    tabId: AGENT_TAB,
    contextHandle: "snap-1",
    documentEpoch: "doc-1",
    canonicalOrigin: SITE,
    formValueItems: [],
    ...overrides,
  } as Collected;
}

function harness(collected: Collected | (() => Promise<Collected>)) {
  const collect = vi.fn(async () => (typeof collected === "function" ? collected() : collected));
  const runner = createAgentReads({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    collect: collect as unknown as typeof import("../src/service-worker/content-broker.js").collectFromActiveTab,
  });
  return { runner, collect };
}

function request(tool: string, args: Record<string, unknown>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-h1", tool: tool as AgentNativeRequest["tool"], tabId: AGENT_TAB, args };
}

describe("T034 agent read tools", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("returns the page's text and says it was not cut", async () => {
    const { runner, collect } = harness(collection({ visibleText: "Ordinary page", truncated: false }));

    const response = await runner.run(request("get_page_text", { tabId: AGENT_TAB }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { text: "Ordinary page", truncated: false },
    });
    // The one category it needs and no other: a text read never asks for form values.
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ requested: ["page.visible-text"], tab: AGENT_TAB }),
    );
  });

  it("says when the collector's bound cut the text", async () => {
    const { runner } = harness(
      collection({ visibleText: "Ordin", truncated: true, truncatedDimension: "visible-text" }),
    );

    const response = await runner.run(request("get_page_text", { tabId: AGENT_TAB }));

    // 004/T135a: the text read names the limit that cut it, as the structured read does.
    expect(response.result).toEqual({ text: "Ordin", truncated: true, truncatedBy: "chars" });
  });

  it("returns structure as refs, roles, names and depths - and nothing else", async () => {
    const { runner } = harness(
      collection({
        semanticNodes: [
          { role: "button", label: "Save", targetHandle: "t_save", depth: 3 },
          { role: "textbox", label: "Notes", targetHandle: "t_notes", depth: 4 },
        ],
      }),
    );

    const response = await runner.run(request("read_page", { tabId: AGENT_TAB }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        nodes: [
          { ref: "t_save", role: "button", name: "Save", depth: 3 },
          { ref: "t_notes", role: "textbox", name: "Notes", depth: 4 },
        ],
        truncated: false,
      },
    });
  });

  it("keeps only interactive roles by default, and everything when asked", async () => {
    const nodes = [
      { role: "button", label: "Save", targetHandle: "t_save", depth: 2 },
      { role: "control", label: "Odd", depth: 2 },
    ];
    const filtered = await harness(collection({ semanticNodes: nodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "interactive" }),
    );
    expect(filtered.result).toEqual({
      nodes: [{ ref: "t_save", role: "button", name: "Save", depth: 2 }],
      // Something was left out, so the answer is not the whole page and says so.
      truncated: true,
    });

    const all = await harness(collection({ semanticNodes: nodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "all" }),
    );
    expect(all.result).toEqual({
      nodes: [
        { ref: "t_save", role: "button", name: "Save", depth: 2 },
        // No ref: the registry mints one only where an effect could actually be delivered, and a
        // node without one is honestly saying this product cannot act on it.
        { role: "control", name: "Odd", depth: 2 },
      ],
      truncated: false,
    });
  });

  /**
   * C2 — the collection says which nodes the page is not showing. `all` still lists them, because
   * the agent asked what is on the page and a wait has to be able to name an element that has not
   * appeared yet; the working answer leaves them out, because an element nobody can see is not one
   * an action can be delivered to now.
   */
  it("leaves an element nobody can see out of the interactive answer", async () => {
    const nodes = [
      { role: "link", label: "Visible link", targetHandle: "t_link", depth: 2 },
      { role: "link", label: "Hidden link", targetHandle: "t_hidden", hidden: true, depth: 3 },
    ];
    const filtered = await harness(collection({ semanticNodes: nodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "interactive" }),
    );
    expect(filtered.result).toEqual({
      nodes: [{ ref: "t_link", role: "link", name: "Visible link", depth: 2 }],
      truncated: true,
    });

    const all = await harness(collection({ semanticNodes: nodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "all" }),
    );
    expect((all.result as { nodes: unknown[] }).nodes).toEqual([
      { ref: "t_link", role: "link", name: "Visible link", depth: 2 },
      // Named, and nameable: the ref is what a `wait { condition: "present" }` needs (FR-048).
      { ref: "t_hidden", role: "link", name: "Hidden link", depth: 3 },
    ]);
  });

  it("stops at the depth it was asked for", async () => {
    const { runner } = harness(
      collection({
        semanticNodes: [
          { role: "button", label: "Shallow", targetHandle: "t_1", depth: 1 },
          { role: "button", label: "Deep", targetHandle: "t_2", depth: 5 },
        ],
      }),
    );

    const response = await runner.run(request("read_page", { tabId: AGENT_TAB, depth: 2 }));

    expect(response.result).toEqual({
      nodes: [{ ref: "t_1", role: "button", name: "Shallow", depth: 1 }],
      truncated: true,
      // 004/T137b: and says which limit left the rest out, because "truncated" on its own does not
      // tell an agent whether to raise a bound or narrow the read.
      truncatedBy: "depth",
    });
  });

  /**
   * 004/T137b - `filter: "all"` is the read that asks what the page contains, so no depth is put on
   * it that the caller did not ask for. Measured on a real repository page, the default of 15 was
   * returning 86 of 587 elements while calling itself the whole page.
   */
  it("puts no depth on the read that asks for everything", async () => {
    const semanticNodes = [
      { role: "button", label: "Shallow", targetHandle: "t_1", depth: 1 },
      { role: "button", label: "Deep", targetHandle: "t_2", depth: 40 },
    ];

    const all = await harness(collection({ semanticNodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "all" }),
    );
    expect(all.result).toEqual({
      nodes: [
        { ref: "t_1", role: "button", name: "Shallow", depth: 1 },
        { ref: "t_2", role: "button", name: "Deep", depth: 40 },
      ],
      truncated: false,
    });

    // A caller may still name one, and gets exactly that - with the limit that cut it named.
    const bounded = await harness(collection({ semanticNodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB, filter: "all", depth: 2 }),
    );
    expect(bounded.result).toEqual({
      nodes: [{ ref: "t_1", role: "button", name: "Shallow", depth: 1 }],
      truncated: true,
      truncatedBy: "depth",
    });

    // The working read keeps its depth: it is a list of what can be acted on, not the page.
    const working = await harness(collection({ semanticNodes })).runner.run(
      request("read_page", { tabId: AGENT_TAB }),
    );
    expect((working.result as { nodes: unknown[] }).nodes).toEqual([
      { ref: "t_1", role: "button", name: "Shallow", depth: 1 },
    ]);
  });

  it("roots the read at a ref when it is given one", async () => {
    const { runner, collect } = harness(collection({ semanticNodes: [] }));

    await runner.run(request("read_page", { tabId: AGENT_TAB, ref: "t_panel" }));

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ rootTargetHandle: "t_panel", includeDepth: true }),
    );
  });

  /**
   * 003/B1 — a ref for every control (FR-040).
   *
   * The reviewed walk names only what a remote review could act on, so a checkbox, a select and a
   * submit control came back with no ref and the tools that take one could not reach them at all.
   * The agent asks for the wider policy by name; the remote path keeps asking for nothing, which is
   * the default.
   */
  it("asks the page to name every control it can see", async () => {
    const { runner, collect } = harness(collection({ semanticNodes: [] }));

    await runner.run(request("read_page", { tabId: AGENT_TAB }));

    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ mintPolicy: "all-controls" }));
  });

  it("refuses a tab the session does not own, before it reads anything", async () => {
    const { runner, collect } = harness(collection());

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "read_page",
      tabId: 99,
      args: { tabId: 99 },
    });

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(collect).not.toHaveBeenCalled();
  });

  it("answers not-readable for a page this extension may not read (FR-039)", async () => {
    const chromeRef = (globalThis as { chrome?: { tabs: Record<string, unknown> } }).chrome!;
    chromeRef.tabs.get = async () => ({ id: AGENT_TAB, url: "chrome://version" });
    chromeRef.tabs.query = async () => [{ id: AGENT_TAB, url: "chrome://version" }];
    const { runner, collect } = harness(collection());

    const response = await runner.run(request("get_page_text", { tabId: AGENT_TAB }));

    expect(response).toEqual({ callId: "call-1", outcome: "not-readable", reason: "not-actionable" });
    expect(collect).not.toHaveBeenCalled();
  });

  it("answers not-readable, not stale, for the extension's own page (SC-027, FR-039)", async () => {
    const chromeRef = (globalThis as { chrome?: { tabs: Record<string, unknown> } }).chrome!;
    const url = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/side-panel.html";
    chromeRef.tabs.get = async () => ({ id: AGENT_TAB, url });
    chromeRef.tabs.query = async () => [{ id: AGENT_TAB, url }];
    const { runner, collect } = harness(collection());

    const response = await runner.run(request("get_page_text", { tabId: AGENT_TAB }));

    expect(response).toEqual({ callId: "call-1", outcome: "not-readable", reason: "not-actionable" });
    expect(collect).not.toHaveBeenCalled();
  });

  it("refuses arguments the contract does not declare", async () => {
    const { runner } = harness(collection());

    const response = await runner.run(request("read_page", { tabId: AGENT_TAB, filter: "visible" }));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments" });
  });
});
