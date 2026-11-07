import { afterEach, describe, expect, it } from "vitest";
import { collectFromActiveTab } from "../src/service-worker/content-broker.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { TEST_NONCE } from "./helpers/content-frames.js";
import { testInputAttachments } from "./helpers/input-attachments.js";

/**
 * 004/T115 — the wiring that makes a framed page one read (US4 read half, R-114).
 *
 * The merge and the collector's frame facts are already tested on their own (T112, T114); what is
 * missing until this file is green is the seam between them: the worker asking a *named* frame, and
 * the read tool going through the merge instead of the top document alone.
 *
 * The page modelled here is `tests/e2e/fixtures/pages/frames.html`: a top document, a same-origin
 * child that itself frames a grandchild, and a child on a **second origin**. The cross-origin child
 * is the whole point - it is the shape the artifact page has, and the one a per-tab origin check
 * would quietly file as `no-answer` while the answer still looked like the merge working.
 */

const TAB = 7;
const TOP_ORIGIN = "https://fixtures.test:19443";
const CROSS_ORIGIN = "https://embed.test:19444";
const TOP_URL = `${TOP_ORIGIN}/frames`;

/** The four documents, keyed by the browser frame id the enumeration reports for each. */
const DOCUMENTS: Record<number, { url: string; origin: string; epoch: string; text: string; nodes: unknown[] }> = {
  0: {
    url: TOP_URL,
    origin: TOP_ORIGIN,
    epoch: "doc-top",
    text: "Top text",
    nodes: [
      { role: "iframe", label: "same-origin child", targetHandle: "t_same", depth: 1, frameOwner: true },
      { role: "iframe", label: "cross-origin child", targetHandle: "t_cross", depth: 1, frameOwner: true },
      { role: "button", label: "Top action", targetHandle: "t_top_btn", depth: 1 },
    ],
  },
  11: {
    url: `${TOP_ORIGIN}/frames-child`,
    origin: TOP_ORIGIN,
    epoch: "doc-same",
    text: "Child text",
    nodes: [
      { role: "button", label: "Child action", targetHandle: "t_same_btn", depth: 1 },
      { role: "iframe", label: "grandchild", targetHandle: "t_grand", depth: 1, frameOwner: true },
    ],
  },
  12: {
    url: `${CROSS_ORIGIN}/frames-child`,
    origin: CROSS_ORIGIN,
    epoch: "doc-cross",
    text: "Cross text",
    nodes: [{ role: "button", label: "Cross action", targetHandle: "t_cross_btn", depth: 1 }],
  },
  13: {
    url: `${TOP_ORIGIN}/frames-grandchild`,
    origin: TOP_ORIGIN,
    epoch: "doc-grand",
    text: "Grandchild text",
    nodes: [{ role: "button", label: "Grandchild action", targetHandle: "t_grand_btn", depth: 1 }],
  },
};

/** The index chain each document reports for itself, which is what the enumerator matches up. */
const PATHS: Record<number, number[]> = { 0: [], 11: [0], 12: [1], 13: [0, 0] };

type Sent = { frameId: number | undefined; type: string };

type ProbeSender = { origin?: string; frameId?: number; documentId?: string; tab?: { id?: number } };
type ProbeListener = (message: unknown, sender: ProbeSender) => unknown;

