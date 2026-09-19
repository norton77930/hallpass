/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T117c - a document that is a document (US4 read half, FR-063, FR-067).
 *
 * Measured on the owner's artifact page over CDP: the artifact's own frame holds 320 elements, six
 * headings, three tables and 6,687 characters of text, and **zero** elements matching the walk the
 * agent's collection ran. So `read_page` returned nothing from that frame while `get_page_text`
 * returned its whole body - not a frame defect at all, but a structural read whose walk only ever
 * looked at *controls*: a page of prose has no button to find, and a document is more than the
 * things one can click.
 *
 * The frame wiring test could not catch it: it answers `content.collect-page` from a table of
 * canned nodes, so no document is ever walked, and every child document in it was given a button.
 * This is the seam that reaches the walk - a real document, collected the way a frame collects its
 * own - which is why the regression test lives here.
 *
 * Headings are the whole of what this adds. Prose and table cells are content, and content is
 * `get_page_text`'s answer; a heading is *structure* - the outline a reader navigates the document
 * by - and it is the one thing an agent cannot reconstruct from the text alone.
 */

function collectArticle() {
  document.body.innerHTML =
    "<h1>004 參考對齊清單</h1>" +
    "<p>對照 Claude in Chrome 與 ChatGPT/Codex 的能力盤點。</p>" +
    "<h2 id='today'>今天的四個證據</h2>" +
    "<table><tr><td>E1</td><td>frames</td></tr></table>" +
    "<div role='heading' aria-level='2'>附錄</div>";
  return (
    collectPage({
      snapshotId: "snapshot-1",
      documentEpoch: "doc-1",
      origin: "https://frame.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: TEST_COLLECTION_BOUNDS,
      mintPolicy: "all-controls",
      registry: new TargetRegistry(),
    }).semanticNodes ?? []
  );
}

describe("T117c a document of headings and prose", () => {
  it("names the headings of a document that holds no control at all", () => {
    const nodes = collectArticle();
    const headings = nodes.filter((node) => node.role === "heading");
    expect(headings.map((node) => node.label)).toEqual(["004 參考對齊清單", "今天的四個證據", "附錄"]);
  });

  it("gives each heading a reference, so a later read or wait can name it", () => {
    const nodes = collectArticle();
    for (const heading of nodes.filter((node) => node.role === "heading")) {
      expect(typeof heading.targetHandle).toBe("string");
    }
  });
});
