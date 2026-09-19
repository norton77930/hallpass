import { afterEach, describe, expect, it } from "vitest";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { testInputAttachments } from "./helpers/input-attachments.js";

/**
 * 005/T173 - the worker carries a field's state to the agent, for both read tools and across the
 * frame merge (US1 scenario 8, FR-072, FR-073).
 *
 * The collection is faked at the message seam with the fields the page side now emits (T171); what
 * this proves is the projection in `reads.ts` and the description map in `refs.ts` passing them
 * through, and `frames.ts`'s flatten keeping them on a node that came from a child document.
 */

const TAB = 7;
const ORIGIN = "https://fixtures.test:19443";
const TOP_URL = `${ORIGIN}/form-values`;

const DOCUMENTS: Record<number, { url: string; epoch: string; nodes: unknown[] }> = {
  0: {
    url: TOP_URL,
    epoch: "doc-top",
    nodes: [
      { role: "textbox", label: "Name", targetHandle: "t_name", depth: 1, type: "text", value: "Ada" },
      { role: "textbox", label: "Secret", targetHandle: "t_secret", depth: 1, type: "password", redacted: true },
      { role: "checkbox", label: "Terms", targetHandle: "t_terms", depth: 1, type: "checkbox", checked: false },
      // A page that lies - a value beside `redacted`, a value beside `checked` - is a page whose
      // value the worker must still not carry; the contract refuses the shape, so the broker drops it.
      { role: "textbox", label: "Lying secret", targetHandle: "t_lie", depth: 1, redacted: true, value: "hunter2" },
      { role: "checkbox", label: "Lying toggle", targetHandle: "t_lie2", depth: 1, checked: true, value: "on" },
      { role: "combobox", label: "Size", targetHandle: "t_size", depth: 1, options: ["Small", "Large"], value: "Large" },
      { role: "iframe", label: "child", targetHandle: "t_child", depth: 1, frameOwner: true },
    ],
  },
  11: {
    url: `${ORIGIN}/form-values-child`,
    epoch: "doc-child",
    nodes: [
      { role: "textbox", label: "Notes", targetHandle: "t_notes", depth: 1, value: "x".repeat(80), valueTruncated: true },
      { role: "radio", label: "Large", targetHandle: "t_radio", depth: 1, type: "radio", checked: true },
    ],
  },
};

const PATHS: Record<number, number[]> = { 0: [], 11: [0] };

function installChrome(framed: boolean): void {
  const documents: Record<number, (typeof DOCUMENTS)[number]> = framed ? DOCUMENTS : { 0: DOCUMENTS[0]! };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    scripting: {
      async executeScript(input: { func?: unknown }) {
        if (input.func === undefined) return [];
        return Object.entries(documents).map(([id, document]) => ({
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
        const frameId = options?.frameId ?? 0;
        const document = documents[frameId];
        if (!document) throw new Error("Could not establish connection. Receiving end does not exist.");
        if (frame.type === "content.probe") return { documentEpoch: document.epoch, canonicalOrigin: ORIGIN };
        if (frame.type === "content.collect-page") {
          return {
            contextHandle: `snap-${frameId}`,
            documentEpoch: document.epoch,
            canonicalOrigin: ORIGIN,
            semanticNodes: document.nodes,
            formValueItems: [],
          };
        }
        if (frame.type === "content.resolve-target") {
          const payload = frame.payload as { description: string };
          const candidates = document.nodes
            .filter((node) => (node as { label?: string }).label === payload.description)
            .map((node) => ({ targetHandle: (node as { targetHandle: string }).targetHandle }));
          if (candidates.length === 0) return { ok: true, outcome: "no-match" };
          return { ok: true, outcome: "resolved", candidates };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function reads() {
  return createAgentReads({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    tabOwnership: async () => ({ state: "this" }),
  });
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

type Node = Record<string, unknown> & { name?: string };

async function readPage(): Promise<Node[]> {
  const response = await reads().run({
    callId: "call-read",
    sessionId: "session-fields",
    tool: "read_page",
    tabId: TAB,
    args: { tabId: TAB },
  });
  expect(response.outcome).toBe("ok");
  return (response.result as { nodes: Node[] }).nodes;
}

function named(nodes: Node[], name: string): Node | undefined {
  return nodes.find((node) => node.name === name);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("T173 read_page carries field state", () => {
  it("passes value, checked and redacted through on a page of one document", async () => {
    installChrome(false);

    const nodes = await readPage();

    expect(named(nodes, "Name")).toMatchObject({ type: "text", value: "Ada" });
    expect(named(nodes, "Secret")).toMatchObject({ redacted: true });
    expect(named(nodes, "Secret")).not.toHaveProperty("value");
    expect(named(nodes, "Terms")).toMatchObject({ checked: false });
    expect(named(nodes, "Size")).toMatchObject({ options: ["Small", "Large"], value: "Large" });
    expect(named(nodes, "Lying secret")).toEqual({ ref: "t_lie", role: "textbox", name: "Lying secret", depth: 1, redacted: true });
    expect(named(nodes, "Lying toggle")).toEqual({ ref: "t_lie2", role: "checkbox", name: "Lying toggle", depth: 1, checked: true });
    expect(JSON.stringify(nodes)).not.toContain("hunter2");
  });

  it("keeps them on nodes that came through the frame merge", async () => {
    installChrome(true);

    const nodes = await readPage();

    expect(named(nodes, "Notes")).toMatchObject({ frame: "f1", value: "x".repeat(80), valueTruncated: true });
    expect(named(nodes, "Large")).toMatchObject({ frame: "f1", checked: true });
    expect(named(nodes, "Name")).toMatchObject({ frame: "0", value: "Ada" });
  });
});

describe("T173 find carries the same field state", () => {
  async function find(query: string) {
    const response = await effects().run({
      callId: "call-find",
      sessionId: "session-fields",
      tool: "find",
      tabId: TAB,
      args: { tabId: TAB, query },
    });
    expect(response.outcome).toBe("ok");
    return response.result as { outcome: string; matches: Node[] };
  }

  it("answers a match with what the field holds, and a secret as redacted", async () => {
    installChrome(false);

    expect((await find("Name")).matches).toEqual([{ ref: "t_name", role: "textbox", label: "Name", value: "Ada" }]);
    expect((await find("Secret")).matches).toEqual([
      { ref: "t_secret", role: "textbox", label: "Secret", redacted: true },
    ]);
    expect((await find("Terms")).matches).toEqual([{ ref: "t_terms", role: "checkbox", label: "Terms", checked: false }]);
  });

  it("carries them for a match found in a child frame", async () => {
    installChrome(true);

    expect((await find("Notes")).matches).toEqual([
      { ref: "t_notes", role: "textbox", label: "Notes", frame: "f1", value: "x".repeat(80), valueTruncated: true },
    ]);
  });
});
