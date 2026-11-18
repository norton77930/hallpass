/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { registerLiveElement, TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 038 T1077 - a ref's own element is always in a collection rooted at it (FR-562, D-038-1), and the
 * agent's walk names the ARIA widget roles a page builds its own controls from (FR-565, FR-566).
 *
 * The measured failure: a point click registers the innermost element at the point (a `span` inside
 * a `li[role=menuitemradio]`), and the locate that follows collects the page rooted at that ref. The
 * walk only visits the agent's selector list, so the root was never in the collection and the click
 * answered `target-not-located`.
 */
const EPOCH = "doc-1";

function collect(registry: TargetRegistry, rootTargetHandle?: string) {
  return (
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
      ...(rootTargetHandle ? { rootTargetHandle } : {}),
    }).semanticNodes ?? []
  );
}

function mint(registry: TargetRegistry, element: Element): string {
  const reply = registerLiveElement(registry, EPOCH, element);
  if (reply.ok !== true || reply.outcome !== "resolved") throw new Error("not-minted");
  const handle = reply.candidates[0]?.targetHandle;
  if (!handle) throw new Error("no-handle");
  return handle;
}

function giveBox(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () =>
    ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }) as DOMRect;
}

describe("038 FR-562 the root of a rooted collection is collected", () => {
  it("returns a header inside an article (a sectioned header the walk skips) with its handle", () => {
    document.body.innerHTML = '<article><header id="h">Title</header></article>';
    const header = document.getElementById("h");
    if (!header) throw new Error("header-missing");
    giveBox(header, { x: 0, y: 0, width: 300, height: 40 });
    const registry = new TargetRegistry();
    const handle = mint(registry, header);

    expect(collect(registry, handle).find((node) => node.targetHandle === handle)).toBeDefined();
  });

  it("does not collect a root inside Hallpass's own indicator", () => {
    document.body.innerHTML = '<div data-hallpass-indicator=""><button id="stop" type="button">Stop</button></div>';
    const stop = document.getElementById("stop");
    if (!stop) throw new Error("button-missing");
    giveBox(stop, { x: 0, y: 0, width: 60, height: 20 });
    const registry = new TargetRegistry();
    const handle = mint(registry, stop);

    expect(collect(registry, handle).find((node) => node.targetHandle === handle)).toBeUndefined();
  });

  it("returns a span inside li[role=menuitemradio] with the handle it was minted with, and its rect", () => {
    document.body.innerHTML =
      '<ul role="menu"><li role="menuitemradio"><div><span id="label">Custom</span></div></li></ul>';
    const span = document.getElementById("label");
    if (!span) throw new Error("span-missing");
    giveBox(span, { x: 10, y: 20, width: 50, height: 16 });
    const registry = new TargetRegistry();
    const handle = mint(registry, span);

    const nodes = collect(registry, handle);

    const root = nodes.find((node) => node.targetHandle === handle);
    expect(root).toMatchObject({ depth: 0, rect: { x: 10, y: 20, width: 50, height: 16 } });
    expect(nodes[0]?.targetHandle).toBe(handle);
  });

  it("returns an aria-hidden element with its handle although the node is marked hidden", () => {
    document.body.innerHTML = '<button type="button"><svg id="icon" aria-hidden="true"></svg>Save</button>';
    const icon = document.getElementById("icon");
    if (!icon) throw new Error("icon-missing");
    giveBox(icon, { x: 5, y: 5, width: 12, height: 12 });
    const registry = new TargetRegistry();
    const handle = mint(registry, icon);

    const nodes = collect(registry, handle);

    expect(nodes.find((node) => node.targetHandle === handle)).toMatchObject({
      hidden: true,
      rect: { x: 5, y: 5, width: 12, height: 12 },
    });
  });

  it("does not hand a handle to a hidden element that is not the root", () => {
    document.body.innerHTML =
      '<ul><li id="host"><button type="button" aria-hidden="true">Ghost</button></li></ul>';
    const host = document.getElementById("host");
    if (!host) throw new Error("host-missing");
    const registry = new TargetRegistry();
    const handle = mint(registry, host);

    const nodes = collect(registry, handle);

    expect(nodes.find((node) => node.label === "Ghost")?.targetHandle).toBeUndefined();
  });

  it("does not repeat the root when the walk already returns it", () => {
    document.body.innerHTML = '<button type="button" id="b">Save</button>';
    const button = document.getElementById("b");
    if (!button) throw new Error("button-missing");
    const registry = new TargetRegistry();
    const handle = mint(registry, button);

    const nodes = collect(registry, handle);

    expect(nodes.filter((node) => node.targetHandle === handle)).toHaveLength(1);
  });
});

describe("038 FR-565, FR-566 widget roles are walked and named from content", () => {
  it("names a div[role=option] by its text", () => {
    document.body.innerHTML = '<div role="listbox"><div role="option">Issues</div></div>';

    const nodes = collect(new TargetRegistry());

    expect(nodes.find((node) => node.role === "option")).toMatchObject({ label: "Issues" });
  });

  it("walks li[role=menuitemradio] as that role, named by its text", () => {
    document.body.innerHTML =
      '<ul role="menu"><li role="menuitemradio"><div><span>Custom</span></div></li></ul>';

    const nodes = collect(new TargetRegistry());

    expect(nodes.find((node) => node.role === "menuitemradio")).toMatchObject({ label: "Custom" });
  });

  it.each(["menuitem", "menuitemcheckbox", "tab", "treeitem", "radio"])(
    "walks a div with role=%s and names it from its text",
    (role) => {
      document.body.innerHTML = `<div role="${role}">Thing</div>`;

      const nodes = collect(new TargetRegistry());

      expect(nodes.find((node) => node.role === role)).toMatchObject({ label: "Thing" });
    },
  );

  it.each(["combobox", "textbox", "searchbox", "slider", "spinbutton", "listbox"])(
    "walks a div with role=%s but does not name it from its content",
    (role) => {
      document.body.innerHTML = `<div role="${role}">Inner text</div>`;

      const nodes = collect(new TargetRegistry());

      const node = nodes.find((entry) => entry.role === role);
      expect(node).toBeDefined();
      expect(node?.label).toBeUndefined();
    },
  );
});
