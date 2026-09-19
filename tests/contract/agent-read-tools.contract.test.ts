import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 003/T032 — the read tools' closed shapes (US2, FR-036..FR-039).
 *
 * Reading is ungated, which is exactly why the *shapes* carry the discipline. Every read says
 * whether it was cut by a bound, because a page reported without that flag is a page the agent
 * would believe it had seen all of. Every node a read returns carries the role and the name the
 * worker already holds - never markup, never a selector - and carries a `ref` only where the
 * registry actually minted one, because a ref is an offer to act on that element.
 *
 * A screenshot's shape is the odd one: what travels back to the agent is an MCP image block, so the
 * result declared here is what the *worker* answers with, and the host turns it into the block.
 */

const TAB = 7;
const LABEL_BOUND = contractExport<{ maxLabelChars: number }>("DEFAULT_BOUNDS").maxLabelChars;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T032 agent read tool contracts", () => {
  it("reads a tab's text with nothing to choose but the tab", () => {
    const text = args("get_page_text");
    expectAccepted(text, { tabId: TAB }, "get_page_text");
    expectRejected(text, {}, "get_page_text with no tab");
    expectRejected(text, { tabId: TAB, ref: "t_1" }, "get_page_text with an extra field");
  });

  it("says whether the page's text was cut by a bound", () => {
    const result = contractSchema("agentPageTextResultSchema");
    expectAccepted(result, { text: "hello", truncated: false }, "a whole page");
    expectAccepted(result, { text: "hel", truncated: true }, "a page that was cut");
    // Required, not optional: a read that would not say is a read the agent would believe complete.
    expectRejected(result, { text: "hello" }, "a page that will not say");
  });

  it("reads a page's structure with a filter, a depth and an optional root", () => {
    const read = args("read_page");
    expectAccepted(read, { tabId: TAB }, "read_page with defaults");
    expectAccepted(read, { tabId: TAB, filter: "interactive" }, "read_page interactive");
    expectAccepted(read, { tabId: TAB, filter: "all", depth: 3 }, "read_page all to depth 3");
    expectAccepted(read, { tabId: TAB, ref: "t_1" }, "read_page rooted at a ref");
    expectRejected(read, { tabId: TAB, filter: "visible" }, "read_page with an undeclared filter");
    expectRejected(read, { tabId: TAB, depth: 0 }, "read_page to depth 0");
    expectRejected(read, { tabId: TAB, depth: 1.5 }, "read_page to a fractional depth");
  });

  it("answers read_page with nodes that carry a role, a depth and a ref where one exists", () => {
    const result = contractSchema("agentReadPageResultSchema");
    expectAccepted(
      result,
      { nodes: [{ ref: "t_1", role: "button", name: "Save", depth: 3 }], truncated: false },
      "a node the agent can act on",
    );
    // A node with no ref is a node the runtime cannot deliver an effect to; saying so by omission is
    // the honest shape, and inventing a ref for it would advertise a capability that is not there.
    expectAccepted(result, { nodes: [{ role: "heading", depth: 1 }], truncated: true }, "a node with no ref");
    expectRejected(result, { nodes: [{ ref: "t_1", name: "Save", depth: 1 }], truncated: false }, "a node with no role");
    expectRejected(result, { nodes: [{ role: "button", depth: 1 }] }, "nodes that will not say if cut");
    expectRejected(
      result,
      { nodes: [{ role: "button", depth: 1, html: "<b>x</b>" }], truncated: false },
      "a node carrying markup",
    );
  });

  it("lets a node say what its field holds, and never a value beside redacted or checked (005/T172)", () => {
    const result = contractSchema("agentReadPageResultSchema");
    const node = (fields: Record<string, unknown>) => ({
      nodes: [{ ref: "t_1", role: "textbox", depth: 1, ...fields }],
      truncated: false,
    });
    expectAccepted(result, node({ value: "Ada" }), "a text entry with its value");
    expectAccepted(result, node({ value: "x".repeat(LABEL_BOUND), valueTruncated: true }), "a value cut at the bound");
    expectAccepted(result, node({ checked: true }), "a toggle that is on");
    expectAccepted(result, node({ checked: false }), "a toggle that is off");
    expectAccepted(result, node({ redacted: true }), "a secret field");
    expectAccepted(result, node({ value: "one\ntwo" }), "a textarea with its line break");
    // FR-073: a redacted field carries no value under any circumstances; FR-072: a toggle is not
    // a text entry, so `checked` and `value` never travel together.
    expectRejected(result, node({ value: "hunter2", redacted: true }), "a value beside redacted");
    expectRejected(result, node({ value: "yes", checked: true }), "a value beside checked");
    expectRejected(result, node({ value: "x".repeat(LABEL_BOUND + 1) }), "a value over the label bound");
    expectRejected(result, node({ value: 42 }), "a value that is not a string");
  });

  it("lets a find match carry the same field state as a read node (005/T172, FR-072 scenario 8)", () => {
    const find = contractSchema("agentFindResultSchema");
    const match = (fields: Record<string, unknown>) => ({
      outcome: "resolved",
      matches: [{ ref: "t_1", role: "textbox", label: "Email", ...fields }],
    });
    expectAccepted(find, match({ value: "ada@example.test" }), "a match with its value");
    expectAccepted(find, match({ checked: true }), "a match that is a toggle");
    expectAccepted(find, match({ redacted: true }), "a match that is a secret");
    expectAccepted(find, match({ value: "x".repeat(LABEL_BOUND), valueTruncated: true }), "a match cut at the bound");
    expectRejected(find, match({ value: "hunter2", redacted: true }), "a match with a value beside redacted");
    expectRejected(find, match({ value: "yes", checked: true }), "a match with a value beside checked");
  });

  it("takes a screenshot of a tab, optionally of one region of it", () => {
    const shot = args("screenshot");
    expectAccepted(shot, { tabId: TAB }, "screenshot");
    expectAccepted(shot, { tabId: TAB, region: { x: 0, y: 0, width: 100, height: 80 } }, "screenshot of a region");
    expectRejected(shot, { tabId: TAB, region: { x: 0, y: 0, width: 0, height: 80 } }, "a region with no width");
    expectRejected(shot, { tabId: TAB, region: { x: -1, y: 0, width: 10, height: 10 } }, "a region off the left");
    expectRejected(shot, { tabId: TAB, region: { x: 0, y: 0, width: 10 } }, "a region with no height");
  });

  it("answers a screenshot as a png, and says when a region was not cropped", () => {
    const result = contractSchema("agentScreenshotResultSchema");
    expectAccepted(result, { mimeType: "image/png", data: "iVBORw0K", cropped: true }, "a cropped shot");
    expectAccepted(result, { mimeType: "image/png", data: "iVBORw0K", cropped: false }, "a whole-viewport shot");
    expectRejected(result, { mimeType: "image/jpeg", data: "x", cropped: false }, "a shot in another format");
    expectRejected(result, { mimeType: "image/png", data: "iVBORw0K" }, "a shot that will not say");
  });

  it("keeps find's answer the one the worker already mints, and offers every read tool", () => {
    const find = contractSchema("agentFindResultSchema");
    expectAccepted(
      find,
      { outcome: "resolved", matches: [{ ref: "t_1", role: "button", label: "Save" }] },
      "find with role and name",
    );
    const descriptors = contractExport<ReadonlyArray<{ name: string }>>("AGENT_TOOL_DESCRIPTORS");
    const named = new Set(descriptors.map((descriptor) => descriptor.name));
    for (const tool of ["get_page_text", "read_page", "screenshot", "find"]) {
      expect(named.has(tool), `${tool} must be offered`).toBe(true);
    }
    // FR-038: reading is ungated, so no read tool is in the list the per-site gate governs.
    const gated = contractExport<readonly string[]>("AGENT_EFFECT_TOOL_NAMES");
    for (const tool of ["get_page_text", "read_page", "screenshot", "find"]) {
      expect(gated).not.toContain(tool);
    }
  });
});
