import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 003/T039 — the tab tools' closed shapes (US4, FR-044..FR-046).
 *
 * These are the only tools that bring a tab into the agent's world or take one out of it, so the
 * shapes here are what bound that world. Two of them are pinned nowhere else: `navigate` takes a
 * destination *or* a history direction and never both - "go back to this url" is not a thing the
 * browser can do and an agent that asked for it would be told something happened that did not - and
 * a navigable url is refused when its scheme would turn a navigation into script execution.
 *
 * `tabs_context` gains `active` here: the agent owns several tabs and only one of them is the one
 * `captureVisibleTab` can see, so which is active is a fact the agent has to be able to read rather
 * than infer.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T039 agent tab tool contracts", () => {
  it("creates a tab with an optional url and nothing else", () => {
    const create = args("tabs_create");
    expectAccepted(create, {}, "tabs_create with no url");
    expectAccepted(create, { url: "https://example.test/page" }, "tabs_create with a url");
    expectAccepted(create, { url: "about:blank" }, "tabs_create with about:blank");
    expectRejected(create, { url: "" }, "tabs_create with an empty url");
    expectRejected(create, { url: "not a url" }, "tabs_create with a non-url");
    expectRejected(create, { tabId: TAB }, "tabs_create naming a tab");
  });

  it("refuses a url whose scheme would run script instead of navigating", () => {
    const create = args("tabs_create");
    const navigate = args("navigate");
    for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>"]) {
      // FR-045 lets an agent tab go anywhere the owner's browser can go, which is a *navigation*.
      // These two schemes execute in the destination's own context instead, so they are refused at
      // the contract rather than left to whichever Chrome API happens to notice.
      expectRejected(create, { url }, `tabs_create to ${url}`);
      expectRejected(navigate, { tabId: TAB, url }, `navigate to ${url}`);
    }
  });

  it("closes exactly one named tab", () => {
    const close = args("tabs_close");
    expectAccepted(close, { tabId: TAB }, "tabs_close");
    expectRejected(close, {}, "tabs_close with no tab");
    expectRejected(close, { tabId: TAB, url: "https://example.test/" }, "tabs_close with an extra field");
  });

  it("navigates to a url or through history, never both and never neither", () => {
    const navigate = args("navigate");
    expectAccepted(navigate, { tabId: TAB, url: "https://example.test/one" }, "navigate to a url");
    expectAccepted(navigate, { tabId: TAB, direction: "back" }, "navigate back");
    expectAccepted(navigate, { tabId: TAB, direction: "forward" }, "navigate forward");
    expectRejected(navigate, { tabId: TAB }, "navigate with no destination");
    expectRejected(
      navigate,
      { tabId: TAB, url: "https://example.test/one", direction: "back" },
      "navigate to a url and back at once",
    );
    expectRejected(navigate, { tabId: TAB, direction: "reload" }, "navigate in an undeclared direction");
    expectRejected(navigate, { url: "https://example.test/one" }, "navigate with no tab");
  });

  it("resizes the window holding a tab, within bounds a window can have", () => {
    const resize = args("resize_window");
    expectAccepted(resize, { tabId: TAB, width: 1024, height: 768 }, "resize_window");
    expectRejected(resize, { tabId: TAB, width: 1024 }, "resize_window with no height");
    expectRejected(resize, { tabId: TAB, width: 0, height: 768 }, "resize_window to nothing");
    expectRejected(resize, { tabId: TAB, width: 1024.5, height: 768 }, "resize_window to a fractional width");
  });

  it("lists a session's tabs with the one the owner is looking at marked", () => {
    const schema = contractSchema("agentTabViewSchema");
    // 004/T105b widened the row: FR-060 lists a tab by title as well as by address.
    expectAccepted(schema, { tabId: TAB, url: "https://example.test/", title: "Example", active: true }, "an active tab");
    expectAccepted(schema, { tabId: TAB, url: "https://example.test/", title: "Example", active: false }, "an inactive tab");
    expectRejected(schema, { tabId: TAB, url: "https://example.test/", title: "Example" }, "a tab that will not say");
  });

  it("answers each tab tool with the fact the agent needs next", () => {
    expectAccepted(contractSchema("agentTabsCreateResultSchema"), { tabId: TAB }, "tabs_create result");
    expectAccepted(contractSchema("agentTabsCloseResultSchema"), { closed: true }, "tabs_close result");
    // `false` is not a result: a close that did not happen is an outcome, not an `ok` carrying a no.
    expectRejected(contractSchema("agentTabsCloseResultSchema"), { closed: false }, "a close that did not close");
    expectAccepted(
      contractSchema("agentNavigateResultSchema"),
      { url: "https://example.test/two" },
      "navigate result",
    );
    expectAccepted(
      contractSchema("agentResizeWindowResultSchema"),
      { width: 1024, height: 768 },
      "resize_window result",
    );
  });

  /**
   * 005/US2 (T187 B19): a url the browser downloads rather than renders never commits, so a
   * navigation there reports the download it became instead of running to its bound. The state is
   * the record's own, `in_progress` included - the answer is given when the download *begins*.
   */
  it("lets a navigation report the download it became", () => {
    const schema = contractSchema("agentNavigateResultSchema");
    const download = {
      id: 12,
      filename: "C:\\Users\\owner\\Downloads\\master.zip",
      url: "https://example.test/archive/master.zip",
      state: "in_progress",
    };
    expectAccepted(schema, { url: "https://example.test/", download }, "a navigation that became a download");
    expectAccepted(schema, { url: "https://example.test/", download: { ...download, state: "complete" } }, "one already over");
    expectRejected(schema, { url: "https://example.test/", download: { ...download, state: "paused" } }, "a state nobody declared");
    expectRejected(
      schema,
      { url: "https://example.test/", download: { ...download, bytesReceived: 0 } },
      "a field the navigation's answer does not carry",
    );
  });

  it("offers every tab tool to the agent from the same table the worker parses", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; inputShape: Record<string, unknown> }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    const named = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    for (const tool of ["tabs_create", "tabs_close", "navigate", "resize_window"]) {
      expect(named.get(tool), `${tool} must be offered`).toBeDefined();
    }
    // A navigation the browser turned into a download says so (005/US2).
    expect((named.get("navigate") as { description?: string } | undefined)?.description).toContain("download");
    // The gate governs effects only; a tab tool never enters it (FR-045).
    expect(contractExport<readonly string[]>("AGENT_EFFECT_TOOL_NAMES")).not.toContain("navigate");
  });
});
