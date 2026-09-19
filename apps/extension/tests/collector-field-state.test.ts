/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { TargetMintPolicy } from "@hallpass/contracts";
import { collectPage } from "../src/content-runtime/collector.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * 005/T171 - the agent's read carries what a field holds; the archived remote path does not
 * (US1, FR-072, FR-073, FR-075, R-122).
 *
 * The seam is the one gate `collectPage` already has for agent-only fields: the same document is
 * collected under both policies, and the four state fields are present under `all-controls` and
 * absent under `reviewed` - the remote path's answer is byte for byte what it was.
 */

const FORM = [
  '<input id="name" type="text" aria-label="Name">',
  '<input id="secret" type="password" aria-label="Secret">',
  '<input id="card" type="text" autocomplete="cc-number" aria-label="Card">',
  '<select id="size"><option>Small</option><option selected>Large</option></select>',
  '<textarea id="notes"></textarea>',
  '<input id="tick" type="checkbox" checked><input id="untick" type="checkbox">',
].join("");

function collect(mintPolicy: TargetMintPolicy) {
  return collectPage({
    snapshotId: "snapshot-1",
    documentEpoch: "doc-1",
    origin: "https://example.test",
    requested: ["page.structure", "page.target-metadata"],
    formGrantActive: false,
    generalGrantActive: true,
    bounds: TEST_COLLECTION_BOUNDS,
    mintPolicy,
    registry: new TargetRegistry(),
  });
}

type CollectedNode = NonNullable<ReturnType<typeof collectPage>["semanticNodes"]>[number];

function withLabel(nodes: CollectedNode[], label: string): Record<string, unknown> | undefined {
  return nodes.find((node) => node.label === label) as Record<string, unknown> | undefined;
}

describe("T171 field state in the collection", () => {
  beforeEach(() => {
    document.body.innerHTML = FORM;
    (document.getElementById("name") as HTMLInputElement).value = "Ada";
    (document.getElementById("secret") as HTMLInputElement).value = "hunter2";
    (document.getElementById("card") as HTMLInputElement).value = "4111111111111111";
    (document.getElementById("notes") as HTMLTextAreaElement).value = "one\ntwo";
  });

  it("carries value, checked and redacted on the agent's read", () => {
    const nodes = collect("all-controls").semanticNodes ?? [];

    expect(withLabel(nodes, "Name")?.value).toBe("Ada");
    expect(withLabel(nodes, "Secret")).toMatchObject({ redacted: true });
    expect(withLabel(nodes, "Secret")?.value).toBeUndefined();
    expect(withLabel(nodes, "Card")).toMatchObject({ redacted: true });
    expect(withLabel(nodes, "Card")?.value).toBeUndefined();
    // The select's shown text sits beside the options it already carried.
    const size = nodes.find((node) => node.role === "combobox") as Record<string, unknown>;
    expect(size.value).toBe("Large");
    expect(size.options).toEqual(["Small", "Large"]);
    const notes = nodes.find((node) => node.role === "textbox" && (node as { value?: string }).value === "one\ntwo");
    expect(notes).toBeDefined();
    const toggles = nodes.filter((node) => node.role === "checkbox") as Array<Record<string, unknown>>;
    expect(toggles.map((node) => node.checked)).toEqual([true, false]);
    expect(toggles.every((node) => node.value === undefined)).toBe(true);
    // The secret never entered the collection under any key.
    expect(JSON.stringify(nodes)).not.toContain("hunter2");
    expect(JSON.stringify(nodes)).not.toContain("4111");
  });

  it("carries none of them on the reviewed read (FR-075)", () => {
    const nodes = collect("reviewed").semanticNodes ?? [];

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes as Array<Record<string, unknown>>) {
      expect(node.value).toBeUndefined();
      expect(node.checked).toBeUndefined();
      expect(node.redacted).toBeUndefined();
      expect(node.valueTruncated).toBeUndefined();
    }
    expect(JSON.stringify(nodes)).not.toContain("Ada");
  });
});
