import { describe, expect, it } from "vitest";
import { contractExport } from "./helpers.js";

/**
 * 012/T314 — the two size tools steer the agent apart (FR-165, D-012-2, R-172).
 *
 * The only thing that decides which of `viewport` and `resize_window` an agent reaches for is the
 * sentence it reads in the offering, so the sentence is a contract rather than prose: an editor who
 * shortens "Prefer this over `resize_window`" out of the description has changed the product's
 * behaviour - the agent starts dragging the owner's window around for a breakpoint check - without
 * a single line of code moving. The probe (SC-090) is the live proof; this is the cheap guard that
 * fails in CI the moment the steering leaves.
 *
 * The strings are asserted as fragments, not whole, so the descriptions stay editable prose: what
 * is pinned is the four things the agent has to be told - the viewport does not touch the window,
 * it is the one to prefer, it is reset when you are done, and the two tools are independent of each
 * other in both directions.
 */

type Descriptor = { name: string; description: string };

function descriptionOf(name: string): string {
  const descriptors = contractExport<readonly Descriptor[]>("AGENT_TOOL_DESCRIPTORS");
  const found = descriptors.find((entry) => entry.name === name);
  expect(found, `AGENT_TOOL_DESCRIPTORS must carry '${name}'`).toBeDefined();
  return found!.description;
}

describe("T314 the descriptions that decide which size tool is used", () => {
  it("tells the agent a viewport is not the owner's window, is the one to prefer, and is reset", () => {
    const viewport = descriptionOf("viewport");
    // What it is: a size for looking at a page, bought without disturbing anything of the owner's.
    expect(viewport).toContain("without changing the browser window");
    // Which one to reach for (D-012-2): the steering sentence, in those words.
    expect(viewport).toContain("Prefer this over `resize_window`");
    // And that it is given back - explicitly by `reset`, and by the release path either way (FR-159).
    expect(viewport).toContain("`reset` puts the page back");
    expect(viewport).toContain("cleared when you release the tab");
  });

  it("points `resize_window` at `viewport` for anything but a real window change", () => {
    const resize = descriptionOf("resize_window");
    expect(resize).toContain("use `viewport` instead");
    // The narrow case it is still for: a window that genuinely has to move.
    expect(resize).toContain("only when the real window must change");
  });

  it("says on both tools that the two do not affect each other", () => {
    // An agent that thought `resize_window` clears an emulation - or that a `viewport set` shrinks
    // the owner's window - would use one to undo the other. Both descriptions deny it, so whichever
    // of the two the agent is reading says so.
    for (const name of ["viewport", "resize_window"]) {
      expect(descriptionOf(name), name).toContain("does not change an emulated viewport");
    }
    expect(descriptionOf("viewport")).toContain("The two tools are independent");
  });
});
