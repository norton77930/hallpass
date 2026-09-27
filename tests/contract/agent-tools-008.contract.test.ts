import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_EXTENSION_VERSION,
  AGENT_PROFILE_PERMISSIONS,
  createManifest,
  resolveBuildConfig,
} from "../../apps/extension/src/build-config.js";
import { SERVER_VERSION } from "../../packages/agent-host/src/tool-offering.js";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 008/S1 — the two new tools, the changed answers and the artefact's identity (FR-100 shape,
 * FR-121, FR-122).
 *
 * Contracts only: nothing answers `gif_recorder` or `dialog` yet, and that is the point of pinning
 * them here first. What is closed at this slice is the *shape* the later slices must fill - the
 * file name an export may be asked for, what a dialog looks like when it blocks a call, the eight
 * new refusals, and the one place the version of the agent artefact is written down.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

const DIALOG = {
  id: "d1",
  type: "confirm",
  message: "Delete this item?",
  openedAt: 1_757_000_000_000,
  tabId: TAB,
};

describe("T223 export bound", () => {
  it("gives a recording export the encoder's bound, every other recorder action the flat one", () => {
    const bound = contractExport<(tool: string, args: Record<string, unknown>) => number>("agentCallBoundMs");
    const flat = contractExport<number>("AGENT_CALL_TIMEOUT_MS");
    const exportBound = contractExport<number>("AGENT_EXPORT_CALL_TIMEOUT_MS");
    const cap = contractExport<number>("AGENT_MAX_CALL_TIMEOUT_MS");
    expect(bound("gif_recorder", { action: "export", filename: "TC-1" })).toBe(exportBound);
    expect(bound("gif_recorder", { action: "start" })).toBe(flat);
    expect(exportBound).toBeGreaterThan(flat);
    expect(exportBound).toBeLessThanOrEqual(cap);
  });
});

