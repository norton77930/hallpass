import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";
import { CONTENT_EXECUTION_REFUSAL_REASONS, DEFAULT_BOUNDS, isContentExecutionRefusalReason } from "@hallpass/contracts";

const TEST_NONCE = "0".repeat(32);
const TEST_COLLECTION_BOUNDS = {
  maxVisibleTextChars: DEFAULT_BOUNDS.maxVisibleTextChars,
  maxSemanticNodes: DEFAULT_BOUNDS.maxSemanticNodes,
  maxLabelChars: DEFAULT_BOUNDS.maxLabelChars,
};

const runtimeBase = {
  runtimeProtocolVersion: 2,
  messageId: "ui-1",
  runtimeEpochId: "epoch-1",
};

describe("T009 extension-runtime contract", () => {
  it("T095 pins runtime protocol 2 and the exact action enum as amended by 002/FR-028", () => {
    expect(contractExport("RUNTIME_PROTOCOL_VERSION")).toBe(2);
    expect(contractExport("BRIDGE_ACTIONS")).toEqual([
      "browser.scroll",
      "browser.click",
      "browser.enter-text",
      "browser.key-press",
      "browser.hover",
      "browser.double-click",
      "browser.drag",
    ]);
    expect(contractExport<readonly string[]>("BRIDGE_ACTIONS")).not.toContain(
      "browser.navigate-same-origin",
    );
  });

  it("requires trusted-sender and runtime-epoch fields on protected content messages", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    expectAccepted(
      schema,
      {
        ...runtimeBase,
        type: "content.collect-page",
        taskId: "task-1",
        operationId: "op-1",
        nonce: TEST_NONCE,
        expectedTabId: 3,
        expectedDocumentEpoch: "doc-1",
        payload: {
          generalPageReadGrantId: "grant-read",
          bounds: TEST_COLLECTION_BOUNDS,
          requestedDataCategories: ["page.canonical-origin", "page.visible-text"],
        },
      },
      "collect-page",
    );
    expectRejected(
      schema,
      {
        ...runtimeBase,
        type: "content.collect-page",
        payload: {},
      },
      "missing task/document binding",
    );
  });
});

describe("WP8 bounded and closed runtime boundaries", () => {
  const contentBase = {
    ...runtimeBase,
    taskId: "task-1",
    operationId: "op-1",
    nonce: TEST_NONCE,
    expectedTabId: 7,
    expectedDocumentEpoch: "doc-1",
  };

  /** Claim 5: every content frame carries the binding nonce, in one closed shape. */
  it("requires a well-formed binding nonce on every content frame", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    expectAccepted(schema, { ...contentBase, type: "content.cancel", payload: {} }, "cancel with a nonce");
    const { nonce: _dropped, ...withoutNonce } = contentBase;
    expectRejected(schema, { ...withoutNonce, type: "content.cancel", payload: {} }, "cancel without a nonce");
    expectRejected(
      schema,
      { ...contentBase, nonce: "not-hex", type: "content.cancel", payload: {} },
      "a nonce outside the closed shape",
    );
    expectRejected(
      schema,
      { ...contentBase, nonce: "0".repeat(31), type: "content.cancel", payload: {} },
      "a nonce short of 128 bits",
    );
  });

  /** Claim 6: the worker supplies the collection limits; the page never picks its own. */
  it("requires injected collection bounds on a page read", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    const payload = {
      generalPageReadGrantId: "grant-1",
      requestedDataCategories: ["page.visible-text"],
      bounds: TEST_COLLECTION_BOUNDS,
    };
    expectAccepted(schema, { ...contentBase, type: "content.collect-page", payload }, "bounded collection");
    const { bounds: _dropped, ...withoutBounds } = payload;
    expectRejected(
      schema,
      { ...contentBase, type: "content.collect-page", payload: withoutBounds },
      "collection without bounds",
    );
    expectRejected(
      schema,
      {
        ...contentBase,
        type: "content.collect-page",
        payload: { ...payload, bounds: { ...TEST_COLLECTION_BOUNDS, maxVisibleTextChars: 0 } },
      },
      "a bound that is not positive",
    );
  });

  /**
   * 003/B1: which controls a collection may name is a closed, caller-stated policy (FR-040).
   *
   * The remote path states nothing, which is `reviewed` - the frame it has always sent, unchanged.
   * The agent path states `all-controls`, and nothing else is a word this schema knows, so a page
   * or a caller cannot invent a third minting rule.
   */
  it("keeps the collection's minting policy a closed word", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    const payload = {
      generalPageReadGrantId: "grant-1",
      requestedDataCategories: ["page.structure", "page.target-metadata"],
      bounds: TEST_COLLECTION_BOUNDS,
    };
    expectAccepted(
      schema,
      { ...contentBase, type: "content.collect-page", payload },
      "a collection that states no minting policy",
    );
    expectAccepted(
      schema,
      { ...contentBase, type: "content.collect-page", payload: { ...payload, mintPolicy: "all-controls" } },
      "the agent's wide minting policy",
    );
    expectRejected(
      schema,
      { ...contentBase, type: "content.collect-page", payload: { ...payload, mintPolicy: "everything" } },
      "a minting policy nobody defined",
    );
  });

  /** Claim 1: the page receives the same closed action shape the channel accepts. */
  it("keeps the executed action and its arguments one closed pair", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    expectAccepted(
      schema,
      {
        ...contentBase,
        type: "content.execute-action",
        payload: { action: "browser.click", arguments: { targetHandle: "t_1" } },
      },
      "closed click payload",
    );
    expectRejected(
      schema,
      {
        ...contentBase,
        type: "content.execute-action",
        payload: { action: "browser.click", arguments: { targetHandle: "t_1", target: { tagName: "A" } } },
      },
      "a forged target descriptor",
    );
    expectRejected(
      schema,
      {
        ...contentBase,
        type: "content.execute-action",
        payload: {
          action: "browser.enter-text",
          arguments: {
            targetHandle: "t_1",
            text: "x".repeat(DEFAULT_BOUNDS.maxTextEntryChars + 1),
            editMode: "replace",
          },
        },
      },
      "entered text past the bound",
    );
  });
});

