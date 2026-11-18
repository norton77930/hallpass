/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 040 T1106 - a control's `<label>` names it (FR-573, D-040-2, R-551).
 *
 * The text of `control.labels` (a `<label for>` and a wrapping `<label>`) names the control after
 * `aria-labelledby` and `aria-label`, with the label's own form controls left out of the text. Before
 * this a checkbox or a select inside `<label>Remember me <input></label>` arrived nameless (or named
 * by its `name` attribute), because the label's text belongs to the label, not to the control.
 */
function collectFrom(html: string, maxLabelChars: number = TEST_COLLECTION_BOUNDS.maxLabelChars) {
  document.body.innerHTML = html;
  return (
    collectPage({
      snapshotId: "snapshot-1",
      documentEpoch: "doc-1",
      origin: "https://frame.test",
      requested: ["page.structure", "page.target-metadata"],
      formGrantActive: false,
      generalGrantActive: true,
      bounds: { ...TEST_COLLECTION_BOUNDS, maxLabelChars },
      mintPolicy: "all-controls",
      registry: new TargetRegistry(),
    }).semanticNodes ?? []
  );
}

function labelOf(nodes: ReturnType<typeof collectFrom>, role: string): string | undefined {
  return nodes.find((node) => node.role === role)?.label;
}

describe("040 FR-573 a control's label names it", () => {
  it("names an input from a <label for>", () => {
    const nodes = collectFrom('<label for="email">Email address</label><input id="email" type="email">');
    expect(labelOf(nodes, "textbox")).toBe("Email address");
  });

  it("names a checkbox from its wrapping label, leaving the checkbox itself out", () => {
    const nodes = collectFrom('<label>Remember me <input type="checkbox" id="remember"></label>');
    expect(labelOf(nodes, "checkbox")).toBe("Remember me");
  });

  it("names a select from its wrapping label without the option text", () => {
    const nodes = collectFrom(
      '<label>Country <select id="country"><option>Taiwan</option><option>Japan</option></select></label>',
    );
    expect(labelOf(nodes, "combobox")).toBe("Country");
  });

  it("lets aria-label win over the label", () => {
    const nodes = collectFrom('<label for="a">Visible label</label><input id="a" type="text" aria-label="Aria name">');
    expect(labelOf(nodes, "textbox")).toBe("Aria name");
  });

  it("lets aria-labelledby win over the label", () => {
    const nodes = collectFrom(
      '<span id="ref">By reference</span><label for="a">Visible label</label><input id="a" type="text" aria-labelledby="ref">',
    );
    expect(labelOf(nodes, "textbox")).toBe("By reference");
  });

  it("still names from a display:none label", () => {
    const nodes = collectFrom('<label for="a" style="display:none">Hidden label</label><input id="a" type="text">');
    expect(labelOf(nodes, "textbox")).toBe("Hidden label");
  });

  it("joins two labels with one space in document order", () => {
    const nodes = collectFrom(
      '<label for="a">First</label><label>  Second\n   part <input id="a" type="text"></label>',
    );
    expect(labelOf(nodes, "textbox")).toBe("First Second part");
  });

  it("bounds the name by maxLabelChars", () => {
    const nodes = collectFrom('<label for="a">abcdefghijklmnop</label><input id="a" type="text">', 5);
    expect(labelOf(nodes, "textbox")).toBe("abcde");
  });

  it("falls back to the control's own name when it has no label", () => {
    const nodes = collectFrom('<input id="a" type="text" name="fallback">');
    expect(labelOf(nodes, "textbox")).toBe("fallback");
  });
});
