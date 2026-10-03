import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_PERMISSIONS,
  createManifest,
  resolveBuildConfig,
} from "../../apps/extension/src/build-config.js";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 012/S1 — the viewport tool, the scale on a picture, and what a picture now says about itself
 * (FR-156, FR-157, FR-158, FR-162, FR-166).
 *
 * Contracts only, as 008's own first slice was: nothing answers `viewport` yet, and pinning the
 * shape first is what keeps the worker and the host from each inventing their own. The two facts
 * worth stating here rather than in prose are the bounds - a viewport the browser can actually
 * draw - and that every new field on the screenshot answer is *optional*, because an older host in
 * front of a newer worker (and the reverse) is the ordinary state of an installed extension, which
 * is also why the link protocol number does not move for any of this.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T303 the viewport tool", () => {
  it("joins the closed tool list and the batchable steps", () => {
    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    expect(names).toContain("viewport");
    // 013 adds the thirty-third, `upload_image`, 017 the thirty-fourth, `propose_sites`, and 018
    // the three browser tools.
    expect(names).toHaveLength(37);

    // It is about one tab, exactly as `resize_window` is, so it composes inside a batch.
    expect(contractExport<readonly string[]>("AGENT_BATCH_STEP_TOOL_NAMES")).toContain("viewport");

    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    expect(descriptors.find((entry) => entry.name === "viewport")).toBeDefined();
  });

  it("takes a size the browser can draw, and refuses one it cannot", () => {
    const viewport = args("viewport");
    expectAccepted(viewport, { tabId: TAB, action: "set", width: 375, height: 812 }, "a phone width");
    expectAccepted(viewport, { tabId: TAB, action: "reset" }, "putting the page back");

    expectRejected(viewport, { tabId: TAB, action: "set", width: 319, height: 812 }, "under the floor");
    expectRejected(viewport, { tabId: TAB, action: "set", width: 4097, height: 812 }, "over the ceiling");
    // A `set` is a size; half of one would leave the worker to pick the other half.
    expectRejected(viewport, { tabId: TAB, action: "set", width: 375 }, "a set without a height");
    expectRejected(viewport, { tabId: TAB, action: "reset", width: 375, height: 812 }, "a reset with a size");
  });

  it("answers with the size and whether it is the browser's own", () => {
    const result = contractSchema("agentViewportResultSchema");
    expectAccepted(result, { width: 375, height: 812, emulated: true }, "an emulated viewport");
    expectAccepted(result, { width: 1187, height: 707, emulated: false }, "the real one, after a reset");
    expectRejected(result, { width: 375, height: 812 }, "a size that does not say which it is");
  });
});

describe("T303 the picture's scale and its measurements", () => {
  /**
   * 012/S2c F8 - the dial is useless if the description does not say what it does to the numbers.
   *
   * `scale` is the answer to a picture too large for one frame, and the one thing an agent must not
   * conclude from it is that its coordinates moved: a click is still aimed in the viewport the
   * answer's `frame` names. The refusal for a region outside that frame belongs here too - it is a
   * refusal the agent can avoid entirely by reading one sentence.
   */
  it("says what `scale` shrinks, which frame coordinates stay in, and what an outside region gets", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    const screenshot = descriptors.find((entry) => entry.name === "screenshot")?.description ?? "";

    expect(screenshot).toContain("`scale`");
    expect(screenshot).toContain("0.1");
    expect(screenshot).toContain("`frame`");
    expect(screenshot).toMatch(/refused/);
  });


  it("takes a scale between a tenth and the whole, and nothing outside it", () => {
    const screenshot = args("screenshot");
    expectAccepted(screenshot, { tabId: TAB, scale: 0.5 }, "half size");
    expectAccepted(screenshot, { tabId: TAB }, "no scale at all");
    // Under a tenth the picture is not a picture of anything; over 1 it is an upscale of pixels
    // that were never taken.
    expectRejected(screenshot, { tabId: TAB, scale: 0.05 }, "a twentieth");
    expectRejected(screenshot, { tabId: TAB, scale: 1.5 }, "larger than life");
  });

  it("carries what the picture is of, and still accepts the answer an older worker sends", () => {
    const result = contractSchema("agentScreenshotResultSchema");
    expectAccepted(
      result,
      {
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
        cropped: true,
        width: 600,
        height: 200,
        scale: 1,
        frame: { width: 1200, height: 800 },
        coverage: "region",
        region: { x: 100, y: 200, width: 300, height: 100 },
      },
      "a region at native density",
    );
    expectAccepted(
      result,
      { mimeType: "image/png", data: "iVBORw0KGgo=", cropped: false, width: 2560, height: 1440, coverage: "viewport" },
      "the whole emulated viewport",
    );
    // Every field is additive: a worker that predates this slice answers the three it always did.
    expectAccepted(
      result,
      { mimeType: "image/png", data: "iVBORw0KGgo=", cropped: false },
      "the answer 005 sent",
    );
    expectRejected(
      result,
      { mimeType: "image/png", data: "iVBORw0KGgo=", cropped: false, coverage: "page" },
      "a coverage nobody declared",
    );
  });
});

describe("T303 the card's line and the artefact", () => {
  it("lets a card say a viewport was set and cleared", () => {
    const item = contractSchema("agentActivityItemSchema");
    expectAccepted(
      item,
      { at: 1_757_000_000_000, kind: "viewport", outcome: "set", message: "375x812" },
      "the line for a set",
    );
    expectAccepted(item, { at: 1_757_000_000_000, kind: "viewport", outcome: "cleared" }, "the line for a clear");
    expectRejected(item, { at: 1_757_000_000_000, kind: "viewport", outcome: "resized" }, "an outcome nobody declared");
  });

  it("buys no new permission for any of it", () => {
    // The emulation rides on the debugger attachment the session already makes for input; nothing
    // here asks Chrome for a capability the owner has not already seen in the install prompt.
    expect([...AGENT_PROFILE_PERMISSIONS]).toEqual([
      "activeTab",
      "scripting",
      "sidePanel",
      "storage",
      "nativeMessaging",
      "tabs",
      "tabGroups",
      "alarms",
      "debugger",
      "downloads",
      "offscreen",
    ]);
    const agent = createManifest(resolveBuildConfig("agent"));
    expect(agent.permissions).toEqual([...AGENT_PROFILE_PERMISSIONS]);
    expect(agent.host_permissions ?? []).toEqual(["<all_urls>", "https://localhost/*"]);
  });

  it("does not move the link protocol number for an additive change", () => {
    // 012: the new fields are optional and the new tool is simply absent from an older offering, so
    // an old relay in front of a new host keeps working. The stamp is a floor for shapes both sides
    // must agree on, and neither side has to agree on anything new here.
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});
