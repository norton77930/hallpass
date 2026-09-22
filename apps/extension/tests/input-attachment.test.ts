import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import {
  createInputAttachments,
  inputUnavailable,
} from "../src/service-worker/agent-tools/input.js";
import { createAgentDiagnostics } from "../src/service-worker/agent-tools/diagnostics.js";
import { createAgentDialogs } from "../src/service-worker/agent-tools/dialogs.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 004/T118 — one debugger attachment per held tab (US5, R-113, FR-064, FR-071).
 *
 * The attachment is the thing S4 is built on, and it is shared: input needs it to deliver a real
 * pointer, and 003's diagnostics need it to hear the console. What is *not* shared is the consent.
 * The debugger being attached says nothing about the page; enabling `Runtime`, `Log` and `Network`
 * is what turns it into a window on what the page logged and fetched, and that only ever happens
 * under the owner's per-site diagnostics grant. So the two lifetimes come apart here: the domains
 * end with the grant - on a site change - and the attachment outlives it, ending with the lease.
 *
 * The other half is the failure. Chrome refuses the attachment when the owner has developer tools
 * open on that tab, or on a page no extension may attach to. Then every effect on that tab says so
 * (`failed` / `input-unavailable` with the cause) and nothing is delivered by another route: the
 * page-level events 003 used are what this slice exists to replace, so falling back to them would
 * be handing the page exactly the synthetic input the reference never produces.
 */

const AGENT_TAB = 7;
const OTHER_TAB = 8;
const SITE = "https://fixtures.test:19443";
const OTHER_SITE = "https://elsewhere.test";
const DIAGNOSTICS_DOMAINS = ["Runtime.enable", "Log.enable", "Network.enable"];

type FakeDebugger = {
  attached: number[];
  detached: number[];
  commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }>;
  /** Set by a test that wants Chrome to refuse the attachment, as it does for C7. */
  attachError: string | undefined;
  /**
   * Set by a test that wants a window open during a detach in flight (T161): `chrome.debugger.detach`
   * awaits this before resolving, the same real gap `Input.detach`'s own round trip to Chrome leaves
   * open.
   */
  detachGate?: Promise<void>;
  emit(tabId: number, method: string, params: Record<string, unknown>): void;
};

function installChrome(): { fakeDebugger: FakeDebugger; url: { value: string } } {
  const local: Record<string, unknown> = {};
  const listeners: Array<(source: { tabId?: number }, method: string, params?: unknown) => void> = [];
  const url = { value: `${SITE}/form` };
  const fakeDebugger: FakeDebugger = {
    attached: [],
    detached: [],
    commands: [],
    attachError: undefined,
    emit(tabId, method, params) {
      for (const listener of listeners) listener({ tabId }, method, params);
    },
  };
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
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB && tabId !== OTHER_TAB) throw new Error("No tab with id");
        return { id: tabId, url: url.value, groupId: 1, windowId: 900, active: false };
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach(target: { tabId: number }) {
        if (fakeDebugger.attachError !== undefined) throw new Error(fakeDebugger.attachError);
        if (fakeDebugger.attached.includes(target.tabId)) throw new Error("Already attached");
        fakeDebugger.attached.push(target.tabId);
      },
      async detach(target: { tabId: number }) {
        if (fakeDebugger.detachGate) await fakeDebugger.detachGate;
        if (!fakeDebugger.attached.includes(target.tabId)) throw new Error("Not attached");
        fakeDebugger.attached = fakeDebugger.attached.filter((tabId) => tabId !== target.tabId);
        fakeDebugger.detached.push(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>) {
        fakeDebugger.commands.push({ tabId: target.tabId, method, ...(params ? { params } : {}) });
        return {};
      },
      onEvent: {
        addListener(callback: (source: { tabId?: number }, method: string, params?: unknown) => void) {
          listeners.push(callback);
        },
      },
      onDetach: { addListener() {} },
    },
  };
  return { fakeDebugger, url };
}

