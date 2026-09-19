import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import {
  createAgentEffects,
  createFocusConfirmer,
  createOopifSessionResolver,
  createTargetConfirmer,
} from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import type { PageExecutionOutcome } from "../src/service-worker/page-ports.js";
import { testInputAttachments } from "./helpers/input-attachments.js";

/**
 * 003/T028 — the effect tools end to end inside the worker, with the page stubbed.
 *
 * What is asserted is the order the guarantees depend on and nothing about the page itself: the
 * gate decides before anything touches the document, an `ask` the owner never answers runs nothing
 * (FR-043), a denied prompt runs nothing (SC-023), a tab the session does not own is refused
 * whatever the site mode says, and an `ok` carries the executor's own evidence plus the
 * verification verdict, never a claim (FR-040).
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;

type Sent = { type: string; payload: Record<string, unknown>; frameId?: number };

function installChrome(): { sent: Sent[]; epoch: { value: string }; injections: number[] } {
  const local: Record<string, unknown> = {};
  const sent: Sent[] = [];
  const epoch = { value: "doc-1" };
  const injections: number[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
    scripting: {
      async executeScript(details: { target: { tabId: number } }) {
        injections.push(details.target.tabId);
      },
    },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown, options?: { frameId?: number }) {
        const frame = message as { type: string; payload: Record<string, unknown> };
        sent.push({ type: frame.type, payload: frame.payload, ...(options?.frameId === undefined ? {} : { frameId: options.frameId }) });
        if (frame.type === "content.probe") {
          // A framed document mints its own epoch, independent of the top document's (004/T128
          // gap 3) - the fixture's own grandchild and its sibling are two live examples. A fake
          // that answered every frame with the same value could never catch a confirmation asking
          // the top page's epoch about a child's document. The same is true of its origin
          // (004/T129, B71): a fake that gave every frame the top document's origin could never
          // catch a confirmation comparing a cross-origin frame's own origin against it.
          const frameId = options?.frameId;
          return {
            documentEpoch: frameId === undefined || frameId === 0 ? epoch.value : `doc-frame-${frameId}`,
            canonicalOrigin: frameId === undefined || frameId === 0 ? SITE : `https://frame-${frameId}.fixtures.test`,
          };
        }
        if (frame.type === "content.resolve-point" || frame.type === "content.resolve-active-element") {
          // A confirmation names the ref it is checking (`targetHandle`); the fixture echoes it
          // back, the same way the real content runtime answers a hit on the ref itself (004/T128
          // gap 1). A bare point resolution - no ref to confirm - names nothing to hit-test.
          const targetHandle = typeof frame.payload.targetHandle === "string" ? frame.payload.targetHandle : "t_point";
          return { ok: true, outcome: "resolved", candidates: [{ targetHandle }] };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
  return { sent, epoch, injections };
}

function clicked(): Extract<PageExecutionOutcome, { ok: true }> {
  return { ok: true, effect: "activated", clicks: 1, documentChanged: false };
}

function harness(
  overrides: Partial<Parameters<typeof createAgentEffects>[0]> = {},
  options: {
    /** False lets the real confirmer run, e.g. to prove what it asks the page (004/T128 gap 2). */
    fakeConfirm?: boolean;
  } = {},
) {
  const execute = vi.fn(async () => clicked() as PageExecutionOutcome);
  const siteModes = createSiteModeStore();
  const prompts = createAgentPromptController({ timeoutMs: 60 });
  // 004/T121: the pointer gestures leave through the debugger now, so this suite's harness holds
  // one. What it asserts about them is unchanged - the gate, the ownership check and the
  // verification step are the same for both routes.
  const input = testInputAttachments();
  const located: string[] = [];
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    attachments: input.attachments,
    cursor: () => {},
    locate: async ({ ref }) => {
      located.push(ref);
      return { x: 100, y: 40, width: 80, height: 20 };
    },
    // 004/T128: correct by construction, like every other fake here - the delivered point always
    // resolves to the target it was computed from, unless a test says otherwise.
    ...((options.fakeConfirm ?? true) ? { confirm: async () => ({ outcome: "hit" as const }) } : {}),
    execute,
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...overrides,
  });
  return { runner, execute, siteModes, prompts, input, located };
}

/** The pointer traffic of a gesture, in order (004/T121). */
function mouse(commands: Array<{ method: string; params: Record<string, unknown> }>) {
  return commands
    .filter((command) => command.method === "Input.dispatchMouseEvent")
    .map((command) => ({
      type: command.params.type,
      x: command.params.x,
      y: command.params.y,
      button: command.params.button,
      clickCount: command.params.clickCount,
    }));
}

function clickRequest(overrides: Partial<AgentNativeRequest> = {}): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-h1",
    tool: "click",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, target: { ref: "t_save" } },
    ...overrides,
  };
}

function dragRequest(overrides: Partial<AgentNativeRequest> = {}): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-h1",
    tool: "drag",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, from: { ref: "t_alpha" }, to: { ref: "t_beta" } },
    ...overrides,
  };
}

