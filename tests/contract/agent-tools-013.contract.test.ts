import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_PERMISSIONS,
  createManifest,
  resolveBuildConfig,
} from "../../apps/extension/src/build-config.js";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 013/S1 — `upload_image`: the screenshot this session already took, put into a page (FR-167,
 * FR-169, FR-172, FR-176).
 *
 * There are *two* argument shapes here rather than one, for the same reason `file_upload` has two:
 * the agent names a picture it was given (`imageId`), and the worker is handed bytes. Between them
 * is the host, which is the only end that has the picture at all - so the id is not a field the
 * worker-facing schema is merely uninterested in, it is one it cannot express. Pinning both here is
 * what stops the host and the worker each inventing their own half of the translation.
 *
 * The other fact worth stating rather than implying: nothing in this feature buys a permission. A
 * screenshot the agent already received, delivered into a page the site's own mode gates, needs no
 * capability the owner has not already seen.
 */

const TAB = 7;
const REF = "tgt-1";
const IMAGE = "img_a1b2c3d4e5";
const BYTES = "iVBORw0KGgo=";

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T325 the upload_image tool", () => {
  it("joins the closed tool list and the batchable steps, beside file_upload", () => {
    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    expect(names).toContain("upload_image");
    // 017 adds the thirty-fourth, `propose_sites`, and 018 the three browser tools.
    expect(names).toHaveLength(37);

    // Parity with `file_upload` (R-181): putting a file into a page is one step of a batch, and
    // the two tools differ only in where the bytes came from.
    const steps = contractExport<readonly string[]>("AGENT_BATCH_STEP_TOOL_NAMES");
    expect(steps).toContain("upload_image");
    expect(steps).toContain("file_upload");

    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    expect(descriptors.find((entry) => entry.name === "upload_image")).toBeDefined();
  });

  it("takes a picture and exactly one place to put it, from the agent", () => {
    const request = contractSchema("agentUploadImageRequestSchema");

    expectAccepted(request, { tabId: TAB, imageId: IMAGE, ref: REF }, "into an input named by ref");
    expectAccepted(
      request,
      { tabId: TAB, imageId: IMAGE, coordinate: { x: 120, y: 340 }, filename: "a.png" },
      "dropped at a point, under a name the agent chose",
    );

    // "Both" would be asking the host to pick, which is a choice that belongs to neither of them;
    // "neither" names no target at all. The same refusal answers each (`invalid-arguments`).
    expectRejected(
      request,
      { tabId: TAB, imageId: IMAGE, ref: REF, coordinate: { x: 1, y: 2 } },
      "a ref and a coordinate together",
    );
    expectRejected(request, { tabId: TAB, imageId: IMAGE }, "neither a ref nor a coordinate");

    // A separator would make the name a path, and a path is not what a page shows.
    expectRejected(request, { tabId: TAB, imageId: IMAGE, ref: REF, filename: "a/b.png" }, "a forward slash");
    expectRejected(request, { tabId: TAB, imageId: IMAGE, ref: REF, filename: "a\\b.png" }, "a backslash");
  });

  it("names the picture `screenshot.png` when the agent does not", () => {
    const request = contractExport<{ parse: (input: unknown) => { filename: string } }>(
      "agentUploadImageRequestSchema",
    );
    expect(request.parse({ tabId: TAB, imageId: IMAGE, ref: REF }).filename).toBe("screenshot.png");
  });

  it("hands the worker bytes and a target, and no id at all", () => {
    const worker = args("upload_image");

    expectAccepted(
      worker,
      { tabId: TAB, target: { ref: REF }, file: { name: "screenshot.png", type: "image/png", bytesBase64: BYTES } },
      "bytes for an input",
    );
    expectAccepted(
      worker,
      {
        tabId: TAB,
        target: { coordinate: { x: 120, y: 340 } },
        file: { name: "screenshot.png", type: "image/png", bytesBase64: BYTES },
      },
      "bytes for a drop point",
    );

    // Not merely uninteresting to the worker: unexpressible. The picture is the host's to resolve.
    expectRejected(
      worker,
      { tabId: TAB, imageId: IMAGE, target: { ref: REF }, file: { name: "a.png", type: "image/png", bytesBase64: BYTES } },
      "an id smuggled past the host",
    );
    // The frame's own bound, the same number `file_upload`'s total is held to.
    const bound = contractExport<number>("AGENT_UPLOAD_MAX_BASE64_CHARS");
    expectRejected(
      worker,
      { tabId: TAB, target: { ref: REF }, file: { name: "a.png", type: "image/png", bytesBase64: "a".repeat(bound + 1) } },
      "more than one frame can carry",
    );
  });

  it("answers with how the picture was delivered and what the page holds", () => {
    const result = contractSchema("agentUploadImageResultSchema");

    expectAccepted(result, { delivery: "input", file: { name: "screenshot.png", size: 8 } }, "read back from an input");
    expectAccepted(
      result,
      { delivery: "drop", file: { name: "screenshot.png", size: 8 }, point: { x: 120, y: 340 } },
      "echoed from a drop",
    );
    expectRejected(result, { delivery: "paste", file: { name: "a.png", size: 8 } }, "a delivery nobody declared");
    expectRejected(result, { delivery: "input" }, "a delivery with no file");
  });

  it("buys no new permission for any of it", () => {
    // The picture is one the agent already received and the page change is gated by the site's own
    // mode; nothing here asks Chrome for a capability the owner has not already seen.
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

  /**
   * 013/T337 — the one line the panel's activity list gets for an upload (FR-174).
   *
   * FR-174 asks for it in the same breath as the consent card: putting a picture into the owner's
   * page is something that happened to their browser, and the card is where they read afterwards
   * what a session did while they were looking elsewhere. The item carries the *pieces* as every
   * other kind does - `message` is the delivery the page reported, `input` or `drop`, and the panel
   * writes the sentence - so no worker English reaches the card.
   */
  it("lets a card say a picture was delivered into a page", () => {
    const item = contractSchema("agentActivityItemSchema");

    expectAccepted(
      item,
      { at: 1_757_000_000_000, kind: "upload", outcome: "delivered", site: "fixtures.test", message: "input" },
      "put into a form",
    );
    expectAccepted(
      item,
      { at: 1_757_000_000_000, kind: "upload", outcome: "delivered", message: "drop" },
      "dropped on a page whose site the worker did not resolve",
    );
    expectRejected(
      item,
      { at: 1_757_000_000_000, kind: "upload", outcome: "uploaded" },
      "an outcome nobody declared",
    );
  });

  /**
   * 013/S4 (R-184, FR-168) — which run of the browser answered a pairing request.
   *
   * The retention has to survive a worker recycling and end when the browser exits, and on the link
   * those two look the same: Chrome recycling the service worker kills the native host with it. The
   * worker's own `chrome.storage.session` is the one thing whose lifetime is exactly the difference,
   * so an opaque id kept there and carried on this frame is what the host compares. Optional in the
   * shape on purpose: an extension from before this field is a worker that cannot tell the host
   * which run it is, and the host then keeps clearing on the link as S1 did.
   */
  it("lets the worker name its browser run on a pairing answer", () => {
    const frame = contractSchema("agentControlFrameSchema");
    const answer = { type: "pair-result", agentId: "claude-code", sessionId: "session-1", accepted: true };

    expectAccepted(frame, { ...answer, browserRunId: "3f1a9c0e-run" }, "an answer naming its browser run");
    expectAccepted(frame, answer, "an answer from a worker that predates the field");
    expectAccepted(frame, { ...answer, browserRunId: "r".repeat(64) }, "a run id at the bound");

    // The bound and the emptiness rule are the whole of what the host may assume about it: it is
    // compared, never parsed, and an empty id would compare equal to another empty one - two
    // different browsers reading as the same run, which is the one mistake that loses a picture's
    // honesty in the wrong direction.
    expectRejected(frame, { ...answer, browserRunId: "" }, "an empty browser run");
    expectRejected(frame, { ...answer, browserRunId: "r".repeat(65) }, "a run id past the bound");
    expectRejected(frame, { ...answer, browserRunId: 7 }, "a browser run that is not a string");
  });

  it("does not move the link protocol number for an additive change", () => {
    // A worker that predates this slice is simply never sent the tool, and a host that predates it
    // never mints an id: neither end has to agree on anything new, so the floor does not move.
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});

/**
 * 013/T338 — the four descriptions that have to carry the id from one tool to another (FR-176).
 *
 * `upload_image` is the one tool of this product an agent cannot discover by trying: the picture it
 * needs is one it was already handed, and the only way it learns that is a sentence. So the
 * sentences are the feature's interface, pinned here as fragments the way 012's steering was - an
 * editor may rewrite the prose around them, but an `imageId` dropped out of the `screenshot`
 * description leaves an agent holding a picture it has no way to use, with nothing failing.
 *
 * Four tools, because there are four places an agent can be standing when it needs to know:
 * looking at a screenshot's answer (`screenshot`, `computer`), looking for a way to attach a file it
 * has (`file_upload`, which would otherwise have it write the picture to disk), and reading
 * `upload_image` itself, which has to say what it takes and for how long.
 */
describe("T338 the descriptions that carry the id", () => {
  function descriptionOf(name: string): string {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    const found = descriptors.find((entry) => entry.name === name);
    expect(found, `AGENT_TOOL_DESCRIPTORS must carry '${name}'`).toBeDefined();
    return found!.description;
  }

  it("tells the agent what upload_image takes, where it can put it, and for how long", () => {
    const upload = descriptionOf("upload_image");
    // What it is for, and the one field it cannot work without.
    expect(upload).toContain("screenshot");
    expect(upload).toContain("imageId");
    // The two places, both of them, because an agent told only about inputs cannot use a page that
    // takes dragged files - and one told only about points would drop on a form.
    expect(upload).toContain("ref");
    expect(upload).toContain("coordinate");
    // How long it has, in the words the host's own sentence uses (FR-168).
    expect(upload).toContain("5 minutes");
    // And which tool the *other* kind of file belongs to, so the owner's disk stays out of this one.
    expect(upload).toContain("file_upload");
  });

  it("points file_upload at upload_image for a picture that needs no path", () => {
    expect(descriptionOf("file_upload")).toContain("upload_image");
  });

  it("says on both screenshot answers that they carry an id", () => {
    // `computer` as well as `screenshot`: its screenshot action answers the same shape, so an agent
    // that only ever aims by point reads its id there or nowhere.
    for (const name of ["screenshot", "computer"]) {
      expect(descriptionOf(name), name).toContain("imageId");
    }
  });
});
