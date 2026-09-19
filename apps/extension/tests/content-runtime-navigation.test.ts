import { describe, expect, it, vi } from "vitest";

import {
  createContentRuntimeContext,
  installNavigationInvalidation,
} from "../src/content-runtime/index.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

describe("content runtime SPA navigation lifecycle", () => {
  it("rotates the document epoch and clears binding/targets after pushState changes the URL", () => {
    let href = "https://example.test/ordinary";
    const listeners = new Map<string, () => void>();
    const history = {
      pushState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
        if (url !== undefined && url !== null) href = new URL(String(url), href).href;
      }),
      replaceState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
        if (url !== undefined && url !== null) href = new URL(String(url), href).href;
      }),
    };
    const host = {
      get location() {
        return { href, origin: new URL(href).origin };
      },
      history,
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener);
      },
    };
    const context = createContentRuntimeContext({
      documentEpoch: "doc-before",
      canonicalOrigin: "https://example.test",
    });
    context.binding = { taskId: "task-1", runtimeEpochId: "runtime-1", nonce: TEST_NONCE };
    context.registry.issue({
      targetHandle: "target-1",
      snapshotId: "snapshot-1",
      documentEpoch: "doc-before",
    });

    installNavigationInvalidation(context, host);
    history.pushState({}, "", "/spa/next");

    expect(context.documentEpoch).not.toBe("doc-before");
    expect(context.canonicalOrigin).toBe("https://example.test");
    expect(context.binding).toBeUndefined();
    expect(context.registry.resolve("target-1", "doc-before")).toBeUndefined();
  });
});