describe("T028 agent effect tools", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  /**
   * 004/T103a — the session's main tab follows its effects.
   *
   * `mainTabId` is what the indicator's control focuses, so a session that has been working in a
   * tab it claimed rather than created would otherwise point the owner at the wrong window.
   */
  it("tells the tab manager which tab the session just acted in", async () => {
    const touched: Array<{ sessionId: string; tabId: number }> = [];
    const { runner, siteModes } = harness({
      onEffect: (sessionId, tabId) => touched.push({ sessionId, tabId }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response.outcome).toBe("ok");
    // The session the call named, not whichever one called last.
    expect(touched).toEqual([{ sessionId: "session-h1", tabId: AGENT_TAB }]);
  });

  it("runs an effect under skip-checks and reports what was observed", async () => {
    const { runner, execute, siteModes, input } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "activated",
          clicks: 1,
          documentChanged: false,
          verified: true,
          verdict: "verified",
        },
      },
    });
    // 004/T121: the click leaves through the debugger, at the centre of the box the page reported,
    // and the page's own executor is not asked at all.
    expect(mouse(input.commands)).toEqual([
      { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
      { type: "mousePressed", x: 140, y: 50, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 140, y: 50, button: "left", clickCount: 1 },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * 008/T226 — the click that raised a dialog is told so on its own answer (FR-111, US3 scenario 1).
   *
   * The event arrives while the verify step is waiting for the page, which is the only moment at
   * which the click and the dialog are known to belong together - so this call carries it, and the
   * agent's next move is `dialog` rather than a puzzled retry. The other half is the record the
   * chaining rule reads: the tab and the moment the owner's consent covered an effect here, written
   * where the gate decides rather than where the effect lands.
   */
  it("carries the dialog its own click raised, and records the approval the chaining rule reads", async () => {
    const dialog = {
      id: "d1",
      type: "confirm" as const,
      message: "Delete 3 orders?",
      openedAt: 1_700_000_000_000,
      tabId: AGENT_TAB,
    };
    const approvals: Array<{ tabId: number; tool: string }> = [];
    let open = false;
    const { runner, siteModes } = harness({
      onApproved: (tabId, tool) => approvals.push({ tabId, tool }),
      currentDialog: (tabId) => (open && tabId === AGENT_TAB ? dialog : undefined),
      // The page opens its confirm as the click lands, before anything is verified.
      probe: async () => {
        open = true;
        return { ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE };
      },
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ dialog });
    expect(approvals).toEqual([{ tabId: AGENT_TAB, tool: "click" }]);
  });

  /**
   * 004/T128 - a click confirms it hit its target rather than trusting the rect it was computed
   * from (B60, B61). `documentChanged` staying false and the epoch matching only ever proved the
   * document was intact; nothing checked the point itself, so a delivered click at the wrong place
   * read `verified` exactly like one that landed. This is the honest refusal that replaces it, with
   * a cause distinguishable from `target-not-located` ("found it, hit something else" rather than
   * "never found it").
   */
  it("refuses a click honestly when the delivered point does not resolve to its target (T128), and says what was there (004/T129)", async () => {
    const { runner, siteModes } = harness({
      confirm: async () => ({ outcome: "missed", role: "link", label: "Cancel" }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "activated",
          clicks: 1,
          documentChanged: false,
          verified: false,
          verdict: "target-missed",
          role: "link",
          label: "Cancel",
        },
      },
    });
  });

  /**
   * 004/T168 - the click family's point confirmation is a check on this worker's own arithmetic
   * (the rect turned into a coordinate), and it has to be made *before* the click is delivered:
   * measured on YouTube's embed, a click at exactly the right point plays the video and the
   * player's controls then cover that point, so a hit-test made afterwards resolves to the control
   * that replaced the target and a landed click was reported `target-missed`. Hit-testing the point
   * first measures the arithmetic; hit-testing it after measures the effect, which is not the
   * question. `hover` is the exception and stays after delivery (T150): its whole purpose is to
   * change what is under the pointer.
   */
  it("confirms a click's point before delivering the click, and a hover's after (T168)", async () => {
    let mouseEventsWhenConfirmed: number | undefined;
    let input!: ReturnType<typeof harness>["input"];
    const built = harness({
      confirm: async () => {
        mouseEventsWhenConfirmed = input.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;
        return { outcome: "hit" };
      },
    });
    input = built.input;
    await built.siteModes.set(SITE, { mode: "skip-checks" });

    const clicked = await built.runner.run(clickRequest());
    expect(clicked.outcome).toBe("ok");
    expect(mouseEventsWhenConfirmed, "a click is confirmed before any mouse event leaves").toBe(0);
    expect(input.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length).toBeGreaterThan(0);

    mouseEventsWhenConfirmed = undefined;
    const before = input.commands.filter((c) => c.method === "Input.dispatchMouseEvent").length;
    await built.runner.run(clickRequest({ tool: "hover", callId: "call-2" }));
    expect(mouseEventsWhenConfirmed, "a hover is confirmed after the move was delivered").toBeGreaterThan(before);
  });

  /**
   * 004/T150 - `hover` answered `verified` from this worker's own arithmetic on the rect (`width >
   * 0 && height > 0`) alone, never asking whether the delivered point actually resolves to the
   * target once it is there. An overlay that intercepts the pointer leaves that rect unchanged - it
   * was true before the hover and remains true after - so a menu that never opened was reported as
   * a success. Confirmed the same way the click family already is (004/T128): a fresh round trip at
   * the delivered point, after delivery, and it says what was actually there when it missed
   * (004/T129) - hitting a covering element is not the same fact as pointing at nothing.
   */
  it("refuses a hover honestly when the delivered point does not resolve to its target (T150)", async () => {
    const { runner, siteModes } = harness({
      confirm: async () => ({ outcome: "missed", role: "div", label: "Overlay" }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest({ tool: "hover" }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "hovered",
          targetVisible: true,
          documentChanged: false,
          verified: false,
          verdict: "target-missed",
          role: "div",
          label: "Overlay",
        },
      },
    });
  });

  /**
   * 004/T129 - a confirmation that never got to ask is not a miss: the round trip that checks the
   * delivered point can itself be refused upstream (the `stale-context` family, B69/B72), and that
   * is a different fact from the check running and naming something else. Reporting the two the
   * same way would claim an observation nobody made.
   */
  it("answers unconfirmed, not missed, when the point confirmation could not be asked at all (004/T129)", async () => {
    const { runner, siteModes } = harness({ confirm: async () => ({ outcome: "unconfirmed" }) });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "activated",
          clicks: 1,
          documentChanged: false,
          verified: false,
          verdict: "target-unconfirmed",
        },
      },
    });
  });

  /**
   * 004/T147 (S4 review) - `resolveHandleOnTab` throws on several paths (`unsupported-page`,
   * `no-active-tab`, `content.probe`, `content.injection`); nothing caught them, so a confirmation
   * whose effect had already landed escaped as `failed / handler-error` instead of the honest
   * `target-unconfirmed` this same round trip already answers when the reply says `ok: false`. A
   * click that navigates to a PDF or a `chrome://` page is the routine trigger: the click worked,
   * and the confirmation that follows it throws.
   */
  it("answers unconfirmed rather than throwing when resolveHandleOnTab throws (T147)", async () => {
    const confirm = createTargetConfirmer(async () => {
      throw new Error("unsupported-page");
    });

    const result = await confirm({
      context: testSessionContexts().forCall("session-h1", "call-1"),
      binding: { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
      ref: "t_save",
      point: { x: 10, y: 10 },
    });

    expect(result).toEqual({ outcome: "unconfirmed" });
  });

  /**
   * Same throw, on the keyboard path's own confirmer (T147) - but unlike its sibling
   * `TargetConfirmer`, this confirmer used to collapse the throw straight into a definite `false`,
   * claiming a miss the check never actually observed (004/T161). A round trip that could not run at
   * all is the same `unconfirmed` fact the sibling already draws, not a confirmed loss of focus.
   */
  it("answers unconfirmed (undefined), not a definite miss, when resolveHandleOnTab throws (T161)", async () => {
    const confirmFocus = createFocusConfirmer(async () => {
      throw new Error("unsupported-page");
    });

    const retained = await confirmFocus({
      context: testSessionContexts().forCall("session-h1", "call-1"),
      binding: { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
      ref: "t_save",
    });

    expect(retained).toBe(undefined);
  });

  /**
   * 004/T128 gap 2 - the confirmation has to ask the frame that claimed the target, in that
   * frame's own coordinates, or a framed click refuses whether or not the delivered coordinate was
   * right - which is exactly what made the framed case unmeasurable before this closed.
   *
   * 004/T128 gap 3 - asking the right frame in the right coordinates is not enough on its own: the
   * round trip still carried the *top document's* epoch as the one the frame's answer had to match,
   * so a framed confirmation refused every time on a document that had never gone stale at all
   * (`content-broker.ts`'s `resolveHandleOnTab`). The click genuinely lands (the fixture's own echo
   * proves it) and confirmation must say so, not answer `target-missed` for a page that never moved.
   *
   * 004/T129, B71 - the same mistake a second time, on the other half of the same check: the round
   * trip also carried the *top document's* origin as the one the frame's answer had to match, which
   * is structural for any genuinely cross-origin frame, never racy - it refuses every time on a
   * document that never left its own origin. `resolveHandleOnTab` now takes the frame's own origin
   * the same way it already took the frame's own epoch.
   */
  it("confirms a framed click against the frame that claimed the target, not frame 0", async () => {
    const { runner, siteModes } = harness(
      {
        locate: async () => ({
          // The page-level box the click is actually delivered at.
          x: 100,
          y: 40,
          width: 80,
          height: 20,
          // The same element's box in its own frame's viewport - what the confirmation must ask in
          // - and that frame's own epoch and origin (004/T128 gap 3, 004/T129), both distinct from
          // the top document's.
          frame: {
            frameId: 7,
            rect: { x: 20, y: 5, width: 80, height: 20 },
            documentEpoch: "doc-frame-7",
            canonicalOrigin: "https://frame-7.fixtures.test",
          },
        }),
      },
      { fakeConfirm: false },
    );
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    const asked = fake.sent.find((entry) => entry.type === "content.resolve-point");
    expect(asked).toMatchObject({
      frameId: 7,
      payload: { x: 60, y: 15 },
    });
    // The frame's own document never changed, so a click that lands must verify - not refuse for an
    // epoch mismatch manufactured by comparing the wrong two documents.
    expect(response).toMatchObject({
      result: { observed: { verified: true, verdict: "verified" } },
    });
  });

  /**
   * 004/T129 - the routing decision itself: a claimed frame that carries its own CDP session (a
   * genuine out-of-process, cross-site frame - `locate` stands in for `createTargetLocator` finding
   * one, the same seam the previous test uses) is dispatched through that session, at the frame's
   * own local point, never composed into a page-level point and sent to the tab. Same-site frames
   * are untouched by this - they never carry a `sessionId` at all, which is what the two tests above
   * still prove.
   */
  it("routes a pointer effect through the frame's own CDP session when the target has one, not the tab (T129)", async () => {
    const { runner, siteModes, input } = harness(
      {
        locate: async () => ({
          // No composition (004/T129): the frame-local box *is* the point dispatched at - there is
          // nothing above this frame, in this tab's own process, to add an offset from.
          x: 60,
          y: 15,
          width: 80,
          height: 20,
          frame: {
            frameId: 9,
            rect: { x: 60, y: 15, width: 80, height: 20 },
            documentEpoch: "doc-frame-9",
            canonicalOrigin: "https://oopif.fixtures.test",
            sessionId: "session-oopif-9",
          },
        }),
      },
      { fakeConfirm: false },
    );
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(clickRequest());

    const dispatched = input.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.every((command) => command.sessionId === "session-oopif-9")).toBe(true);
    expect(dispatched.map((command) => ({ x: command.params.x, y: command.params.y }))).toEqual([
      { x: 100, y: 25 },
      { x: 100, y: 25 },
      { x: 100, y: 25 },
    ]);
  });

  /**
   * 004/T129 (B76, closing the gap B75 disclosed) - keyboard delivery has to follow the same
   * correlation the click that focuses a target already resolved. `deliverKeyboard` clicks the named
   * target first (the way a person reaches a field before typing in it), and when that click landed
   * on a genuinely out-of-process frame the keys that follow must reach that frame's own session too
   * - the tab's own top-level session is a different document, one the click never focused at all.
   */
  it("routes keyboard delivery through the frame's own CDP session when the clicked target has one, not the tab (T129)", async () => {
    const { runner, siteModes, input } = harness(
      {
        locate: async () => ({
          x: 60,
          y: 15,
          width: 80,
          height: 20,
          frame: {
            frameId: 9,
            rect: { x: 60, y: 15, width: 80, height: 20 },
            documentEpoch: "doc-frame-9",
            canonicalOrigin: "https://oopif.fixtures.test",
            sessionId: "session-oopif-9",
          },
        }),
        // 004/T159 moved the focus poll to gate delivery: this test's own concern is session routing,
        // not focus, so the caret is stipulated as landed - the same way every other session/frame
        // test in this file names its own concern and fakes the rest.
        confirmFocus: async () => true,
      },
      { fakeConfirm: false },
    );
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(
      clickRequest({ tool: "type", args: { tabId: AGENT_TAB, target: { ref: "t_field" }, text: "a", mode: "insert" } }),
    );

    const clicked = input.commands.filter((command) => command.method === "Input.dispatchMouseEvent");
    expect(clicked.length).toBeGreaterThan(0);
    expect(clicked.every((command) => command.sessionId === "session-oopif-9")).toBe(true);
    const typed = input.commands.filter((command) => command.method === "Input.dispatchKeyEvent");
    expect(typed.length).toBeGreaterThan(0);
    // The load-bearing assertion: the keys go over the same session the click did, not the tab's own
    // top-level session which B75 left this on unconditionally.
    expect(typed.every((command) => command.sessionId === "session-oopif-9")).toBe(true);
  });

  /**
   * 004/T128, B70 - two properties a drag's locates must hold, both visible in one call sequence.
   *
   * First: a drag scrolls, if at all, once. `from` is the delivery's first locate and scrolls its
   * endpoint into view; `to` is measured in the scroll state `from` already established, or the two
   * endpoints would describe two different scroll positions and the coordinates `pointer.drag`
   * computes from them would disagree with each other.
   *
   * Second: a locate whose purpose is to verify must not scroll. The post-drag re-measure exists
   * only to check whether the element moved, and a scroll there would re-centre it to exactly where
   * the delivering locate already centred it - normalising away the very difference the check exists
   * to see.
   */
  it("scrolls only a drag's first endpoint into view, and never its post-drag remeasure (T128, B70)", async () => {
    const calls: Array<{ ref: string; scroll: boolean }> = [];
    const { runner, siteModes } = harness({
      locate: async ({ ref, scroll }) => {
        calls.push({ ref, scroll });
        return { x: 100, y: 40, width: 80, height: 20 };
      },
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(dragRequest());

    expect(response).toMatchObject({ outcome: "ok" });
    expect(calls).toEqual([
      { ref: "t_alpha", scroll: true },
      { ref: "t_beta", scroll: false },
      { ref: "t_alpha", scroll: false },
    ]);
  });

  /**
   * 004/T151 - both endpoints are located independently, but only `from`'s session was ever used to
   * deliver the gesture, and `createTargetLocator` returns frame-local coordinates for a genuine
   * out-of-process (OOPIF) frame but page coordinates for everything else (no frame, or a same-site
   * one - both already composited to the page's own coordinate space). Dragging across that boundary
   * - one endpoint in an OOPIF's own local space, the other in the page's - dispatched both ends
   * through `from`'s session, releasing at a coordinate from the wrong document entirely. `moved` was
   * then measured on `from` alone, so it still answered `verified: true` for a drop nobody observed.
   * Endpoints that do not share a coordinate space must be refused before anything is delivered.
   */
  it("refuses a drag whose endpoints do not share a frame, before delivering anything (T151)", async () => {
    const { runner, siteModes, input } = harness({
      locate: async ({ ref }) => {
        if (ref === "t_alpha") {
          return {
            x: 20,
            y: 5,
            width: 20,
            height: 10,
            frame: {
              frameId: 9,
              rect: { x: 20, y: 5, width: 20, height: 10 },
              documentEpoch: "doc-frame-9",
              canonicalOrigin: "https://oopif.fixtures.test",
              sessionId: "session-oopif-9",
            },
          };
        }
        // `t_beta` names an ordinary page-level target - a different coordinate space entirely.
        return { x: 100, y: 40, width: 80, height: 20 };
      },
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(dragRequest());

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "cross-frame-drag" });
    // Refused, not delivered: no pointer traffic at all.
    expect(input.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("refuses a tab the session does not own, before it touches the page", async () => {
    const { runner, execute, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest({ args: { tabId: 99, target: { ref: "t_save" } } }));

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("prompts on a site nobody has decided about, and runs nothing until it is answered", async () => {
    const { runner, input, prompts } = harness();

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    // Nothing has been delivered while the question is up - not through the page, and not through
    // the debugger either (004/T121).
    expect(input.commands).toEqual([]);
    expect(prompts.current()).toMatchObject({ site: SITE, tool: "click", argsSummary: "click a page element" });

    prompts.decide(prompts.current()?.promptId ?? "", true);

    await expect(pending).resolves.toMatchObject({ outcome: "ok" });
    expect(input.commands).not.toEqual([]);
  });

  it("runs nothing when the owner denies (SC-023)", async () => {
    const { runner, execute, prompts } = harness();

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    prompts.decide(prompts.current()?.promptId ?? "", false);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers timed-out and runs nothing when the prompt is never answered (FR-043)", async () => {
    const { runner, execute } = harness();

    await expect(runner.run(clickRequest())).resolves.toEqual({
      callId: "call-1",
      outcome: "timed-out",
      reason: "no-answer",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a late answer to a prompt that already timed out (D-M3-1)", async () => {
    const diagnostics: string[] = [];
    const prompts = createAgentPromptController({
      timeoutMs: 40,
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    const { runner, execute } = harness({ prompts });
    const pendingId = new Promise<string>((resolve) => {
      const tick = setInterval(() => {
        const current = prompts.current();
        if (current) {
          clearInterval(tick);
          resolve(current.promptId);
        }
      }, 5);
    });

    const call = runner.run(clickRequest());
    const promptId = await pendingId;
    await expect(call).resolves.toMatchObject({ outcome: "timed-out" });

    expect(prompts.decide(promptId, true)).toBe(false);
    expect(diagnostics).toContain("agent.prompt.late-answer");
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * 006 FR-087 (S1 review, must-fix 1) - the owner took the tab back while the question stood.
   *
   * Ownership was checked before the prompt was raised; a Release pressed while it is up, followed
   * by "only this time", would otherwise land the effect on a tab that is the owner's again. The
   * lease is read once more after the answer, through the same lookup as before, and the refusal
   * is the one any unheld tab gets.
   */
  it("re-checks ownership after the owner answers, and refuses a tab released while the prompt stood", async () => {
    let held = true;
    const { runner, execute, input, prompts } = harness({
      tabOwnership: async (_sessionId, tabId) => (held && tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    });

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    held = false;
    prompts.decide(prompts.current()?.promptId ?? "", true);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(execute).not.toHaveBeenCalled();
    expect(input.commands).toEqual([]);
  });

  it("answers not-yours, not timed-out, when the session's tabs are released under a standing prompt", async () => {
    let held = true;
    const { runner, execute, prompts } = harness({
      tabOwnership: async (_sessionId, tabId) => (held && tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    });

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    held = false;
    prompts.cancelSession("session-h1", "released");

    await expect(pending).resolves.toMatchObject({ outcome: "denied", reason: "not-yours" });
    expect(prompts.current()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  /** 006 FR-087 (S1 review, should-fix 3): the owner's Stop reaches a parked call as `owner-stopped`. */
  it("answers owner-stopped when the owner stops the session while its prompt stands", async () => {
    const { runner, execute, prompts } = harness();

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    prompts.cancelSession("session-h1", "stopped");

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "stopped", reason: "owner-stopped" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("remembers the mode the owner chose from inside the prompt (FR-042)", async () => {
    const { runner, prompts, siteModes } = harness();

    const pending = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    prompts.decide(prompts.current()?.promptId ?? "", true, "skip-checks");
    await pending;

    await expect(siteModes.get(SITE)).resolves.toMatchObject({ mode: "skip-checks" });
    // The next call is admitted without asking anyone.
    const second = await runner.run(clickRequest({ callId: "call-2" }));
    expect(second).toMatchObject({ outcome: "ok" });
  });

  it("answers busy while another prompt is up", async () => {
    const { runner, prompts } = harness();

    const first = runner.run(clickRequest());
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    const second = await runner.run(clickRequest({ callId: "call-2" }));

    expect(second).toEqual({ callId: "call-2", outcome: "busy", reason: "prompt-pending" });
    prompts.decide(prompts.current()?.promptId ?? "", false);
    await first;
  });

  it("turns a point into a ref through the registry before acting on it", async () => {
    const { runner, located, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(clickRequest({ args: { tabId: AGENT_TAB, target: { x: 12, y: 34 } } }));

    // The point the agent named is hit-tested by the page and the handle it minted is what the
    // gesture is aimed at; the coordinates it is delivered at are that element's own box.
    expect(located).toEqual(["t_point"]);
  });

  it("reports a handle the document no longer knows as stale, not as failed", async () => {
    const { runner, siteModes } = harness({
      execute: async () => ({ ok: false, reachedPage: true, reason: "stale-target" }) as PageExecutionOutcome,
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    // Asked of form_input, which is still the page's to run: 004/T121 moved the pointer gestures to
    // the debugger and nothing else, and the mapping from the runtime's refusal is unchanged.
    await expect(
      runner.run(
        clickRequest({ tool: "form_input", args: { tabId: AGENT_TAB, ref: "t_email", value: "a@b.c" } }),
      ),
    ).resolves.toEqual({
      callId: "call-1",
      outcome: "stale",
      reason: "stale-target",
    });
  });

  it("never reports an effect the document moved under as verified", async () => {
    const { runner, siteModes } = harness({
      execute: async () =>
        ({ ok: true, effect: "value-set", valueMatched: true, documentChanged: true }) as PageExecutionOutcome,
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    await expect(
      runner.run(
        clickRequest({ tool: "form_input", args: { tabId: AGENT_TAB, ref: "t_email", value: "a@b.c" } }),
      ),
    ).resolves.toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "value-set",
          valueMatched: true,
          documentChanged: true,
          verified: false,
          verdict: "document-changed",
        },
      },
    });
  });

  /**
   * 003/B2 — the verdict is part of what was observed (FR-040).
   *
   * A click that starts a navigation asynchronously leaves the executor with nothing to report: the
   * old document was still there when it returned, so its own `documentChanged` is false, and only
   * the post-effect probe sees the replacement. Reporting that observation as `documentChanged:
   * false` tells the agent its refs are still good when every one of them is dead.
   */
  it("reports the document as changed when only the verification saw it move", async () => {
    const { runner, siteModes } = harness({
      // The executor saw an intact document; the tab is on a different one by the time it is probed.
      probe: async () => ({ ok: true, documentEpoch: "doc-2", canonicalOrigin: SITE }),
    });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "activated",
          clicks: 1,
          documentChanged: true,
          verified: false,
          verdict: "document-changed",
        },
      },
    });
  });

  it("refuses a page this extension may not act on", async () => {
    (globalThis as { chrome?: { tabs: { get: (id: number) => Promise<unknown> } } }).chrome!.tabs.get = async () => ({
      id: AGENT_TAB,
      url: "chrome://settings",
    });
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    await expect(runner.run(clickRequest())).resolves.toEqual({
      callId: "call-1",
      outcome: "not-actionable",
      reason: "not-actionable",
    });
  });

  /**
   * 003/M4 — `form_input` names its target as `ref`, not as `target`, because a control's identity
   * is the point of it (contracts `agentFormInputShape`). The mapping was missing entirely, so the
   * tool answered `failed`/`tool-not-implemented`; found by T031.
   */
  it("sets a form control by the ref it was given, not by whatever has focus", async () => {
    const { runner, execute, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });
    execute.mockResolvedValue({
      ok: true,
      effect: "value-set",
      valueMatched: true,
      documentChanged: false,
    } as PageExecutionOutcome);

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "form_input",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB, ref: "t_nickname", value: "agent-set" },
    });

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: {
        observed: {
          effect: "value-set",
          valueMatched: true,
          documentChanged: false,
          verified: true,
          verdict: "verified",
        },
      },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "browser.form-input",
        arguments: { targetHandle: "t_nickname", value: "agent-set" },
      }),
    );
  });

  /**
   * 003/M4 — re-injecting the content runtime destroys every handle the page has minted.
   *
   * The registry lives in the injected module, so a second `executeScript` builds a new one and the
   * ref `find` returned a moment ago names nothing. The binding therefore probes first and injects
   * only when nothing answers, which is exactly what the remote path's own `ensureContentRuntime`
   * does. Found by T031: `find` then `click` answered `stale`/`stale-target` on a page that had not
   * changed at all.
   */
  it("does not re-inject the runtime into a page that already answers", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    await runner.run(clickRequest());
    await runner.run(clickRequest({ callId: "call-2" }));

    expect(fake.injections).toEqual([]);
  });

  it("injects the runtime into a page that has none, then binds it", async () => {
    const chromeRef = (globalThis as { chrome?: { tabs: Record<string, unknown> } }).chrome!;
    let answering = false;
    chromeRef.tabs.sendMessage = async (_tabId: number, message: unknown) => {
      const frame = message as { type: string };
      if (!answering) {
        answering = true;
        // Chrome's own words for "nothing is listening in that tab", which is the only signal that
        // an injection is needed at all.
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_save" }] };
    };
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest());

    expect(response.outcome).toBe("ok");
    expect(fake.injections).toEqual([AGENT_TAB]);
  });

  it("does not gate a find, and answers with refs the registry minted", async () => {
    const chromeRef = (globalThis as { chrome?: { tabs: Record<string, unknown> } }).chrome!;
    chromeRef.tabs.sendMessage = async (_tabId: number, message: unknown) => {
      const frame = message as { type: string };
      if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      if (frame.type === "content.collect-page") {
        return {
          contextHandle: "snap-1",
          documentEpoch: "doc-1",
          canonicalOrigin: SITE,
          formValueItems: [],
          semanticNodes: [{ role: "button", label: "Save", targetHandle: "t_save" }],
        };
      }
      return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_save" }] };
    };
    const { runner, prompts } = harness();

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "find",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB, query: "primary button" },
    });

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { outcome: "resolved", matches: [{ ref: "t_save", role: "button", label: "Save" }] },
    });
    // Reading never asks the owner anything, even on a site whose mode is `ask`.
    expect(prompts.current()).toBeUndefined();
  });

  /**
   * 003/B1 — every control is nameable and actionable for the owner's own agent (FR-040, SC-021).
   *
   * `find` mints through the same collection `read_page` does, so it asks for the same policy; and
   * the arms below - a checkbox set by boolean, a select set by option, a *submit* control clicked -
   * were unreachable before, not because the effect path refused them but because no ref for them
   * existed to name.
   */
  it("finds through the same wide minting the structural read uses", async () => {
    const chromeRef = (globalThis as { chrome?: { tabs: Record<string, unknown> } }).chrome!;
    const collected: Array<Record<string, unknown>> = [];
    chromeRef.tabs.sendMessage = async (_tabId: number, message: unknown) => {
      const frame = message as { type: string; payload: Record<string, unknown> };
      if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
      if (frame.type === "content.collect-page") {
        collected.push(frame.payload);
        return {
          contextHandle: "snap-1",
          documentEpoch: "doc-1",
          canonicalOrigin: SITE,
          formValueItems: [],
          semanticNodes: [{ role: "checkbox", label: "Agree", targetHandle: "t_agree" }],
        };
      }
      return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_agree" }] };
    };
    const { runner } = harness();

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "find",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB, query: "agree checkbox" },
    });

    expect(response.result).toEqual({
      outcome: "resolved",
      matches: [{ ref: "t_agree", role: "checkbox", label: "Agree" }],
    });
    expect(collected[0]).toMatchObject({ mintPolicy: "all-controls" });
  });

  it("ticks a checkbox and picks a select option through the refs a wide read minted", async () => {
    const { runner, execute, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });
    execute.mockResolvedValue({
      ok: true,
      effect: "value-set",
      valueMatched: true,
      documentChanged: false,
    } as PageExecutionOutcome);

    const ticked = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "form_input",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB, ref: "t_agree", value: true },
    });
    const chosen = await runner.run({
      callId: "call-2",
      sessionId: "session-h1",
      tool: "form_input",
      tabId: AGENT_TAB,
      args: { tabId: AGENT_TAB, ref: "t_country", value: "Taiwan" },
    });

    expect([ticked.outcome, chosen.outcome]).toEqual(["ok", "ok"]);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ arguments: { targetHandle: "t_agree", value: true } }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ arguments: { targetHandle: "t_country", value: "Taiwan" } }),
    );
  });

  /**
   * 003/B8 — the gestures and the repeating key have a mapping of their own, and it was untested.
   *
   * Each of these turns into a different runtime action, and `key`'s `repeat` turns into more than
   * one delivery; a mapping nothing drives is a mapping that can be wrong without saying so.
   */
  it("maps the pointer gestures onto their own runtime actions", async () => {
    const { runner, input, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    for (const [tool, effect, button, clickCount] of [
      ["right_click", "context-activated", "right", 1],
      ["triple_click", "triple-activated", "left", 3],
    ] as const) {
      input.commands.length = 0;

      const response = await runner.run(clickRequest({ tool, args: { tabId: AGENT_TAB, target: { ref: "t_menu" } } }));

      expect(response.outcome, tool).toBe("ok");
      expect(response.result, tool).toMatchObject({ observed: { effect } });
      // 004/T121: what makes a gesture what it is, is the button that goes down and how many
      // times - after the move that put the pointer there.
      expect(mouse(input.commands), tool).toEqual([
        { type: "mouseMoved", x: 140, y: 50, button: "none", clickCount: 0 },
        { type: "mousePressed", x: 140, y: 50, button, clickCount },
        { type: "mouseReleased", x: 140, y: 50, button, clickCount },
      ]);
    }
  });

  it("delivers a key as many times as the call asked for", async () => {
    const { runner, execute, input, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(
      clickRequest({ tool: "key", args: { tabId: AGENT_TAB, key: "ArrowDown", repeat: 3 } }),
    );

    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ observed: { effect: "key-pressed", key: "ArrowDown" } });
    // 004/T123: `repeat` still means how many times the key is delivered; what changed is that the
    // key is now the browser's own rather than an event dispatched inside the page.
    const pressed = input.commands.filter(
      (command) => command.method === "Input.dispatchKeyEvent" && command.params.type === "rawKeyDown",
    );
    expect(pressed).toHaveLength(3);
    expect(pressed[0]?.params).toMatchObject({ key: "ArrowDown", code: "ArrowDown" });
    // No target named, so the key goes wherever the page's focus already is: nothing is clicked
    // first, which is what an absent target has meant since 003.
    expect(input.commands.some((command) => command.method === "Input.dispatchMouseEvent")).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * 004/T128, B65 - `focusRetained` had no producer on this path: `effect-verification.ts` requires
   * it to be exactly `true` to verify a key press, and this worker never set it, so every key press
   * answered `focus-lost` regardless of what actually happened. Asked the same way the click family
   * confirms its point - a fresh round trip to the document, not this worker's own bookkeeping.
   */
  it("verifies a key press whose target kept focus, and reports focus-lost when it did not (T128/B65)", async () => {
    const kept = harness({ confirmFocus: async () => true });
    await kept.siteModes.set(SITE, { mode: "skip-checks" });
    const keptResponse = await kept.runner.run(
      clickRequest({ tool: "key", args: { tabId: AGENT_TAB, target: { ref: "t_save" }, key: "Enter" } }),
    );
    expect(keptResponse.result).toMatchObject({
      observed: { effect: "key-pressed", key: "Enter", verified: true, verdict: "verified" },
    });

    const lost = harness({ confirmFocus: async () => false });
    await lost.siteModes.set(SITE, { mode: "skip-checks" });
    const lostResponse = await lost.runner.run(
      clickRequest({ tool: "key", args: { tabId: AGENT_TAB, target: { ref: "t_save" }, key: "Enter" } }),
    );
    expect(lostResponse.result).toMatchObject({
      observed: { effect: "key-pressed", key: "Enter", verified: false, verdict: "focus-lost" },
    });
  });

  /**
   * 004/T146 (S4 review) - `type` clicks to place the caret using the same rect arithmetic the
   * click family already confirms, then answered `verified` unconditionally: a rect stale by a
   * banner's height would focus the neighbouring field, the agent's text would land there, and the
   * answer would say success regardless. Checked the same way the `key` branch already does
   * (T128/B65) - a fresh round trip asking whether the clicked target actually kept focus.
   */
  it("verifies typed text against whether the clicked target kept focus, and reports focus-lost when it did not (T146)", async () => {
    const kept = harness({ confirmFocus: async () => true });
    await kept.siteModes.set(SITE, { mode: "skip-checks" });
    const keptResponse = await kept.runner.run(
      clickRequest({ tool: "type", args: { tabId: AGENT_TAB, target: { ref: "t_field" }, text: "a", mode: "insert" } }),
    );
    expect(keptResponse.result).toMatchObject({
      observed: { effect: "text-entered", verified: true, verdict: "verified" },
    });

    const lost = harness({ confirmFocus: async () => false });
    await lost.siteModes.set(SITE, { mode: "skip-checks" });
    const lostResponse = await lost.runner.run(
      clickRequest({ tool: "type", args: { tabId: AGENT_TAB, target: { ref: "t_field" }, text: "a", mode: "insert" } }),
    );
    expect(lostResponse.result).toMatchObject({
      observed: { effect: "text-entered", verified: false, verdict: "focus-lost" },
    });
  });

  /**
   * 004/T159 (second review) - T146 checked focus, but only *after* `keyboard.type` had already run:
   * the wrong-field scenario was reported honestly, but `replace` mode's own select-all-and-delete,
   * and the text itself, had already gone into the wrong field by the time the honest answer came
   * back. The poll has to run between the click and the typing, so a caret that never landed on the
   * named target refuses before a single character is sent - not just after.
   */
  it("checks focus before typing, and never sends a character when it did not land (T159)", async () => {
    const lost = harness({ confirmFocus: async () => false });
    await lost.siteModes.set(SITE, { mode: "skip-checks" });

    const response = await lost.runner.run(
      clickRequest({ tool: "type", args: { tabId: AGENT_TAB, target: { ref: "t_field" }, text: "secret", mode: "replace" } }),
    );

    expect(response.result).toMatchObject({
      observed: { effect: "text-entered", charactersChanged: 0, verified: false, verdict: "focus-lost" },
    });
    // The click that places the caret is still allowed to land - only the keystrokes that would
    // follow it are refused. Not one `Input.insertText` for text that never should have been typed.
    expect(lost.input.commands.some((command) => command.method === "Input.insertText")).toBe(false);
  });

  /**
   * 004/T128 follow-up (B66): the focus check used a fixed 50ms sleep before its one and only
   * `confirmFocus` call - real on a loaded machine, but a constant that either over-pays when
   * focus settles sooner or still loses the race when it settles later. A bounded poll checks
   * again rather than trusting the single sample a fixed wait happened to land on.
   */
  it("polls for focus rather than trusting one sample after a fixed wait (T128 follow-up)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const settling = harness({
      // False on the first ask, true from then on - a renderer that settles just after the first
      // check, which a single fixed-delay sample can land on either side of.
      confirmFocus: async () => {
        calls += 1;
        return calls > 1;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await settling.siteModes.set(SITE, { mode: "skip-checks" });

    const response = await settling.runner.run(
      clickRequest({ tool: "key", args: { tabId: AGENT_TAB, target: { ref: "t_save" }, key: "Enter" } }),
    );

    expect(response.result).toMatchObject({
      observed: { effect: "key-pressed", key: "Enter", verified: true, verdict: "verified" },
    });
    expect(calls).toBe(2);
    // One short wait between the two checks, not one fixed 50ms wait before the only check.
    expect(sleeps).toEqual([10]);
  });

  /**
   * 004/T155 (regression from T146, the same family for the third time) - `createFocusConfirmer`
   * asked the top document's `frameId`, `documentEpoch` and `canonicalOrigin` for every focus check,
   * never the claiming frame's own, exactly as the click confirmation did before B69 (epoch) and B72
   * (origin). A fake that gives every frame the top document's epoch and origin can never catch this
   * - it has to give the claimed frame a genuinely distinct document, the way `installChrome`'s own
   * fixture already does for the click family, or asking the wrong document happens to look right.
   */
  it("confirms a framed focus check against the frame that claimed the target, not frame 0 (T155)", async () => {
    const confirmFocus = createFocusConfirmer(async (input) => {
      // Mirrors a real page: frame 7 is its own document, with its own epoch, origin and active
      // element - never the top document's. Asking frame 0 about a target that lives in frame 7
      // reaches a different document's activeElement, not this one.
      const frameId = input.frameId ?? 0;
      const epoch = frameId === 0 ? "doc-1" : `doc-frame-${frameId}`;
      const origin = frameId === 0 ? SITE : `https://frame-${frameId}.fixtures.test`;
      if (input.documentEpoch !== epoch || (input.frameOrigin ?? SITE) !== origin) {
        return { ok: false, reason: "stale-context" };
      }
      const activeHandle = frameId === 7 ? "t_field" : "t_other";
      return { ok: true, outcome: "resolved", candidates: [{ targetHandle: activeHandle }] };
    });

    const retained = await confirmFocus({
      context: testSessionContexts().forCall("session-h1", "call-1"),
      binding: { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
      ref: "t_field",
      frameId: 7,
      documentEpoch: "doc-frame-7",
      frameOrigin: "https://frame-7.fixtures.test",
    });

    expect(retained).toBe(true);
  });

  it("clicks a submit control, which only the agent's own policy allows", async () => {
    const { runner, located, input, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = await runner.run(clickRequest({ args: { tabId: AGENT_TAB, target: { ref: "t_submit" } } }));

    expect(response.outcome).toBe("ok");
    // The classification that would refuse a submit control for a remote caller never enters into
    // it: the owner's site mode answered this call (US3 decision 3), and a browser-level press has
    // no page-side policy to consult at all (004/T121).
    expect(located).toEqual(["t_submit"]);
    expect(mouse(input.commands).map((event) => event.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });
});

/**
 * 004/T149 - the OOPIF correlation nonce itself, in isolation from the delivery it correlates for.
 * The nonce only ever proves "this session's document ran the script that wrote it" - it says
 * nothing about which document that was unless something else checks. These two are the behavioural
 * half of the fix: a session that echoes the nonce from the wrong origin, and a page that arranges
 * for more than one session to echo it, must both fail closed rather than hand back a session id the
 * caller then trusts as "the claimed frame".
 */
describe("T149 OOPIF session resolver", () => {
  const TAB = 4;
  const FRAME = 9;
  const GOOD_ORIGIN = "https://good.fixtures.test";

  /** A fake page world: `writeNonce` remembers what was planted, `send` echoes it back on demand. */
  function fakeRound(sessions: Array<{ sessionId: string; url: string }>, echoFrom: string[]) {
    let nonce: string | undefined;
    const cleared: Array<{ tabId: number; frameId: number }> = [];
    const resolver = createOopifSessionResolver({
      sessions: () => sessions,
      writeNonce: async (_tabId, _frameId, value) => {
        nonce = value;
      },
      clearNonce: async (tabId, frameId) => {
        cleared.push({ tabId, frameId });
      },
      send: async (_tabId, _method, _params, sessionId) => ({
        result: { value: echoFrom.includes(sessionId) ? nonce : "not-the-nonce" },
      }),
    });
    return { resolver, cleared };
  }

  it("refuses a session that echoes the nonce from a frame whose own origin does not match the one claimed", async () => {
    const { resolver, cleared } = fakeRound(
      [
        { sessionId: "session-good", url: `${GOOD_ORIGIN}/child` },
        { sessionId: "session-evil", url: "https://evil.example/child" },
      ],
      ["session-evil"],
    );

    const sessionId = await resolver(TAB, FRAME, GOOD_ORIGIN);

    expect(sessionId).toBeUndefined();
    // Cleaned up regardless of the outcome - the tell must not survive a refusal either.
    expect(cleared).toEqual([{ tabId: TAB, frameId: FRAME }]);
  });

  it("refuses to pick a session when more than one candidate echoes the nonce from the claimed origin, rather than taking the first", async () => {
    // Two frames the page itself put at the same origin - the order between them is the page's own
    // choice, never something the resolver may use as a tiebreaker.
    const { resolver, cleared } = fakeRound(
      [
        { sessionId: "session-first", url: `${GOOD_ORIGIN}/a` },
        { sessionId: "session-second", url: `${GOOD_ORIGIN}/b` },
      ],
      ["session-first", "session-second"],
    );

    const sessionId = await resolver(TAB, FRAME, GOOD_ORIGIN);

    expect(sessionId).toBeUndefined();
    expect(cleared).toEqual([{ tabId: TAB, frameId: FRAME }]);
  });

  it("resolves the one session that echoes the nonce from the claimed frame's own origin", async () => {
    const { resolver, cleared } = fakeRound(
      [
        { sessionId: "session-good", url: `${GOOD_ORIGIN}/child` },
        { sessionId: "session-evil", url: "https://evil.example/child" },
      ],
      ["session-good"],
    );

    const sessionId = await resolver(TAB, FRAME, GOOD_ORIGIN);

    expect(sessionId).toBe("session-good");
    expect(cleared).toEqual([{ tabId: TAB, frameId: FRAME }]);
  });
});
