/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { ElementRegistry } from "../src/content-runtime/registry.js";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T130 - a reference lives as long as its element, not as long as the read (US6, R-115, FR-066).
 *
 * 003 replaced the page's references on every collection, so a reference an agent had just been
 * given went stale the moment it read again and the agent had to re-read before every action. The
 * reference behaviour (G8) is the opposite: an element is named once and keeps that name until the
 * element itself is gone.
 *
 * Three of the properties below are the ones that make that safe rather than merely convenient:
 *
 * - an index is **never recycled**. A recycled index would hand an agent someone else's element
 *   under the name it already holds - the one failure mode a stable reference must not have;
 * - the registry holds its elements **weakly**, so keeping a name alive never keeps a removed
 *   element alive;
 * - it **dies with the document**, so a name minted before a navigation cannot name anything after.
 */

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  document.body.append(element);
  return element;
}

describe("the page's element registry", () => {
  it("keeps one element's index and handle across collections", () => {
    const registry = new ElementRegistry();
    const first = button("save");

    const initial = registry.register(first);
    const again = registry.register(first);
    registry.prune();
    const afterPrune = registry.register(first);

    expect(again).toEqual(initial);
    expect(afterPrune).toEqual(initial);
    expect(registry.elementOf(initial.handle)).toBe(first);
    expect(registry.elementAt(initial.index)).toBe(first);
  });

  it("prunes a disconnected element, and its reference answers stale from then on", () => {
    const registry = new ElementRegistry();
    const gone = button("cancel");
    const entry = registry.register(gone);

    gone.remove();
    registry.prune();

    expect(registry.elementOf(entry.handle)).toBeUndefined();
    expect(registry.elementAt(entry.index)).toBeUndefined();
    expect(registry.entryOfHandle(entry.handle)).toBeUndefined();
  });

  it("never hands a new element an index another element has used", () => {
    const registry = new ElementRegistry();
    const used = new Set<number>();
    for (const label of ["one", "two", "three"]) {
      const element = button(label);
      used.add(registry.register(element).index);
      element.remove();
    }
    registry.prune();

    const replacement = button("four");
    const entry = registry.register(replacement);

    expect(used.size).toBe(3);
    expect(used.has(entry.index)).toBe(false);
    // The retired indices stay retired: nothing later can make one of them resolve again.
    for (const index of used) expect(registry.elementAt(index)).toBeUndefined();
  });

  it("holds its elements weakly, so a removed element is not kept alive by the registry", () => {
    const registry = new ElementRegistry();
    const element = button("weak");
    const entry = registry.register(element);

    const holders = registry.weakHolders();

    // The registry's only hold on the element is a `WeakRef`; the reverse lookup is keyed weakly
    // too, so neither direction of the map is a strong reference to page content.
    expect(holders.byIndex.get(entry.index)).toBeInstanceOf(WeakRef);
    expect(holders.byIndex.get(entry.index)?.deref()).toBe(element);
    expect(holders.byElement).toBeInstanceOf(WeakMap);
  });

  it("dies with the document: a new document's registry knows none of the old names", () => {
    const previous = new ElementRegistry();
    const element = button("before");
    const entry = previous.register(element);

    const current = new ElementRegistry();

    expect(current.entryOfHandle(entry.handle)).toBeUndefined();
    expect(current.elementAt(entry.index)).toBeUndefined();
  });
});

describe("the collector over the registry", () => {
  function collect(registry: TargetRegistry) {
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

  function handlesOf(result: ReturnType<typeof collectPage>): string[] {
    return (result.semanticNodes ?? [])
      .map((node) => node.targetHandle)
      .filter((handle): handle is string => typeof handle === "string");
  }

  it("gives an element the same handle on a later collection, and a new element a new one", () => {
    document.body.innerHTML = "";
    const registry = new TargetRegistry();
    const kept = button("kept");

    const first = handlesOf(collect(registry));
    button("added");
    const second = handlesOf(collect(registry));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    // The whole point of the slice: the first read's reference still names its element after a
    // second read, and it still resolves.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[0]);
    expect(registry.resolve(first[0] as string, "doc-1")?.element).toBe(kept);
  });

  it("stops resolving the handle of an element the page has removed", () => {
    document.body.innerHTML = "";
    const registry = new TargetRegistry();
    const doomed = button("doomed");

    const [handle] = handlesOf(collect(registry));
    doomed.remove();
    collect(registry);

    expect(registry.resolve(handle as string, "doc-1")).toBeUndefined();
  });

  /**
   * 004/T136 - the fast guard for the fact the packaged journey exercises end to end: a removed
   * element's handle must be told apart from one this document never minted at all, because the two
   * lead an agent to different next moves ("read again" versus "that was never here"). The registry
   * already knows the difference - a bound entry whose element no longer derefs versus no entry at
   * all - and it has to survive the very collection that would otherwise prune it away unseen.
   */
  it("tells a just-removed element's handle apart from one the document never minted, when rooted there", () => {
    document.body.innerHTML = "";
    const registry = new TargetRegistry();
    const doomed = button("doomed");

    const [handle] = handlesOf(collect(registry));
    doomed.remove();

    const rootedOnGone = collectPage({
      snapshotId: "snapshot-1",
      documentEpoch: "doc-1",
      origin: "https://example.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy: "all-controls",
      registry,
      rootTargetHandle: handle as string,
    });
    expect(rootedOnGone.rootTargetGone).toBe(true);

    const rootedOnUnknown = collectPage({
      snapshotId: "snapshot-2",
      documentEpoch: "doc-1",
      origin: "https://example.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy: "all-controls",
      registry,
      rootTargetHandle: "t_never-minted",
    });
    expect(rootedOnUnknown.rootTargetGone).toBeUndefined();
  });
});
