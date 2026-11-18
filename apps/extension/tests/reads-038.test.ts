import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";

/**
 * 038 T1078 - `filter: "interactive"` keeps the menu-item and tree-item roles (FR-567): a page that
 * builds a menu out of `li[role=menuitemradio]` has controls a person would act on, and the working
 * read must list them.
 */
const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";

type Collected = Awaited<ReturnType<typeof import("../src/service-worker/content-broker.js").collectFromActiveTab>>;

function request(args: Record<string, unknown>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-h1", tool: "read_page", tabId: AGENT_TAB, args };
}

describe("038 FR-567 interactive filter keeps widget roles", () => {
  beforeEach(() => {
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: { async executeScript() {} },
      tabs: {
        async get() {
          return { id: AGENT_TAB, url: `${SITE}/popover-038` };
        },
        async query() {
          return [{ id: AGENT_TAB, url: `${SITE}/popover-038` }];
        },
        async sendMessage() {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("lists menuitemradio, menuitemcheckbox and treeitem nodes", async () => {
    const collected = {
      tabId: AGENT_TAB,
      contextHandle: "snap-1",
      documentEpoch: "doc-1",
      canonicalOrigin: SITE,
      formValueItems: [],
      semanticNodes: [
        { role: "menuitemradio", label: "Custom", targetHandle: "t_radio", depth: 3 },
        { role: "menuitemcheckbox", label: "Wrap", targetHandle: "t_check", depth: 3 },
        { role: "treeitem", label: "src", targetHandle: "t_tree", depth: 3 },
        { role: "listitem", label: "Plain", targetHandle: "t_li", depth: 3 },
      ],
    } as Collected;
    const runner = createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
      collect: vi.fn(async () => collected) as unknown as typeof import("../src/service-worker/content-broker.js").collectFromActiveTab,
    });

    const response = await runner.run(request({ tabId: AGENT_TAB, filter: "interactive" }));

    expect((response.result as { nodes: Array<{ role: string }> }).nodes.map((node) => node.role)).toEqual([
      "menuitemradio",
      "menuitemcheckbox",
      "treeitem",
    ]);
  });
});
