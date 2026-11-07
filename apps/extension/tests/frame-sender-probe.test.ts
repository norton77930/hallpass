import { afterEach, describe, expect, it } from "vitest";
import { FRAME_SENDER_PROBE_KEY, probeFrameSender } from "../src/chrome-adapters/frame-sender.js";

/**
 * 030/T891 - the one message a claimed frame sends the worker, and what the browser attaches to it.
 *
 * The decision reads only the sender fields the browser fills in (R-440, "Measured 2026-11-07"), so
 * what is pinned here is the matching around them: the probe's own nonce and tab, nothing from the
 * message body, a bound after which the answer is "no reply", and no listener left behind.
 */

type Sender = { origin?: string; frameId?: number; documentId?: string; tab?: { id?: number } };
type Listener = (message: unknown, sender: Sender, sendResponse: (value: unknown) => void) => unknown;

function installChrome(options: {
  /** What the browser attaches to the frame's message; the message itself is what the frame wrote. */
  deliver?: (message: Record<string, unknown>, send: (message: unknown, sender: Sender) => void) => void;
  injection?: () => Promise<Array<{ frameId: number; documentId: string; result?: unknown }>>;
}) {
  const listeners = new Set<Listener>();
  const injected: Array<{ target: unknown; world: unknown }> = [];
  const send = (message: unknown, sender: Sender) => {
    for (const listener of [...listeners]) listener(message, sender, () => {});
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
      // The frame's side of the round trip: the injected function calls this, and the fake browser
      // hands it to the worker's listeners with a sender of the test's choosing.
      sendMessage: async (message: Record<string, unknown>) => {
        options.deliver?.(message, send);
        return undefined;
      },
    },
    scripting: {
      async executeScript(details: {
        target: { tabId: number; frameIds: number[] };
        world: string;
        func: (...args: unknown[]) => unknown;
        args: unknown[];
      }) {
        injected.push({ target: details.target, world: details.world });
        if (options.injection) return options.injection();
        const result = details.func(...details.args);
        return [{ frameId: details.target.frameIds[0] ?? 0, documentId: "doc-pay", result }];
      },
    },
  };
  return { listeners, injected };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("030 frame sender probe", () => {
  it("answers the sender the browser attached and the document the probe ran in, never the body", async () => {
    const fake = installChrome({
      deliver: (message, send) =>
        send(
          // The frame may write anything beside the nonce; only the sender below is read.
          { ...message, origin: "https://shop.test" },
          { origin: "https://pay.test", frameId: 12, documentId: "doc-pay", tab: { id: 7 } },
        ),
    });

    const probed = await probeFrameSender(7, 12, 500);

    expect(probed).toEqual({
      documentId: "doc-pay",
      sender: { origin: "https://pay.test", frameId: 12, documentId: "doc-pay" },
    });
    expect(fake.injected).toEqual([{ target: { tabId: 7, frameIds: [12] }, world: "ISOLATED" }]);
    expect(fake.listeners.size, "the one-shot listener is removed once answered").toBe(0);
  });

  it("ignores a message with another nonce or from another tab, and answers no sender at the bound", async () => {
    const fake = installChrome({
      deliver: (message, send) => {
        send({ [FRAME_SENDER_PROBE_KEY]: "someone-else" }, { origin: "https://shop.test", frameId: 12, documentId: "doc-pay", tab: { id: 7 } });
        send(message, { origin: "https://shop.test", frameId: 12, documentId: "doc-pay", tab: { id: 8 } });
      },
    });

    const probed = await probeFrameSender(7, 12, 40);

    expect(probed.sender).toBeUndefined();
    expect(fake.listeners.size, "the listener is removed after the bound too").toBe(0);
  });

  it("answers nothing at once when the browser refuses the injection, and leaves no listener", async () => {
    const fake = installChrome({
      injection: async () => {
        throw new Error("Frame with ID 12 was removed.");
      },
    });

    const started = Date.now();
    const probed = await probeFrameSender(7, 12, 5_000);

    expect(probed).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.listeners.size).toBe(0);
  });
});
