import { describe, expect, it } from "vitest";
import { contractExport } from "./helpers.js";

/**
 * 030/T903 - the descriptions tell the agent whose consent an embedded frame answers to (FR-463,
 * FR-466, contracts/prompt-and-reads.md "Tool descriptions").
 *
 * An agent that does not know a frame from another site is decided by that site will treat a
 * refusal inside it as a broken tool. The sentences are asserted as fragments so the surrounding
 * prose stays editable.
 */

type Descriptor = { name: string; description: string };

function descriptionOf(name: string): string {
  const descriptors = contractExport<readonly Descriptor[]>("AGENT_TOOL_DESCRIPTORS");
  const found = descriptors.find((entry) => entry.name === name);
  expect(found, `AGENT_TOOL_DESCRIPTORS must carry '${name}'`).toBeDefined();
  return found!.description;
}

describe("T903 frame-site wording in the tool descriptions", () => {
  it.each([
    "click",
    "double_click",
    "triple_click",
    "right_click",
    "hover",
    "drag",
    "type",
    "key",
    "computer",
    "browser_batch",
    "file_upload",
    "upload_image",
  ])("%s says an action inside another site's embedded frame is decided by that site", (name) => {
    const description = descriptionOf(name);
    expect(description).toContain("another site's embedded frame");
    expect(description).toContain("decided by that site");
  });

  it.each(["read_page", "find"])("%s says it marks frames and references from other sites", (name) => {
    const description = descriptionOf(name);
    expect(description).toContain("marks frames and references from other sites");
  });

  it("propose_sites says an embedded frame's site may be proposed like any site", () => {
    expect(descriptionOf("propose_sites")).toContain(
      "an embedded frame's site may be proposed like any site",
    );
  });
});
