/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_READ_PAGE_MAX_NODES, type AgentNativeRequest } from "@hallpass/contracts";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T134 - what one read is worth (US6, R-116, D-004-5, FR-064, FR-067, FR-068).
 *
 * A read that names an element without saying where its link goes, what a control accepts or what a
 * select offers is a read the agent has to follow with another one; a read that stops at 200 nodes
 * is a read of a different, smaller page than the one on screen. So four questions, each about a
 * different half of the same claim - the answer is the page:
 *
 * - the fields an agent chooses on, carried by the node that names the element;
 * - the elements a page built inside an *open* shadow root, which are page content the same way
 *   the light DOM is, and the ones behind a *closed* root, which the page has said nobody may see;
 * - the viewport filter: the working list is what is on screen now, which is a different question
 *   from whether the browser renders the element at all;
 * - capacity: the page-wide ceilings, and an answer that says *which* one it ran out of.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;

function collect(registry = new TargetRegistry()) {
  return collectPage({
    snapshotId: "snapshot-1",
    documentEpoch: "doc-1",
    origin: "https://example.test",
    requested: ["page.structure", "page.target-metadata"],
    formGrantActive: false,
    generalGrantActive: true,
    bounds: TEST_COLLECTION_BOUNDS,
    mintPolicy: "all-controls",
    registry,
  });
}

type CollectedNode = NonNullable<ReturnType<typeof collectPage>["semanticNodes"]>[number];

function nodesOf(): CollectedNode[] {
  return collect().semanticNodes ?? [];
}

function withRole(nodes: CollectedNode[], role: string): CollectedNode | undefined {
  return nodes.find((node) => node.role === role);
}

/** A box the browser would have measured; jsdom has no layout, so the fixture supplies one. */
function measure(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }) as DOMRect;
}

describe("T134 the fields a node carries", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("gives a link its destination, a control its type and placeholder, and a select its options", () => {
    document.body.innerHTML = [
      '<a href="/pricing">Pricing</a>',
      '<input type="email" placeholder="you@example.test">',
      "<select><option>Bronze</option><option>Silver</option></select>",
    ].join("");

    const nodes = nodesOf();

    // The destination is what lets an agent decide about a link without navigating to find out.
    expect(withRole(nodes, "link")?.href).toMatch(/\/pricing$/);
    // The type is what makes a textbox answerable: `email` is not a free-text field.
    expect(withRole(nodes, "textbox")?.type).toBe("email");
    expect(withRole(nodes, "textbox")?.placeholder).toBe("you@example.test");
    // A select's choices, in the words the agent would have to name one of them by.
    expect(withRole(nodes, "combobox")?.options).toEqual(["Bronze", "Silver"]);
  });
});

describe("T134 shadow roots (D-004-5)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("lists a control inside an open shadow root and none from a closed one", () => {
    const open = document.createElement("div");
    const closed = document.createElement("div");
    document.body.append(open, closed);
    open.attachShadow({ mode: "open" }).innerHTML = '<button aria-label="open-root-save">Save</button>';
    closed.attachShadow({ mode: "closed" }).innerHTML = '<button aria-label="closed-root-save">Save</button>';

    const labels = nodesOf().map((node) => node.label);

    // An open root is page content: the page published it, and a walker that stopped at the host
    // would report a page with no controls on it at all.
    expect(labels).toContain("open-root-save");
    // A closed root is the page saying nobody may look. The extension has an API that would open it
    // anyway and deliberately does not use it, so the control is simply not there to be named.
    expect(labels).not.toContain("closed-root-save");
  });
});

describe("T134 the viewport filter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("marks a rendered element whose box is outside the viewport", () => {
    document.body.innerHTML =
      '<button aria-label="on-screen">A</button><button aria-label="far-below">B</button>';
    const [onScreen, farBelow] = Array.from(document.querySelectorAll("button"));
    measure(onScreen!, { x: 10, y: 20, width: 80, height: 30 });
    measure(farBelow!, { x: 10, y: window.innerHeight + 400, width: 80, height: 30 });

    const nodes = nodesOf();

    // Rendered, and nowhere near the screen: a different fact from "the browser is not drawing it",
    // and the only one an agent acting on what it can see cares about.
    expect(nodes.find((node) => node.label === "far-below")?.offscreen).toBe(true);
    expect(nodes.find((node) => node.label === "on-screen")?.offscreen).toBeUndefined();
    expect((nodes.find((node) => node.label === "far-below") as { hidden?: boolean }).hidden).toBeUndefined();
  });
});

type Collected = Awaited<ReturnType<typeof import("../src/service-worker/content-broker.js").collectFromActiveTab>>;

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
        if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function collection(semanticNodes: unknown[]): Collected {
  return {
    tabId: AGENT_TAB,
    contextHandle: "snap-1",
    documentEpoch: "doc-1",
    canonicalOrigin: SITE,
    formValueItems: [],
    semanticNodes,
  } as unknown as Collected;
}

