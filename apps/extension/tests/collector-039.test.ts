/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { registerLiveElement, TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 039 T1095 - the root of a rooted collection says whether it sits on a link (FR-571, D-039-3, R-549).
 *
 * A point click registers the innermost element at the point - the `span` inside an `<a href>` - and
 * the press-outcome hint (015) used to ask only whether that element's own role was `link`. The
 * collection that locates the ref now carries `inLink` on the root: the element, or its nearest
 * ancestor in the same document (composed tree, through shadow roots to their hosts), is `a[href]` or
 * has the role `link`.
 */
const EPOCH = "doc-1";

function collectRoot(registry: TargetRegistry, element: Element) {
  const reply = registerLiveElement(registry, EPOCH, element);
  if (reply.ok !== true || reply.outcome !== "resolved") throw new Error("not-minted");
  const handle = reply.candidates[0]?.targetHandle;
  if (!handle) throw new Error("no-handle");
  const nodes =
    collectPage({
      snapshotId: "snapshot-1",
      documentEpoch: EPOCH,
      origin: "https://frame.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy: "all-controls",
      registry,
      rootTargetHandle: handle,
    }).semanticNodes ?? [];
  const root = nodes.find((node) => node.targetHandle === handle);
  if (!root) throw new Error("root-missing");
  return { root, nodes };
}

function byId(id: string): Element {
  const found = document.getElementById(id);
  if (!found) throw new Error(`${id}-missing`);
  return found;
}

describe("039 FR-571 the root says whether it is on a link", () => {
  it("flags a span inside a[href]", () => {
    document.body.innerHTML = '<a href="https://example.test/next"><span id="s">Next</span></a>';
    expect(collectRoot(new TargetRegistry(), byId("s")).root).toMatchObject({ role: "control", inLink: true });
  });

  it("flags a span deeper inside a[href]", () => {
    document.body.innerHTML = '<a href="/x"><b><i><span id="s">Deep</span></i></b></a>';
    expect(collectRoot(new TargetRegistry(), byId("s")).root).toMatchObject({ inLink: true });
  });

  it("flags a span inside an element with role=link", () => {
    document.body.innerHTML = '<div role="link" tabindex="0"><span id="s">Go</span></div>';
    expect(collectRoot(new TargetRegistry(), byId("s")).root).toMatchObject({ inLink: true });
  });

  it("flags the link itself", () => {
    document.body.innerHTML = '<a id="a" href="/x">Go</a>';
    expect(collectRoot(new TargetRegistry(), byId("a")).root).toMatchObject({ role: "link", inLink: true });
  });

  it("flags an element in a shadow root whose host is a link", () => {
    document.body.innerHTML = '<a href="/x"><div id="host"></div></a>';
    const shadow = byId("host").attachShadow({ mode: "open" });
    shadow.innerHTML = '<span id="inner">Shadow</span>';
    const inner = shadow.getElementById("inner");
    if (!inner) throw new Error("inner-missing");
    expect(collectRoot(new TargetRegistry(), inner).root).toMatchObject({ inLink: true });
  });

  it("does not flag an a without href", () => {
    document.body.innerHTML = '<a id="a"><span id="s">Placeholder</span></a>';
    expect(collectRoot(new TargetRegistry(), byId("s")).root).not.toHaveProperty("inLink");
    expect(collectRoot(new TargetRegistry(), byId("a")).root).not.toHaveProperty("inLink");
  });

  it("does not flag an element that is not under a link", () => {
    document.body.innerHTML = '<div><span id="s">Plain</span></div><a href="/x">Elsewhere</a>';
    expect(collectRoot(new TargetRegistry(), byId("s")).root).not.toHaveProperty("inLink");
  });

  it("flags only the root, not the other nodes of the collection", () => {
    document.body.innerHTML = '<div id="d"><a href="/x">One</a></div>';
    const { nodes } = collectRoot(new TargetRegistry(), byId("d"));
    expect(nodes.filter((node) => (node as { inLink?: boolean }).inLink === true)).toHaveLength(0);
  });
});
