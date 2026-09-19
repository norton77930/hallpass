import { afterEach, describe, expect, it } from "vitest";
import { resizeWindow } from "../src/chrome-adapters/windows.js";

/**
 * resize_window on a window that is not in the "normal" state (found 2026-09-16 on the owner's
 * maximized branded Chrome: 1024x768 and 900x600 both came back as the unchanged 2064x1120).
 *
 * Chrome's `windows.update` applies `width`/`height` only to a window in the "normal" state; on a
 * maximized, minimized or fullscreen window the bounds are dropped without an error. The adapter
 * has to restore the window to "normal" first, and the fake below reproduces exactly that rule so
 * the test goes red on the original single-call implementation.
 */
describe("resizeWindow on a window that is not in the normal state", () => {
  type FakeWindow = { id: number; state: string; width: number; height: number };
  type UpdateInfo = { state?: string; width?: number; height?: number };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  function installChrome(initial: FakeWindow): { window: FakeWindow; updates: UpdateInfo[] } {
    const window = { ...initial };
    const updates: UpdateInfo[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      windows: {
        async get(windowId: number) {
          if (windowId !== window.id) throw new Error(`No window with id: ${windowId}.`);
          return { ...window };
        },
        async update(windowId: number, info: UpdateInfo) {
          if (windowId !== window.id) throw new Error(`No window with id: ${windowId}.`);
          updates.push({ ...info });
          if (info.state !== undefined) window.state = info.state;
          // Chrome's rule: bounds only take effect on a "normal" window.
          if (window.state === "normal") {
            if (info.width !== undefined) window.width = info.width;
            if (info.height !== undefined) window.height = info.height;
          }
          return { ...window };
        },
      },
    };
    return { window, updates };
  }

  it("honours the requested size on a maximized window by restoring it to normal first", async () => {
    const { window, updates } = installChrome({ id: 900, state: "maximized", width: 2064, height: 1120 });

    const resized = await resizeWindow(900, { width: 1024, height: 768 });

    expect(resized.size).toEqual({ width: 1024, height: 768 });
    // 008/FR-118: the state the window was in before anything was updated, read once, here.
    expect(resized.priorState).toBe("maximized");
    expect(window.state).toBe("normal");
    // The state change lands before (or together with) the bounds, never after them.
    const firstBounds = updates.findIndex((u) => u.width !== undefined || u.height !== undefined);
    const firstNormal = updates.findIndex((u) => u.state === "normal");
    expect(firstNormal).toBeGreaterThanOrEqual(0);
    expect(firstNormal).toBeLessThanOrEqual(firstBounds);
  });

  it("honours the requested size on a fullscreen window the same way", async () => {
    const { window } = installChrome({ id: 901, state: "fullscreen", width: 2560, height: 1440 });

    const resized = await resizeWindow(901, { width: 900, height: 600 });

    expect(resized.size).toEqual({ width: 900, height: 600 });
    expect(resized.priorState).toBe("fullscreen");
    expect(window.state).toBe("normal");
  });

  it("leaves a normal window's state alone and sends the bounds in a single update", async () => {
    const { updates } = installChrome({ id: 902, state: "normal", width: 1400, height: 900 });

    const resized = await resizeWindow(902, { width: 1024, height: 768 });

    expect(resized.size).toEqual({ width: 1024, height: 768 });
    // Nothing to give back: a window that was already normal was never taken out of anything.
    expect(resized.priorState).toBe("normal");
    expect(updates).toEqual([{ width: 1024, height: 768 }]);
  });

  it("still reports the size Chrome ended up with when the display clamps the request", async () => {
    installChrome({ id: 903, state: "normal", width: 1400, height: 900 });
    const chrome = (globalThis as { chrome: { windows: { update: (id: number, info: UpdateInfo) => Promise<FakeWindow> } } }).chrome;
    const honest = chrome.windows.update;
    chrome.windows.update = async (id, info) => {
      const updated = await honest(id, info);
      return { ...updated, width: Math.min(updated.width, 1920), height: Math.min(updated.height, 1080) };
    };

    const resized = await resizeWindow(903, { width: 4000, height: 3000 });

    expect(resized.size).toEqual({ width: 1920, height: 1080 });
  });
});