function harness(collected: Collected) {
  const collect = vi.fn(async () => collected);
  const runner = createAgentReads({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    collect: collect as unknown as typeof import("../src/service-worker/content-broker.js").collectFromActiveTab,
  });
  return { runner, collect };
}

function request(args: Record<string, unknown>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-f1", tool: "read_page", tabId: AGENT_TAB, args: { tabId: AGENT_TAB, ...args } };
}

function readNode(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "button", label: `control-${index}`, targetHandle: `t-${index}`, depth: 1, ...overrides };
}

describe("T134 what the interactive read keeps, and what a read may cost", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it("keeps only viewport-intersecting nodes, and `all` keeps everything", async () => {
    const { runner } = harness(
      collection([readNode(1), readNode(2, { offscreen: true })]),
    );

    const working = await runner.run(request({}));
    const whole = await runner.run(request({ filter: "all" }));

    const workingResult = (working as { result: { nodes: Array<{ name?: string }>; truncated: boolean } }).result;
    const wholeResult = (whole as { result: { nodes: Array<{ name?: string }> } }).result;
    expect(workingResult.nodes.map((node) => node.name)).toEqual(["control-1"]);
    // Something was left out, and a read that did not say so would be a partial page under the
    // word for the whole of it.
    expect(workingResult.truncated).toBe(true);
    expect(wholeResult.nodes.map((node) => node.name)).toEqual(["control-1", "control-2"]);
  });

  it("carries the fields through to the answer", async () => {
    const { runner } = harness(
      collection([
        readNode(1, { role: "link", href: "https://example.test/pricing" }),
        readNode(2, { role: "textbox", type: "email", placeholder: "you@example.test" }),
        readNode(3, { role: "combobox", options: ["Bronze", "Silver"] }),
      ]),
    );

    const answer = await runner.run(request({}));

    const nodes = (answer as { result: { nodes: Array<Record<string, unknown>> } }).result.nodes;
    expect(nodes[0]?.href).toBe("https://example.test/pricing");
    expect(nodes[1]?.type).toBe("email");
    expect(nodes[1]?.placeholder).toBe("you@example.test");
    expect(nodes[2]?.options).toEqual(["Bronze", "Silver"]);
  });

  it("answers past the remote path's 200 nodes; the page's ceiling is the only one", async () => {
    const { runner, collect } = harness(
      collection(Array.from({ length: 300 }, (_, index) => readNode(index))),
    );

    const answer = await runner.run(request({}));

    const result = (answer as { result: { nodes: unknown[]; truncated: boolean } }).result;
    expect(result.nodes).toHaveLength(300);
    expect(result.truncated).toBe(false);
    // The collection itself has to be allowed to bring back that many, or the ceiling above it
    // would never be the one that decided anything.
    expect((collect.mock.calls[0] as unknown[])[0]).toMatchObject({
      bounds: expect.objectContaining({ maxSemanticNodes: AGENT_READ_PAGE_MAX_NODES }),
    });
  });

  it("says which limit it ran out of: the node ceiling", async () => {
    const { runner } = harness(
      // Single-character names, so it is the node ceiling that runs out and not the character one.
      collection(
        Array.from({ length: AGENT_READ_PAGE_MAX_NODES + 5 }, (_, index) => readNode(index, { label: "c" })),
      ),
    );

    const answer = await runner.run(request({}));

    const result = (answer as { result: { nodes: unknown[]; truncated: boolean; truncatedBy?: string } }).result;
    expect(result.nodes).toHaveLength(AGENT_READ_PAGE_MAX_NODES);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("nodes");
  });

  it("says which limit it ran out of: the caller's character bound", async () => {
    const { runner } = harness(
      collection(Array.from({ length: 50 }, (_, index) => readNode(index, { label: "x".repeat(40) }))),
    );

    const answer = await runner.run(request({ max_chars: 120 }));

    const result = (answer as { result: { nodes: unknown[]; truncated: boolean; truncatedBy?: string } }).result;
    expect(result.nodes.length).toBeLessThan(50);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("chars");
  });

  it("goes fifteen levels deep unless the caller asks for more", async () => {
    const { runner } = harness(
      collection([readNode(1, { depth: 15 }), readNode(2, { depth: 16 })]),
    );

    const shallow = await runner.run(request({}));
    const deep = await runner.run(request({ depth: 20 }));

    expect((shallow as { result: { nodes: unknown[] } }).result.nodes).toHaveLength(1);
    expect((deep as { result: { nodes: unknown[] } }).result.nodes).toHaveLength(2);
  });
});