function installChrome(
  options: {
    /**
     * 030/T902: the origin the browser attaches to each frame's site-probe message, by frame id.
     * By default the frame's own origin.
     */
    senders?: Record<number, { origin: string }>;
  } = {},
): { sent: Sent[]; probed: number[] } {
  const sent: Sent[] = [];
  const probed: number[] = [];
  const listeners = new Set<ProbeListener>();
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      onMessage: {
        addListener: (listener: ProbeListener) => listeners.add(listener),
        removeListener: (listener: ProbeListener) => listeners.delete(listener),
      },
    },
    scripting: {
      async executeScript(input: { func?: unknown; target: { allFrames?: boolean; frameIds?: number[] }; args?: unknown[] }) {
        if (input.func === undefined) return [];
        const probedFrame = input.target.frameIds?.[0];
        if (probedFrame !== undefined) {
          // The sender probe (`probeFrameSender`): the frame sends one message carrying the nonce,
          // and the browser attaches the sender below to it - never anything the frame wrote.
          probed.push(probedFrame);
          const document = DOCUMENTS[probedFrame];
          if (!document) throw new Error("No frame with id");
          const origin = options.senders?.[probedFrame]?.origin ?? document.origin;
          const documentId = `bdoc-${probedFrame}`;
          const [key, nonce] = input.args as [string, string];
          const sender = { origin, frameId: probedFrame, documentId, tab: { id: TAB } };
          queueMicrotask(() => {
            for (const listener of [...listeners]) listener({ [key]: nonce }, sender);
          });
          return [{ frameId: probedFrame, documentId, result: true }];
        }
        // The all-frames execution the enumerator is built on: one result per frame, each carrying
        // the frame's own id and the chain it reports for itself.
        return Object.entries(DOCUMENTS).map(([id, document]) => ({
          frameId: Number(id),
          result: { url: document.url, path: PATHS[Number(id)] },
        }));
      },
    },
    tabs: {
      async get(tabId: number) {
        if (tabId !== TAB) throw new Error("No tab with id");
        return { id: TAB, url: TOP_URL };
      },
      async query() {
        return [{ id: TAB, url: TOP_URL }];
      },
      async sendMessage(_tabId: number, message: unknown, options?: { frameId?: number }) {
        const frame = message as { type: string; payload: Record<string, unknown> };
        const frameId = options?.frameId;
        sent.push({ frameId, type: frame.type });
        const document = frameId === undefined ? undefined : DOCUMENTS[frameId];
        if (!document) throw new Error("Could not establish connection. Receiving end does not exist.");
        if (frame.type === "content.probe") {
          return { documentEpoch: document.epoch, canonicalOrigin: document.origin };
        }
        if (frame.type === "content.collect-page") {
          return {
            contextHandle: `snap-${frameId}`,
            documentEpoch: document.epoch,
            canonicalOrigin: document.origin,
            visibleText: document.text,
            semanticNodes: document.nodes,
            formValueItems: [],
          };
        }
        if (frame.type === "content.resolve-target") {
          // The runtime's own rule, per document: every node whose label carries the description,
          // and `too-broad` once there are more of them than the caller asked for.
          const payload = frame.payload as { description: string; maxCandidates: number };
          const candidates = document.nodes
            .filter((node) =>
              String((node as { label?: unknown }).label ?? "")
                .toLowerCase()
                .includes(payload.description.toLowerCase()),
            )
            .map((node) => ({ targetHandle: (node as { targetHandle: string }).targetHandle }));
          if (candidates.length === 0) return { ok: true, outcome: "no-match" };
          if (candidates.length > payload.maxCandidates) return { ok: true, outcome: "too-broad" };
          return { ok: true, outcome: "resolved", candidates };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
  return { sent, probed };
}

function collectArgs(frameId: number | undefined): Parameters<typeof collectFromActiveTab>[0] {
  return {
    taskId: "task-frames",
    operationId: "op-frames",
    runtimeEpochId: "epoch-1",
    nonce: TEST_NONCE,
    requested: ["page.structure", "page.target-metadata"],
    generalGrantActive: true,
    generalPageReadGrantId: "grant-frames",
    formGrantActive: false,
    includeDepth: true,
    includeFrameFacts: true,
    tab: TAB,
    ...(frameId === undefined ? {} : { frameId }),
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("T115 per-frame delivery", () => {
  it("addresses the probe and the collection to the frame it was asked for", async () => {
    const { sent } = installChrome();

    const collected = await collectFromActiveTab(collectArgs(11));

    expect(collected.documentEpoch).toBe("doc-same");
    expect(sent).toEqual([
      { frameId: 11, type: "content.probe" },
      { frameId: 11, type: "content.collect-page" },
    ]);
  });

  it("carries the frame facts the merge splices on, and only when asked for them", async () => {
    installChrome();

    const withFacts = await collectFromActiveTab(collectArgs(0));
    expect(withFacts.semanticNodes?.[0]).toMatchObject({ role: "iframe", frameOwner: true });

    const without = await collectFromActiveTab({ ...collectArgs(0), includeFrameFacts: false });
    expect(without.semanticNodes?.[0]).not.toHaveProperty("frameOwner");
  });

  /**
   * The origin check is per-document, not per-tab: what it catches is a document being replaced
   * under us between the probe and the read, and the frame that answers a probe is the one that
   * has to still be there at the read. A cross-origin child never had the tab's origin and never
   * will, so a tab-wide comparison would reject it for being exactly what it is.
   */
  it("binds a cross-origin child frame to its own origin", async () => {
    installChrome();

    const collected = await collectFromActiveTab(collectArgs(12));

    expect(collected.canonicalOrigin).toBe(CROSS_ORIGIN);
  });

  it("still refuses a top frame that answers for another origin", async () => {
    installChrome();
    const chrome = (globalThis as { chrome: { tabs: { sendMessage: unknown } } }).chrome;
    chrome.tabs.sendMessage = async () => ({ documentEpoch: "doc-top", canonicalOrigin: CROSS_ORIGIN });

    await expect(collectFromActiveTab(collectArgs(0))).rejects.toThrow();
  });
});

describe("T115 read_page over frames", () => {
  it("returns every readable frame's controls, each labelled with its frame", async () => {
    installChrome();
    const runner = createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
    });

    const response = await runner.run({
      callId: "call-frames",
      sessionId: "session-frames",
      tool: "read_page",
      tabId: TAB,
      args: { tabId: TAB },
    });

    const result = response.result as {
      frames: Array<{ frame: string; url: string; readable: boolean; reason?: string }>;
      nodes: Array<{ name?: string; frame?: string }>;
    };
    expect(response.outcome).toBe("ok");
    // Tree order: the top document, then its first child, that child's own child, then the second.
    expect(result.frames.map((frame) => [frame.frame, frame.readable, frame.reason])).toEqual([
      ["0", true, undefined],
      ["f1", true, undefined],
      ["f2", true, undefined],
      ["f3", true, undefined],
    ]);
    // A working read keeps the interactive roles, so the iframe elements themselves are not in the
    // answer; their documents' content follows the document that holds them, in frame order.
    expect(result.nodes.map((node) => [node.name, node.frame])).toEqual([
      ["Top action", "0"],
      ["Child action", "f1"],
      ["Grandchild action", "f2"],
      ["Cross action", "f3"],
    ]);
    // The cross-origin child is read, not listed as the frame that said nothing.
    expect(result.frames.find((frame) => frame.url.startsWith(CROSS_ORIGIN))).toMatchObject({
      readable: true,
    });
  });
});

describe("T115 get_page_text over frames", () => {
  function reads() {
    return createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
    });
  }

  function textRequest() {
    return {
      callId: "call-text",
      sessionId: "session-frames",
      tool: "get_page_text" as const,
      tabId: TAB,
      args: { tabId: TAB },
    };
  }

  it("concatenates every readable frame's text in frame order", async () => {
    installChrome();

    const response = await reads().run(textRequest());

    expect(response.outcome).toBe("ok");
    // The frame order the structural read lists: the top document, its first child, that child's
    // own child, then the second child. The text read carries no frame list - the structured read
    // is where frame accounting belongs - so the order is the only thing that says where it came
    // from, and it is the order a person reads the page in.
    expect(response.result).toEqual({
      text: "Top text\nChild text\nGrandchild text\nCross text",
      truncated: false,
    });
  });

  /**
   * A frame that says nothing contributes nothing - and the read still succeeds, because "part of
   * this page is unreadable" and "this page is unreadable" send an agent to two different moves.
   * The text result has no frame list to say which part went missing, so `truncated` is the one
   * channel it has for "this is not all of the page".
   */
  it("succeeds without a frame that could not answer, and says the text is not all of the page", async () => {
    installChrome();
    type Send = (tabId: number, message: unknown, options?: { frameId?: number }) => Promise<unknown>;
    const tabs = (globalThis as unknown as { chrome: { tabs: { sendMessage: Send } } }).chrome.tabs;
    const inner = tabs.sendMessage;
    // The cross-origin child has nobody listening and nobody who can be injected: the shape S2
    // established as indistinguishable from a frame that simply stayed silent.
    tabs.sendMessage = async (tabId, message, options) => {
      if (options?.frameId === 12) throw new Error("Could not establish connection. Receiving end does not exist.");
      return inner(tabId, message, options);
    };

    const response = await reads().run(textRequest());

    expect(response.outcome).toBe("ok");
    expect(response.result).toEqual({
      text: "Top text\nChild text\nGrandchild text",
      truncated: true,
    });
  });
});

