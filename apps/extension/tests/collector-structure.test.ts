/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T117d - `filter: "all"` has to mean the page (US6, FR-063, FR-067, SC-036).
 *
 * The reference builds an accessibility tree; this collection walked a list of *controls*, so the
 * prose, the lists and the table of a real document were invisible to the structural read
 * everywhere - not only in a child frame. T117c put headings in the walk, which is the outline; a
 * document is also its paragraphs, its lists, its tables, the images that carry a description and
 * the regions it is laid out in, and an agent asking for everything got a fraction with no way to
 * tell.
 *
 * The seam is the collector, for the reason T117c recorded: the frame wiring test answers
 * `content.collect-page` from a table of canned nodes, so no document is ever walked there and this
 * whole class of defect is invisible to it. Here a real document is collected the way a frame
 * collects its own.
 *
 * The agent's walk only. The reviewed 001/002 walk is untouched - widening what a remote review may
 * be shown is not this slice's decision - and none of these roles is interactive, so the default
 * `read_page` is unchanged.
 */

function collectDocument(html: string, mintPolicy: "reviewed" | "all-controls" = "all-controls") {
  document.body.innerHTML = html;
  return (
    collectPage({
      snapshotId: "snapshot-1",
      documentEpoch: "doc-1",
      origin: "https://frame.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy,
      registry: new TargetRegistry(),
    }).semanticNodes ?? []
  );
}

const ARTICLE =
  "<main>" +
  "<h1>004 參考對齊清單</h1>" +
  "<p>對照 Claude in Chrome 的能力盤點。</p>" +
  "<blockquote>沒有按鈕的頁面也是頁面。</blockquote>" +
  "<ul><li>frames</li><li>refs</li></ul>" +
  "<table><caption>今天的證據</caption><tr><th>編號</th><td>E1</td></tr></table>" +
  "<img src='chart.png' alt='節點數對照圖'>" +
  "<img src='spacer.png' alt=''>" +
  "</main>" +
  "<nav aria-label='章節'><a href='https://frame.test/next'>下一節</a></nav>";

describe("T117d a document is more than its controls", () => {
  it("names the prose, the lists, the table, the described image and the regions it holds", () => {
    const nodes = collectDocument(ARTICLE);
    const named = nodes.map((node) => [node.role, node.label ?? ""]);
    expect(named).toEqual(
      expect.arrayContaining([
        ["main", ""],
        ["paragraph", "對照 Claude in Chrome 的能力盤點。"],
        ["blockquote", "沒有按鈕的頁面也是頁面。"],
        ["list", ""],
        ["listitem", "frames"],
        ["listitem", "refs"],
        ["table", "今天的證據"],
        ["row", ""],
        ["columnheader", "編號"],
        ["cell", "E1"],
        ["img", "節點數對照圖"],
        ["navigation", "章節"],
      ]),
    );
  });

  it("leaves out an image the page itself marked decorative", () => {
    const images = collectDocument(ARTICLE).filter((node) => node.role === "img");
    expect(images.map((node) => node.label)).toEqual(["節點數對照圖"]);
  });

  it("gives each structural node a reference, so a later read can be rooted at it", () => {
    const nodes = collectDocument(ARTICLE);
    for (const node of nodes.filter((candidate) => candidate.role === "listitem")) {
      expect(typeof node.targetHandle).toBe("string");
    }
  });

  it("leaves the reviewed 001/002 walk seeing controls and nothing else", () => {
    const roles = new Set(collectDocument(ARTICLE, "reviewed").map((node) => node.role));
    expect(roles).toEqual(new Set());
  });
});
