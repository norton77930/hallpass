import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings, PAGE_NOT_RESPONDING_HINT } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createAgentUpload } from "../src/service-worker/agent-tools/upload.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { frameAnswerText } from "../src/service-worker/agent-tools/site-recheck.js";
import { fakePointPage, pointSiteAttachments, type FakeFrame } from "./helpers/point-site.js";

/**
 * 003/T062 — `file_upload` inside the worker (US7, FR-051).
 *
 * The worker's half of the boundary is what is asserted here: it receives *bytes*, never a path, so
 * there is nothing in this module that could read a file even if it wanted to. What it does own is
 * the same consent every other page change passes - putting a file into a form is a change to the
 * page, so the site's mode decides it exactly as it decides a click - and the evidence rule: the
 * answer is what the input is holding afterwards, read from the page, never an echo of the request.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/form`;

function installChrome(): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
    scripting: { async executeScript() {} },
    tabs: {
      // Page zoom (R-282): 100 %, as the tests were written for; an unreadable one is no frame.
      async getZoom() {
        return 1;
      },
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

const RECEIPT = { name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" };

function harness(overrides: Partial<Parameters<typeof createAgentUpload>[0]> = {}) {
  const setFiles = vi.fn(async () => ({ ok: true as const, files: [{ name: "receipt.txt", size: 5 }] }));
  const siteModes = createSiteModeStore();
  const prompts = createAgentPromptController({ timeoutMs: 60 });
  const runner = createAgentUpload({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    setFiles: setFiles as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["setFiles"]>,
    ...overrides,
  });
  return { runner, setFiles, siteModes, prompts };
}

function request(files = [RECEIPT]): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-h1",
    tool: "file_upload",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ref: "t_attachment", files },
  };
}

describe("T062 agent file upload", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("puts the bytes on the input and answers with what the page is holding", async () => {
    const { runner, setFiles, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(request());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { files: [{ name: "receipt.txt", size: 5 }] },
    });
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({ targetHandle: "t_attachment", files: [RECEIPT], tab: AGENT_TAB }),
    );
  });

  it("asks the owner first on a site they have not waved through, and uploads nothing if they refuse", async () => {
    const { runner, setFiles, prompts } = harness();

    const pending = runner.run(request());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    // Putting a file into a form is a change to the page, so it is the site mode's to decide.
    expect(prompts.current()).toMatchObject({ site: SITE, tool: "file_upload" });
    expect(setFiles).not.toHaveBeenCalled();

    prompts.decide(prompts.current()?.promptId ?? "", false);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    expect(setFiles).not.toHaveBeenCalled();
  });

  /** 014/T356 (FR-179): interrupted is the stopped outcome with its own word, never a decline. */
  it("answers owner-interrupted when the owner interrupts the session while its prompt stands", async () => {
    const { runner, setFiles, prompts, siteModes } = harness();

    const pending = runner.run(request());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    prompts.cancelSession("session-h1", "interrupted");

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "stopped", reason: "owner-interrupted" });
    expect(setFiles).not.toHaveBeenCalled();
    await expect(siteModes.list()).resolves.toEqual([]);
  });

  it("addresses frame 0 with the binding's own identity on a page with no other frames (004/T160 regression)", async () => {
    const { runner, setFiles, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(request());

    // No frame-discovery machinery leaks a frame identity into a single-document page's call - it
    // stays exactly what it was before T160.
    expect(setFiles).toHaveBeenCalledWith(
      expect.not.objectContaining({ frameId: expect.anything() }),
    );
    expect(setFiles).toHaveBeenCalledWith(
      expect.not.objectContaining({ frameOrigin: expect.anything() }),
    );
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({ documentEpoch: "doc-1", canonicalOrigin: SITE }),
    );
  });

  it("threads a nested frame's own identity into the file delivery, not the binding's (004/T160)", async () => {
    const discoverFrame = vi.fn(async () => ({
      frameId: 3,
      documentEpoch: "doc-frame-3",
      canonicalOrigin: "https://embed.test",
    }));
    const { runner, setFiles, siteModes } = harness({
      discoverFrame: discoverFrame as unknown as NonNullable<
        Parameters<typeof createAgentUpload>[0]["discoverFrame"]
      >,
      // 030/T895: the frame's site decides, and the browser names it as the frame's own.
      probeFrameSender: async (_tabId, frameId) => ({
        documentId: "bdoc-3",
        sender: { origin: "https://embed.test", frameId, documentId: "bdoc-3" },
      }),
    });
    await siteModes.set("https://embed.test", { mode: "skip-checks" });

    const response = await runner.run(request());

    expect(response.outcome).toBe("ok");
    expect(discoverFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), "t_attachment");
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 3,
        documentEpoch: "doc-frame-3",
        frameOrigin: "https://embed.test",
        canonicalOrigin: SITE,
      }),
    );
  });

  it("refuses a tab the session does not own, before anything reaches a page", async () => {
    const { runner, setFiles, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "file_upload",
      tabId: 99,
      args: { tabId: 99, ref: "t_attachment", files: [RECEIPT] },
    });

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(setFiles).not.toHaveBeenCalled();
  });

  it("names what the page refused: a ref that is not a file input, and one it no longer knows", async () => {
    for (const [reason, outcome, expected] of [
      ["not-a-file-input", "not-actionable", "not-a-file-input"],
      ["stale-target", "stale", "stale-target"],
    ] as const) {
      const { runner, siteModes } = harness({
        setFiles: (async () => ({ ok: false, reason })) as unknown as NonNullable<
          Parameters<typeof createAgentUpload>[0]["setFiles"]
        >,
      });
      await siteModes.set(SITE, { mode: "skip-checks" });

      await expect(runner.run(request())).resolves.toEqual({
        callId: "call-1",
        outcome,
        reason: expected,
      });
    }
  });

  it("refuses arguments the contract does not declare, including a path", async () => {
    const { runner, setFiles, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "file_upload",
      tabId: AGENT_TAB,
      // The worker has no business seeing a path: the host is what may read a file (FR-051).
      args: { tabId: AGENT_TAB, ref: "t_attachment", paths: ["C:/allowed/receipt.txt"] },
    });

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments" });
    expect(setFiles).not.toHaveBeenCalled();
  });
});

