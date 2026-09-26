import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings, PAGE_NOT_RESPONDING_HINT } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createAgentUpload } from "../src/service-worker/agent-tools/upload.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

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
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

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
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

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
