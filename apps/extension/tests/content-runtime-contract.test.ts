/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { handleContentMessage } from "../src/content-runtime/index.js";
import { TEST_NONCE, TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

function frame(
  type: "content.probe" | "content.collect-page" | "content.execute-action" | "content.cancel",
  documentEpoch: string,
  payload: Record<string, unknown>,
) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: "message-" + type,
    runtimeEpochId: "epoch-1",
    type,
    taskId: "task-1",
    operationId: "operation-" + type,
    nonce: TEST_NONCE,
    expectedTabId: 7,
    expectedDocumentEpoch: documentEpoch,
    payload,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("content runtime wire contract", () => {
  it("probes, collects opaque in-memory targets, and applies DOM effects without echoing entered text", () => {
    document.body.innerHTML =
      '<button type="button" aria-label="Go">Go</button>' +
      '<input type="text" name="nickname" aria-label="Nickname" value="start" />';
    let clicks = 0;
    const button = document.querySelector("button");
    const input = document.querySelector("input");
    if (!(button instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("fixture-missing");
    }
    button.addEventListener("click", () => {
      clicks += 1;
    });

    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
      canonicalOrigin: string;
    };
    expect(probe.documentEpoch).toBeTruthy();
    expect(probe.canonicalOrigin).toBe(location.origin);

    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as {
      documentEpoch: string;
      visibleText: string;
      semanticNodes: Array<{ label?: string; targetHandle?: string }>;
    };
    expect(collected.documentEpoch).toBe(probe.documentEpoch);
    expect(collected.visibleText).toContain("Go");
    expect(document.querySelector("[data-target-handle]")).toBeNull();
    const clickHandle = collected.semanticNodes.find((node) => node.label === "Go")?.targetHandle;
    const textHandle = collected.semanticNodes.find((node) => node.label === "Nickname")?.targetHandle;
    expect(clickHandle).toBeTruthy();
    expect(textHandle).toBeTruthy();

    const clicked = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.click",
        arguments: { targetHandle: clickHandle },
      }),
    ) as { ok: boolean };
    expect(clicked.ok).toBe(true);
    expect(clicks).toBe(1);

    const entered = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.enter-text",
        arguments: { targetHandle: textHandle, text: "hello", editMode: "replace" },
      }),
    ) as Record<string, unknown>;
    expect(entered).toMatchObject({
      ok: true,
      effect: "text-entered",
      charactersChanged: 5,
      valueEchoed: false,
    });
    expect(entered).not.toHaveProperty("value");
    expect(input.value).toBe("hello");
  });

  /**
   * WP8 claim 5: the binding is identified by a nonce the worker minted, so a frame captured under
   * an earlier binding cannot be replayed into a live one even when its task and epoch still match.
   */
  it("refuses a frame whose nonce is not the one this binding was established with", () => {
    document.body.innerHTML = '<button type="button" aria-label="Safe">Safe</button>';
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const replayed = {
      ...frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text"],
      }),
      nonce: "f".repeat(32),
    };
    expect(handleContentMessage(replayed)).toMatchObject({ ok: false, reason: "stale-binding" });
    // the binding this document actually holds is untouched and still answers
    expect(
      handleContentMessage(
        frame("content.collect-page", probe.documentEpoch, {
          generalPageReadGrantId: "grant-general-1",
          bounds: TEST_COLLECTION_BOUNDS,
          requestedDataCategories: ["page.visible-text"],
        }),
      ),
    ).toMatchObject({ documentEpoch: probe.documentEpoch });
  });

  it("fails closed for invalid frames and stale document epochs", () => {
    expect(handleContentMessage({ type: "content.probe", payload: {} })).toMatchObject({
      ok: false,
      reason: "invalid-message",
    });
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    expect(
      handleContentMessage(
        frame("content.execute-action", probe.documentEpoch + "-stale", {
          action: "browser.scroll",
          arguments: { mode: "viewport", direction: "down", magnitude: "small" },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "stale-context" });
  });

  it("keeps form text out of general visible text and never issues unsafe action handles", () => {
    document.body.innerHTML =
      '<p>Public fixture text</p>' +
      '<textarea name="notes" aria-label="Notes">textarea-secret</textarea>' +
      '<select name="choice" aria-label="Choice"><option selected>option-secret</option></select>' +
      '<input type="password" aria-label="Password" value="password-secret" />' +
      '<input type="file" aria-label="Upload" />' +
      '<button type="submit" aria-label="Submit">Submit</button>' +
      '<button type="button" aria-label="Safe">Safe</button>' +
      '<div hidden>hidden-secret</div>';
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as {
      visibleText: string;
      semanticNodes: Array<{ label?: string; targetHandle?: string }>;
    };
    expect(collected.visibleText).toContain("Public fixture text");
    expect(collected.visibleText).not.toMatch(/textarea-secret|option-secret|password-secret|hidden-secret/);
    expect(collected.semanticNodes.find((node) => node.label === "Safe")?.targetHandle).toBeTruthy();
    for (const label of ["Password", "Upload", "Submit"]) {
      expect(collected.semanticNodes.find((node) => node.label === label)).not.toHaveProperty("targetHandle");
    }
  });

  it("never turns a control's own content into its target label", () => {
    // A textarea's text node is its current value and a select's is its option list. Both would
    // otherwise become the accessible name the worker keeps and renders on a review card.
    document.body.innerHTML =
      '<p>Public fixture text</p>' +
      '<textarea name="notes">textarea-secret</textarea>' +
      '<select name="choice"><option selected>option-secret</option></select>' +
      '<button type="button">Safe action</button>';
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as {
      semanticNodes: Array<{ role?: string; label?: string; text?: string; targetHandle?: string }>;
    };
    const rendered = JSON.stringify(collected.semanticNodes);
    expect(rendered).not.toContain("textarea-secret");
    expect(rendered).not.toContain("option-secret");
    // A button's visible text is its name, not a value, and stays available for the review card.
    expect(collected.semanticNodes.find((node) => node.label === "Safe action")).toBeTruthy();
    // The controls are still offered, named by their form name rather than their content.
    expect(collected.semanticNodes.find((node) => node.label === "notes")?.targetHandle).toBeTruthy();
  });

  /**
   * 004/FR-066: a handle is unguessable *and* it stays with its element. 003 rotated every handle
   * on every collection, which is the limitation this slice removes - the two properties are
   * independent, and the one this test used to assert (rotation) was never what made a handle
   * unguessable.
   */
  it("issues unguessable target handles that stay with their element across collections", () => {
    document.body.innerHTML =
      '<button type="button" aria-label="Alpha">Alpha</button>' +
      '<button type="button" aria-label="Beta">Beta</button>';
    const collect = () => {
      const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
        documentEpoch: string;
      };
      return handleContentMessage(
        frame("content.collect-page", probe.documentEpoch, {
          generalPageReadGrantId: "grant-general-1",
          bounds: TEST_COLLECTION_BOUNDS,
          requestedDataCategories: ["page.visible-text", "page.target-metadata"],
        }),
      ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    };
    const first = collect();
    const handles = first.semanticNodes
      .map((node) => node.targetHandle)
      .filter((handle): handle is string => typeof handle === "string");
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      // never positional, never derivable from the collection order
      expect(handle).not.toMatch(/^tgt-\d+$/);
      expect(handle.replace(/[^0-9a-f]/g, "").length).toBeGreaterThanOrEqual(16);
    }
    expect(new Set(handles).size).toBe(2);
    const second = collect();
    const laterHandles = second.semanticNodes
      .map((node) => node.targetHandle)
      .filter((handle): handle is string => typeof handle === "string");
    // The same two elements, so the same two names: a reference the caller was given on the first
    // read is still the name of its element after the second.
    expect(laterHandles).toEqual(handles);

    // A new element is named for the first time, and never under a name another element has held.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button type="button" aria-label="Gamma">Gamma</button>',
    );
    const third = collect();
    const newest = third.semanticNodes
      .map((node) => node.targetHandle)
      .filter((handle): handle is string => typeof handle === "string");
    expect(newest.slice(0, 2)).toEqual(handles);
    expect(newest).toHaveLength(3);
    expect(handles).not.toContain(newest[2]);
  });

  /**
   * WP8 claim 1: the arguments of an action are a closed shape shared with the task channel, so a
   * forged descriptor is refused as an invalid frame rather than carried as far as classification
   * and then ignored. The same handle still works when the frame states only what the action takes.
   */
  it("refuses a frame carrying an argument the action does not take, then acts on the live element", () => {
    document.body.innerHTML = '<button type="button" aria-label="Safe">Safe</button>';
    let clicks = 0;
    document.querySelector("button")?.addEventListener("click", () => {
      clicks += 1;
    });
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    const handle = collected.semanticNodes.find((node) => node.label === "Safe")?.targetHandle;
    expect(handle).toBeTruthy();
    const forged = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.click",
        arguments: {
          targetHandle: handle,
          // A forged descriptor for a navigating anchor is not part of the click shape at all.
          target: { tagName: "A", href: "https://elsewhere.test/go", role: "link" },
        },
      }),
    ) as { ok: boolean; reason?: string };
    expect(forged).toMatchObject({ ok: false, reason: "invalid-message" });
    expect(clicks).toBe(0);

    const executed = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.click",
        arguments: { targetHandle: handle },
      }),
    ) as { ok: boolean; reason?: string };
    expect(executed.ok).toBe(true);
    expect(executed.reason).toBeUndefined();
    expect(clicks).toBe(1);
  });

  it("refuses an effect when the element turned sensitive after its handle was minted", () => {
    document.body.innerHTML =
      '<input type="text" name="nickname" aria-label="Nickname" value="start" />';
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    const handle = collected.semanticNodes.find((node) => node.label === "Nickname")?.targetHandle;
    expect(handle).toBeTruthy();

    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("fixture-missing");
    }
    // the page mutates the control into a payment field after the handle was issued
    input.setAttribute("autocomplete", "cc-number");
    const executed = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.enter-text",
        arguments: { targetHandle: handle, text: "4111111111111111", editMode: "replace" },
      }),
    ) as { ok: boolean; reason?: string };
    expect(executed.ok).toBe(false);
    expect(executed.reason).toBe("denied");
    expect(input.value).toBe("start");
  });

  it("refuses a click when the element became a link after its handle was minted", () => {
    document.body.innerHTML = '<button type="button" aria-label="Safe">Safe</button>';
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    const handle = collected.semanticNodes.find((node) => node.label === "Safe")?.targetHandle;
    expect(handle).toBeTruthy();
    document.querySelector("button")?.setAttribute("role", "link");
    const executed = handleContentMessage(
      frame("content.execute-action", probe.documentEpoch, {
        action: "browser.click",
        arguments: { targetHandle: handle },
      }),
    ) as { ok: boolean; reason?: string };
    expect(executed.ok).toBe(false);
    expect(executed.reason).toBe("denied");
  });
});