describe("002 T053b the content runtime's refusal vocabulary is closed", () => {
  it("pins the exact reasons a runtime reply may carry, and admits nothing else", () => {
    expect([...CONTENT_EXECUTION_REFUSAL_REASONS]).toEqual([
      "denied",
      "submission-guard",
      "unsupported-key",
      "stale-target",
      "missing-target",
      "missing-sink",
      "invalid-message",
      "stale-binding",
      "stale-context",
      "cancelled",
      "unsupported-page",
    ]);
    expect(isContentExecutionRefusalReason("submission-guard")).toBe(true);
    // The old open-ended fallback, and the worker's own broker-side codes, are not runtime reasons.
    for (const outside of ["execute-failed", "fence-refused", "invalid-action-arguments", "", undefined, 7]) {
      expect(isContentExecutionRefusalReason(outside), String(outside)).toBe(false);
    }
  });
});

describe("002 US5 resolution reaches the page", () => {
  const contentBase = {
    runtimeProtocolVersion: 2,
    messageId: "sw-1",
    runtimeEpochId: "epoch-1",
    taskId: "task-1",
    operationId: "op-1",
    nonce: TEST_NONCE,
    expectedTabId: 3,
    expectedDocumentEpoch: "doc-1",
  };

  it("carries a bounded description and candidate bound to the content runtime, under a page-read grant", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    const payload = { generalPageReadGrantId: "grant-1", description: "search box", maxCandidates: DEFAULT_BOUNDS.maxResolutionCandidates };
    expectAccepted(schema, { ...contentBase, type: "content.resolve-target", payload }, "a resolution frame");
    expectRejected(schema, { ...contentBase, type: "content.resolve-target", payload: { ...payload, generalPageReadGrantId: undefined } }, "a resolution without the grant it rides on");
    expectRejected(
      schema,
      { ...contentBase, type: "content.resolve-target", payload: { ...payload, maxCandidates: DEFAULT_BOUNDS.maxResolutionCandidates + 1 } },
      "a candidate bound above the contract's",
    );
    expectRejected(
      schema,
      { ...contentBase, type: "content.resolve-target", payload: { ...payload, description: "x".repeat(DEFAULT_BOUNDS.maxLabelChars + 1) } },
      "a description past its bound",
    );
    expectRejected(schema, { ...contentBase, type: "content.resolve-target", payload: { ...payload, selector: "#q" } }, "a selector beside the description");
  });

  it("admits a resolution reply of handles and nothing else", () => {
    const schema = contractSchema("contentResolutionReplySchema");
    expectAccepted(
      schema,
      { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t1" }] },
      "a resolved reply naming one handle",
    );
    expectAccepted(schema, { ok: true, outcome: "no-match" }, "a no-match reply");
    expectAccepted(schema, { ok: true, outcome: "too-broad" }, "a too-broad reply");
    // The worker re-projects every card detail from the metadata it minted at collection, so a
    // role, a label, or any other field travelling back from the page could only describe an
    // element the review never showed.
    expectRejected(
      schema,
      { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t1", role: "button" }] },
      "a candidate carrying the page's own role",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t1", label: "Search" }] },
      "a candidate carrying the page's own label",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t1", kind: "input" }] },
      "a candidate carrying anything beyond the handle",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "no-match", candidates: [] },
      "a candidate list on an outcome that names none",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "too-broad", candidates: [{ targetHandle: "t1" }] },
      "a candidate list on a too-broad reply",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "resolved", candidates: [] },
      "a resolved reply naming no handle at all",
    );
    // 004/T129: a point confirmation's own outcome - a real miss, distinct from `resolved`/`no-match`
    // - carries the role and name a plain read already discloses under the same grant, bounded the
    // way a `find` candidate already is.
    expectAccepted(schema, { ok: true, outcome: "missed" }, "a missed reply with nothing to say about it");
    expectAccepted(
      schema,
      { ok: true, outcome: "missed", role: "link", label: "Cancel" },
      "a missed reply naming what was actually there",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "missed", label: "x".repeat(DEFAULT_BOUNDS.maxLabelChars + 1) },
      "a missed reply's label past the same bound a label already has",
    );
    expectRejected(
      schema,
      { ok: true, outcome: "missed", candidates: [{ targetHandle: "t1" }] },
      "a missed reply carrying a candidate",
    );
    expectRejected(
      schema,
      {
        ok: true,
        outcome: "resolved",
        candidates: Array.from(
          { length: DEFAULT_BOUNDS.maxResolutionCandidates + 1 },
          (_unused, index) => ({ targetHandle: `t${index}` }),
        ),
      },
      "more candidates than the protocol bound",
    );
    expectRejected(
      schema,
      { ok: false, outcome: "no-match" },
      "a refusal - the reply says how resolution ended, never that the page refused it",
    );
  });
});

