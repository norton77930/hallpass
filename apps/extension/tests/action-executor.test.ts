import { describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { createMemorySink, executeAction } from "../src/content-runtime/actions.js";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

describe("T065 action executor", () => {
  it("applies real scroll, click, and text changes on the page sink", () => {
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-1", snapshotId: "snap-1", documentEpoch: "doc-1" });
    const sink = createMemorySink({ scrollTop: 0, fields: { "tgt-1": { value: "start", clicks: 0 } } });
    const scrolled = executeAction(registry, {
      capability: "browser.scroll",
      documentEpoch: "doc-1",
      magnitude: "small",
      sink,
    });
    expect(scrolled.ok).toBe(true);
    expect(scrolled.scrollTop).toBe(80);
    expect(sink.scrollTop).toBe(80);
    const clicked = executeAction(registry, {
      capability: "browser.click",
      documentEpoch: "doc-1",
      targetHandle: "tgt-1",
      target: { tagName: "BUTTON", type: "button" },
      sink,
    });
    expect(clicked.clicks).toBe(1);
    expect(sink.field("tgt-1")?.clicks).toBe(1);
    const typed = executeAction(registry, {
      capability: "browser.enter-text",
      documentEpoch: "doc-1",
      targetHandle: "tgt-1",
      target: { tagName: "INPUT", type: "text", name: "nickname" },
      text: "-more",
      editMode: "insert",
      sink,
    });
    expect(typed).toMatchObject({ charactersChanged: 5, valueEchoed: false });
    expect(typed).not.toHaveProperty("value");
    expect(sink.field("tgt-1")?.value).toBe("start-more");
  });

  it("routes execute-action through the content-runtime message handler", () => {
    const context = createContentRuntimeContext({
      documentEpoch: "doc-1",
      canonicalOrigin: "https://example.test",
    });
    const sink = createMemorySink({ scrollTop: 10 });
    handleContentMessage(
      {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        messageId: "probe-1",
        runtimeEpochId: "epoch-1",
        type: "content.probe",
        taskId: "task-1",
        operationId: "probe-1",
        nonce: TEST_NONCE,
        expectedTabId: 1,
        expectedDocumentEpoch: "probe-unbound",
        payload: {},
      },
      sink,
      context,
    );
    const result = handleContentMessage(
      {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        messageId: "action-1",
        runtimeEpochId: "epoch-1",
        type: "content.execute-action",
        taskId: "task-1",
        operationId: "action-1",
        nonce: TEST_NONCE,
        expectedTabId: 1,
        expectedDocumentEpoch: "doc-1",
        payload: {
          action: "browser.scroll",
          arguments: { mode: "viewport", direction: "down", magnitude: "medium" },
        },
      },
      sink,
      context,
    ) as { ok: boolean; scrollTop: number };
    expect(result.ok).toBe(true);
    expect(result.scrollTop).toBe(210);
    expect(sink.scrollTop).toBe(210);
  });

  it("denies stale, sensitive, submit, and file targets", () => {
    const registry = new TargetRegistry();
    expect(executeAction(registry, { capability: "browser.click", documentEpoch: "doc-1", targetHandle: "missing" }).ok).toBe(
      false,
    );
    registry.issue({ targetHandle: "tgt-1", snapshotId: "snap-1", documentEpoch: "doc-1" });
    expect(
      executeAction(registry, {
        capability: "browser.click",
        documentEpoch: "doc-1",
        targetHandle: "tgt-1",
        target: { tagName: "A", href: "https://example.test" },
      }).ok,
    ).toBe(false);
    expect(
      executeAction(registry, {
        capability: "browser.click",
        documentEpoch: "doc-1",
        targetHandle: "tgt-1",
        target: { tagName: "INPUT", type: "file" },
      }).ok,
    ).toBe(false);
    expect(
      executeAction(registry, {
        capability: "browser.enter-text",
        documentEpoch: "doc-1",
        targetHandle: "tgt-1",
        target: { tagName: "INPUT", type: "password" },
      }).ok,
    ).toBe(false);
  });
});

describe("WP1 post-effect observation", () => {
  it("reports documentChanged when a click handler moved the document URL", () => {
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-nav", snapshotId: "snap-1", documentEpoch: "doc-1" });
    const sink = createMemorySink({
      href: "https://example.test/start",
      fields: { "tgt-nav": { value: "", clicks: 0, navigatesTo: "https://example.test/next" } },
    });
    const clicked = executeAction(registry, {
      capability: "browser.click",
      documentEpoch: "doc-1",
      targetHandle: "tgt-nav",
      target: { tagName: "BUTTON", type: "button" },
      sink,
    });
    expect(clicked).toMatchObject({ ok: true, effect: "activated", clicks: 1, documentChanged: true });
  });

  it("reports documentChanged false for a click and text entry that left the URL alone", () => {
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-1", snapshotId: "snap-1", documentEpoch: "doc-1" });
    const sink = createMemorySink({
      href: "https://example.test/start",
      fields: { "tgt-1": { value: "", clicks: 0 } },
    });
    expect(
      executeAction(registry, {
        capability: "browser.click",
        documentEpoch: "doc-1",
        targetHandle: "tgt-1",
        target: { tagName: "BUTTON", type: "button" },
        sink,
      }),
    ).toMatchObject({ ok: true, documentChanged: false });
    expect(
      executeAction(registry, {
        capability: "browser.enter-text",
        documentEpoch: "doc-1",
        targetHandle: "tgt-1",
        target: { tagName: "INPUT", type: "text", name: "nickname" },
        text: "hi",
        sink,
      }),
    ).toMatchObject({ ok: true, effect: "text-entered", documentChanged: false, valueEchoed: false });
  });

  it("scrolls a target into view in target mode and reports its visibility", () => {
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-far", snapshotId: "snap-1", documentEpoch: "doc-1" });
    const sink = createMemorySink({
      scrollTop: 0,
      fields: { "tgt-far": { value: "", clicks: 0, offsetTop: 900 } },
    });
    const scrolled = executeAction(registry, {
      capability: "browser.scroll",
      documentEpoch: "doc-1",
      mode: "target",
      targetHandle: "tgt-far",
      sink,
    });
    expect(scrolled).toMatchObject({ ok: true, effect: "scrolled", scrollTop: 900, targetVisibility: "visible" });
    expect(sink.scrolledTo).toEqual(["tgt-far"]);
  });

  it("refuses target-mode scroll for a stale handle and reports not-applicable for viewport mode", () => {
    const registry = new TargetRegistry();
    const sink = createMemorySink({ scrollTop: 0 });
    expect(
      executeAction(registry, {
        capability: "browser.scroll",
        documentEpoch: "doc-1",
        mode: "target",
        targetHandle: "tgt-missing",
        sink,
      }),
    ).toMatchObject({ ok: false, reason: "stale-target" });
    expect(
      executeAction(registry, {
        capability: "browser.scroll",
        documentEpoch: "doc-1",
        mode: "viewport",
        direction: "down",
        magnitude: "medium",
        sink,
      }),
    ).toMatchObject({ ok: true, scrollTop: 200, targetVisibility: "not-applicable" });
  });

  it("passes scroll mode through the content-runtime message handler", () => {
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    const sink = createMemorySink({ scrollTop: 0, fields: { "tgt-far": { value: "", clicks: 0, offsetTop: 400 } } });
    handleContentMessage(
      {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        messageId: "probe-mode",
        runtimeEpochId: "epoch-1",
        type: "content.probe",
        taskId: "task-1",
        operationId: "probe-mode",
        nonce: TEST_NONCE,
        expectedTabId: 1,
        expectedDocumentEpoch: "probe-unbound",
        payload: {},
      },
      sink,
      context,
    );
    // The probe binds the runtime and clears the registry, so handles are minted after it.
    context.registry.issue({ targetHandle: "tgt-far", snapshotId: "snap-1", documentEpoch: "doc-1" });
    const result = handleContentMessage(
      {
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        messageId: "exec-mode",
        runtimeEpochId: "epoch-1",
        type: "content.execute-action",
        taskId: "task-1",
        operationId: "exec-mode",
        nonce: TEST_NONCE,
        expectedTabId: 1,
        expectedDocumentEpoch: "doc-1",
        payload: { action: "browser.scroll", arguments: { mode: "target", targetHandle: "tgt-far" } },
      },
      sink,
      context,
    );
    expect(result).toMatchObject({ ok: true, scrollTop: 400, targetVisibility: "visible" });
  });
});
