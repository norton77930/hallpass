import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
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