describe("T207 the 008 tool contracts", () => {
  it("adds recording and dialog answering to the closed tool list", () => {
    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    expect(names).toContain("gif_recorder");
    expect(names).toContain("dialog");
    // 012 adds the thirty-second, `viewport`, and 013 the thirty-third, `upload_image`; the count
    // itself is pinned by each of those slices' own tests.
    expect(names).toHaveLength(33);

    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    for (const name of ["gif_recorder", "dialog"]) {
      const descriptor = descriptors.find((entry) => entry.name === name);
      expect(descriptor, `the host describes ${name} to the agent`).toBeDefined();
    }
    // The description is what a coding agent reads before it spends a call, so the two facts it
    // cannot discover by trying are said in it: where the file lands, and what `dismiss` costs.
    const recorder = descriptors.find((entry) => entry.name === "gif_recorder");
    expect(recorder?.description).toContain("download");
    const dialog = descriptors.find((entry) => entry.name === "dialog");
    expect(dialog?.description).toContain("blocked-by-dialog");
  });

  it("takes a file name a folder cannot hide in and refuses the extension it appends", () => {
    const recorder = args("gif_recorder");
    for (const action of ["start", "stop", "export", "clear"]) {
      expectAccepted(recorder, { action }, `action ${action}`);
    }
    expectRejected(recorder, { action: "pause" }, "an action nobody declared");
    expectRejected(recorder, { action: "export", tabId: TAB }, "a tab: a recording is the session's");

    for (const filename of ["TC-1234", "run 01", "a.b_c-d"]) {
      expectAccepted(recorder, { action: "export", filename }, `file name '${filename}'`);
    }
    for (const filename of [".hidden", "../x", "a/b", "x\\y", "name.gif", "n".repeat(81), ""]) {
      expectRejected(recorder, { action: "export", filename }, `file name '${filename}'`);
    }

    const pattern = contractExport<RegExp>("AGENT_RECORDING_FILENAME_PATTERN");
    expect(pattern.test("TC-1234")).toBe(true);
    expect(pattern.test("a/b")).toBe(false);
  });

  it("answers a dialog on one named tab, with text only where a prompt asks for it", () => {
    const dialog = args("dialog");
    expectAccepted(dialog, { tabId: TAB, action: "accept" }, "accepting a confirm");
    expectAccepted(dialog, { tabId: TAB, action: "dismiss" }, "dismissing");
    expectAccepted(dialog, { tabId: TAB, action: "accept", promptText: "Ada" }, "answering a prompt");
    expectRejected(dialog, { tabId: TAB, action: "close" }, "an action nobody declared");
    expectRejected(dialog, { action: "accept" }, "a dialog with no tab");
    expectRejected(dialog, { tabId: TAB, action: "accept", promptText: "x".repeat(2_001) }, "an over-long answer");
  });

  it("carries a blocked call's evidence in the refusal the agent reads", () => {
    const refusal = contractSchema("agentRefusalSchema");
    expectAccepted(refusal, { reason: "blocked-by-dialog", dialog: DIALOG }, "a call a dialog blocked");
    expectRejected(refusal, { reason: "blocked-by-dialog" }, "a block that will not say which dialog");
    expectAccepted(refusal, { reason: "blocked-by-beforeunload", url: "https://shop.test/cart" }, "a page asking to stay");
    expectRejected(refusal, { reason: "blocked-by-beforeunload" }, "a stay with no page");
    for (const reason of ["no-dialog", "page-unresponsive", "invalid-filename", "empty-recording", "refused"]) {
      expectAccepted(refusal, { reason }, `refusal ${reason}`);
    }
    // `download-failed` is the one new refusal with something to say, and it says it in a bounded
    // field of its own: the discriminant is called `reason` already, exactly as `input-unavailable`
    // found when it had to spell its cause `unavailableReason`.
    expectAccepted(refusal, { reason: "download-failed", downloadReason: "USER_CANCELED" }, "a download the browser stopped");
    expectRejected(refusal, { reason: "download-failed" }, "a failure with no cause");
    expectRejected(refusal, { reason: "no-dialog", dialog: DIALOG }, "a dialog on a refusal that has none");
  });

  it("describes the dialog the page opened, and what it followed", () => {
    const dialog = contractSchema("currentDialogSchema");
    expectAccepted(dialog, DIALOG, "an unchained confirm");
    expectAccepted(
      dialog,
      { ...DIALOG, chainedTo: { tool: "click", approvedAt: 1_756_999_999_400 } },
      "a dialog that followed an approved click",
    );
    expectAccepted(dialog, { ...DIALOG, type: "prompt", defaultValue: "Ada" }, "a prompt with its default");
    for (const type of ["alert", "confirm", "prompt", "beforeunload"]) {
      expectAccepted(dialog, { ...DIALOG, type }, `a ${type}`);
    }
    expectRejected(dialog, { ...DIALOG, type: "onbeforeunload" }, "a type nobody declared");
    expectRejected(dialog, { ...DIALOG, message: "m".repeat(4_001) }, "a page-written message with no bound");
    expectRejected(dialog, { ...DIALOG, url: "https://shop.test/" }, "a field the dialog event does not carry");
  });

  it("bounds a recording at the frames it can hold", () => {
    const recording = contractSchema("recordingStateSchema");
    expectAccepted(recording, { state: "recording", frames: 12, skipped: 0, full: false }, "an open recording");
    expectAccepted(recording, { state: "stopped", frames: 200, skipped: 3, full: true }, "a full recording");
    expectAccepted(recording, { state: "none", frames: 0, skipped: 0, full: false }, "no recording");
    expectRejected(recording, { state: "recording", frames: 201, skipped: 0, full: false }, "a frame past the cap");
    expectRejected(recording, { state: "recording", frames: 12, skipped: -1, full: false }, "negative skips");
    expectRejected(recording, { state: "paused", frames: 0, skipped: 0, full: false }, "a state nobody declared");
  });

  it("lets an answer carry the recording it is part of and the dialog it raised", () => {
    const effect = contractSchema("agentEffectResultSchema");
    const observed = {
      effect: "activated",
      documentChanged: false,
      verified: true,
      verdict: "verified",
    };
    expectAccepted(effect, { observed }, "an effect outside a recording");
    expectAccepted(
      effect,
      { observed, recording: { state: "recording", frames: 4, skipped: 0, full: false } },
      "an effect inside a recording",
    );
    expectAccepted(effect, { observed, dialog: DIALOG }, "an effect that raised a dialog");

    const screenshot = contractSchema("agentScreenshotResultSchema");
    expectAccepted(
      screenshot,
      { mimeType: "image/png", data: "iVBOR", cropped: false, recording: { state: "recording", frames: 1, skipped: 0, full: false } },
      "a screenshot inside a recording",
    );
    const navigate = contractSchema("agentNavigateResultSchema");
    expectAccepted(navigate, { url: "https://shop.test/", dialog: DIALOG }, "a navigation a dialog interrupted");
    const upload = contractSchema("agentUploadResultSchema");
    expectAccepted(upload, { files: [], recording: { state: "stopped", frames: 200, skipped: 0, full: true } }, "an upload in a full recording");
    const resize = contractSchema("agentResizeWindowResultSchema");
    expectAccepted(resize, { width: 1024, height: 768, dialog: DIALOG }, "a resize beside a dialog");
  });

  it("ends a wait that a dialog stopped, saying which dialog", () => {
    const wait = contractSchema("agentWaitResultSchema");
    expectAccepted(wait, { outcome: "condition-met", waitedMs: 640 }, "a met condition");
    expectAccepted(wait, { outcome: "condition-unmet", waitedMs: 640, dialog: DIALOG }, "a wait a dialog ended");
    expectRejected(wait, { outcome: "condition-unmet", waitedMs: 640 }, "an unmet wait that will not say why");
    expectRejected(wait, { outcome: "bound-reached", waitedMs: 5_000 }, "a bound as if it were a result");
  });

  it("lets navigate and tabs_close leave a page that asked to stay", () => {
    expectAccepted(args("navigate"), { tabId: TAB, url: "https://shop.test/", force: true }, "a forced navigation");
    expectAccepted(args("tabs_close"), { tabId: TAB, force: true }, "a forced close");
    expectAccepted(args("navigate"), { tabId: TAB, url: "https://shop.test/" }, "a navigation that stays by default");
    expectRejected(args("tabs_close"), { tabId: TAB, force: "yes" }, "force as anything but a decision");
  });
});

