import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 003/T045 — the batch and wait shapes (US5, FR-046..FR-048).
 *
 * Three things are pinned here and nowhere else.
 *
 * A batch is a *flat* list on one tab: nesting is not expressible, the two tab tools that would
 * change which tab the batch is about are not members, and a step may not name a tab of its own -
 * the batch's tab governs every step, so an agent cannot smuggle a second tab into a call the
 * worker checked ownership of once.
 *
 * A wait is a closed union of two shapes rather than one object with optional fields, because "wait
 * this long" and "wait until this holds" are different questions and an argument object that could
 * be read as both would leave the worker to choose.
 *
 * And the call bound is computed from the arguments rather than fixed, because a batch or a wait can
 * legitimately outlive the host's 30 s backstop; the cap is what keeps "legitimately" bounded.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T045 agent batch and wait contracts", () => {
  it("takes an ordered list of steps on one tab", () => {
    const batch = args("browser_batch");
    expectAccepted(
      batch,
      {
        tabId: TAB,
        steps: [
          { tool: "click", args: { target: { ref: "tgt-1" } } },
          { tool: "type", args: { target: { ref: "tgt-1" }, text: "hello" } },
        ],
      },
      "a two-step batch",
    );
    expectRejected(batch, { tabId: TAB, steps: [] }, "a batch with no steps");
    expectRejected(batch, { steps: [{ tool: "click", args: {} }] }, "a batch naming no tab");
    expectRejected(
      batch,
      { tabId: TAB, steps: [{ tool: "click", args: {} }], extra: 1 },
      "a batch with an extra field",
    );
    expectRejected(batch, { tabId: TAB, steps: [{ tool: "click" }] }, "a step with no arguments");
  });

  it("refuses a batch inside a batch", () => {
    // Nesting has no meaning here: the outer batch is already the one call the tab is busy with,
    // and an inner one would be a second call on the same tab from inside the first.
    expectRejected(
      args("browser_batch"),
      { tabId: TAB, steps: [{ tool: "browser_batch", args: { steps: [] } }] },
      "a nested batch",
    );
  });

  it("refuses the tab tools that would change which tab the batch is about", () => {
    const batch = args("browser_batch");
    for (const tool of ["tabs_create", "tabs_close"]) {
      expectRejected(batch, { tabId: TAB, steps: [{ tool, args: {} }] }, `${tool} inside a batch`);
    }
    // `navigate` is allowed: it changes what the tab shows, not which tab the batch means, and the
    // steps after it are governed by the destination site's own mode (US5 scenario 3).
    expectAccepted(
      batch,
      { tabId: TAB, steps: [{ tool: "navigate", args: { url: "https://example.test/two" } }] },
      "navigate inside a batch",
    );
  });

  it("admits every tool but the three a batch cannot contain", () => {
    // Derived rather than listed twice: a tool added to the closed list is a step of a batch unless
    // it is one of the three that would change what the batch is about, and a list written out here
    // by hand is how that stops being true without anybody noticing.
    const all = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    const steps = contractExport<readonly string[]>("AGENT_BATCH_STEP_TOOL_NAMES");
    // 004 adds two more for the same reason `tabs_create`/`tabs_close` are out: a claim or a release
    // inside a batch would change which tabs the session holds after the batch's one ownership check.
    // 008 adds two that a batch could not run: `gif_recorder` is about the session and names no tab,
    // and `dialog` is about a tab a dialog has stopped - which is a state that ends the batch.
    // 017 adds `propose_sites`: a site plan is about the session and waits on the owner's card,
    // so it is never one step of a batch (R-248).
    expect([...steps]).toEqual(
      all.filter(
        (tool) =>
          ![
            "browser_batch",
            "tabs_create",
            "tabs_close",
            "tabs_claim",
            "tabs_release",
            "gif_recorder",
            "dialog",
            "propose_sites",
          ].includes(tool),
      ),
    );
  });

  it("refuses a step that names a tab of its own", () => {
    expectRejected(
      args("browser_batch"),
      { tabId: TAB, steps: [{ tool: "click", args: { tabId: 9, target: { ref: "tgt-1" } } }] },
      "a step naming another tab",
    );
  });

  it("names each step's answer by its position, with the outcome vocabulary every tool uses", () => {
    const step = contractSchema("agentBatchStepResultSchema");
    expectAccepted(step, { index: 0, outcome: "ok", result: { observed: {} } }, "a step that ran");
    expectAccepted(step, { index: 2, outcome: "failed", reason: "not-run" }, "a step that did not run");
    expectRejected(step, { index: 0, outcome: "done" }, "an outcome outside the closed list");
    expectRejected(step, { outcome: "ok" }, "a step answer with no position");
    expectAccepted(
      contractSchema("agentBatchResultSchema"),
      { results: [{ index: 0, outcome: "ok" }, { index: 1, outcome: "failed", reason: "not-run" }] },
      "a batch result",
    );
  });

  it("waits either a fixed time or for one condition, never both and never neither", () => {
    const wait = args("wait");
    expectAccepted(wait, { tabId: TAB, forMs: 250 }, "a fixed wait");
    expectAccepted(wait, { tabId: TAB, condition: "present", ref: "tgt-1", maxMs: 5_000 }, "a condition wait");
    expectRejected(wait, { tabId: TAB }, "a wait with neither shape");
    expectRejected(wait, { tabId: TAB, forMs: 250, condition: "present", ref: "t", maxMs: 10 }, "both shapes");
    expectRejected(wait, { forMs: 250 }, "a wait naming no tab");
    expectRejected(wait, { tabId: TAB, forMs: 250, extra: 1 }, "a wait with an extra field");
  });

  it("bounds both wait shapes by the protocol's own maximum", () => {
    const wait = args("wait");
    const bounds = contractExport<{ maxWaitMs: number }>("DEFAULT_BOUNDS");
    expectAccepted(wait, { tabId: TAB, forMs: bounds.maxWaitMs }, "a wait at the bound");
    expectRejected(wait, { tabId: TAB, forMs: bounds.maxWaitMs + 1 }, "a wait past the bound");
    expectRejected(wait, { tabId: TAB, forMs: 0 }, "a wait of no time at all");
    expectAccepted(
      wait,
      { tabId: TAB, condition: "absent", ref: "tgt-1", maxMs: bounds.maxWaitMs },
      "a condition wait at the bound",
    );
    expectRejected(
      wait,
      { tabId: TAB, condition: "absent", ref: "tgt-1", maxMs: bounds.maxWaitMs + 1 },
      "a condition wait past the bound",
    );
    expectRejected(wait, { tabId: TAB, condition: "present", ref: "tgt-1" }, "a condition wait with no bound");
  });

  it("requires a target for every condition that is about one element", () => {
    const wait = args("wait");
    for (const condition of ["present", "absent", "enabled"]) {
      expectRejected(wait, { tabId: TAB, condition, maxMs: 1_000 }, `${condition} with no ref`);
    }
    // The one condition that is about the page rather than about a named element: without a ref the
    // worker takes the baseline from the tab's current binding.
    expectAccepted(
      wait,
      { tabId: TAB, condition: "visible-text-changed", maxMs: 1_000 },
      "visible-text-changed with no ref",
    );
    expectRejected(wait, { tabId: TAB, condition: "settled", ref: "t", maxMs: 10 }, "a condition nobody declared");
  });

  it("answers a met condition with how long it actually waited", () => {
    const result = contractSchema("agentWaitResultSchema");
    expectAccepted(result, { outcome: "condition-met", waitedMs: 640 }, "a met condition");
    expectRejected(result, { outcome: "bound-reached", waitedMs: 5_000 }, "a bound as if it were a result");
    expectRejected(result, { outcome: "condition-met" }, "a result that will not say how long");
  });

  it("offers both tools to the agent from the same table the worker parses", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; inputShape: Record<string, unknown> }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    const named = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    for (const tool of ["browser_batch", "wait"]) {
      expect(named.get(tool), `${tool} must be offered`).toBeDefined();
    }
    // Neither is an effect of its own: a batch's steps are gated one by one as if sent alone, and a
    // wait changes nothing on the page at all (FR-047, FR-048).
    const effects = contractExport<readonly string[]>("AGENT_EFFECT_TOOL_NAMES");
    expect(effects).not.toContain("browser_batch");
    expect(effects).not.toContain("wait");
  });

  it("projects a whole batch as one plan the owner answers once", () => {
    const state = contractSchema("agentPanelStateSchema");
    const plan = {
      planId: "plan-1",
      site: "https://fixtures.test:19443",
      steps: [
        { tool: "click", summary: "click a page element" },
        { tool: "type", summary: "type text into a page element" },
      ],
    };
    expectAccepted(
      state,
      { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected", plan },
      "a projection carrying a plan prompt",
    );
    expectAccepted(state, { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected" }, "a projection with no plan");
    expectRejected(
      state,
      { paired: [], sessions: [], tabs: [], sites: [], bridge: "connected", plan: { ...plan, steps: [{ tool: "click" }] } },
      "a plan step the owner is shown nothing about",
    );
    expectRejected(
      state,
      // The arguments themselves never reach the panel; the worker's summary is what is shown.
      {
        paired: [],
        sessions: [],
        sites: [],
        bridge: "connected",
        plan: { ...plan, steps: [{ tool: "click", summary: "x", args: { ref: "tgt-1" } }] },
      },
      "a plan step carrying its arguments",
    );
  });

  it("answers a plan once, with the steps the owner struck out", () => {
    const command = contractSchema("agentPanelCommandSchema");
    expectAccepted(
      command,
      { type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: true } },
      "approving a plan whole",
    );
    expectAccepted(
      command,
      { type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: true, excludedIndexes: [1] } },
      "approving a plan without one step",
    );
    expectAccepted(
      command,
      { type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: false } },
      "refusing a plan",
    );
    expectRejected(
      command,
      { type: "ui.agent.plan-decide", payload: { planId: "plan-1" } },
      "a plan answer that decides nothing",
    );
    expectRejected(
      command,
      { type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: true, excludedIndexes: [-1] } },
      "excluding a step that cannot exist",
    );
  });

  it("gives a batch and a wait the time their own arguments ask for, up to a cap", () => {
    const bound = contractExport<(tool: string, args: Record<string, unknown>) => number>("agentCallBoundMs");
    const base = contractExport<number>("AGENT_CALL_TIMEOUT_MS");
    const slack = contractExport<number>("AGENT_CALL_TIMEOUT_SLACK_MS");
    const cap = contractExport<number>("AGENT_MAX_CALL_TIMEOUT_MS");

    // Everything else keeps the flat backstop: its bound is not something the arguments can move.
    expect(bound("click", { tabId: TAB, target: { ref: "tgt-1" } })).toBe(base);
    expect(bound("wait", { tabId: TAB, forMs: 4_000 })).toBe(4_000 + slack);
    expect(bound("wait", { tabId: TAB, condition: "present", ref: "t", maxMs: 9_000 })).toBe(9_000 + slack);
    expect(
      bound("browser_batch", {
        tabId: TAB,
        steps: [
          { tool: "click", args: { target: { ref: "tgt-1" } } },
          { tool: "wait", args: { forMs: 2_000 } },
        ],
      }),
    ).toBe(base + (2_000 + slack) + slack);
    // A batch big enough to ask for more than the cap gets the cap, not what it asked for.
    expect(
      bound("browser_batch", {
        tabId: TAB,
        steps: Array.from({ length: 20 }, () => ({ tool: "wait", args: { forMs: 15_000 } })),
      }),
    ).toBe(cap);
    // Arguments the schema would refuse decide nothing; the flat backstop applies.
    expect(bound("wait", { tabId: TAB, forMs: "soon" })).toBe(base);
  });
});
