// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFromActiveTab } from "../src/service-worker/content-broker.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

type RuntimeListener = (
  message: unknown,
  sender: { id?: string },
  sendResponse: (response: unknown) => void,
) => boolean | void;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
  Reflect.deleteProperty(globalThis, "__pocContentRuntimeBound");
  Reflect.deleteProperty(globalThis, "__pocContentRuntimeListener");
  document.body.innerHTML = "";
  vi.resetModules();
});

describe("content runtime reinjection after extension reload", () => {
  it("rebinds the Chrome listener when a stale page guard outlives the old extension context", async () => {
    const listeners: RuntimeListener[] = [];
    (globalThis as typeof globalThis & { __pocContentRuntimeBound?: boolean }).__pocContentRuntimeBound =
      true;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        onMessage: {
          addListener(listener: RuntimeListener) {
            listeners.push(listener);
          },
        },
      },
    };

    vi.resetModules();
    await import("../src/content-runtime/index.js");

    expect(listeners).toHaveLength(1);
  });

  it("replaces the prior listener instead of duplicating it on same-document reinjection", async () => {
    const active = new Set<RuntimeListener>();
    const added: RuntimeListener[] = [];
    const removed: RuntimeListener[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        onMessage: {
          addListener(listener: RuntimeListener) {
            added.push(listener);
            active.add(listener);
          },
          removeListener(listener: RuntimeListener) {
            removed.push(listener);
            active.delete(listener);
          },
        },
      },
    };

    vi.resetModules();
    await import("../src/content-runtime/index.js");
    vi.resetModules();
    await import("../src/content-runtime/index.js");

    expect(added).toHaveLength(2);
    expect(removed).toEqual([added[0]]);
    expect(active).toEqual(new Set([added[1]!]));
  });

  /**
   * 033 review I1: agent-entry shares frame 0's isolated world and answers the worker's awaited
   * `marks` and `cursor` messages itself, later. This listener must stay silent for anything that is
   * not a `content.*` message, or its immediate `invalid-message` reply settles those waits at once.
   */
  describe("which messages the listener answers", () => {
    const runtimeId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    async function boundListener(): Promise<RuntimeListener> {
      const listeners: RuntimeListener[] = [];
      (globalThis as { chrome?: unknown }).chrome = {
        runtime: {
          id: runtimeId,
          onMessage: {
            addListener(listener: RuntimeListener) {
              listeners.push(listener);
            },
          },
        },
      };
      vi.resetModules();
      await import("../src/content-runtime/index.js");
      return listeners[0]!;
    }

    it.each([
      ["marks", { type: "marks", hidden: true }],
      ["cursor", { type: "cursor", x: 1, y: 2 }],
      ["pointer-step", { type: "pointer-step", words: "Clicking", mode: "travel" }],
      ["indicator", { type: "indicator", show: true, label: "Agent", action: "Back" }],
      ["a string", "marks"],
      ["null", null],
      ["an array", ["content.probe"]],
      ["a non-string type", { type: 7 }],
    ])("does not answer %s, so the message's real owner can", async (_name, message) => {
      const listener = await boundListener();
      const sendResponse = vi.fn();

      expect(listener(message, { id: runtimeId }, sendResponse)).toBe(false);

      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("still answers a malformed content.* message with the invalid-message reply", async () => {
      const listener = await boundListener();
      const sendResponse = vi.fn();

      listener({ type: "content.probe", unexpected: true }, { id: runtimeId }, sendResponse);

      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse.mock.calls[0]![0]).toMatchObject({ ok: false, reason: "invalid-message" });
    });

    it("does not answer a message from another sender", async () => {
      const listener = await boundListener();
      const sendResponse = vi.fn();

      expect(listener({ type: "content.probe" }, { id: "someone-else" }, sendResponse)).toBe(false);

      expect(sendResponse).not.toHaveBeenCalled();
    });
  });

  it("reinjects, probes, and collects from an existing page whose old listener was invalidated", async () => {
    const active = new Set<RuntimeListener>();
    const runtimeId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pageOrigin = globalThis.location.origin;
    (globalThis as typeof globalThis & { __pocContentRuntimeBound?: boolean }).__pocContentRuntimeBound =
      true;
    document.body.innerHTML = "<p>Visible after extension reload</p>";
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: runtimeId,
        onMessage: {
          addListener(listener: RuntimeListener) {
            active.add(listener);
          },
          removeListener(listener: RuntimeListener) {
            active.delete(listener);
          },
        },
      },
      scripting: {
        async executeScript() {
          vi.resetModules();
          await import("../src/content-runtime/index.js");
        },
      },
      tabs: {
        async query() {
          return [{ id: 7, url: pageOrigin + "/ordinary" }];
        },
        async sendMessage(_tabId: number, message: unknown) {
          const listener = [...active][0];
          if (!listener) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          let response: unknown;
          listener(message, { id: runtimeId }, (value) => {
            response = value;
          });
          return response;
        },
      },
    };

    const result = await collectFromActiveTab({
      taskId: "task-reload",
      operationId: "op-reload",
      runtimeEpochId: "epoch-reload",
      nonce: TEST_NONCE,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: "grant-reload",
      formGrantActive: false,
    });

    expect(active.size).toBe(1);
    expect(result.visibleText).toContain("Visible after extension reload");
  });
});
