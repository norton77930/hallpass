import { afterEach, describe, expect, it, vi } from "vitest";
import { contentRuntimeMessageSchema } from "@hallpass/contracts";
import {
  cancelActiveContent,
  collectFromActiveTab,
  evaluateConditionOnLeasedTab,
  executeOnActiveTab,
  probeActiveTab,
  resolveOnActiveTab,
  resolveHandleOnTab,
  resolveSupportedTabPage,
} from "../src/service-worker/content-broker.js";
import { pageFailureCode, pageOutcomeCode } from "../src/service-worker/page-ports.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("content broker contract wiring", () => {
  it.each([
    { name: "incognito", tab: { id: 7, url: "https://example.test/page", incognito: true } },
    {
      name: "Chrome Web Store",
      tab: { id: 7, url: "https://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    },
    { name: "PDF", tab: { id: 7, url: "https://example.test/manual.pdf" } },
  ])("rejects an excluded $name tab before content-runtime injection", async ({ tab }) => {
    let injections = 0;
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: {
        async executeScript() {
          injections += 1;
        },
      },
      tabs: {
        async query() {
          return [tab];
        },
      },
    };

    await expect(
      collectFromActiveTab({
        taskId: "task-excluded-page",
        operationId: "op-excluded-page",
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        requested: ["page.visible-text"],
        generalGrantActive: true,
        generalPageReadGrantId: "grant-excluded-page",
        formGrantActive: false,
      }),
    ).rejects.toThrow("unsupported-page");
    expect(injections).toBe(0);
  });

  /**
   * 004/T165. `chrome.tabs.create({ url })` resolves before the document commits, and a PDF's viewer
   * commits late: the tab record then reads `url: ""` with the address still in `pendingUrl`. The
   * classification has to read the address the tab is going to, or a PDF opened a moment ago is
   * "no tab" (`stale`) instead of "a page this extension may not read" (`not-readable`).
   */
  it("classifies a tab by its pending address while its document has not committed (T165)", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        async get() {
          return { id: 7, url: "", pendingUrl: "https://example.test/manual.pdf" };
        },
      },
    };

    await expect(resolveSupportedTabPage(7)).rejects.toThrow("unsupported-page");
  });

  it("still reports a tab with no address at all as absent", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        async get() {
          return { id: 7, url: "" };
        },
      },
    };

    await expect(resolveSupportedTabPage(7)).rejects.toThrow("no-active-tab");
  });

  it.each([
    {
      name: "injection",
      executeScript: async () => {
        throw new Error("sensitive injection detail");
      },
      sendMessage: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      expected: "content.injection",
    },
    {
      name: "post-injection probe",
      executeScript: async () => undefined,
      sendMessage: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      expected: "content.probe",
    },
  ])("classifies $name failures without exposing the raw exception", async ({ executeScript, sendMessage, expected }) => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { executeScript },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        sendMessage,
      },
    };

    const failure = await collectFromActiveTab({
      taskId: "task-failure",
      operationId: "op-failure",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-general-1",
      formGrantActive: false,
    }).catch((error: unknown) => error);

    expect(pageFailureCode(failure)).toBe(expected);
    expect(String(failure)).not.toContain("sensitive injection detail");
  });

  it.each([
    {
      name: "stale context",
      result: {
        contextHandle: "snap-live",
        documentEpoch: "doc-old",
        canonicalOrigin: "https://example.test",
        formValueItems: [],
      },
      expected: "content.stale-context",
    },
    {
      name: "invalid result",
      result: { documentEpoch: "doc-live", canonicalOrigin: "https://example.test", formValueItems: [] },
      expected: "content.invalid-result",
    },
  ])("classifies $name collection results", async ({ result, expected }) => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.parse(message);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          return result;
        },
      },
    };

    const failure = await collectFromActiveTab({
      taskId: "task-result",
      operationId: "op-result",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-general-1",
      formGrantActive: false,
    }).catch((error: unknown) => error);

    expect(pageFailureCode(failure)).toBe(expected);
  });

  it("maps an opaque-only runtime response to an unsupported outcome without exposing page data", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/opaque" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.parse(message);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          return {
            ok: false,
            reason: "unsupported-page",
            documentEpoch: "doc-live",
            canonicalOrigin: "https://example.test",
            formValueItems: [],
          };
        },
      },
    };

    const failure = await collectFromActiveTab({
      taskId: "task-opaque",
      operationId: "op-opaque",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-general-1",
      formGrantActive: false,
    }).catch((error: unknown) => error);

    expect(pageFailureCode(failure)).toBe("content.collection");
    expect(pageOutcomeCode(failure)).toBe("unsupported-page");
    expect(String(failure)).not.toContain("opaque");
  });

  it("classifies a collection transport failure", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.parse(message);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          throw new Error("private collection transport detail");
        },
      },
    };

    const failure = await collectFromActiveTab({
      taskId: "task-transport",
      operationId: "op-transport",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-general-1",
      formGrantActive: false,
    }).catch((error: unknown) => error);

    expect(pageFailureCode(failure)).toBe("content.collection");
    expect(String(failure)).not.toContain("private collection transport detail");
  });

  it("classifies a malformed action response as an invalid result", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.parse(message);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          return { ok: true, effect: "not-a-scroll" };
        },
      },
    };

    const failure = await executeOnActiveTab({
      taskId: "task-action-invalid",
      operationId: "op-action-invalid",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.scroll",
      arguments: { mode: "viewport", direction: "down", magnitude: "medium" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    }).catch((error: unknown) => error);

    expect(pageFailureCode(failure)).toBe("content.invalid-result");
  });

  it("probes before injection, then sends only contract-valid collect/action messages", async () => {
    const sent: unknown[] = [];
    const sendOptions: unknown[] = [];
    const injections: unknown[] = [];
    let runtimeAvailable = false;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript(input: unknown) {
          injections.push(input);
          runtimeAvailable = true;
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async get(id: number) {
          return { id, url: "https://example.test/page" };
        },
        async sendMessage(_tabId: number, message: unknown, options: unknown) {
          sent.push(message);
          sendOptions.push(options);
          const parsed = contentRuntimeMessageSchema.safeParse(message);
          if (!parsed.success) {
            throw new Error("invalid-content-frame");
          }
          if (parsed.data.type === "content.probe") {
            if (!runtimeAvailable) {
              throw new Error("Could not establish connection. Receiving end does not exist.");
            }
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          if (parsed.data.type === "content.collect-page") {
            return {
              contextHandle: "snap-live",
              documentEpoch: "doc-live",
              canonicalOrigin: "https://example.test",
              visibleText: "Visible fixture",
              formValueItems: [{ controlId: "leak", value: "secret" }],
              unexpectedSecret: "secret",
            };
          }
          return {
            ok: true,
            effect:
              "action" in parsed.data.payload && parsed.data.payload.action === "browser.enter-text"
                ? "text-entered"
                : "scrolled",
            scrollTop: 80,
            targetVisibility: "not-applicable",
            charactersChanged: 5,
            valueEchoed: false,
            documentChanged: false,
            value: "must-not-cross-worker",
          };
        },
      },
    };

    const collected = await collectFromActiveTab({
      taskId: "task-1",
      operationId: "op-read-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-general-1",
      formGrantActive: false,
    });
    expect(collected.documentEpoch).toBe("doc-live");
    expect(collected.formValueItems).toEqual([]);
    expect(collected).not.toHaveProperty("unexpectedSecret");
    expect(injections).toHaveLength(1);
    expect(sent.map((message) => (message as { type?: string }).type)).toEqual([
      "content.probe",
      "content.probe",
      "content.collect-page",
    ]);
    // 003/B1: a caller that states no minting policy sends a frame with no such field, so the
    // archived remote read is the frame it always was and collects under the reviewed walk.
    expect(
      sent.find((message) => (message as { type?: string }).type === "content.collect-page"),
    ).toMatchObject({ payload: expect.not.objectContaining({ mintPolicy: expect.anything() }) });

    const executed = await executeOnActiveTab({
      taskId: "task-1",
      operationId: "op-action-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.scroll",
      arguments: { mode: "viewport", direction: "down", magnitude: "small" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(executed).toMatchObject({ ok: true, scrollTop: 80 });
    expect(injections).toHaveLength(1);
    expect(sent.every((message) => contentRuntimeMessageSchema.safeParse(message).success)).toBe(true);
    expect(sendOptions.every((options) => JSON.stringify(options) === JSON.stringify({ frameId: 0 }))).toBe(true);

    const entered = await executeOnActiveTab({
      taskId: "task-1",
      operationId: "op-action-2",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.enter-text",
      arguments: { targetHandle: "tgt-1", text: "hello", editMode: "replace" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(entered).toMatchObject({ ok: true, charactersChanged: 5, valueEchoed: false });
    expect(entered).not.toHaveProperty("value");

    expect(
      await cancelActiveContent({
        taskId: "task-1",
        operationId: "stop-1",
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        tabId: 7,
        documentEpoch: "doc-live",
        canonicalOrigin: "https://example.test",
      }),
    ).toEqual({ cancelled: true });
    expect((sent.at(-1) as { type?: string }).type).toBe("content.cancel");
    expect(injections).toHaveLength(1);
  });

  it("cancels without probing so a superseded cancel cannot rebind a successor runtime", async () => {
    const sent: Array<{ type?: string; taskId?: string; expectedDocumentEpoch?: string }> = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript() {
          throw new Error("cancel must never inject");
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async get(id: number) {
          return { id, url: "https://example.test/page" };
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.safeParse(message);
          if (!parsed.success) {
            throw new Error("invalid-content-frame");
          }
          sent.push({
            type: parsed.data.type,
            taskId: parsed.data.taskId,
            expectedDocumentEpoch: parsed.data.expectedDocumentEpoch,
          });
          // the live runtime belongs to a later task, so it refuses this cancel
          return { ok: false, reason: "stale-binding" };
        },
      },
    };
    const result = await cancelActiveContent({
      taskId: "task-orphaned",
      operationId: "cancel-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      tabId: 7,
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(sent.map((frame) => frame.type)).toEqual(["content.cancel"]);
    expect(sent[0]).toMatchObject({
      taskId: "task-orphaned",
      expectedDocumentEpoch: "doc-live",
    });
    expect(result.cancelled).toBe(false);
  });

  it("still cancels the runtime that is genuinely bound to the task", async () => {
    const sent: string[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript() {
          throw new Error("cancel must never inject");
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async get(id: number) {
          return { id, url: "https://example.test/page" };
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.safeParse(message);
          if (!parsed.success) {
            throw new Error("invalid-content-frame");
          }
          sent.push(parsed.data.type);
          return { ok: true, effect: "cancelled" };
        },
      },
    };
    const result = await cancelActiveContent({
      taskId: "task-bound",
      operationId: "cancel-2",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      tabId: 7,
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(sent).toEqual(["content.cancel"]);
    expect(result.cancelled).toBe(true);
  });
  /**
   * Every content-script round trip is a promise that only settles when the page answers. A runtime
   * that accepts a message and never responds leaves the whole task without a result and without a
   * terminal, which is the shape of the owner-reported deadlock. These cases pin a finite bound.
   */
  describe("unresponsive content runtime", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const raceAgainstAdvance = async (operation: Promise<unknown>): Promise<string> => {
      const outcome = operation.then(() => "resolved").catch((error) => pageFailureCode(error));
      const advanced = vi.advanceTimersByTimeAsync(120_000).then(() => "still-pending");
      return (await Promise.race([outcome, advanced])) as string;
    };

    it("bounds a probe that the page never answers", async () => {
      vi.useFakeTimers();
      (globalThis as { chrome?: unknown }).chrome = {
        scripting: { async executeScript() {} },
        tabs: {
          async query() {
            return [{ id: 7, url: "https://example.test/page" }];
          },
          sendMessage() {
            return new Promise(() => {});
          },
        },
      };
      const settled = await raceAgainstAdvance(
        collectFromActiveTab({
          taskId: "task-probe-hang",
          operationId: "op-probe-hang",
          runtimeEpochId: "epoch-1",
          nonce: TEST_NONCE,
          requested: ["page.visible-text"],
          generalGrantActive: true,
          generalPageReadGrantId: "grant-probe-hang",
          formGrantActive: false,
        }),
      );
      expect(settled).toBe("content.probe");
    });

    it("bounds an injection that never completes", async () => {
      vi.useFakeTimers();
      (globalThis as { chrome?: unknown }).chrome = {
        scripting: {
          executeScript() {
            return new Promise(() => {});
          },
        },
        tabs: {
          async query() {
            return [{ id: 7, url: "https://example.test/page" }];
          },
          async sendMessage() {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          },
        },
      };
      const settled = await raceAgainstAdvance(
        collectFromActiveTab({
          taskId: "task-inject-hang",
          operationId: "op-inject-hang",
          runtimeEpochId: "epoch-1",
          nonce: TEST_NONCE,
          requested: ["page.visible-text"],
          generalGrantActive: true,
          generalPageReadGrantId: "grant-inject-hang",
          formGrantActive: false,
        }),
      );
      expect(settled).toBe("content.injection");
    });

    it("bounds a collection that the page never answers", async () => {
      vi.useFakeTimers();
      (globalThis as { chrome?: unknown }).chrome = {
        scripting: { async executeScript() {} },
        tabs: {
          async query() {
            return [{ id: 7, url: "https://example.test/page" }];
          },
          sendMessage(_tabId: number, message: unknown) {
            const parsed = contentRuntimeMessageSchema.safeParse(message);
            if (parsed.success && parsed.data.type === "content.probe") {
              return Promise.resolve({
                documentEpoch: "doc-live",
                canonicalOrigin: "https://example.test",
              });
            }
            return new Promise(() => {});
          },
        },
      };
      const settled = await raceAgainstAdvance(
        collectFromActiveTab({
          taskId: "task-collect-hang",
          operationId: "op-collect-hang",
          runtimeEpochId: "epoch-1",
          nonce: TEST_NONCE,
          requested: ["page.visible-text"],
          generalGrantActive: true,
          generalPageReadGrantId: "grant-collect-hang",
          formGrantActive: false,
        }),
      );
      expect(settled).toBe("content.collection");
    });

    it("bounds an action the page never confirms so the effect stays uncertain", async () => {
      vi.useFakeTimers();
      (globalThis as { chrome?: unknown }).chrome = {
        scripting: { async executeScript() {} },
        tabs: {
          async query() {
            return [{ id: 7, url: "https://example.test/page" }];
          },
          sendMessage(_tabId: number, message: unknown) {
            const parsed = contentRuntimeMessageSchema.safeParse(message);
            if (parsed.success && parsed.data.type === "content.probe") {
              return Promise.resolve({
                documentEpoch: "doc-live",
                canonicalOrigin: "https://example.test",
              });
            }
            return new Promise(() => {});
          },
        },
      };
      const settled = await raceAgainstAdvance(
        executeOnActiveTab({
          taskId: "task-execute-hang",
          operationId: "op-execute-hang",
          runtimeEpochId: "epoch-1",
          nonce: TEST_NONCE,
          expectedTabId: 7,
          capability: "browser.scroll",
          arguments: { mode: "viewport", direction: "down", magnitude: "small" },
          documentEpoch: "doc-live",
          canonicalOrigin: "https://example.test",
        }),
      );
      // The worker turns any thrown execution into attention-required / execute-uncertain, so a
      // bounded rejection here is what keeps an unconfirmed effect from being claimed as failed.
      // The stage code must name the action round trip: reporting a collection failure for an action
      // that may already have happened sends a reader of the diagnostics to the wrong place.
      expect(settled).toBe("content.execution");
    });
  });
});

describe("WP1 post-effect observation over the content broker", () => {
  function fakeChrome(reply: (message: { type: string; payload?: Record<string, unknown> }) => unknown) {
    const sent: unknown[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          sent.push(message);
          const parsed = contentRuntimeMessageSchema.parse(message);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          return reply(parsed as { type: string; payload?: Record<string, unknown> });
        },
      },
    };
    return sent;
  }

  it("forwards documentChanged from a click and refuses a click reply that omits it", async () => {
    fakeChrome(() => ({ ok: true, effect: "activated", clicks: 1, documentChanged: true }));
    const changed = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.click",
      arguments: { targetHandle: "tgt-1" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(changed).toMatchObject({ ok: true, effect: "activated", clicks: 1, documentChanged: true });

    fakeChrome(() => ({ ok: true, effect: "activated", clicks: 1 }));
    const missing = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-2",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.click",
      arguments: { targetHandle: "tgt-1" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    }).catch((error: unknown) => error);
    expect(pageFailureCode(missing)).toBe("content.invalid-result");
  });

  it("forwards target visibility from a scroll and refuses a scroll reply that omits it", async () => {
    fakeChrome(() => ({ ok: true, effect: "scrolled", scrollTop: 900, targetVisibility: "visible" }));
    const scrolled = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-3",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.scroll",
      arguments: { mode: "target", targetHandle: "tgt-1" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(scrolled).toMatchObject({ ok: true, effect: "scrolled", scrollTop: 900, targetVisibility: "visible" });

    fakeChrome(() => ({ ok: true, effect: "scrolled", scrollTop: 900, targetVisibility: "somewhere" }));
    const invalid = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-4",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.scroll",
      arguments: { mode: "target", targetHandle: "tgt-1" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    }).catch((error: unknown) => error);
    expect(pageFailureCode(invalid)).toBe("content.invalid-result");
  });

  it("forwards a key press with its focus evidence and refuses a key outside the named set", async () => {
    fakeChrome(() => ({
      ok: true,
      effect: "key-pressed",
      key: "Enter",
      focusRetained: false,
      valueEchoed: false,
      documentChanged: false,
    }));
    const pressed = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-key-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.key-press",
      arguments: { targetHandle: "tgt-1", key: "Enter" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    // A lost focus is evidence the worker needs, so it passes through; the worker decides what it means.
    expect(pressed).toMatchObject({ ok: true, effect: "key-pressed", key: "Enter", focusRetained: false, documentChanged: false });

    // The key is a contract value. A reply naming one outside the set is not a verified result, and
    // refusing it here keeps it from reaching the channel as a frame the schema would reject.
    fakeChrome(() => ({
      ok: true,
      effect: "key-pressed",
      key: "F5",
      focusRetained: true,
      valueEchoed: false,
      documentChanged: false,
    }));
    const invalid = await executeOnActiveTab({
      taskId: "task-observe",
      operationId: "op-observe-key-2",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.key-press",
      arguments: { targetHandle: "tgt-1", key: "Enter" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    }).catch((error: unknown) => error);
    expect(pageFailureCode(invalid)).toBe("content.invalid-result");
  });

  it("forwards a refusal the runtime names from its closed vocabulary and refuses any other", async () => {
    const keyPress = (operationId: string) => ({
      taskId: "task-observe",
      operationId,
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      capability: "browser.key-press" as const,
      arguments: { targetHandle: "tgt-1", key: "Enter" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    fakeChrome(() => ({ ok: false, reason: "submission-guard" }));
    expect(await executeOnActiveTab(keyPress("op-refusal-1"))).toEqual({
      ok: false,
      // The runtime decided it, so the frame arrived; the worker reads this, not a list of reasons.
      reachedPage: true,
      reason: "submission-guard",
    });

    // A reason outside the contract's list - here the broker's own former fallback - is not a result
    // the worker can name on the channel, so the reply is invalid rather than forwarded.
    fakeChrome(() => ({ ok: false, reason: "execute-failed" }));
    const unknown = await executeOnActiveTab(keyPress("op-refusal-2")).catch((error: unknown) => error);
    expect(pageFailureCode(unknown)).toBe("content.invalid-result");

    fakeChrome(() => ({ ok: false }));
    const missing = await executeOnActiveTab(keyPress("op-refusal-3")).catch((error: unknown) => error);
    expect(pageFailureCode(missing)).toBe("content.invalid-result");
  });

  it("forwards each gesture's evidence and refuses a gesture reply without it (002 US4)", async () => {
    const run = (capability: "browser.hover" | "browser.double-click" | "browser.drag", operationId: string) =>
      executeOnActiveTab({
        taskId: "task-observe",
        operationId,
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        expectedTabId: 7,
        capability,
        arguments:
          capability === "browser.drag" ? { targetHandle: "tgt-1", dropTargetHandle: "tgt-2" } : { targetHandle: "tgt-1" },
        documentEpoch: "doc-live",
        canonicalOrigin: "https://example.test",
      });

    fakeChrome(() => ({ ok: true, effect: "hovered", targetVisible: false, documentChanged: false }));
    expect(await run("browser.hover", "op-gesture-1")).toMatchObject({ ok: true, effect: "hovered", targetVisible: false, documentChanged: false });
    fakeChrome(() => ({ ok: true, effect: "hovered", documentChanged: false }));
    expect(pageFailureCode(await run("browser.hover", "op-gesture-2").catch((e: unknown) => e))).toBe("content.invalid-result");

    fakeChrome(() => ({ ok: true, effect: "double-activated", clicks: 2, documentChanged: false }));
    expect(await run("browser.double-click", "op-gesture-3")).toMatchObject({ ok: true, effect: "double-activated", clicks: 2 });
    fakeChrome(() => ({ ok: true, effect: "double-activated", clicks: 1, documentChanged: false }));
    expect(pageFailureCode(await run("browser.double-click", "op-gesture-4").catch((e: unknown) => e))).toBe("content.invalid-result");

    fakeChrome(() => ({ ok: true, effect: "dragged", moved: false, documentChanged: true }));
    expect(await run("browser.drag", "op-gesture-5")).toMatchObject({ ok: true, effect: "dragged", moved: false, documentChanged: true });
    fakeChrome(() => ({ ok: true, effect: "dragged", documentChanged: false }));
    expect(pageFailureCode(await run("browser.drag", "op-gesture-6").catch((e: unknown) => e))).toBe("content.invalid-result");
    // A reply for a different effect than the one requested is not a result for this request.
    fakeChrome(() => ({ ok: true, effect: "activated", clicks: 2, documentChanged: false }));
    expect(pageFailureCode(await run("browser.double-click", "op-gesture-7").catch((e: unknown) => e))).toBe("content.invalid-result");
  });

  it("forwards a resolution in its three outcomes and refuses anything beyond review-card metadata (002 US5)", async () => {
    const resolve = (operationId: string) =>
      resolveOnActiveTab({
        taskId: "task-resolve",
        operationId,
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        expectedTabId: 7,
        canonicalOrigin: "https://example.test",
        documentEpoch: "doc-live",
        generalPageReadGrantId: "grant-1",
        description: "search box",
        maxCandidates: 3,
      });
    const sent = fakeChrome(() => ({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_1" }] }));
    expect(await resolve("op-resolve-1")).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_1" }],
    });
    const frame = sent.find((message) => (message as { type?: string }).type === "content.resolve-target") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(frame?.payload).toEqual({ generalPageReadGrantId: "grant-1", description: "search box", maxCandidates: 3 });

    fakeChrome(() => ({ ok: true, outcome: "no-match" }));
    expect(await resolve("op-resolve-2")).toEqual({ ok: true, outcome: "no-match" });
    fakeChrome(() => ({ ok: true, outcome: "too-broad" }));
    expect(await resolve("op-resolve-3")).toEqual({ ok: true, outcome: "too-broad" });

    // A candidate carrying anything beyond the handle is not a result the worker may hold, whatever
    // the page meant by it - including the role and the label the worker re-projects for itself.
    fakeChrome(() => ({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_1", value: "cats" }] }));
    expect(pageFailureCode(await resolve("op-resolve-4").catch((e: unknown) => e))).toBe("content.invalid-result");
    fakeChrome(() => ({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_1", role: "textbox", label: "Search" }] }));
    expect(pageFailureCode(await resolve("op-resolve-4b").catch((e: unknown) => e))).toBe("content.invalid-result");
    fakeChrome(() => ({ ok: true, outcome: "resolved", candidates: Array.from({ length: 4 }, (_, i) => ({ targetHandle: "t_" + i })) }));
    expect(pageFailureCode(await resolve("op-resolve-5").catch((e: unknown) => e))).toBe("content.invalid-result");
    fakeChrome(() => ({ ok: true, outcome: "ambiguous" }));
    expect(pageFailureCode(await resolve("op-resolve-6").catch((e: unknown) => e))).toBe("content.invalid-result");
    fakeChrome(() => ({ ok: false, reason: "stale-context" }));
    expect(await resolve("op-resolve-7")).toEqual({ ok: false, reason: "stale-context" });
  });

  /**
   * 004/T168. The page answers a point confirmation with `stale-target` when the ref it named has
   * left the document since the delivery (its own activation removed it). That is "the check could
   * not be made", which the confirmer already reads from `ok: false` as `unconfirmed` - never a miss,
   * and never an invalid reply. A point resolution that named no ref has nothing to be stale about,
   * so the same word from the page there is still what it always was: not a reply this worker holds.
   */
  it("reads a point confirmation whose ref has left the document as unconfirmable, not invalid (T168)", async () => {
    const resolve = (operationId: string, targetHandle?: string) =>
      resolveHandleOnTab({
        taskId: "task-confirm",
        operationId,
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        expectedTabId: 7,
        canonicalOrigin: "https://example.test",
        documentEpoch: "doc-live",
        generalPageReadGrantId: "grant-1",
        point: { x: 10, y: 10 },
        ...(targetHandle === undefined ? {} : { targetHandle }),
      });
    fakeChrome(() => ({ ok: false, reason: "stale-target" }));
    expect(await resolve("op-confirm-1", "t_play")).toEqual({ ok: false, reason: "stale-context" });
    fakeChrome(() => ({ ok: false, reason: "stale-target" }));
    expect(pageFailureCode(await resolve("op-confirm-2").catch((e: unknown) => e))).toBe("content.invalid-result");
  });

  it("re-probes the bound tab after an effect without injecting and reports a replaced document", async () => {
    let probes = 0;
    let injections = 0;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript() {
          injections += 1;
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage() {
          probes += 1;
          if (probes === 1) {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          throw new Error("Could not establish connection. Receiving end does not exist.");
        },
      },
    };
    const same = await probeActiveTab({
      taskId: "task-observe",
      operationId: "verify-1",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      canonicalOrigin: "https://example.test",
    });
    expect(same).toEqual({ ok: true, documentEpoch: "doc-live", canonicalOrigin: "https://example.test" });
    const gone = await probeActiveTab({
      taskId: "task-observe",
      operationId: "verify-2",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: 7,
      canonicalOrigin: "https://example.test",
    });
    expect(gone).toEqual({ ok: false, reason: "document-replaced" });
    expect(injections).toBe(0);
  });

  it("treats a frame that answers nothing as a frame without a runtime, and injects into it", async () => {
    // 004/T107a: the agent build declares a content script in every frame, so `sendMessage` finds a
    // receiver even where the page runtime was never injected - the declared script does not answer
    // a runtime frame, and Chrome resolves the call with `undefined` instead of the "receiving end
    // does not exist" rejection this path used to get. An absent answer is the same fact as an
    // absent receiver: no runtime is bound here, so the probe must say `document-replaced` and the
    // collection must inject, or every read on a freshly declared page answers `stale`.
    let probes = 0;
    let injections = 0;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript() {
          injections += 1;
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const frame = message as { type: string };
          if (frame.type !== "content.probe") {
            return {
              contextHandle: "snap-live",
              documentEpoch: "doc-live",
              canonicalOrigin: "https://example.test",
              visibleText: "Visible fixture",
              formValueItems: [],
            };
          }
          probes += 1;
          // The declared script is the only listener until the runtime is injected.
          return injections === 0 ? undefined : { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
        },
      },
    };
    expect(
      await probeActiveTab({
        taskId: "task-declared",
        operationId: "verify-declared",
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        expectedTabId: 7,
        canonicalOrigin: "https://example.test",
      }),
    ).toEqual({ ok: false, reason: "document-replaced" });
    expect(injections).toBe(0);
    await collectFromActiveTab({
      taskId: "task-declared",
      operationId: "collect-declared",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      requested: ["page.structure"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-declared",
      formGrantActive: false,
    });
    expect(injections).toBe(1);
    expect(probes).toBe(3);
  });

  it("reports stale-context when the active tab is no longer the bound tab", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 8, url: "https://example.test/other" }];
        },
        async sendMessage() {
          return { documentEpoch: "doc-other", canonicalOrigin: "https://example.test" };
        },
      },
    };
    expect(
      await probeActiveTab({
        taskId: "task-observe",
        operationId: "verify-3",
        runtimeEpochId: "epoch-1",
        nonce: TEST_NONCE,
        expectedTabId: 7,
        canonicalOrigin: "https://example.test",
      }),
    ).toEqual({ ok: false, reason: "stale-context" });
  });
});

/**
 * WP3 (review H3/M5): the executor's own probe is an await the worker cannot see through, so the
 * worker-owned fence is handed to the executor and re-run after the probe, immediately before the
 * effect is sent. The executor also refuses any active tab other than the leased one before it
 * probes or injects.
 */
describe("WP3 dispatch fence inside the executor", () => {
  function installChrome(input: {
    activeTabId: number;
    injections: unknown[];
    onMessage: (type: string) => unknown;
  }) {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript(call: unknown) {
          input.injections.push(call);
        },
      },
      tabs: {
        async query() {
          return [{ id: input.activeTabId, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.safeParse(message);
          if (!parsed.success) throw new Error("invalid-content-frame");
          return input.onMessage(parsed.data.type);
        },
      },
    };
  }

  const scrollInput = {
    taskId: "task-1",
    operationId: "op-fence",
    runtimeEpochId: "epoch-1",
    nonce: TEST_NONCE,
    capability: "browser.scroll" as const,
    arguments: { mode: "viewport", direction: "down", magnitude: "small" },
    documentEpoch: "doc-live",
    canonicalOrigin: "https://example.test",
    expectedTabId: 7,
  };

  it("refuses an effect on a tab other than the leased one without probing or injecting", async () => {
    const injections: unknown[] = [];
    const sent: string[] = [];
    installChrome({
      activeTabId: 8,
      injections,
      onMessage: (type) => {
        sent.push(type);
        return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
      },
    });
    expect(await executeOnActiveTab(scrollInput)).toEqual({ ok: false, reachedPage: false, reason: "stale-context" });
    expect(sent).toEqual([]);
    expect(injections).toHaveLength(0);
  });

  it("asks the worker again after its probe and sends no effect once the answer is no", async () => {
    const injections: unknown[] = [];
    const sent: string[] = [];
    let allowed = true;
    installChrome({
      activeTabId: 7,
      injections,
      onMessage: (type) => {
        sent.push(type);
        if (type === "content.probe") {
          // Stop lands while the probe round trip is in flight.
          allowed = false;
          return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
        }
        return { ok: true, effect: "scrolled", scrollTop: 80, targetVisibility: "not-applicable" };
      },
    });
    const answers: boolean[] = [];
    const executed = await executeOnActiveTab({
      ...scrollInput,
      stillAllowed: () => {
        answers.push(allowed);
        return allowed;
      },
    });
    expect(executed).toEqual({ ok: false, reachedPage: false, reason: "fence-refused" });
    expect(sent).toEqual(["content.probe"]);
    expect(answers).toEqual([false]);
    expect(injections).toHaveLength(0);
  });

  it("refuses an effect when the active tab shows another origin, without probing or injecting", async () => {
    const injections: unknown[] = [];
    const sent: string[] = [];
    installChrome({
      activeTabId: 7,
      injections,
      onMessage: (type) => {
        sent.push(type);
        return { documentEpoch: "doc-live", canonicalOrigin: "https://elsewhere.test" };
      },
    });
    expect(
      await executeOnActiveTab({ ...scrollInput, canonicalOrigin: "https://elsewhere.test" }),
    ).toEqual({ ok: false, reachedPage: false, reason: "stale-context" });
    expect(sent).toEqual([]);
    expect(injections).toHaveLength(0);
  });

  it("sends the effect when the worker still allows it after the probe", async () => {
    const injections: unknown[] = [];
    const sent: string[] = [];
    installChrome({
      activeTabId: 7,
      injections,
      onMessage: (type) => {
        sent.push(type);
        if (type === "content.probe") {
          return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
        }
        return { ok: true, effect: "scrolled", scrollTop: 80, targetVisibility: "not-applicable" };
      },
    });
    const answers: boolean[] = [];
    const executed = await executeOnActiveTab({
      ...scrollInput,
      stillAllowed: () => {
        answers.push(true);
        return true;
      },
    });
    expect(executed).toMatchObject({ ok: true, effect: "scrolled", scrollTop: 80 });
    expect(sent).toEqual(["content.probe", "content.execute-action"]);
    expect(answers).toEqual([true]);
  });

  /**
   * WP8 claim 8: the frame is assembled - and therefore validated - before the fence is asked. A
   * frame the schema refuses must be a refusal that never reached the page, not a throw after the
   * fence has already committed the effect and made its outcome uncertain.
   */
  it("refuses an unbuildable frame without ever asking the fence", async () => {
    const sent: string[] = [];
    let fenceAsked = 0;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: 7, url: "https://example.test/page" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const parsed = contentRuntimeMessageSchema.parse(message);
          sent.push(parsed.type);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          throw new Error("the effect must never be sent");
        },
      },
    };
    const result = await executeOnActiveTab({
      taskId: "task-unbuildable",
      operationId: "op-unbuildable",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      capability: "browser.enter-text",
      // no targetHandle and no editMode: the closed shape cannot be built from this
      arguments: { text: "hello" },
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
      expectedTabId: 7,
      stillAllowed: () => {
        fenceAsked += 1;
        return true;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid-action-arguments" });
    expect(fenceAsked).toBe(0);
    expect(sent).toEqual(["content.probe"]);
  });
});

/**
 * WP3: a Stop cancels on the leased tab. The runtime that may be running the effect lives there
 * even when the user has since switched to another tab of the same origin.
 */
describe("WP3 cancel targets the leased tab", () => {
  function installChrome(input: { leasedUrl: string; targets: number[] }) {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: {
        async executeScript() {
          throw new Error("cancel must never inject");
        },
      },
      tabs: {
        async query() {
          return [{ id: 8, url: "https://example.test/other" }];
        },
        async get(id: number) {
          if (id !== 7) throw new Error("No tab with id");
          return { id, url: input.leasedUrl };
        },
        async sendMessage(tabId: number) {
          input.targets.push(tabId);
          return { ok: true, effect: "cancelled" };
        },
      },
    };
  }

  const cancelInput = {
    taskId: "task-leased",
    operationId: "op-req-9",
    runtimeEpochId: "epoch-1",
    nonce: TEST_NONCE,
    tabId: 7,
    documentEpoch: "doc-live",
    canonicalOrigin: "https://example.test",
  };

  it("sends the cancel to the leased tab even when another tab is active", async () => {
    const targets: number[] = [];
    installChrome({ leasedUrl: "https://example.test/page", targets });
    expect(await cancelActiveContent(cancelInput)).toEqual({ cancelled: true });
    expect(targets).toEqual([7]);
  });

  it("reports no cancellation when the leased tab is gone or shows another origin", async () => {
    const targets: number[] = [];
    installChrome({ leasedUrl: "https://elsewhere.test/page", targets });
    expect(await cancelActiveContent(cancelInput)).toEqual({ cancelled: false });
    expect(await cancelActiveContent({ ...cancelInput, tabId: 9 })).toEqual({ cancelled: false });
    expect(targets).toEqual([]);
  });
});

/**
 * 002 US6 (FR-027). One question per poll, asked of the leased tab. A wait spans seconds and touches
 * nothing, so which tab the user happens to be looking at while it runs is none of its business -
 * unlike an effect, which may only ever land on the tab in front of them. What ends a wait early is
 * the bound document going away, and that is a fact about the leased tab alone.
 */
describe("002 US6 condition evaluation over the content broker", () => {
  function installChrome(input: {
    /** The tab the user is looking at now; deliberately not the leased one in most cases below. */
    activeTabId: number;
    leasedTabId?: number;
    sent: unknown[];
    targets: number[];
    reply: () => unknown;
  }) {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      scripting: { async executeScript() {} },
      tabs: {
        async query() {
          return [{ id: input.activeTabId, url: "https://example.test/other" }];
        },
        async get(id: number) {
          if (id !== (input.leasedTabId ?? 7)) throw new Error("No tab with id");
          return { id, url: "https://example.test/page" };
        },
        async sendMessage(tabId: number, message: unknown) {
          input.targets.push(tabId);
          const parsed = contentRuntimeMessageSchema.parse(message);
          input.sent.push(parsed);
          if (parsed.type === "content.probe") {
            return { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" };
          }
          return input.reply();
        },
      },
    };
  }

  const evaluateInput = {
    taskId: "task-wait",
    operationId: "op-wait-1",
    runtimeEpochId: "epoch-1",
    nonce: TEST_NONCE,
    expectedTabId: 7,
    canonicalOrigin: "https://example.test",
    documentEpoch: "doc-live",
    generalPageReadGrantId: "grant-wait",
    targetHandle: "tgt-1",
    condition: "present" as const,
  };

  const evaluateWith = async (reply: () => unknown, activeTabId = 8) => {
    const sent: unknown[] = [];
    const targets: number[] = [];
    installChrome({ activeTabId, sent, targets, reply });
    const outcome = await evaluateConditionOnLeasedTab(evaluateInput).catch((error: unknown) => error);
    return { outcome, sent, targets };
  };

  it("asks the leased tab while the user looks at another one, and forwards the boolean", async () => {
    const held = await evaluateWith(() => ({ ok: true, holds: true }));
    expect(held.outcome).toEqual({ ok: true, holds: true });
    // Every frame went to the leased tab, not to the tab that happens to be active.
    expect(held.targets).toEqual([7, 7]);
    const frame = held.sent.find((message) => (message as { type?: string }).type === "content.evaluate-condition") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(frame?.payload).toEqual({
      generalPageReadGrantId: "grant-wait",
      targetHandle: "tgt-1",
      condition: "present",
    });

    const notYet = await evaluateWith(() => ({ ok: true, holds: false }));
    expect(notYet.outcome).toEqual({ ok: true, holds: false });
  });

  it("refuses a reply that says more, or less, than the one boolean", async () => {
    // A wait may learn exactly one thing about a document it is only watching.
    const extra = await evaluateWith(() => ({ ok: true, holds: true, text: "result opened" }));
    expect(pageFailureCode(extra.outcome)).toBe("content.invalid-result");
    const wrongType = await evaluateWith(() => ({ ok: true, holds: "yes" }));
    expect(pageFailureCode(wrongType.outcome)).toBe("content.invalid-result");
    const missing = await evaluateWith(() => ({ ok: true }));
    expect(pageFailureCode(missing.outcome)).toBe("content.invalid-result");
  });

  it("forwards a runtime refusal it knows and refuses one it does not", async () => {
    // The runtime's own vocabulary travels as it is: the worker decides from the reason whether the
    // wait is over, so a handle the page no longer knows arrives under its own name.
    const stale = await evaluateWith(() => ({ ok: false, reason: "stale-target" }));
    expect(stale.outcome).toEqual({ ok: false, reason: "stale-target" });
    const unknown = await evaluateWith(() => ({ ok: false, reason: "evaluate-failed" }));
    expect(pageFailureCode(unknown.outcome)).toBe("content.invalid-result");
  });

  it("reports stale-context when the leased tab is gone or shows another origin", async () => {
    const sent: unknown[] = [];
    const targets: number[] = [];
    installChrome({ activeTabId: 8, leasedTabId: 9, sent, targets, reply: () => ({ ok: true, holds: true }) });
    // The tab the wait was bound to is gone: there is no document left to watch, which is the same
    // fact - and the same word - as the document under it having changed.
    expect(await evaluateConditionOnLeasedTab(evaluateInput)).toEqual({ ok: false, reason: "stale-context" });
    expect(targets).toEqual([]);

    installChrome({ activeTabId: 7, sent, targets, reply: () => ({ ok: true, holds: true }) });
    expect(
      await evaluateConditionOnLeasedTab({ ...evaluateInput, canonicalOrigin: "https://elsewhere.test" }),
    ).toEqual({ ok: false, reason: "stale-context" });
    expect(targets).toEqual([]);
  });

  it("bounds a poll the page never answers, and names the stage it gave out at", async () => {
    vi.useFakeTimers();
    try {
      (globalThis as { chrome?: unknown }).chrome = {
        runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        scripting: { async executeScript() {} },
        tabs: {
          async query() {
            return [{ id: 8, url: "https://example.test/other" }];
          },
          async get(id: number) {
            return { id, url: "https://example.test/page" };
          },
          sendMessage(_tabId: number, message: unknown) {
            const parsed = contentRuntimeMessageSchema.safeParse(message);
            if (parsed.success && parsed.data.type === "content.probe") {
              return Promise.resolve({ documentEpoch: "doc-live", canonicalOrigin: "https://example.test" });
            }
            return new Promise(() => {});
          },
        },
      };
      const outcome = evaluateConditionOnLeasedTab(evaluateInput)
        .then(() => "resolved")
        .catch((error: unknown) => pageFailureCode(error));
      const advanced = vi.advanceTimersByTimeAsync(120_000).then(() => "still-pending");
      // A poll is its own stage: reporting a collection failure for a question that never touched
      // the page sends a reader of the diagnostics to the wrong round trip.
      expect(await Promise.race([outcome, advanced])).toBe("content.evaluation");
    } finally {
      vi.useRealTimers();
    }
  });
});
