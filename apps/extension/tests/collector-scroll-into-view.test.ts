/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { TEST_NONCE, TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T128, B67 G5 correction - a coordinate-delivered effect's rect has to be measured on an
 * element the reference already brought on screen: `scrollIntoView({block: "center"})`, called in
 * the frame that owns the element, before the rect is read. Without it a target that lays out below
 * an ancestor iframe's own visible box is never reachable, whatever the offset arithmetic composes -
 * the grandchild-frame click this reproduces (`frames.html`/`frames-grandchild.html`, B67). Each
 * frame runs its own content-runtime instance against its own `document` (that is what "the frame
 * that owns the element" means at the wire level - `collector-frame.test.ts`'s `snapshotDocument`
 * calls are the same convention), so one document is enough to exercise the collector's own logic.
 */

function probeFrame() {
  return { ...collectFrame(), type: "content.probe" as const, expectedDocumentEpoch: "probe-unbound", payload: {} };
}

function collectFrame(payload: Record<string, unknown> = {}) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: "message-collect",
    runtimeEpochId: "epoch-1",
    type: "content.collect-page" as const,
    taskId: "task-1",
    operationId: "operation-collect",
    nonce: TEST_NONCE,
    expectedTabId: 1,
    expectedDocumentEpoch: "doc-1",
    payload: {
      generalPageReadGrantId: "grant-1",
      requestedDataCategories: ["page.structure", "page.target-metadata"],
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy: "all-controls",
      ...payload,
    },
  };
}

describe("004/T128 scrollIntoView before a coordinate-delivered effect measures its rect", () => {
  it("scrolls the ref's own element into view when the collection asks for it", () => {
    document.body.innerHTML = '<button type="button" id="btn">Grandchild action</button>';
    const button = document.querySelector("button");
    if (!button) throw new Error("button-missing");
    const scrollCalls: unknown[] = [];
    button.scrollIntoView = (options?: unknown) => scrollCalls.push(options);

    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://fixtures.test" });
    handleContentMessage(probeFrame(), undefined, context);
    const minted = handleContentMessage(collectFrame(), undefined, context) as {
      semanticNodes?: Array<{ targetHandle?: string; label?: string }>;
    };
    const ref = minted.semanticNodes?.find((node) => node.label === "Grandchild action")?.targetHandle;
    if (!ref) throw new Error("ref-not-minted");

    expect(scrollCalls).toHaveLength(0);

    handleContentMessage(collectFrame({ rootTargetHandle: ref, scrollIntoView: true }), undefined, context);

    expect(scrollCalls).toEqual([{ block: "center", inline: "nearest", behavior: "instant" }]);
  });

  it("does not scroll when the collection does not ask for it", () => {
    document.body.innerHTML = '<button type="button" id="btn">Action</button>';
    const button = document.querySelector("button");
    if (!button) throw new Error("button-missing");
    const scrollCalls: unknown[] = [];
    button.scrollIntoView = (options?: unknown) => scrollCalls.push(options);

    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://fixtures.test" });
    handleContentMessage(probeFrame(), undefined, context);
    const minted = handleContentMessage(collectFrame(), undefined, context) as {
      semanticNodes?: Array<{ targetHandle?: string; label?: string }>;
    };
    const ref = minted.semanticNodes?.find((node) => node.label === "Action")?.targetHandle;
    if (!ref) throw new Error("ref-not-minted");

    handleContentMessage(collectFrame({ rootTargetHandle: ref }), undefined, context);

    expect(scrollCalls).toHaveLength(0);
  });
});