describe("T115 find over frames", () => {
  function findRequest(query: string) {
    return {
      callId: "call-find",
      sessionId: "session-frames",
      tool: "find" as const,
      tabId: TAB,
      args: { tabId: TAB, query },
    };
  }

  function effects() {
    return createAgentEffects({
      context: testSessionContexts(),
      siteModes: createSiteModeStore(),
      bindings: createAgentPageBindings(),
      prompts: createAgentPromptController({ timeoutMs: 60 }),
      attachments: testInputAttachments().attachments,
      tabOwnership: async () => ({ state: "this" }),
    });
  }

  it("resolves a description that only exists inside a child frame, and says which frame", async () => {
    installChrome();

    const response = await effects().run(findRequest("Grandchild action"));

    expect(response.outcome).toBe("ok");
    expect(response.result).toEqual({
      outcome: "resolved",
      matches: [{ ref: "t_grand_btn", role: "button", label: "Grandchild action", frame: "f2" }],
    });
  });

  /**
   * The "too broad" rule is the product refusing to choose between several elements, and an agent
   * holding one answer for the page cannot have that refusal decided a frame at a time: one match
   * in each of four frames is four elements it would have to pick between, exactly the situation
   * the rule exists for.
   */
  it("applies the too-broad rule across the merged match set", async () => {
    installChrome();

    const response = await effects().run(findRequest("action"));

    expect(response.result).toEqual({ outcome: "too-broad", matches: [] });
  });
});

