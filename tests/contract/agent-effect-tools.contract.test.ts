import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 003/T026 — the effect tools' closed argument and result shapes (US3, FR-040..FR-043).
 *
 * Three things are pinned here and nowhere else. Each effect names its target *once*, as a ref or
 * as a point, so an agent cannot send both and leave the worker to choose. Each result carries what
 * was actually observed, so an `ok` that claims an effect nobody saw is not expressible. And the
 * execute frame's `policy` field is closed with `classified` as its absent value, so every frame the
 * archived remote path has ever sent still means exactly what it meant before this field existed.
 */

const TAB = 7;

function args(tool: string): { safeParse: (input: unknown) => { success: boolean } } {
  const table = contractExport<Record<string, { safeParse: (input: unknown) => { success: boolean } }>>(
    "agentToolArgSchemas",
  );
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as { safeParse: (input: unknown) => { success: boolean } };
}

const POINTER_TOOLS = ["click", "right_click", "double_click", "triple_click", "hover"] as const;

describe("T026 agent effect tool contracts", () => {
  it("names the effect tools the per-site gate governs", () => {
    expect(contractExport("AGENT_EFFECT_TOOL_NAMES")).toEqual([
      "click",
      "right_click",
      "double_click",
      "triple_click",
      "hover",
      "drag",
      "type",
      "key",
      "scroll",
      "form_input",
      // 004: input delivered at a point is an effect like any other (data-model PositionAction).
      "computer",
    ]);
  });

  it("takes a pointer effect's target as a ref or a point, never both and never neither", () => {
    for (const tool of POINTER_TOOLS) {
      const schema = args(tool);
      expectAccepted(schema, { tabId: TAB, target: { ref: "tgt-1" } }, `${tool} by ref`);
      expectAccepted(schema, { tabId: TAB, target: { x: 40, y: 80 } }, `${tool} by point`);
      expectRejected(schema, { tabId: TAB }, `${tool} with no target`);
      expectRejected(schema, { tabId: TAB, target: { ref: "tgt-1", x: 1, y: 2 } }, `${tool} with both`);
      expectRejected(schema, { tabId: TAB, target: { ref: "tgt-1" }, extra: 1 }, `${tool} with an extra field`);
      expectRejected(schema, { target: { ref: "tgt-1" } }, `${tool} with no tab`);
      expectRejected(schema, { tabId: -1, target: { ref: "tgt-1" } }, `${tool} on a negative tab`);
    }
  });

  it("takes both endpoints of a drag, each as a ref or a point", () => {
    const drag = args("drag");
    expectAccepted(drag, { tabId: TAB, from: { ref: "a" }, to: { ref: "b" } }, "drag ref to ref");
    expectAccepted(drag, { tabId: TAB, from: { ref: "a" }, to: { x: 10, y: 20 } }, "drag ref to point");
    expectRejected(drag, { tabId: TAB, from: { ref: "a" } }, "drag with one endpoint");
    expectRejected(drag, { tabId: TAB, from: { ref: "a" }, to: { ref: "a" } }, "drag onto itself");
  });

  it("takes text with an optional target and a closed edit mode", () => {
    const type = args("type");
    expectAccepted(type, { tabId: TAB, text: "hello" }, "type into the focused element");
    expectAccepted(type, { tabId: TAB, text: "hello", target: { ref: "tgt-1" }, mode: "insert" }, "type into a ref");
    expectRejected(type, { tabId: TAB }, "type with no text");
    expectRejected(type, { tabId: TAB, text: "x", mode: "append" }, "type with an unknown mode");
  });

  it("takes only the keys and modifiers the runtime can deliver, with a bounded repeat", () => {
    const key = args("key");
    expectAccepted(key, { tabId: TAB, key: "Enter" }, "key");
    expectAccepted(key, { tabId: TAB, key: "Tab", modifiers: ["Shift"], repeat: 3 }, "shift-tab three times");
    expectRejected(key, { tabId: TAB, key: "F5" }, "a key outside the closed set");
    expectRejected(key, { tabId: TAB, key: "Enter", modifiers: ["Control"] }, "an unsupported modifier");
    expectRejected(key, { tabId: TAB, key: "Enter", modifiers: ["Shift"] }, "Shift with a key other than Tab");
    expectRejected(key, { tabId: TAB, key: "Enter", repeat: 0 }, "a repeat of zero");
    expectRejected(key, { tabId: TAB, key: "Enter", repeat: 100 }, "an unbounded repeat");
  });

  it("scrolls either by direction and amount or a target into view, never both", () => {
    const scroll = args("scroll");
    expectAccepted(scroll, { tabId: TAB, direction: "down", amount: "medium" }, "scroll the viewport");
    expectAccepted(scroll, { tabId: TAB, target: { ref: "tgt-1" } }, "scroll a ref into view");
    expectRejected(scroll, { tabId: TAB }, "a scroll that says nothing");
    expectRejected(scroll, { tabId: TAB, target: { ref: "t" }, direction: "down" }, "both at once");
    expectRejected(scroll, { tabId: TAB, direction: "sideways", amount: "small" }, "an unknown direction");
  });

  it("sets a form control by ref, to a string or a boolean", () => {
    const form = args("form_input");
    expectAccepted(form, { tabId: TAB, ref: "tgt-1", value: "Ada" }, "a text value");
    expectAccepted(form, { tabId: TAB, ref: "tgt-1", value: true }, "a checkbox value");
    expectRejected(form, { tabId: TAB, ref: "tgt-1", value: 42 }, "a number value");
    expectRejected(form, { tabId: TAB, value: "Ada" }, "no ref: a point cannot name a control");
  });

  it("takes a bounded description for find", () => {
    const find = args("find");
    expectAccepted(find, { tabId: TAB, query: "primary button" }, "a description");
    expectAccepted(find, { tabId: TAB, query: "primary button", maxCandidates: 3 }, "a bounded search");
    expectRejected(find, { tabId: TAB, query: "" }, "an empty description");
    expectRejected(find, { tabId: TAB, query: "x".repeat(5_000) }, "an unbounded description");
    expectRejected(find, { tabId: TAB, query: "x", maxCandidates: 0 }, "no candidates at all");
  });

  it("reports only what was observed, and says whether it was verified", () => {
    const result = contractSchema("agentEffectResultSchema");
    expectAccepted(
      result,
      { observed: { effect: "activated", documentChanged: false, verified: true, verdict: "verified", clicks: 1 } },
      "a verified click",
    );
    expectAccepted(
      result,
      {
        observed: {
          effect: "hovered",
          documentChanged: false,
          verified: false,
          verdict: "target-not-visible",
          targetVisible: false,
        },
      },
      "a hover the page hid",
    );
    expectRejected(result, { observed: { effect: "activated", documentChanged: false } }, "no verification");
    // 003/B2: an unverified observation has to say *why*, in the closed causes' own words.
    expectRejected(
      result,
      { observed: { effect: "activated", documentChanged: false, verified: false } },
      "an unverified observation with no verdict",
    );
    expectRejected(
      result,
      { observed: { effect: "activated", documentChanged: true, verified: false, verdict: "gave-up" } },
      "a verdict nobody defined",
    );
    expectRejected(
      result,
      { observed: { effect: "exploded", documentChanged: false, verified: true, verdict: "verified" } },
      "an invented effect",
    );
    expectRejected(result, {}, "a result with nothing observed");

    const find = contractSchema("agentFindResultSchema");
    expectAccepted(
      find,
      { outcome: "resolved", matches: [{ ref: "tgt-1", role: "button", label: "Save" }] },
      "one match",
    );
    expectAccepted(find, { outcome: "no-match", matches: [] }, "no match");
    expectAccepted(find, { outcome: "too-broad", matches: [] }, "too broad");
    expectRejected(find, { outcome: "resolved", matches: [{ ref: "tgt-1", selector: "#save" }] }, "a selector");
  });

  it("closes the execute frame's policy field and defaults it to classified", () => {
    const runtime = contractSchema("contentRuntimeMessageSchema");
    const frame = {
      runtimeProtocolVersion: contractExport<number>("RUNTIME_PROTOCOL_VERSION"),
      messageId: "m-1",
      runtimeEpochId: "epoch-1",
      type: "content.execute-action",
      taskId: "task-1",
      operationId: "op-1",
      nonce: "0".repeat(32),
      expectedTabId: TAB,
      expectedDocumentEpoch: "doc-1",
      payload: { action: "browser.click", arguments: { targetHandle: "tgt-1" } },
    };

    // Absent means `classified`: every frame the archived path has ever sent keeps its meaning.
    const parsed = (
      runtime as unknown as { parse: (input: unknown) => { policy: string } }
    ).parse(frame);
    expect(parsed.policy).toBe("classified");

    expectAccepted(runtime, { ...frame, policy: "classified" }, "an explicitly classified frame");
    expectAccepted(runtime, { ...frame, policy: "trusted-agent" }, "a trusted-agent frame");
    expectRejected(runtime, { ...frame, policy: "trusted" }, "a policy outside the closed pair");
    expectRejected(runtime, { ...frame, policy: true }, "a policy that is not a word");

    // The field belongs to the effect frame alone: a read has no classification to skip.
    expectRejected(
      runtime,
      { ...frame, type: "content.probe", payload: {}, policy: "trusted-agent" },
      "a probe carrying a policy",
    );
  });

  it("carries the two new ways a ref is minted", () => {
    const runtime = contractSchema("contentRuntimeMessageSchema");
    const base = {
      runtimeProtocolVersion: contractExport<number>("RUNTIME_PROTOCOL_VERSION"),
      messageId: "m-1",
      runtimeEpochId: "epoch-1",
      taskId: "task-1",
      operationId: "op-1",
      nonce: "0".repeat(32),
      expectedTabId: TAB,
      expectedDocumentEpoch: "doc-1",
    };

    expectAccepted(
      runtime,
      { ...base, type: "content.resolve-point", payload: { generalPageReadGrantId: "g-1", x: 12, y: 34 } },
      "resolve a point",
    );
    expectAccepted(
      runtime,
      { ...base, type: "content.resolve-active-element", payload: { generalPageReadGrantId: "g-1" } },
      "resolve the focused element",
    );
    // A point is a viewport coordinate, not a selector or a document offset.
    expectRejected(
      runtime,
      { ...base, type: "content.resolve-point", payload: { generalPageReadGrantId: "g-1", x: 12 } },
      "half a point",
    );
    expectRejected(
      runtime,
      { ...base, type: "content.resolve-point", payload: { generalPageReadGrantId: "g-1", x: 1, y: 2, selector: "a" } },
      "a point with a selector",
    );
  });

  it("carries the session the host minted, and the call a stop cancels", () => {
    const control = contractSchema("agentControlFrameSchema");
    expectAccepted(
      control,
      { type: "pair-request", agentId: "a", displayName: "Claude Code", origin: "stdio:local", sessionId: "s-1" },
      "a pair request naming its session",
    );
    // 003 D-M3-3: the session id comes from the host, once, so a relay reconnect is the same
    // session rather than a new one that would strand the tab group.
    expectRejected(
      control,
      { type: "pair-request", agentId: "a", displayName: "Claude Code", origin: "stdio:local" },
      "a pair request with no session",
    );
    expectAccepted(control, { type: "stop", callId: "call-1" }, "a stop naming one call");
    expectAccepted(control, { type: "stop" }, "a stop that ends everything");
  });

  it("projects the live prompt and the site list, and closes the panel's new commands", () => {
    const state = contractSchema("agentPanelStateSchema");
    const base = { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected" };
    expectAccepted(state, base, "a panel with nothing pending");
    expectAccepted(
      state,
      {
        ...base,
        sites: [{ site: "https://fixtures.test", mode: "ask", diagnosticsGranted: false }],
        prompt: {
          promptId: "prompt-1",
          site: "https://fixtures.test",
          tool: "click",
          argsSummary: "ref tgt-1",
          targetLabel: "Save",
          targetRole: "button",
        },
      },
      "a panel showing one prompt",
    );
    // The prompt is the panel's view of an effect that has not run. It carries no arguments the
    // panel would have to interpret and no handle it could act on.
    expectRejected(
      state,
      { ...base, prompt: { promptId: "p", site: "https://x.test", tool: "click", args: { ref: "t" } } },
      "a prompt carrying raw arguments",
    );

    const command = contractSchema("agentPanelCommandSchema");
    expectAccepted(
      command,
      { type: "ui.agent.effect-decide", payload: { promptId: "prompt-1", allow: true } },
      "allow",
    );
    expectAccepted(
      command,
      { type: "ui.agent.effect-decide", payload: { promptId: "prompt-1", allow: true, rememberMode: "skip-checks" } },
      "allow and remember",
    );
    expectAccepted(
      command,
      { type: "ui.agent.site-mode", payload: { site: "https://fixtures.test", mode: "ask" } },
      "set a site's mode",
    );
    expectRejected(
      command,
      { type: "ui.agent.site-mode", payload: { site: "https://fixtures.test/path", mode: "ask" } },
      "a site that is not an origin",
    );
    expectRejected(
      command,
      { type: "ui.agent.effect-decide", payload: { promptId: "p", allow: true, rememberMode: "always" } },
      "a mode that is not one of the three",
    );
    // The panel can never grant diagnostics from here; that control is US6's and has its own gate.
    expectRejected(
      command,
      { type: "ui.agent.site-mode", payload: { site: "https://x.test", mode: "ask", diagnosticsGranted: true } },
      "a diagnostics grant smuggled into a mode change",
    );
  });
});
