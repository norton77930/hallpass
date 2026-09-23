import { describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest, SiteMode } from "@hallpass/contracts";
import { createAgentDialogs, type AgentDialogsDeps } from "../src/service-worker/agent-tools/dialogs.js";

/**
 * 008/T225 — the dialogs the page opens, and the one decision answering them can cost (US3,
 * FR-110..FR-117).
 *
 * Two rules are pinned here rather than on the gate, because they are the ones a fixture cannot
 * time honestly. The first is *chaining*: an accept that follows an effect the owner approved on
 * the same tab within a second is part of that action and is shown as a notice; a second later it
 * is a question of its own. The boundary is a number, so it is tested as one - 999 and 1001 - and
 * the tab is part of it, because an approval on another tab is not this dialog's cause.
 *
 * The second is what is *never* asked: an alert has one button, and dismissing is the answer that
 * changes nothing, so neither ever reaches the owner in any mode. Everything else here is about
 * the page after the dialog - the liveness probe FR-116 adds, which neither reference has.
 */

const AGENT_TAB = 7;
const OTHER_TAB = 8;
const SITE = "https://fixtures.test:19443";
const SESSION = "session-d1";

type Sent = { tabId: number; method: string; params?: Record<string, unknown> };

function harness(overrides: Partial<AgentDialogsDeps> & { mode?: SiteMode } = {}) {
  const sent: Sent[] = [];
  const activity: Array<{ sessionId: string; item: Record<string, unknown> }> = [];
  const notices: Array<{ sessionId: string; notice: Record<string, unknown> }> = [];
  const asked: Array<Record<string, unknown>> = [];
  let decision: { decision: string; rememberMode?: SiteMode } = { decision: "allow" };
  const mode = overrides.mode ?? "ask";
  const dialogs = createAgentDialogs({
    async send(tabId, method, params) {
      sent.push({ tabId, method, ...(params ? { params } : {}) });
      return {};
    },
    siteModes: {
      async get() {
        return { mode };
      },
      async set() {},
    },
    prompts: {
      async ask(prompt) {
        asked.push(prompt as unknown as Record<string, unknown>);
        // The real controller's own first rule (014 FR-179): a question raised for a call the
        // owner has already ended is answered `interrupted`, and no card goes up.
        if ((prompt as { stopped?: () => boolean }).stopped?.()) return { decision: "interrupted" } as never;
        return decision as never;
      },
    },
    async tabOwnership(_sessionId, tabId) {
      return tabId === AGENT_TAB || tabId === OTHER_TAB ? { state: "this" } : { state: "not-yours" };
    },
    async siteOfTab() {
      return SITE;
    },
    async holderOf() {
      return SESSION;
    },
    onActivity: (sessionId, item) => activity.push({ sessionId, item: item as unknown as Record<string, unknown> }),
    onNotice: (sessionId, notice) => notices.push({ sessionId, notice: notice as unknown as Record<string, unknown> }),
    livenessMs: 20,
    ...overrides,
  } as AgentDialogsDeps);
  return {
    dialogs,
    sent,
    activity,
    notices,
    asked,
    answerWith(next: { decision: string; rememberMode?: SiteMode }) {
      decision = next;
    },
  };
}

function opening(params: Record<string, unknown>): Record<string, unknown> {
  return { url: `${SITE}/dialogs`, message: "Delete 3 orders?", type: "confirm", hasBrowserHandler: false, ...params };
}

function dialogCall(args: Record<string, unknown>, callId = "call-1"): AgentNativeRequest {
  return {
    callId,
    sessionId: SESSION,
    tool: "dialog",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  } as AgentNativeRequest;
}

/** The handle command the runner sends, which is the whole of what the page is told. */
function handled(sent: Sent[]): Sent | undefined {
  return sent.find((command) => command.method === "Page.handleJavaScriptDialog");
}