function harness() {
  const attachments = createInputAttachments();
  const siteModes = createSiteModeStore();
  const diagnostics = createAgentDiagnostics({
    context: testSessionContexts(),
    siteModes,
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB || tabId === OTHER_TAB ? { state: "this" } : { state: "not-yours" },
    attachments,
  });
  return { attachments, diagnostics, siteModes };
}

function request(tool: string, tabId = AGENT_TAB): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-i1",
    tool: tool as AgentNativeRequest["tool"],
    tabId,
    args: { tabId },
  };
}

/** A console message as `Runtime.consoleAPICalled` delivers one. */
function logged(text: string): Record<string, unknown> {
  return { type: "log", timestamp: 1_700_000_000_000, args: [{ type: "string", value: text }] };
}

function methodsOn(fake: FakeDebugger, tabId: number): string[] {
  return fake.commands.filter((command) => command.tabId === tabId).map((command) => command.method);
}

describe("T118 the input attachment", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("attaches lazily, on the first effect, and once per held tab", async () => {
    const { attachments } = harness();

    // Nothing has asked for an effect yet, so Chrome has not been told to debug anything.
    expect(fake.fakeDebugger.attached).toEqual([]);

    expect(await attachments.acquire(AGENT_TAB, "input")).toEqual({ ok: true });
    expect(await attachments.acquire(AGENT_TAB, "input")).toEqual({ ok: true });

    expect(fake.fakeDebugger.attached).toEqual([AGENT_TAB]);
    expect(attachments.attached()).toEqual([AGENT_TAB]);
    expect(attachments.state(AGENT_TAB)).toEqual({
      tabId: AGENT_TAB,
      attached: true,
      diagnosticsEnabled: false,
    });
  });

  /**
   * FR-071, and the line the owner's consent model rests on: attaching is not reading. An
   * attachment made to deliver a click enables no domain, so no console message, no request and no
   * page value ever reaches this worker through it.
   */
  it("enables no diagnostics domain when it attaches for input, and buffers nothing", async () => {
    const { attachments, diagnostics, siteModes } = harness();

    await attachments.acquire(AGENT_TAB, "input");
    // The page talks while the agent is only clicking. Nobody granted diagnostics for this site.
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("before the grant"));
    fake.fakeDebugger.emit(AGENT_TAB, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: `${SITE}/secret` },
      type: "XHR",
      wallTime: 1_700_000,
    });

    // `Target.setAutoAttach` (004/T129) is not a diagnostics domain - it is what turns a cross-site
    // child frame into its own addressable session at all - and it goes out on every attachment
    // regardless of holder. `Page.enable` (008/T224, D-008-5) is the second such command: it is
    // what makes a dialog audible at all, and the two events it is subscribed for are the only
    // ones anything in this worker consumes (the test below pins the drop of the rest).
    expect(methodsOn(fake.fakeDebugger, AGENT_TAB)).toEqual(["Target.setAutoAttach", "Page.enable"]);
    expect(attachments.state(AGENT_TAB)?.diagnosticsEnabled).toBe(false);
    // And the tools still say no, because the attachment is not the grant.
    expect(await diagnostics.run(request("read_console"))).toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "diagnostics-not-granted",
    });

    // Now the owner grants it. The domains go on only here, and the buffers start only here: what
    // the page said while this was an input-only attachment was never kept.
    await siteModes.set(SITE, { diagnosticsGranted: true });
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("ignored, not yet enabled"));
    const granted = await diagnostics.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("after the grant"));
    const after = await diagnostics.run(request("read_console"));

    expect(methodsOn(fake.fakeDebugger, AGENT_TAB)).toEqual([
      "Target.setAutoAttach",
      "Page.enable",
      ...DIAGNOSTICS_DOMAINS,
    ]);
    // Shared, not re-made: the tab was attached for input and diagnostics joined that attachment.
    expect(fake.fakeDebugger.attached).toEqual([AGENT_TAB]);
    expect(fake.fakeDebugger.detached).toEqual([]);
    expect((granted.result as { messages: unknown[] }).messages).toEqual([]);
    expect((after.result as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual([
      "after the grant",
    ]);
    expect((after.result as { requests?: unknown }).requests).toBeUndefined();
  });

  /**
   * 004/T125b - the invariant the owner's consent model actually rests on (FR-071).
   *
   * Measuring where a frame sits needs the geometry domain enabled on this same attachment, so the
   * simpler sentence - "only diagnostics enables anything" - is not true and never was. The true
   * one is narrower and checkable, and this is the check: no domain whose **events** this worker
   * consumes, and nothing carrying **page content**, is enabled outside the owner's grant. The
   * geometry domain is neither. It answers two questions about boxes when they are asked, its
   * events are subscribed to by nobody, and nothing it says can be read back through any tool -
   * so a `DOM.setChildNodes` full of the page's own values is not held anywhere and is not
   * reachable, granted or not.
   */
  it("enables the geometry domain for measurement, and buffers nothing from it", async () => {
    const { attachments, diagnostics, siteModes } = harness();

    await attachments.acquire(AGENT_TAB, "input");
    // The measurement an effect makes on a framed page (T125a), on an ungranted site.
    await attachments.send(AGENT_TAB, "DOM.enable");
    await attachments.send(AGENT_TAB, "DOM.getFrameOwner", { frameId: "F1" });
    await attachments.send(AGENT_TAB, "DOM.getBoxModel", { backendNodeId: 11 });

    // It is not a domain of the grant, so nothing about the grant changed, and the page is not
    // any more readable than it was before an offset was measured.
    expect(attachments.state(AGENT_TAB)?.diagnosticsEnabled).toBe(false);
    expect(await diagnostics.run(request("read_console"))).toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "diagnostics-not-granted",
    });

    // Now the owner grants the site, so the buffers that exist are filling. The page's DOM events
    // carry its own text and its own values - this is the traffic that would make the geometry
    // domain a window on the page if anything of ours were listening to it.
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await diagnostics.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "DOM.documentUpdated", {});
    fake.fakeDebugger.emit(AGENT_TAB, "DOM.setChildNodes", {
      parentId: 1,
      nodes: [{ nodeId: 2, nodeName: "INPUT", attributes: ["value", "hunter2"] }],
    });
    fake.fakeDebugger.emit(AGENT_TAB, "DOM.attributeModified", {
      nodeId: 2,
      name: "value",
      value: "hunter2",
    });
    fake.fakeDebugger.emit(AGENT_TAB, "DOM.childNodeInserted", {
      node: { nodeValue: "the owner's balance is hunter2" },
    });
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("the console still works"));

    const console = await diagnostics.run(request("read_console"));
    const network = await diagnostics.run(request("read_network"));

    // Buffered: only what the three granted domains said. Reachable: the same, through either
    // tool - so nothing the page put in a DOM event can be read back, and the answers are not
    // even marked as having been cut, which is what a silently dropped buffer would look like.
    expect((console.result as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual([
      "the console still works",
    ]);
    expect(JSON.stringify(console.result)).not.toContain("hunter2");
    expect(network.result).toEqual({ requests: [], truncated: false });
    // And the only domains this worker ever enabled are the grant's three and the two stated
    // exceptions: the geometry domain, reached by asking it a question and never by subscribing to
    // it, and the page domain, subscribed to for exactly two dialog events (008/D-008-5, the test
    // below). The list is spelled out so a fourth one cannot appear without somebody deciding it.
    expect(methodsOn(fake.fakeDebugger, AGENT_TAB).filter((method) => method.endsWith(".enable"))).toEqual([
      "Page.enable",
      "DOM.enable",
      ...DIAGNOSTICS_DOMAINS,
    ]);
  });

  /**
   * R-113's decision, and the one thing that changes about 003's lifetime: the *grant* is per site,
   * so the domains still end on a site change; the attachment is per lease, so it does not.
   */
  it("keeps the attachment across a same-tab navigation and disables the domains with the grant", async () => {
    const { attachments, diagnostics, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await attachments.acquire(AGENT_TAB, "input");
    await diagnostics.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("on the granted site"));

    fake.url.value = `${OTHER_SITE}/next`;
    await diagnostics.refresh(AGENT_TAB);

    // Still one attachment, never detached: the effect that comes next does not pay to attach again.
    expect(fake.fakeDebugger.attached).toEqual([AGENT_TAB]);
    expect(fake.fakeDebugger.detached).toEqual([]);
    expect(attachments.state(AGENT_TAB)).toEqual({
      tabId: AGENT_TAB,
      attached: true,
      diagnosticsEnabled: false,
    });
    // The domains were turned off where the grant stopped applying, so the new site's console is
    // not being listened to at all. `Target.setAutoAttach` (004/T129) is the one attachment-lifetime
    // command, sent once when the tab first attached, not repeated by the navigation.
    expect(methodsOn(fake.fakeDebugger, AGENT_TAB)).toEqual([
      "Target.setAutoAttach",
      "Page.enable",
      ...DIAGNOSTICS_DOMAINS,
      "Runtime.disable",
      "Log.disable",
      "Network.disable",
    ]);
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("on the new site"));
    expect(await diagnostics.run(request("read_console"))).toEqual({
      callId: "call-1",
      outcome: "denied",
      reason: "diagnostics-not-granted",
    });
    // And an effect on the tab is still deliverable; the input half never depended on the grant.
    expect(await attachments.acquire(AGENT_TAB, "input")).toEqual({ ok: true });
  });

  it("lets go with the lease: one tab released, and every tab at session end", async () => {
    const { attachments } = harness();
    await attachments.acquire(AGENT_TAB, "input");
    await attachments.acquire(OTHER_TAB, "input");

    await attachments.release(AGENT_TAB);

    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    expect(attachments.attached()).toEqual([OTHER_TAB]);
    expect(attachments.state(AGENT_TAB)).toBeUndefined();

    await attachments.releaseAll();

    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB, OTHER_TAB]);
    expect(attachments.attached()).toEqual([]);
  });

  /**
   * 012/T306 — the fourth holder, and the two moments the emulated viewport needs (FR-159, R-167).
   *
   * The holder is `"viewport"` and it enables nothing, exactly as `"recording"` does: what it buys
   * is a lifetime, not a capability - the attachment lasts as long as the emulation, so that there
   * is something to send the clear over. The two hooks are here rather than in the runtime because
   * `acquire` is the only place a debugger is attached at all and `release` / `releaseAll` are the
   * only places one is detached; anything that has to happen either side of those cannot be
   * remembered by five call sites.
   */
  it("enables no domain for the viewport holder, and tells its listener after the attachment's own setup", async () => {
    const { attachments } = harness();
    const attachedSeen: Array<{ tabId: number; after: string[] }> = [];
    attachments.onAttached((tabId) => {
      attachedSeen.push({ tabId, after: methodsOn(fake.fakeDebugger, tabId) });
    });

    expect(await attachments.acquire(AGENT_TAB, "viewport")).toEqual({ ok: true });

    expect(methodsOn(fake.fakeDebugger, AGENT_TAB)).toEqual(["Target.setAutoAttach", "Page.enable"]);
    expect(attachments.state(AGENT_TAB)?.diagnosticsEnabled).toBe(false);
    // Told after the per-attachment setup, because what the listener does is send a command of its
    // own: a re-applied viewport override before `Page.enable` would race the attachment's own.
    expect(attachedSeen).toEqual([{ tabId: AGENT_TAB, after: ["Target.setAutoAttach", "Page.enable"] }]);

    // Once per attachment, not once per holder: a second acquire joins the attachment that exists.
    await attachments.acquire(AGENT_TAB, "input");
    expect(attachedSeen).toHaveLength(1);
  });

  it("runs the before-release listener before the detach, on both release paths", async () => {
    const { attachments } = harness();
    const order: string[] = [];
    attachments.onBeforeRelease(async (tabId) => {
      // What the viewport module does here: one command over the attachment that is about to go.
      await attachments.send(tabId, "Emulation.clearDeviceMetricsOverride");
      order.push(`before-release:${tabId}`);
    });
    await attachments.acquire(AGENT_TAB, "viewport");
    await attachments.acquire(OTHER_TAB, "viewport");

    await attachments.release(AGENT_TAB);
    await attachments.releaseAll();

    expect(order).toEqual([`before-release:${AGENT_TAB}`, `before-release:${OTHER_TAB}`]);
    // R-166: a detach does not clear an emulation, so the clear has to be the last thing sent -
    // and it is sent while the tab is still attached, which is the only time `send` will carry it.
    expect(methodsOn(fake.fakeDebugger, AGENT_TAB).at(-1)).toBe("Emulation.clearDeviceMetricsOverride");
    expect(methodsOn(fake.fakeDebugger, OTHER_TAB).at(-1)).toBe("Emulation.clearDeviceMetricsOverride");
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB, OTHER_TAB]);
  });

  /**
   * 012/S2c F1 - the eviction hole the review found.
   *
   * MV3 evicts the worker while Chrome keeps both the emulation and the debugger. The map this
   * module is built on is exactly what the eviction takes away, so a release on a tab it no longer
   * lists used to return before the hook ran - and the owner got their tab back still laid out for
   * the agent. The hook is about the *tab*, not about this worker's bookkeeping.
   */
  it("runs the before-release listener for a tab this worker no longer lists, and clears it", async () => {
    const { attachments } = harness();
    const seen: number[] = [];
    attachments.onBeforeRelease(async (tabId) => {
      seen.push(tabId);
      // What the viewport module does on this path (`decideClear` -> attach-clear-detach): the
      // attachment is made for the clear and given straight back.
      const acquired = await attachments.acquire(tabId, "viewport");
      if (!acquired.ok) return;
      await attachments.send(tabId, "Emulation.clearDeviceMetricsOverride");
      await attachments.drop(tabId, "viewport");
    });

    // Never acquired in this worker's lifetime: the map is empty, as it is after an eviction.
    await attachments.release(AGENT_TAB);

    expect(seen).toEqual([AGENT_TAB]);
    expect(methodsOn(fake.fakeDebugger, AGENT_TAB)).toContain("Emulation.clearDeviceMetricsOverride");
    // The clear's own attachment is the only one there was, and it was given back by the hook.
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
  });

  it("detaches anyway when a hook fails, and never throws its failure at the caller", async () => {
    const reported: string[] = [];
    const attachments = createInputAttachments({ reportDiagnostic: (code) => reported.push(code) });
    attachments.onAttached(() => {
      throw new Error("the record could not be read");
    });
    attachments.onBeforeRelease(() => {
      throw new Error("the clear went nowhere");
    });

    expect(await attachments.acquire(AGENT_TAB, "viewport")).toEqual({ ok: true });
    await attachments.release(AGENT_TAB);

    // The tab is going back to the owner either way: a hook that threw must not keep a debugger
    // attached to it, and the failure is a diagnostic rather than an answer the agent reads.
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    expect(reported).toContain("agent.attachment.hook-failed");
  });

  it("sends its protocol commands over the shared attachment, and only while it holds one", async () => {
    const { attachments } = harness();
    await attachments.acquire(AGENT_TAB, "input");

    await attachments.send(AGENT_TAB, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 5 });

    expect(fake.fakeDebugger.commands).toEqual([
      // `Target.setAutoAttach` (004/T129) fires once, on the acquire above, ahead of anything sent.
      {
        tabId: AGENT_TAB,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      },
      // 008/T224: and the one that makes a dialog audible, on every attachment for the same reason.
      { tabId: AGENT_TAB, method: "Page.enable" },
      { tabId: AGENT_TAB, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 4, y: 5 } },
    ]);
    await expect(attachments.send(OTHER_TAB, "Input.dispatchMouseEvent", {})).rejects.toThrow(
      "input-not-attached",
    );
  });

  /**
   * C7 for the input half. The grant is not the question here - Chrome simply will not attach - and
   * the answer names which of the two causes it was, because they need different things from the
   * owner (close developer tools; go to a page an extension may touch).
   */
  it("answers every effect on the tab with input-unavailable when Chrome will not attach", async () => {
    const { attachments } = harness();
    fake.fakeDebugger.attachError = "Another debugger is already attached to the tab with id: 7";

    const first = await attachments.acquire(AGENT_TAB, "input");
    const second = await attachments.acquire(AGENT_TAB, "input");

    // Every effect, not only the first: there is no second route to try, so the answer is stable.
    expect(first).toEqual({ ok: false, unavailableReason: "devtools-open" });
    expect(second).toEqual(first);
    expect(attachments.state(AGENT_TAB)).toEqual({
      tabId: AGENT_TAB,
      attached: false,
      diagnosticsEnabled: false,
      unavailableReason: "devtools-open",
    });
    expect(inputUnavailable("call-9", "devtools-open")).toEqual({
      callId: "call-9",
      outcome: "failed",
      reason: "input-unavailable",
      refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
    });
    // Nothing was delivered by another route: no protocol traffic, and no page-level fallback -
    // which is also why a read, which never goes through this attachment, is untouched by it.
    expect(fake.fakeDebugger.commands).toEqual([]);
    expect(attachments.attached()).toEqual([]);

    // The refusal is about that tab, not about this session's ability to act at all.
    fake.fakeDebugger.attachError = undefined;
    expect(await attachments.acquire(OTHER_TAB, "input")).toEqual({ ok: true });
    // And once the tab is let go of, the next lease asks Chrome again rather than remembering a no.
    await attachments.release(AGENT_TAB);
    expect(await attachments.acquire(AGENT_TAB, "input")).toEqual({ ok: true });
  });

  it("names a page no extension may attach to as its own cause", async () => {
    const { attachments } = harness();
    fake.fakeDebugger.attachError = "Cannot access a chrome:// URL";

    expect(await attachments.acquire(AGENT_TAB, "input")).toEqual({
      ok: false,
      unavailableReason: "restricted-page",
    });
  });

  /**
   * 008/T224, D-008-5 — the *second* stated exception, pinned the way the first one is.
   *
   * `Page` is enabled on every attachment now, because a dialog cannot be heard otherwise and a
   * page nobody can read while one is open is the state this whole slice exists to end. The
   * exception holds on the same three counts as the geometry domain's, and the third - "only two
   * named events are consumed" - is the one a comment cannot promise. So it is a test: every other
   * event of the domain is emitted here, and the only consumer of them (the dialogs module, wired
   * exactly as `agent-runtime.ts` wires it) is asked afterwards whether it heard anything. The
   * diagnostics buffers are asked too, because they are the only place an event could be kept.
   *
   * What this cannot say is how many consumers the *composed* worker hangs on that fan-out, because
   * the wiring here is the test's own: `dialog-wiring.test.ts` counts them on a real runtime.
   */
  it("hears the two dialog events on the page domain and drops every other one (D-008-5)", async () => {
    const { attachments, diagnostics, siteModes } = harness();
    const dialogs = createAgentDialogs({
      send: (tabId, method, params) => attachments.send(tabId, method, params),
      siteModes: { async get() { return { mode: "ask" as const }; }, async set() {} },
      prompts: { async ask() { return { decision: "deny" as const }; } },
      async tabOwnership() {
        return { state: "this" };
      },
      async siteOfTab() {
        return SITE;
      },
      async holderOf() {
        return "session-i1";
      },
      onActivity() {},
      onNotice() {},
    });
    // The one line `agent-runtime.ts` has: the fan-out goes to the dialog module and nowhere else.
    attachments.onEvent((tabId, method, params) => dialogs.onDebuggerEvent(tabId, method, params));
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await attachments.acquire(AGENT_TAB, "input");
    await diagnostics.run(request("read_console"));

    // Everything else the domain says about the page, including the events that carry urls.
    fake.fakeDebugger.emit(AGENT_TAB, "Page.frameNavigated", {
      frame: { id: "F1", url: `${SITE}/secret?token=hunter2`, securityOrigin: SITE },
    });
    fake.fakeDebugger.emit(AGENT_TAB, "Page.loadEventFired", { timestamp: 12 });
    fake.fakeDebugger.emit(AGENT_TAB, "Page.lifecycleEvent", { name: "load", frameId: "F1" });
    fake.fakeDebugger.emit(AGENT_TAB, "Page.navigatedWithinDocument", { frameId: "F1", url: `${SITE}/secret` });

    // Nothing was kept anywhere: no dialog, and no buffer of a granted site holds a word of it.
    expect(dialogs.current(AGENT_TAB)).toBeUndefined();
    const console = await diagnostics.run(request("read_console"));
    const network = await diagnostics.run(request("read_network"));
    expect(JSON.stringify([console.result, network.result])).not.toContain("hunter2");
    expect((console.result as { messages: unknown[] }).messages).toEqual([]);
    expect(network.result).toEqual({ requests: [], truncated: false });

    // And the one event that is consumed reaches the dialog module, whole - which is the exception
    // being *used*, not merely enabled.
    fake.fakeDebugger.emit(AGENT_TAB, "Page.javascriptDialogOpening", {
      url: `${SITE}/dialogs`,
      message: "Delete 3 orders?",
      type: "confirm",
      hasBrowserHandler: false,
    });
    expect(dialogs.current(AGENT_TAB)).toMatchObject({ type: "confirm", message: "Delete 3 orders?" });
    // Still nothing in the buffers the grant filled: the dialog is not console traffic.
    expect(((await diagnostics.run(request("read_console"))).result as { messages: unknown[] }).messages).toEqual([]);
  });

  it("clears a detached out-of-process frame by its session, not the deprecated targetId (T154)", async () => {
    const { attachments } = harness();
    await attachments.acquire(AGENT_TAB, "input");

    fake.fakeDebugger.emit(AGENT_TAB, "Target.attachedToTarget", {
      sessionId: "oopif-session-1",
      targetInfo: { targetId: "target-1", type: "iframe", url: "https://cross-site.test/frame" },
    });
    expect(attachments.oopifSessions(AGENT_TAB)).toEqual([
      { targetId: "target-1", sessionId: "oopif-session-1", url: "https://cross-site.test/frame" },
    ]);

    // 004/T154 (S4 review): CDP's own docs mark `Target.detachedFromTarget`'s `targetId`
    // deprecated - a real detach can (and does) omit it, carrying only the `sessionId` the attach
    // already gave this worker every reason to key on instead. Keyed on the deprecated field, this
    // detach is invisible and the dead session accumulates for the life of the attachment.
    fake.fakeDebugger.emit(AGENT_TAB, "Target.detachedFromTarget", { sessionId: "oopif-session-1" });

    expect(attachments.oopifSessions(AGENT_TAB)).toEqual([]);
  });

  /**
   * 004/T161: the table used to be cleared *before* the round trip to Chrome that actually ends the
   * attachment, not after. An attach that lands in that window - a real gap, the same one every
   * other await here already leaves open - was recorded into a table this call had already decided
   * was empty, so the entry outlived the attachment it named a session on. Clearing it after the
   * round trip closes the window rather than merely narrowing it.
   */
  it("does not let an attach that lands mid-detach outlive the detach it raced (T161)", async () => {
    const { attachments } = harness();
    await attachments.acquire(AGENT_TAB, "input");

    let releaseGate!: () => void;
    fake.fakeDebugger.detachGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const releasing = attachments.release(AGENT_TAB);

    // The race: a new out-of-process frame announces itself while Chrome's own detach is still in
    // flight.
    fake.fakeDebugger.emit(AGENT_TAB, "Target.attachedToTarget", {
      sessionId: "oopif-session-2",
      targetInfo: { targetId: "target-2", type: "iframe", url: "https://cross-site.test/frame" },
    });

    releaseGate();
    await releasing;

    expect(attachments.oopifSessions(AGENT_TAB)).toEqual([]);
  });
});
