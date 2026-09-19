/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 004/T137 (B88, B89) - the seven names a real GitHub repository page's tree carries that the full
 * read did not, measured free over CDP with no LLM. All seven are ordinary heading/link/button
 * roles the walk already collects 500+ of elsewhere on the same page - they reach the walk and come
 * back nameless (or wrongly named), for two distinct reasons:
 *
 * - An icon button's own name lives entirely in an `aria-labelledby`-referenced element (here, a
 *   tooltip popover the page marks `aria-hidden="true"` - explicit reference overrides that). The
 *   label chain never consulted `aria-labelledby`, so `labelRaw` fell through to nothing.
 * - A link's or a heading's name is built from several sibling elements' own text (a decorative
 *   empty span contributes nothing, an `aria-hidden` counter is skipped, the rest are joined with a
 *   single space the markup itself does not contain) - the browser's own accessible-name-from-content
 *   algorithm. `ownText` used plain `element.textContent.trim()`, which concatenates every descendant
 *   verbatim with no space and no `aria-hidden` exclusion, so it named `<a>` `"Python53.9%"` where the
 *   browser names it `"Python 53.9%"`, and it would have pulled the hidden counter's digits into the
 *   heading's name too.
 */
function collectFrom(html: string) {
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
      mintPolicy: "all-controls",
      registry: new TargetRegistry(),
    }).semanticNodes ?? []
  );
}

describe("T137 the seven names our walk did not collect", () => {
  it("names an icon button from its aria-labelledby, even though the referenced element is aria-hidden", () => {
    const nodes = collectFrom(
      '<button id="trigger" aria-labelledby="tip1"></button>' +
        '<div id="tip1" aria-hidden="true" popover="auto">Appearance settings</div>',
    );
    const button = nodes.find((node) => node.role === "button");
    expect(button?.label).toBe("Appearance settings");
  });

  it("joins a link's own sibling elements the way the browser does, skipping an aria-hidden one", () => {
    const nodes = collectFrom(
      '<a href="/x">' +
        '<span></span>' +
        '<span>Python</span>' +
        '<span>53.9%</span>' +
        "</a>",
    );
    const link = nodes.find((node) => node.role === "link");
    expect(link?.label).toBe("Python 53.9%");
  });

  it("names a heading from its content, keeping the visually-hidden text and dropping the aria-hidden one", () => {
    const nodes = collectFrom(
      "<h2>" +
        '<span><a href="/c">Contributors</a>' +
        '<span aria-hidden="true">58</span>' +
        '<span class="visually-hidden"> (58)</span></span>' +
        "</h2>",
    );
    const heading = nodes.find((node) => node.role === "heading");
    expect(heading?.label).toBe("Contributors  (58)");
  });
});
