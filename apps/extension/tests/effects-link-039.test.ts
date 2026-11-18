import { describe, expect, it } from "vitest";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createTargetLocator } from "../src/service-worker/agent-tools/effects.js";
import type { FrameOffsets } from "../src/service-worker/agent-tools/frames.js";

/**
 * 039 T1096 - the locator's link flag comes from the node's own role or from the collection's `inLink`
 * (FR-571, R-549): a point click lands on the span inside an `<a href>`, whose own role is not `link`.
 */
const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/link-039`;
const RECT = { x: 1, y: 2, width: 3, height: 4 };

async function located(node: Record<string, unknown>) {
  const locate = createTargetLocator({
    offsets: {} as FrameOffsets,
    enumerateFrames: async () => [{ frameId: 0, parentFrameId: -1, url: PAGE_URL }],
    collect: (async () => ({
      tabId: AGENT_TAB,
      contextHandle: "snap-1",
      documentEpoch: "doc-1",
      canonicalOrigin: SITE,
      formValueItems: [],
      semanticNodes: [{ targetHandle: "t_span", rect: RECT, ...node }],
    })) as never,
  }).forDelivery();
  return locate({
    context: testSessionContexts().forCall("session-l039", "call-locate"),
    binding: { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
    ref: "t_span",
    scroll: false,
  });
}

describe("039 FR-571 the locator's link flag", () => {
  it("is set for a control inside a link (the collection says so)", async () => {
    expect(await located({ role: "control", inLink: true })).toEqual({ ...RECT, link: true });
  });

  it("is still set from the node's own role", async () => {
    expect(await located({ role: "link" })).toEqual({ ...RECT, link: true });
  });

  it("is not set when neither says so", async () => {
    expect(await located({ role: "control" })).toEqual(RECT);
  });
});
