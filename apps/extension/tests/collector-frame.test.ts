/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { snapshotDocument } from "../src/content-runtime/collector.js";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { TEST_NONCE, TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T114 - one frame answers for one document (US4 read half, R-114, FR-063).
 *
 * A page made of frames is read by asking *every* frame, and the only way that merge can be built
 * out of the answers is if each answer is about exactly one document. So this is the page half of
 * the contract `mergePageFrames` (T112/T113) is the worker half of:
 *
 * - a frame answers for its own document and nothing else - it does not walk into the documents it
 *   embeds, and it does not walk out into the one embedding it;
 * - the element that *holds* a child frame is still part of the answer, marked, because that mark
 *   is the only thing that tells the worker where the child's nodes belong;
 * - rects are the frame's own viewport coordinates, unshifted. A frame has no way to know where it
 *   sits on the page, and a rect it "corrected" would be a guess the worker could not undo.
 *
 * The shape is `frames.html`'s: a top document with a control of its own and an iframe holding a
 * child that has the same-named control.
 */

const FRAME_OWNER_TITLE = "same-origin child";

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

function probeFrame() {
  return { ...collectFrame(), type: "content.probe" as const, expectedDocumentEpoch: "probe-unbound", payload: {} };
}

/** A box the browser would have measured; jsdom has no layout, so the fixture supplies one. */
function measure(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({
      x: rect.x,
      y: rect.y,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => rect,
    }) as DOMRect;
}

/** The fixture's shape: the top document, its iframe, and the child document inside it. */
function framedPage(): Document {
  document.body.innerHTML =
    '<h1>Frames fixture</h1>' +
    `<iframe id="same-origin-frame" title="${FRAME_OWNER_TITLE}"></iframe>` +
    '<button type="button" id="top-btn">Top action</button>';
  const owner = document.querySelector("iframe");
  if (!(owner instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
  const childDocument = owner.contentDocument;
  if (!childDocument) throw new Error("child-document-missing");
  childDocument.body.innerHTML = '<button type="button" id="child-btn">Child action</button>';
  measure(owner, { x: 20, y: 300, width: 400, height: 320 });
  const childButton = childDocument.querySelector("button");
  if (!childButton) throw new Error("child-button-missing");
  measure(childButton, { x: 8, y: 12, width: 90, height: 30 });
  return childDocument;
}

type CollectedNode = { role: string; label?: string; frameOwner?: boolean; rect?: unknown };

function collectTopDocument(): CollectedNode[] {
  const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://fixtures.test" });
  handleContentMessage(probeFrame(), undefined, context);
  const answer = handleContentMessage(collectFrame(), undefined, context) as {
    semanticNodes?: CollectedNode[];
  };
  return answer.semanticNodes ?? [];
}

describe("004/T114 a frame answers for its own document", () => {
  it("names the element holding a child frame and nothing that is inside it", () => {
    framedPage();

    const nodes = collectTopDocument();

    expect(nodes.map((node) => node.label)).toContain("Top action");
    // The child's own control belongs to the child's answer. A top document that reported it would
    // be reporting a document it is not, with depths and rects from a viewport it does not own.
    expect(nodes.map((node) => node.label)).not.toContain("Child action");
    const owner = nodes.find((node) => node.frameOwner === true);
    expect(owner).toMatchObject({ role: "iframe", label: FRAME_OWNER_TITLE });
  });

  it("reports each node's rect in its own frame's viewport", () => {
    const childDocument = framedPage();

    const ownerNode = collectTopDocument().find((node) => node.frameOwner === true);
    expect(ownerNode?.rect).toEqual({ x: 20, y: 300, width: 400, height: 320 });

    // The same walk, run in the child document: its button sits 12px down *its own* viewport, not
    // 312px down the page. Only the worker knows where the frame is, so only the worker may add it.
    const child = snapshotDocument(childDocument, "https://fixtures.test", 200, undefined, "all-controls");
    expect(child.targets.map((target) => target.label)).toEqual(["Child action"]);
    expect(child.targets[0]?.rect).toEqual({ x: 8, y: 12, width: 90, height: 30 });
  });
});