/**
 * 013/T334 — `upload_image`, `file_upload`'s sibling (FR-169, FR-173, FR-174).
 *
 * Same boundary: the worker receives *bytes* the host already vetted (a screenshot this session
 * took), never an id it could look up. Same consent: putting a picture into a page is an effect the
 * site's mode decides. What differs is the target - an input by ref, or a drop point - and the
 * answer, which names how the page received it.
 */
describe("T334 agent upload_image", () => {
  const PICTURE = { name: "screenshot.png", type: "image/png", bytesBase64: "iVBORw0KGgo=" };

  function imageHarness(overrides: Partial<Parameters<typeof createAgentUpload>[0]> = {}) {
    const deliverImage = vi.fn(async () => ({
      ok: true as const,
      delivery: "input" as const,
      file: { name: "screenshot.png", size: 8 },
    }));
    const setFiles = vi.fn();
    const siteModes = createSiteModeStore();
    const prompts = createAgentPromptController({ timeoutMs: 60 });
    const runner = createAgentUpload({
      context: testSessionContexts(),
      siteModes,
      bindings: createAgentPageBindings(),
      prompts,
      tabOwnership: async (_sessionId, tabId) =>
        tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
      setFiles: setFiles as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["setFiles"]>,
      deliverImage: deliverImage as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["deliverImage"]>,
      // 030: a drop point is asked of the debugger; these pages are of one document.
      attachments: pointSiteAttachments().attachments as unknown as NonNullable<
        Parameters<typeof createAgentUpload>[0]["attachments"]
      >,
      ...overrides,
    });
    return { runner, deliverImage, setFiles, siteModes, prompts };
  }

  function imageRequest(
    target: { ref: string } | { coordinate: { x: number; y: number } } = { ref: "t_zone" },
    tabId = AGENT_TAB,
  ): AgentNativeRequest {
    return {
      callId: "call-2",
      sessionId: "session-h1",
      tool: "upload_image",
      tabId,
      args: { tabId, target, file: PICTURE },
    };
  }

  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("is handled by the upload runner", () => {
    const { runner } = imageHarness();
    expect(runner.handles("upload_image")).toBe(true);
  });

  it("refuses a tab the session does not own, before anything reaches a page", async () => {
    const { runner, deliverImage, siteModes } = imageHarness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(imageRequest({ ref: "t_zone" }, 99));

    expect(response).toEqual({ callId: "call-2", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(deliverImage).not.toHaveBeenCalled();
  });

  /**
   * 014/T385 — and the card is told which of the two deliveries it is about (FR-196).
   *
   * The panel cannot work it out for itself: the projection carries the tool and a summary written
   * in English by this worker, and the sentence the owner reads is looked up from a key. So the
   * fact the owner needs - a file field, or a point on the page - has to travel as a fact. It is
   * read off the arguments rather than off an answer, because the question comes first.
   */
  it("tells the card how the picture would be delivered (014/T385, FR-196)", async () => {
    for (const [target, delivery] of [
      [{ ref: "t_zone" }, "input"],
      [{ coordinate: { x: 40, y: 50 } }, "drop"],
    ] as const) {
      const { runner, prompts } = imageHarness();

      const pending = runner.run(imageRequest(target));
      await vi.waitFor(() => expect(prompts.current()).toBeDefined());
      expect(prompts.current()).toMatchObject({ tool: "upload_image", delivery });

      prompts.decide(prompts.current()?.promptId ?? "", false);
      await pending;
    }
  });

  it("asks the owner first on an `ask` site with a summary that names the target, and delivers nothing if they refuse", async () => {
    const { runner, deliverImage, prompts } = imageHarness();

    const pending = runner.run(imageRequest({ coordinate: { x: 40, y: 50 } }));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    expect(prompts.current()).toMatchObject({
      site: SITE,
      tool: "upload_image",
      argsSummary: "drop a screenshot the agent took onto a point on the page",
    });
    expect(deliverImage).not.toHaveBeenCalled();

    prompts.decide(prompts.current()?.promptId ?? "", false);
    await expect(pending).resolves.toEqual({ callId: "call-2", outcome: "denied", reason: "owner-denied" });
    expect(deliverImage).not.toHaveBeenCalled();
  });

  /**
   * S2c review F3 — the owner's Release tabs, under a standing question (006 FR-087).
   *
   * The card's two buttons reach a call that is parked on a consent prompt, and the picture must
   * not land on a page the owner has just taken back. `not-yours` rather than `denied/owner-denied`
   * is the honest answer: they did not refuse the upload, they ended the session's claim on the
   * tab - and it is the answer `click` gives in the same situation.
   */
  it("refuses with not-yours when the owner takes the tabs back while the question stands", async () => {
    let held = true;
    const { runner, deliverImage, prompts } = imageHarness({
      tabOwnership: async (_sessionId, tabId) =>
        held && tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    });

    const pending = runner.run(imageRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    held = false;
    prompts.cancelSession("session-h1", "released");

    await expect(pending).resolves.toEqual({
      callId: "call-2",
      outcome: "denied",
      reason: "not-yours",
      refusal: { reason: "not-yours" },
    });
    expect(prompts.current()).toBeUndefined();
    expect(deliverImage).not.toHaveBeenCalled();
  });

  it("proceeds on a `skip-checks` site and hands a ref to the page as a handle", async () => {
    const { runner, deliverImage, siteModes } = imageHarness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(imageRequest({ ref: "t_zone" }));

    expect(response).toEqual({
      callId: "call-2",
      outcome: "ok",
      result: { delivery: "input", file: { name: "screenshot.png", size: 8 } },
    });
    expect(deliverImage).toHaveBeenCalledWith(
      expect.objectContaining({ target: { handle: "t_zone" }, file: PICTURE, tab: AGENT_TAB }),
    );
    expect(deliverImage).toHaveBeenCalledWith(expect.not.objectContaining({ frameId: expect.anything() }));
  });

  it("threads the ref's frame into the delivery (the 004/T160 rule holds for pictures)", async () => {
    const discoverFrame = vi.fn(async () => ({
      frameId: 3,
      documentEpoch: "doc-frame-3",
      canonicalOrigin: "https://embed.test",
    }));
    const { runner, deliverImage, siteModes } = imageHarness({
      discoverFrame: discoverFrame as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["discoverFrame"]>,
      // 030/T895: the frame's site decides, and the browser names it as the frame's own.
      probeFrameSender: async (_tabId, frameId) => ({
        documentId: "bdoc-3",
        sender: { origin: "https://embed.test", frameId, documentId: "bdoc-3" },
      }),
    });
    await siteModes.set("https://embed.test", { mode: "skip-checks" });

    await runner.run(imageRequest({ ref: "t_zone" }));

    expect(discoverFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), "t_zone");
    expect(deliverImage).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: 3, documentEpoch: "doc-frame-3", frameOrigin: "https://embed.test" }),
    );
  });

  it("sends a coordinate to the top frame without asking which frame owns anything", async () => {
    const discoverFrame = vi.fn();
    const deliverImage = vi.fn(async () => ({
      ok: true as const,
      delivery: "drop" as const,
      file: { name: "screenshot.png", size: 8 },
      point: { x: 40, y: 50 },
    }));
    const { runner, siteModes } = imageHarness({
      discoverFrame: discoverFrame as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["discoverFrame"]>,
      deliverImage: deliverImage as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["deliverImage"]>,
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(imageRequest({ coordinate: { x: 40, y: 50 } }));

    expect(discoverFrame).not.toHaveBeenCalled();
    expect(deliverImage).toHaveBeenCalledWith(
      expect.objectContaining({ target: { point: { x: 40, y: 50 } }, documentEpoch: "doc-1" }),
    );
    expect(deliverImage).toHaveBeenCalledWith(expect.not.objectContaining({ frameId: expect.anything() }));
    expect(response).toEqual({
      callId: "call-2",
      outcome: "ok",
      result: { delivery: "drop", file: { name: "screenshot.png", size: 8 }, point: { x: 40, y: 50 } },
    });
  });

  /**
   * 012 change log 2026-10-17 (R-280): the drop point is read off the latest picture like any
   * other, so it is mapped back into the frame's pixels; a point off the viewport is refused naming
   * the picture's size, the one the agent aims in.
   */
  it("drops at the picture's point scaled back into the frame, and refuses in the picture's size", async () => {
    const space = { frame: { width: 2560, height: 1440 }, image: { width: 1429, height: 804 } };
    const deliverImage = vi.fn(async () => ({ ok: false as const, reason: "point-outside-viewport (frame 2560x1440)" }));
    const { runner, siteModes } = imageHarness({
      screenshotSpaces: { get: async () => space, remember: async () => undefined },
      deliverImage: deliverImage as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["deliverImage"]>,
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(imageRequest({ coordinate: { x: 500, y: 300 } }));

    expect(deliverImage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { point: { x: Math.round((500 * 2560) / 1429), y: Math.round((300 * 1440) / 804) } },
      }),
    );
    expect(response).toEqual({
      callId: "call-2",
      outcome: "not-actionable",
      reason: "point-outside-viewport (screenshot 1429x804)",
    });
  });

  it("refuses a drop point once the page is no longer as wide as the picture's, before asking anyone (R-282)", async () => {
    const space = { frame: { width: 2560, height: 1440 }, image: { width: 1429, height: 804 } };
    const { runner, deliverImage, siteModes, prompts } = imageHarness({
      screenshotSpaces: { get: async () => space, remember: async () => undefined },
      currentViewport: async () => ({ width: 2048, height: 1440 }),
    });
    await siteModes.set(SITE, { mode: "ask" });
    const asked = vi.spyOn(prompts, "ask");

    const response = await runner.run(imageRequest({ coordinate: { x: 500, y: 300 } }));

    expect(response).toEqual({
      callId: "call-2",
      outcome: "failed",
      reason:
        "viewport-changed (screenshot of a 2560 px wide page, now 2048); the window width or page zoom " +
        "changed since the last screenshot - take a new screenshot first",
    });
    expect(asked).not.toHaveBeenCalled();
    expect(deliverImage).not.toHaveBeenCalled();
    // A ref names an element, not a place: no picture's width has anything to say about it.
    await siteModes.set(SITE, { mode: "skip-checks" });
    expect((await runner.run(imageRequest({ ref: "t_zone" }))).outcome).toBe("ok");
  });

  it("reports where the drop landed in the picture's pixels, the space the agent gave the point in", async () => {
    const space = { frame: { width: 2560, height: 1440 }, image: { width: 1429, height: 804 } };
    const deliverImage = vi.fn(async () => ({
      ok: true as const,
      delivery: "drop" as const,
      file: { name: "screenshot.png", size: 8 },
      point: { x: 896, y: 537 },
    }));
    const { runner, siteModes } = imageHarness({
      screenshotSpaces: { get: async () => space, remember: async () => undefined },
      deliverImage: deliverImage as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["deliverImage"]>,
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(imageRequest({ coordinate: { x: 500, y: 300 } }));

    expect(response.result).toMatchObject({ point: { x: 500, y: 300 } });
  });

  it("maps what the page answered onto the tool's outcomes", async () => {
    for (const [reason, outcome] of [
      ["stale-target", "stale"],
      ["stale-context", "stale"],
      ["not-a-drop-target", "not-actionable"],
      ["point-outside-viewport (frame 1280x720)", "not-actionable"],
      ["not-reachable", "not-actionable"],
      ["unsupported", "failed"],
    ] as const) {
      const { runner, siteModes } = imageHarness({
        deliverImage: (async () => ({ ok: false, reason })) as unknown as NonNullable<
          Parameters<typeof createAgentUpload>[0]["deliverImage"]
        >,
      });
      await siteModes.set(SITE, { mode: "skip-checks" });

      await expect(runner.run(imageRequest())).resolves.toEqual({ callId: "call-2", outcome, reason });
    }
  });

  it("refuses a frame that still carries an image id, both targets, or no file", async () => {
    const { runner, deliverImage, siteModes } = imageHarness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    for (const args of [
      { tabId: AGENT_TAB, imageId: "img_abcdefghij", target: { ref: "t_zone" }, file: PICTURE },
      { tabId: AGENT_TAB, target: { ref: "t_zone", coordinate: { x: 1, y: 2 } }, file: PICTURE },
      { tabId: AGENT_TAB, target: { ref: "t_zone" } },
    ]) {
      const response = await runner.run({ callId: "call-2", sessionId: "session-h1", tool: "upload_image", tabId: AGENT_TAB, args });
      expect(response).toEqual({ callId: "call-2", outcome: "failed", reason: "invalid-arguments" });
    }
    expect(deliverImage).not.toHaveBeenCalled();
  });
});

/** 015/FR-205 - an upload whose page did not answer the binding probe in time is not `stale`. */
describe("015 upload: page-not-responding binding", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("answers failed page-not-responding with the hint, never stale", async () => {
    const { runner, setFiles } = harness({
      bindings: { bind: async () => ({ ok: false, reason: "page-not-responding" }), invalidate() {} },
    });

    const response = await runner.run(request());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "page-not-responding",
      hint: PAGE_NOT_RESPONDING_HINT,
    });
    expect(setFiles).not.toHaveBeenCalled();
  });
});