describe("T208 the agent artefact's permission and version", () => {
  it("adds exactly one permission, for the encoder and nothing else", () => {
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
  });

  it("writes the agent artefact's version once, and the host answers with the same one", () => {
    expect(AGENT_EXTENSION_VERSION).toBe("0.9.0");
    const agent = createManifest(resolveBuildConfig("agent"));
    expect(agent.version).toBe(AGENT_EXTENSION_VERSION);
    // FR-122: the extension and the host it talks to are one release. Two literals that may not
    // disagree are exactly what a contract test is for.
    expect(SERVER_VERSION).toBe(AGENT_EXTENSION_VERSION);
  });
});

/**
 * 008/T214 (FR-121): the encoder's document ships with the agent build and with nothing else.
 *
 * The permission list above says the build *may* open an offscreen document; this says the document
 * it would open is actually in the artefact. That is a fact about files on disk, so it is read off
 * the built directory - and skipped, rather than failed, when a run has not built it.
 */
describe("T214 the offscreen document in the built artefact", () => {
  const agentDist = resolve("apps/extension/dist/agent");
  const built = existsSync(agentDist);

  it.skipIf(!built)("puts the document and its bundle at the agent artefact's root", () => {
    // `offscreen.html` at the root, not at `src/offscreen/index.html`, because that is the url
    // `chrome.offscreen.createDocument` is given and Chrome resolves it against the extension root.
    expect(existsSync(resolve(agentDist, "offscreen.html"))).toBe(true);
    expect(existsSync(resolve(agentDist, "offscreen.js"))).toBe(true);
  });
});