/**
 * 002 US6 (T075). A wait reaches the page as a question with a boolean answer and nothing else: it
 * performs no effect, so the page is asked once, under the read grant it rides on, and answers with
 * the one boolean (FR-027).
 */
describe("002 US6 a wait reaches the page as a question", () => {
  const contentBase = {
    runtimeProtocolVersion: 2,
    messageId: "sw-wait",
    runtimeEpochId: "epoch-1",
    taskId: "task-1",
    operationId: "op-1",
    nonce: TEST_NONCE,
    expectedTabId: 3,
    expectedDocumentEpoch: "doc-1",
  };

  it("asks the content runtime about one condition on one held handle, under the page-read grant", () => {
    const schema = contractSchema("contentRuntimeMessageSchema");
    const payload = { generalPageReadGrantId: "grant-1", targetHandle: "t_1", condition: "present" };
    expectAccepted(schema, { ...contentBase, type: "content.evaluate-condition", payload }, "a condition frame");
    expectRejected(
      schema,
      { ...contentBase, type: "content.evaluate-condition", payload: { ...payload, generalPageReadGrantId: undefined } },
      "a condition without the grant it rides on",
    );
    expectRejected(
      schema,
      { ...contentBase, type: "content.evaluate-condition", payload: { ...payload, condition: "url-changed" } },
      "a condition outside the closed four",
    );
    expectRejected(
      schema,
      { ...contentBase, type: "content.evaluate-condition", payload: { ...payload, selector: "#results" } },
      "a selector beside the handle",
    );
    // The bound belongs to the worker's timer, not to the page: the page is asked once, and answers.
    expectRejected(
      schema,
      { ...contentBase, type: "content.evaluate-condition", payload: { ...payload, maxWaitMs: 5_000 } },
      "a bound handed to the page",
    );
  });

  it("admits a condition reply of one boolean and nothing else", () => {
    const schema = contractSchema("contentEvaluateConditionReplySchema");
    expectAccepted(schema, { ok: true, holds: true }, "a condition that holds");
    expectAccepted(schema, { ok: true, holds: false }, "a condition that does not hold yet");
    expectRejected(schema, { ok: true }, "a reply that observed nothing");
    expectRejected(schema, { ok: true, holds: "yes" }, "an answer that is not a boolean");
    // Nothing about the page travels back: a wait is not a read, so the answer is the boolean alone.
    expectRejected(schema, { ok: true, holds: true, text: "3 results" }, "page text on the answer");
    expectRejected(schema, { ok: true, holds: true, targetHandle: "t_1" }, "a handle echoed back");
  });
});