/**
 * 030/T895 (FR-454, O-030-1) - `file_upload` and `upload_image` into an element inside another
 * site's embedded frame are decided by that frame's site, before anything is written.
 *
 * The ref's frame is found before the gate (the same scroll-free "is this ref yours" question), its
 * site is the browser's sender origin for one message the frame sends (`probeFrameSender`, faked
 * here; its own matching is `frame-sender-probe.test.ts`), and the gate, the card and Allow always
 * all use that site. The page's site lends the frame nothing.
 */
describe("030 upload into a frame from another site", () => {
  const PAY = "https://pay.fixtures.test:19444";
  const PAY_FRAME = { frameId: 12, documentEpoch: "doc-pay", canonicalOrigin: PAY };
  const PICTURE = { name: "screenshot.png", type: "image/png", bytesBase64: "iVBORw0KGgo=" };
  type Deps = Parameters<typeof createAgentUpload>[0];
  type Claim = { frameId: number; documentEpoch: string; canonicalOrigin: string } | undefined;
  type Sender = { origin?: string; frameId?: number; documentId?: string };

  function framedHarness(
    options: {
      /** What the claim finds on each call, in order; the last one repeats. */
      claims?: Claim[];
      /** The browser's sender for the probed frame; `null` is a frame that never answered. */
      sender?: Sender | null;
    } = {},
  ) {
    const timeline: string[] = [];
    const claims = options.claims ?? [PAY_FRAME];
    let claimed = 0;
    const discoverFrame = vi.fn(async (_context: unknown, _binding: unknown, ref: string) => {
      timeline.push(`claim:${ref}`);
      const found = claims[Math.min(claimed, claims.length - 1)];
      claimed += 1;
      return found;
    });
    const sender = options.sender === undefined ? { origin: PAY, frameId: 12, documentId: "bdoc-12" } : options.sender;
    const probeFrameSender = vi.fn(async (_tabId: number, frameId: number) => {
      timeline.push(`probe:${frameId}`);
      return sender === null ? {} : { documentId: "bdoc-12", sender };
    });
    const setFiles = vi.fn(async () => {
      timeline.push("setFiles");
      return { ok: true as const, files: [{ name: "receipt.txt", size: 5 }] };
    });
    const deliverImage = vi.fn(async () => {
      timeline.push("deliverImage");
      return { ok: true as const, delivery: "input" as const, file: { name: "screenshot.png", size: 8 } };
    });
    const siteModes = createSiteModeStore();
    const prompts = createAgentPromptController({ timeoutMs: 60 });
    const runner = createAgentUpload({
      context: testSessionContexts(),
      siteModes,
      bindings: createAgentPageBindings(),
      prompts,
      tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
      setFiles: setFiles as unknown as NonNullable<Deps["setFiles"]>,
      deliverImage: deliverImage as unknown as NonNullable<Deps["deliverImage"]>,
      discoverFrame: discoverFrame as unknown as NonNullable<Deps["discoverFrame"]>,
      probeFrameSender: probeFrameSender as unknown as NonNullable<Deps["probeFrameSender"]>,
    });
    return { runner, setFiles, deliverImage, siteModes, prompts, timeline, discoverFrame, probeFrameSender };
  }

  const uploadRequest = (): AgentNativeRequest => request();
  const imageRequest = (): AgentNativeRequest => ({
    callId: "call-2",
    sessionId: "session-h1",
    tool: "upload_image",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, target: { ref: "t_card_scan" }, file: PICTURE },
  });

  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("finds the frame before the gate and asks for the frame's site, with nothing written before the answer", async () => {
    for (const [build, delivered] of [
      [uploadRequest, "setFiles"],
      [imageRequest, "deliverImage"],
    ] as const) {
      const { runner, siteModes, prompts, timeline, setFiles, deliverImage } = framedHarness();
      // The page's skip-checks lends nothing to the frame: its own site is asked about.
      await siteModes.set(SITE, { mode: "skip-checks" });

      const pending = runner.run(build());
      await vi.waitFor(() => expect(prompts.current()).toBeDefined());
      expect(prompts.current()).toMatchObject({ site: SITE, frame: { site: PAY } });
      expect(timeline).toEqual([expect.stringMatching(/^claim:/), "probe:12"]);
      expect(setFiles).not.toHaveBeenCalled();
      expect(deliverImage).not.toHaveBeenCalled();

      prompts.decide(prompts.current()?.promptId ?? "", true);
      expect((await pending).outcome).toBe("ok");
      expect(timeline.at(-1)).toBe(delivered);
      const sent = delivered === "setFiles" ? setFiles : deliverImage;
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ frameId: 12, documentEpoch: "doc-pay", frameOrigin: PAY }),
      );
    }
  });

  it("runs without asking when the frame's own site is in skip-checks, whatever the page's mode", async () => {
    const { runner, siteModes, prompts, setFiles } = framedHarness();
    await siteModes.set(PAY, { mode: "skip-checks" });
    const asked = vi.spyOn(prompts, "ask");

    const response = await runner.run(uploadRequest());

    expect(response.outcome).toBe("ok");
    expect(asked).not.toHaveBeenCalled();
    expect(setFiles).toHaveBeenCalledTimes(1);
  });

  it("stores Allow always under the frame's site and leaves the page's mode as it was", async () => {
    const { runner, siteModes, prompts } = framedHarness();
    await siteModes.set(SITE, { mode: "follow-a-plan" });

    const pending = runner.run(imageRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    prompts.decide(prompts.current()?.promptId ?? "", true, "skip-checks");

    expect((await pending).outcome).toBe("ok");
    expect((await siteModes.get(PAY)).mode).toBe("skip-checks");
    expect((await siteModes.get(SITE)).mode).toBe("follow-a-plan");
  });

  it("answers a refusal and a timeout with the frame's site and the reason, and writes nothing", async () => {
    const refused = framedHarness();
    const pending = refused.runner.run(uploadRequest());
    await vi.waitFor(() => expect(refused.prompts.current()).toBeDefined());
    refused.prompts.decide(refused.prompts.current()?.promptId ?? "", false);
    await expect(pending).resolves.toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "owner-denied",
      hint: frameAnswerText(PAY, "refused"),
    });
    expect(refused.setFiles).not.toHaveBeenCalled();

    const undecided = framedHarness();
    const timedOut = await undecided.runner.run(imageRequest());
    expect(timedOut).toMatchObject({ outcome: "timed-out", reason: "no-answer" });
    expect(timedOut.hint?.startsWith(frameAnswerText(PAY, "undecided"))).toBe(true);
    expect(undecided.deliverImage).not.toHaveBeenCalled();
  });

  it("asks about a frame whose site could not be established, and stores nothing for it", async () => {
    for (const sender of [null, { origin: "null", frameId: 12, documentId: "bdoc-12" }]) {
      const { runner, siteModes, prompts, setFiles } = framedHarness({ sender });
      await siteModes.set(SITE, { mode: "skip-checks" });

      const pending = runner.run(uploadRequest());
      await vi.waitFor(() => expect(prompts.current()).toBeDefined());
      expect(prompts.current()).toMatchObject({ site: SITE, frame: { unknown: true } });
      // The card offers no Allow always (FR-458); a reply that carries one anyway is not an answer
      // (contracts/prompt-and-reads.md), and is refused exactly as the effect tools refuse it.
      prompts.decide(prompts.current()?.promptId ?? "", true, "skip-checks");

      await expect(pending).resolves.toEqual({
        callId: "call-1",
        outcome: "denied",
        reason: "owner-denied",
        hint: frameAnswerText("unknown", "unknown-site"),
      });
      expect(setFiles).not.toHaveBeenCalled();
      // Only the page's own record: nothing is stored under a site nobody could name (FR-458).
      expect((await siteModes.list()).map((entry) => entry.site)).toEqual([SITE]);
    }

    const refused = framedHarness({ sender: null });
    const pending = refused.runner.run(imageRequest());
    await vi.waitFor(() => expect(refused.prompts.current()).toBeDefined());
    refused.prompts.decide(refused.prompts.current()?.promptId ?? "", false);
    await expect(pending).resolves.toMatchObject({
      outcome: "denied",
      hint: frameAnswerText("unknown", "unknown-site"),
    });
    expect(refused.deliverImage).not.toHaveBeenCalled();
  });

  it("cancels with the frame-moved answer when the claim after the gate lands in another document or frame", async () => {
    for (const moved of [{ ...PAY_FRAME, documentEpoch: "doc-pay-2" }, { ...PAY_FRAME, frameId: 14 }, undefined]) {
      const { runner, siteModes, setFiles } = framedHarness({ claims: [PAY_FRAME, moved] });
      await siteModes.set(PAY, { mode: "skip-checks" });

      const response = await runner.run(uploadRequest());

      expect(response).toEqual({
        callId: "call-1",
        outcome: "stale",
        reason: "stale-context",
        hint: frameAnswerText(PAY, "frame-moved"),
      });
      expect(setFiles).not.toHaveBeenCalled();
    }
  });

  it("cancels when the browser names another document or site for the frame after the gate", async () => {
    for (const after of [
      { origin: PAY, frameId: 12, documentId: "bdoc-13" },
      { origin: "https://other.fixtures.test", frameId: 12, documentId: "bdoc-12" },
    ]) {
      const { runner, siteModes, deliverImage, probeFrameSender } = framedHarness();
      await siteModes.set(PAY, { mode: "skip-checks" });
      probeFrameSender
        .mockImplementationOnce(async () => ({
          documentId: "bdoc-12",
          sender: { origin: PAY, frameId: 12, documentId: "bdoc-12" },
        }))
        .mockImplementationOnce(async () => ({ documentId: after.documentId, sender: after }));

      const response = await runner.run(imageRequest());

      expect(response).toMatchObject({ outcome: "stale", hint: frameAnswerText(PAY, "frame-moved") });
      expect(deliverImage).not.toHaveBeenCalled();
    }
  });

  it("decides a top-frame ref and a same-site frame by the page's site, with no frame on the card", async () => {
    for (const claim of [
      { frameId: 0, documentEpoch: "doc-1", canonicalOrigin: SITE },
      { frameId: 12, documentEpoch: "doc-same", canonicalOrigin: SITE },
    ]) {
      const { runner, prompts, probeFrameSender } = framedHarness({
        claims: [claim],
        sender: { origin: SITE, frameId: 12, documentId: "bdoc-12" },
      });

      const pending = runner.run(uploadRequest());
      await vi.waitFor(() => expect(prompts.current()).toBeDefined());
      expect(prompts.current()).toMatchObject({ site: SITE });
      expect(prompts.current()).not.toHaveProperty("frame");
      // The top document costs no probe (FR-465).
      expect(probeFrameSender).toHaveBeenCalledTimes(claim.frameId === 0 ? 0 : 1);
      prompts.decide(prompts.current()?.promptId ?? "", false);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    }
  });
});

