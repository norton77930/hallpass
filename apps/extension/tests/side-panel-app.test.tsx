import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_BUILD_EXTENSION_ID } from "../src/build-config.js";
import { App } from "../src/side-panel/App.js";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "chrome");
});

/**
 * 006/T192 — `App` renders the rebuilt agent shell and none of the archived remote path (FR-088,
 * D-006-2). Since 009 removed that path there is no profile branch left to take: this is the panel.
 */
describe("side-panel App composition", () => {
  function installAgentPortOnly(): void {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: TEST_BUILD_EXTENSION_ID,
        connect: () => ({
          name: "hallpass-panel",
          postMessage() {},
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
        }),
      },
    };
  }

  it("renders only the agent shell: no service status, no sign-in, no workspace", async () => {
    installAgentPortOnly();
    const view = render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    // The shell is a lazy chunk: the first import of its module graph (and its CSS) can outlast the
    // one-second default in this environment, and a timeout here would be about the bundler rather
    // than about what is rendered.
    expect(
      await view.findByRole("heading", { level: 1, name: "Hallpass" }, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(document.querySelector("[data-agent-state]")).toBeTruthy();
    expect(view.queryByRole("status")).toBeNull();
    expect(view.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(view.queryByText(/Assistant service/)).toBeNull();
    expect(view.queryByLabelText(/ask about this page/i)).toBeNull();
    expect(document.documentElement.lang).toBe("en-US");
  });
});