describe("T225 dialogs", () => {
  it("shows a notice rather than a card for an accept 999 ms after an approved effect", async () => {
    let clock = 1_000_000;
    const h = harness({ now: () => clock });
    h.dialogs.noteApprovedEffect(AGENT_TAB, "click");
    clock += 999;
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(h.asked).toEqual([]);
    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ ok: true, type: "confirm" });
    expect(handled(h.sent)).toMatchObject({ tabId: AGENT_TAB, params: { accept: true } });
    expect(h.notices[0]?.notice).toMatchObject({ dialogText: "Delete 3 orders?", action: "click" });
    expect(h.activity.at(-1)?.item).toMatchObject({ kind: "dialog", outcome: "accepted-chained" });
  });

  it("asks the owner for an accept 1001 ms after the approved effect, and for one on another tab", async () => {
    let clock = 1_000_000;
    const h = harness({ now: () => clock });
    h.dialogs.noteApprovedEffect(AGENT_TAB, "click");
    clock += 1001;
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ kind: "dialog-accept", dialogText: "Delete 3 orders?", tool: "dialog" });
    expect(response.outcome).toBe("ok");
    expect(h.notices).toEqual([]);
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "accepted" });

    // The other tab's approval is not this dialog's cause, however recent it is.
    const other = harness({ now: () => clock });
    other.dialogs.noteApprovedEffect(OTHER_TAB, "click");
    other.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));
    await other.dialogs.run(dialogCall({ action: "accept" }));
    expect(other.asked).toHaveLength(1);
  });

  it("spends one approval on one dialog: the next confirm is a question of its own", async () => {
    // FR-112, as amended by the S4 review: a page that opens a second confirm the moment the first
    // is accepted would otherwise ride on the same click forever, and the owner would have agreed
    // once to an unbounded sequence of accepts.
    let clock = 1_000_000;
    const h = harness({ now: () => clock });
    h.dialogs.noteApprovedEffect(AGENT_TAB, "click");
    clock += 100;
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    await h.dialogs.run(dialogCall({ action: "accept" }));
    expect(h.asked).toEqual([]);
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "accepted-chained" });

    clock += 100;
    h.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ message: "Delete the invoices too?" }),
    );
    await h.dialogs.run(dialogCall({ action: "accept" }, "call-2"));

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ dialogText: "Delete the invoices too?" });
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "accepted" });
  });

  it("never asks for an alert, in any mode, whichever action answers it", async () => {
    const h = harness();
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({ type: "alert", message: "Saved" }));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(h.asked).toEqual([]);
    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ type: "alert" });
    expect(h.activity.at(-1)?.item).toMatchObject({ message: "Saved", outcome: "accepted" });
  });

  it("never asks for a dismiss, and the page sees Cancel", async () => {
    const h = harness();
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "dismiss" }));

    expect(h.asked).toEqual([]);
    expect(response.outcome).toBe("ok");
    expect(handled(h.sent)).toMatchObject({ params: { accept: false } });
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "dismissed" });
  });

  it("submits the typed text, or the page's own default when none was typed", async () => {
    const withText = harness({ mode: "skip-checks" });
    withText.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "prompt", message: "Your name?", defaultPrompt: "hello" }),
    );
    await withText.dialogs.run(dialogCall({ action: "accept", promptText: "typed" }));
    expect(handled(withText.sent)).toMatchObject({ params: { accept: true, promptText: "typed" } });

    const withDefault = harness({ mode: "skip-checks" });
    withDefault.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "prompt", message: "Your name?", defaultPrompt: "hello" }),
    );
    await withDefault.dialogs.run(dialogCall({ action: "accept" }));
    expect(handled(withDefault.sent)).toMatchObject({ params: { accept: true, promptText: "hello" } });
  });

  it("dismisses the dialog and answers refused when the owner presses refuse", async () => {
    const h = harness();
    h.answerWith({ decision: "deny" });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(handled(h.sent)).toMatchObject({ params: { accept: false } });
    expect(response).toMatchObject({ outcome: "denied", reason: "refused", refusal: { reason: "refused" } });
    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "refused" });
  });

  it("leaves the owner's own leave-site prompt alone, and answers only the one a call armed", async () => {
    const h = harness();
    h.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "beforeunload", message: "" }),
    );

    /**
     * FR-115's last sentence: nothing armed this, so the owner pressed something of their own on a
     * tab the session happens to hold - and their browser's leave-site prompt is theirs to answer.
     * Not a current dialog either: this module never holds one for `beforeunload`.
     */
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.activity).toEqual([]);

    // Armed by a call that asked to stay: answered at once, and the card says what happened.
    const staying = h.dialogs.beginUnload(AGENT_TAB, "stay");
    h.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "beforeunload", message: "" }),
    );
    expect(handled(h.sent)).toMatchObject({ params: { accept: false } });
    await expect(staying.settled).resolves.toMatchObject({ action: "stay" });
    // The card is told whose tab it was, which is a lease lookup: a turn of the loop later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.activity.at(-1)?.item).toMatchObject({ kind: "dialog", outcome: "stayed" });
    staying.end();

    const watch = h.dialogs.beginUnload(AGENT_TAB, "leave");
    h.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "beforeunload", message: "" }),
    );
    await expect(watch.settled).resolves.toMatchObject({ action: "leave", url: `${SITE}/dialogs` });
    watch.end();

    // The policy and the arming both belonged to that call (data-model BeforeunloadPolicy): the
    // next prompt is nobody's but the owner's again, so nothing answers it.
    h.sent.length = 0;
    h.dialogs.onDebuggerEvent(
      AGENT_TAB,
      "Page.javascriptDialogOpening",
      opening({ type: "beforeunload", message: "" }),
    );
    expect(h.sent).toEqual([]);
  });

  it("says page-unresponsive when the tab does not answer a trivial read after the dialog", async () => {
    const sent: Sent[] = [];
    const h = harness({
      async send(tabId, method, params) {
        sent.push({ tabId, method, ...(params ? { params } : {}) });
        // The page is frozen: the handle is queued, and the read after it never comes back.
        if (method === "Runtime.evaluate") return new Promise<Record<string, unknown>>(() => {});
        return {};
      },
      mode: "skip-checks",
    });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(sent.map((command) => command.method)).toEqual([
      "Page.handleJavaScriptDialog",
      "Runtime.evaluate",
    ]);
    // A command, never `Runtime.enable`: the probe asks one expression and subscribes to nothing.
    expect(sent[1]?.params).toEqual({ expression: "1", returnByValue: true });
    expect(response).toMatchObject({
      outcome: "failed",
      reason: "page-unresponsive",
      refusal: { reason: "page-unresponsive" },
    });
  });

  it("answers no-dialog when the browser refuses the answer, and keeps nothing about it", async () => {
    // The dialog closed between the event and the command - the owner's own OK, or a navigation
    // that took the page away. Chrome answers "No dialog is showing", and an unhandled rejection
    // here would leave the module believing a dialog is open that the browser says is not.
    const h = harness({
      mode: "skip-checks",
      async send(_tabId, method) {
        if (method === "Page.handleJavaScriptDialog") throw new Error("No dialog is showing");
        return {};
      },
    });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(response).toMatchObject({ outcome: "failed", reason: "no-dialog", refusal: { reason: "no-dialog" } });
    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(h.activity).toEqual([]);
    expect(await h.dialogs.run(dialogCall({ action: "dismiss" }))).toMatchObject({ reason: "no-dialog" });
  });

  it("answers no-dialog when none is open, and when the owner closed it by hand first", async () => {
    const h = harness();
    expect(await h.dialogs.run(dialogCall({ action: "accept" }))).toMatchObject({
      outcome: "failed",
      reason: "no-dialog",
      refusal: { reason: "no-dialog" },
    });

    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogClosed", { result: false, userInput: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(h.activity.at(-1)?.item).toMatchObject({ outcome: "closed-by-owner" });
    expect(await h.dialogs.run(dialogCall({ action: "accept" }))).toMatchObject({ reason: "no-dialog" });
  });

  it("consumes the two dialog events and nothing else the page domain emits (R-138)", () => {
    const h = harness();
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.frameNavigated", {
      frame: { id: "F1", url: `${SITE}/secret`, securityOrigin: SITE },
    });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.loadEventFired", { timestamp: 1 });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.lifecycleEvent", { name: "load" });

    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(h.activity).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("forgets everything about a tab the session let go of", async () => {
    const h = harness({ mode: "skip-checks" });
    h.dialogs.noteApprovedEffect(AGENT_TAB, "click");
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    h.dialogs.forget(AGENT_TAB);

    expect(h.dialogs.current(AGENT_TAB)).toBeUndefined();
    expect(await h.dialogs.run(dialogCall({ action: "dismiss" }))).toMatchObject({ reason: "no-dialog" });
  });

  it("refuses a tab this session does not hold", async () => {
    const h = harness();
    const response = await h.dialogs.run({
      callId: "call-2",
      sessionId: SESSION,
      tool: "dialog",
      args: { tabId: 99, action: "accept" },
    } as AgentNativeRequest);
    expect(response).toMatchObject({ outcome: "denied", reason: "not-yours" });
  });

  /**
   * 014/T369 follow-up — the dialog card was the one ask site that did not read the handle.
   *
   * Every other question a runner raises is refused at the raise when the owner has already ended
   * the call (FR-179). This one was not, so an interrupt landing between the dispatch point and
   * this ask left a card standing whose Allow would press OK on a page for a call the agent had
   * been told was over - and pressing OK on a confirm is the least undoable thing this extension
   * does. The step's own id travels too, so the "still waiting" tick names a call the host holds.
   */
  it("answers interrupted, and presses nothing, when the owner ended the call before the question", async () => {
    const h = harness();
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    const response = await h.dialogs.run({
      ...dialogCall({ action: "accept" }),
      hostCallId: "call-host",
      stopped: () => true,
    });

    expect(response).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
    expect(h.asked[0]).toMatchObject({ hostCallId: "call-host" });
    expect(handled(h.sent), "the page was answered for a call that was already over").toBeUndefined();
    // The dialog is left exactly as it is: the session and the page are untouched by an interrupt.
    expect(h.dialogs.current(AGENT_TAB)).toBeDefined();
  });

  it("carries the agent's answer in the prompt the owner is shown, and remembers a mode from it", async () => {
    const setMode = vi.fn(async () => {});
    const h = harness({
      siteModes: {
        async get() {
          return { mode: "ask" as SiteMode };
        },
        set: setMode,
      },
    });
    h.answerWith({ decision: "allow", rememberMode: "skip-checks" });
    h.dialogs.onDebuggerEvent(AGENT_TAB, "Page.javascriptDialogOpening", opening({}));

    await h.dialogs.run(dialogCall({ action: "accept" }));

    expect(setMode).toHaveBeenCalledWith(SITE, { mode: "skip-checks" });
  });
});
