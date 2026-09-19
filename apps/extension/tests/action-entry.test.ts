import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWorkspace } from "../src/chrome-adapters/action-entry.js";

type Recorded = string[];

function stubChrome(recorded: Recorded): void {
  vi.stubGlobal("chrome", {
    sidePanel: {
      async open() {
        recorded.push("open");
      },
      async setOptions() {
        recorded.push("setOptions");
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("action entry side panel activation", () => {
  it("issues sidePanel.open before its first suspension", async () => {
    const recorded: Recorded = [];
    stubChrome(recorded);

    const activation = activateWorkspace(7);

    // Chrome only accepts `sidePanel.open()` while the user gesture that triggered the action is
    // still live, and awaiting anything at all spends that gesture. Both calls are issued before
    // this function's first suspension, but `open` must be the one that goes out first: if
    // `setOptions` is awaited ahead of it, a real Chrome rejects the open with
    // "`sidePanel.open()` may only be called in response to a user gesture."
    expect(recorded[0]).toBe("open");

    await activation;
    expect(recorded).toContain("setOptions");
  });

  it("does nothing without a tab id", async () => {
    const recorded: Recorded = [];
    stubChrome(recorded);

    await activateWorkspace(undefined);

    expect(recorded).toEqual([]);
  });
});