/**
 * 030/T902 (FR-462, R-448) - reads name the site of each frame, from the browser.
 *
 * Each child frame's site is the origin the browser attaches to one message the frame sends
 * (`probeFrameSender`, R-440 as measured in T886); the frame's own report is never read for it.
 * The top frame is the page's site. A node or a `find` match carries `site` only when its frame's
 * differs from the page's, so a page whose frames all share its site reads as it did before.
 */
describe("030 read labels", () => {
  function reads() {
    return createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
    });
  }

  type ReadResult = {
    frames: Array<{ frame: string; site: string }>;
    nodes: Array<{ name?: string; frame?: string; site?: string }>;
  };

  async function readPage(): Promise<ReadResult> {
    const response = await reads().run({
      callId: "call-sites",
      sessionId: "session-frames",
      tool: "read_page",
      tabId: TAB,
      args: { tabId: TAB },
    });
    expect(response.outcome).toBe("ok");
    return response.result as ReadResult;
  }

  it("lists each frame with the site the browser gives it, and marks the nodes from another site", async () => {
    const { probed } = installChrome();

    const result = await readPage();

    expect(result.frames.map((frame) => [frame.frame, frame.site])).toEqual([
      ["0", TOP_ORIGIN],
      ["f1", TOP_ORIGIN],
      ["f2", TOP_ORIGIN],
      ["f3", CROSS_ORIGIN],
    ]);
    expect(result.nodes.map((node) => [node.name, node.frame, node.site])).toEqual([
      ["Top action", "0", undefined],
      ["Child action", "f1", undefined],
      ["Grandchild action", "f2", undefined],
      ["Cross action", "f3", CROSS_ORIGIN],
    ]);
    expect(result.nodes.filter((node) => "site" in node)).toHaveLength(1);
    // The top frame is the page's site and is never probed; every child frame is, once.
    expect([...probed].sort()).toEqual([11, 12, 13]);
  });

  it("takes the site from the browser, never from what the frame says about itself", async () => {
    // Frame 11 reports the page's origin for itself while the browser attributes its message to
    // another site; frame 13 is sandboxed, so the browser gives it an opaque origin.
    installChrome({ senders: { 11: { origin: CROSS_ORIGIN }, 13: { origin: "null" } } });

    const result = await readPage();

    expect(result.frames.map((frame) => [frame.frame, frame.site])).toEqual([
      ["0", TOP_ORIGIN],
      ["f1", CROSS_ORIGIN],
      ["f2", "unknown"],
      ["f3", CROSS_ORIGIN],
    ]);
    expect(result.nodes.map((node) => [node.name, node.site])).toEqual([
      ["Top action", undefined],
      ["Child action", CROSS_ORIGIN],
      ["Grandchild action", "unknown"],
      ["Cross action", CROSS_ORIGIN],
    ]);
  });

  it("reads a page whose frames all share its site exactly as before", async () => {
    installChrome({ senders: { 12: { origin: TOP_ORIGIN } } });

    const response = await reads().run({
      callId: "call-sites",
      sessionId: "session-frames",
      tool: "read_page",
      tabId: TAB,
      args: { tabId: TAB },
    });

    // The nodes are the 004 answer to the byte (the working list leaves the iframe owners out, so
    // each frame's block follows its parent's at the parent's depth); only the frame list is new.
    const before = [
      { ref: "t_top_btn", role: "button", name: "Top action", depth: 1, frame: "0" },
      { ref: "t_same_btn", role: "button", name: "Child action", depth: 1, frame: "f1" },
      { ref: "t_grand_btn", role: "button", name: "Grandchild action", depth: 1, frame: "f2" },
      { ref: "t_cross_btn", role: "button", name: "Cross action", depth: 1, frame: "f3" },
    ];
    expect(JSON.stringify((response.result as { nodes: unknown }).nodes)).toBe(JSON.stringify(before));
    expect(response).toEqual({
      callId: "call-sites",
      outcome: "ok",
      result: {
        frames: [
          { frame: "0", parent: "0", url: TOP_URL, site: TOP_ORIGIN, readable: true },
          { frame: "f1", parent: "0", url: `${TOP_ORIGIN}/frames-child`, site: TOP_ORIGIN, readable: true },
          { frame: "f2", parent: "f1", url: `${TOP_ORIGIN}/frames-grandchild`, site: TOP_ORIGIN, readable: true },
          { frame: "f3", parent: "0", url: `${CROSS_ORIGIN}/frames-child`, site: TOP_ORIGIN, readable: true },
        ],
        nodes: before,
        truncated: true,
      },
    });
  });

  it("marks a find match inside another site's frame with that site, and a same-site one with none", async () => {
    installChrome();
    const runner = createAgentEffects({
      context: testSessionContexts(),
      siteModes: createSiteModeStore(),
      bindings: createAgentPageBindings(),
      prompts: createAgentPromptController({ timeoutMs: 60 }),
      attachments: testInputAttachments().attachments,
      tabOwnership: async () => ({ state: "this" }),
    });
    const find = (query: string) =>
      runner.run({ callId: "call-find", sessionId: "session-frames", tool: "find", tabId: TAB, args: { tabId: TAB, query } });

    expect((await find("Cross action")).result).toEqual({
      outcome: "resolved",
      matches: [{ ref: "t_cross_btn", role: "button", label: "Cross action", frame: "f3", site: CROSS_ORIGIN }],
    });
    expect((await find("Grandchild action")).result).toEqual({
      outcome: "resolved",
      matches: [{ ref: "t_grand_btn", role: "button", label: "Grandchild action", frame: "f2" }],
    });
  });
});