/**
 * 030 (FR-455, FR-460, FR-464, SC-206) - an `upload_image` drop at a point is decided by the
 * innermost frame under that point, exactly as a coordinate click is (`computer.test.ts`).
 *
 * The page is modelled in the debugger's own terms (`helpers/point-site.ts`): one frame from a
 * second site in its own process, whose holder's content box is (100, 50)-(400, 250). The drop
 * itself still goes to the top frame, which does its own descent (FR-171); what changes is whose
 * consent it waits for, and that the frame is asked about again right before the drop.
 */
describe("030 a drop point is decided by the frame under it", () => {
  const PAY = "https://pay.fixtures.test:19444";
  const OVER_FRAME = { x: 160, y: 90 };
  const OUTSIDE = { x: 20, y: 20 };
  const PICTURE = { name: "screenshot.png", type: "image/png", bytesBase64: "iVBORw0KGgo=" };
  type Deps = Parameters<typeof createAgentUpload>[0];
  const payFrame = (): FakeFrame => ({
    cdpFrameId: "T-PAY",
    box: { x: 100, y: 50, width: 300, height: 200 },
    outOfProcess: true,
    frameId: 5,
    documentId: "bdoc-5",
    sender: PAY,
    securityOrigin: SITE,
  });

  function dropHarness(frames: FakeFrame[], pageOptions: { missingSessions?: string[] } = {}) {
    const page = fakePointPage(frames, { pageSite: SITE, ...pageOptions });
    const fake = pointSiteAttachments(page);
    const deliverImage = vi.fn(async () => ({
      ok: true as const,
      delivery: "drop" as const,
      file: { name: "screenshot.png", size: 8 },
      point: { x: 160, y: 90 },
    }));
    const siteModes = createSiteModeStore();
    const prompts = createAgentPromptController({ timeoutMs: 2_000 });
    const runner = createAgentUpload({
      context: testSessionContexts(),
      siteModes,
      bindings: createAgentPageBindings(),
      prompts,
      tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
      setFiles: vi.fn() as unknown as NonNullable<Deps["setFiles"]>,
      deliverImage: deliverImage as unknown as NonNullable<Deps["deliverImage"]>,
      attachments: fake.attachments as unknown as NonNullable<Deps["attachments"]>,
      readFrameMarks: (_tabId: number, key: string) => page.readMarks(key),
      probeFrameSender: (_tabId: number, frameId: number) => page.probeSender(frameId),
    });
    return { runner, deliverImage, siteModes, prompts, page, ...fake };
  }

  const dropAt = (coordinate: { x: number; y: number }): AgentNativeRequest => ({
    callId: "call-3",
    sessionId: "session-h1",
    tool: "upload_image",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, target: { coordinate }, file: PICTURE },
  });

  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("asks for the site of the frame under the point, while the page's site is skip-checks", async () => {
    const { runner, siteModes, prompts, deliverImage } = dropHarness([payFrame()]);
    await siteModes.set(SITE, { mode: "skip-checks" });

    const pending = runner.run(dropAt(OVER_FRAME));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());

    expect(prompts.current()).toMatchObject({ site: SITE, frame: { site: PAY }, tool: "upload_image", delivery: "drop" });
    expect(deliverImage).not.toHaveBeenCalled();

    prompts.decide(prompts.current()?.promptId ?? "", true, "skip-checks");
    expect((await pending).outcome).toBe("ok");
    // The drop still goes to the top frame at the point; Allow always is the frame's site's.
    expect(deliverImage).toHaveBeenCalledTimes(1);
    expect(deliverImage).toHaveBeenCalledWith(expect.objectContaining({ target: { point: OVER_FRAME } }));
    expect(deliverImage).toHaveBeenCalledWith(expect.not.objectContaining({ frameId: expect.anything() }));
    expect((await siteModes.get(PAY)).mode).toBe("skip-checks");
  });

  /**
   * 031/T945 (R-466): the walk before the gate and the walk again before the drop ride the same
   * attachment, so the call holds it through the owner's answer, and lets go when it answers.
   */
  it("holds the attachment from the walk before the gate through the drop, and lets go when it answers", async () => {
    const { runner, prompts, holds } = dropHarness([payFrame()]);

    const pending = runner.run(dropAt(OVER_FRAME));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    expect(holds.filter((hold) => !hold.done)).toHaveLength(1);

    prompts.decide(prompts.current()?.promptId ?? "", true);
    expect((await pending).outcome).toBe("ok");
    expect(holds.every((hold) => hold.done)).toBe(true);
  });

  it("is decided by the frame's own mode, and walks the point again right before the drop", async () => {
    const { runner, siteModes, prompts, deliverImage, page } = dropHarness([payFrame()]);
    await siteModes.set(PAY, { mode: "skip-checks" });
    const asked = vi.spyOn(prompts, "ask");

    const response = await runner.run(dropAt(OVER_FRAME));

    expect(response.outcome).toBe("ok");
    expect(asked).not.toHaveBeenCalled();
    expect(deliverImage).toHaveBeenCalledTimes(1);
    // Asked before the gate, and again right before the drop.
    expect(page.probed).toEqual([5, 5]);
  });

  it("asks as an unknown site, with nothing remembered, over a point whose frame cannot be resolved", async () => {
    const { runner, siteModes, prompts, deliverImage } = dropHarness([payFrame()], { missingSessions: ["T-PAY"] });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const pending = runner.run(dropAt(OVER_FRAME));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    expect(prompts.current()).toMatchObject({ site: SITE, frame: { unknown: true }, delivery: "drop" });
    // Allow once: the drop is still possible with the owner's yes.
    prompts.decide(prompts.current()?.promptId ?? "", true);

    expect((await pending).outcome).toBe("ok");
    expect(deliverImage).toHaveBeenCalledTimes(1);

    // A reply carrying Allow always answers a card that offered none: refused, nothing stored or sent.
    const remembering = dropHarness([payFrame()], { missingSessions: ["T-PAY"] });
    await remembering.siteModes.set(SITE, { mode: "skip-checks" });
    const remembered = remembering.runner.run(dropAt(OVER_FRAME));
    await vi.waitFor(() => expect(remembering.prompts.current()).toBeDefined());
    remembering.prompts.decide(remembering.prompts.current()?.promptId ?? "", true, "skip-checks");
    await expect(remembered).resolves.toMatchObject({
      outcome: "denied",
      reason: "owner-denied",
      hint: frameAnswerText("unknown", "unknown-site"),
    });
    expect(remembering.deliverImage).not.toHaveBeenCalled();
    // Only the page's own record: nothing is stored under a site nobody could name (FR-458).
    expect((await siteModes.list()).map((entry) => entry.site)).toEqual([SITE]);
    expect((await remembering.siteModes.list()).map((entry) => entry.site)).toEqual([SITE]);

    const refused = dropHarness([payFrame()], { missingSessions: ["T-PAY"] });
    const denied = refused.runner.run(dropAt(OVER_FRAME));
    await vi.waitFor(() => expect(refused.prompts.current()).toBeDefined());
    refused.prompts.decide(refused.prompts.current()?.promptId ?? "", false);
    await expect(denied).resolves.toMatchObject({ outcome: "denied", hint: frameAnswerText("unknown", "unknown-site") });
    expect(refused.deliverImage).not.toHaveBeenCalled();
  });

  it("keeps the top frame's decision, card and text exactly as before outside every frame (SC-206)", async () => {
    const { runner, siteModes, prompts, deliverImage, page } = dropHarness([payFrame()]);

    const pending = runner.run(dropAt(OUTSIDE));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    const card = prompts.current();
    expect(card).toMatchObject({
      site: SITE,
      tool: "upload_image",
      argsSummary: "drop a screenshot the agent took onto a point on the page",
      delivery: "drop",
    });
    expect(card).not.toHaveProperty("frame");
    prompts.decide(card?.promptId ?? "", false);
    await expect(pending).resolves.toEqual({ callId: "call-3", outcome: "denied", reason: "owner-denied" });
    expect(deliverImage).not.toHaveBeenCalled();

    // Under the page's skip-checks it runs unasked, with no nonce or probe before or after the gate.
    await siteModes.set(SITE, { mode: "skip-checks" });
    expect((await runner.run(dropAt(OUTSIDE))).outcome).toBe("ok");
    expect(deliverImage).toHaveBeenCalledTimes(1);
    expect(page.probed).toEqual([]);
    expect(page.marksRead).toEqual([]);
  });

  it("cancels with the frame-moved answer when the frame changed after the answer, and drops nothing", async () => {
    for (const move of [
      (frame: FakeFrame) => {
        frame.documentId = "bdoc-5-next";
      },
      (frame: FakeFrame) => {
        frame.sender = "https://fixtures.test:19445";
        frame.documentId = "bdoc-5-third";
      },
      (frame: FakeFrame) => {
        frame.box = { x: 600, y: 400, width: 300, height: 200 };
      },
    ]) {
      const frame = payFrame();
      const { runner, siteModes, prompts, deliverImage } = dropHarness([frame]);
      await siteModes.set(SITE, { mode: "skip-checks" });

      const pending = runner.run(dropAt(OVER_FRAME));
      await vi.waitFor(() => expect(prompts.current()).toBeDefined());
      move(frame);
      prompts.decide(prompts.current()?.promptId ?? "", true);

      await expect(pending).resolves.toEqual({
        callId: "call-3",
        outcome: "stale",
        reason: "stale-context",
        hint: frameAnswerText(PAY, "frame-moved"),
      });
      expect(deliverImage).not.toHaveBeenCalled();
    }
  });
});
