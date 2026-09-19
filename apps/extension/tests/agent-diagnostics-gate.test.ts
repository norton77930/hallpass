import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentDiagnostics } from "../src/service-worker/agent-tools/diagnostics.js";
import { createInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 003/T056 — diagnostics behind the owner's explicit grant (US6, FR-049, FR-050).
 *
 * The grant is the whole subject. Attaching a debugger to a page is wider than anything else this
 * feature does - it can read what the page logged and what it fetched - so nothing here happens
 * until the owner has said yes *for that site*, and the debugger goes away again the moment the yes
 * does. Three claims follow from that and are asserted below: nothing attaches without the grant,
 * the attachment is lazy and single, and revoking, closing the tab, ending the session or moving
 * the tab to a site with no grant all detach it.
 *
 * The second subject is what a diagnostics read may carry back. Console messages are levels, texts
 * and times; network records are methods, urls, statuses and kinds. No header, no cookie, no body -
 * the same rule the redacting proxy applies to the remote path, applied here at the source.
 *
 * The third is that a script is not exempt from the site mode: `evaluate` can do anything a click
 * can, so on a site the owner has not waved through it asks, exactly as an effect would (US6
 * scenario 3). The grant says the tool may run at all; the mode says whether *this* call may.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const OTHER_SITE = "https://elsewhere.test";

type FakeDebugger = {
  attached: number[];
  detached: number[];
  commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }>;
  emit(tabId: number, method: string, params: Record<string, unknown>): void;
  /** What `Runtime.evaluate` answers with; a test that cares sets it. */
  evaluateResult: Record<string, unknown>;
  /** What `chrome.debugger.getTargets` reports; a worker restart is the case that reads it (C1). */
  targets: Array<{ tabId?: number; type: string; attached: boolean }>;
};

/** Chrome's own `tabs.onUpdated`, which is how a navigation nobody asked for becomes observable (C1). */
type FakeTabs = {
  update(tabId: number, changeInfo: { status?: string; url?: string }): void;
};

function installChrome(): { fakeDebugger: FakeDebugger; url: { value: string }; tabs: FakeTabs } {
  const local: Record<string, unknown> = {};
  const listeners: Array<(source: { tabId?: number }, method: string, params?: unknown) => void> = [];
  const updateListeners: Array<
    (tabId: number, changeInfo: { status?: string; url?: string }, tab?: { url?: string }) => void
  > = [];
  const url = { value: `${SITE}/form` };
  const fakeDebugger: FakeDebugger = {
    attached: [],
    detached: [],
    commands: [],
    targets: [],
    evaluateResult: { result: { type: "string", value: "Form page" } },
    emit(tabId, method, params) {
      for (const listener of listeners) listener({ tabId }, method, params);
    },
  };
  const tabs: FakeTabs = {
    update(tabId, changeInfo) {
      for (const listener of updateListeners) listener(tabId, changeInfo, { url: url.value });
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
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: url.value, groupId: 1, windowId: 900, active: false };
      },
      onUpdated: {
        addListener(
          callback: (tabId: number, changeInfo: { status?: string; url?: string }, tab?: { url?: string }) => void,
        ) {
          updateListeners.push(callback);
        },
        removeListener(callback: (tabId: number, changeInfo: { status?: string; url?: string }) => void) {
          const index = updateListeners.indexOf(callback as (typeof updateListeners)[number]);
          if (index >= 0) updateListeners.splice(index, 1);
        },
      },
    },
    debugger: {
      async getTargets() {
        return fakeDebugger.targets;
      },
      async attach(target: { tabId: number }) {
        if (fakeDebugger.attached.includes(target.tabId)) throw new Error("Already attached");
        fakeDebugger.attached.push(target.tabId);
      },
      async detach(target: { tabId: number }) {
        if (!fakeDebugger.attached.includes(target.tabId)) throw new Error("Not attached");
        fakeDebugger.attached = fakeDebugger.attached.filter((tabId) => tabId !== target.tabId);
        fakeDebugger.detached.push(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>) {
        fakeDebugger.commands.push({ tabId: target.tabId, method, ...(params ? { params } : {}) });
        return method === "Runtime.evaluate" ? fakeDebugger.evaluateResult : {};
      },
      onEvent: {
        addListener(callback: (source: { tabId?: number }, method: string, params?: unknown) => void) {
          listeners.push(callback);
        },
      },
      onDetach: { addListener() {} },
    },
  };
  return { fakeDebugger, url, tabs };
}

function harness(overrides: Partial<Parameters<typeof createAgentDiagnostics>[0]> = {}) {
  const siteModes = createSiteModeStore();
  const prompts = createAgentPromptController({ timeoutMs: 60 });
  const runner = createAgentDiagnostics({
    context: testSessionContexts(),
    siteModes,
    prompts,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    ...overrides,
  });
  return { runner, siteModes, prompts };
}

function request(tool: string, args: Record<string, unknown> = {}): AgentNativeRequest {
  return {
    callId: "call-1",
    sessionId: "session-h1",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

/** A console message as `Runtime.consoleAPICalled` delivers one. */
function logged(text: string, type = "log"): Record<string, unknown> {
  return { type, timestamp: 1_700_000_000_000, args: [{ type: "string", value: text }] };
}

describe("T056 agent diagnostics gate", () => {
  let fake: ReturnType<typeof installChrome>;

  beforeEach(() => {
    fake = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("refuses all three tools on a site the owner has not granted, and attaches nothing", async () => {
    const { runner } = harness();

    for (const tool of ["read_console", "read_network", "evaluate"]) {
      const response = await runner.run(
        request(tool, tool === "evaluate" ? { expression: "document.title" } : {}),
      );
      expect(response, tool).toEqual({
        callId: "call-1",
        outcome: "denied",
        reason: "diagnostics-not-granted",
      });
    }
    // Not merely refused after the fact: the debugger was never attached, so Chrome never told the
    // owner this extension was debugging their browser for a call they had not allowed.
    expect(fake.fakeDebugger.attached).toEqual([]);
  });

  /**
   * C7 — Chrome can refuse the attachment itself: another client is already debugging the tab, or
   * the tab is one no extension may attach to. The grant was there, so this is not a refusal; it is
   * a failure, and it says which one so the owner is not told they never allowed it.
   */
  it("says so plainly when Chrome will not let it attach at all", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    const chromeApi = (globalThis as { chrome?: { debugger: { attach: unknown } } }).chrome;
    if (chromeApi) {
      chromeApi.debugger.attach = async (): Promise<void> => {
        throw new Error("Another debugger is already attached");
      };
    }

    const response = await runner.run(request("read_console"));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "debugger-not-attached" });
    expect(runner.attached()).toEqual([]);
  });

  it("refuses a tab the session does not own before it looks at any grant", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });

    const response = await runner.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "read_console",
      tabId: 99,
      args: { tabId: 99 },
    });

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    expect(fake.fakeDebugger.attached).toEqual([]);
  });

  it("attaches once, lazily, on the first granted call and enables the domains it reads", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });

    await runner.run(request("read_console"));
    await runner.run(request("read_console"));

    expect(fake.fakeDebugger.attached).toEqual([AGENT_TAB]);
    // `Target.setAutoAttach` (004/T129) fires once, on the attach that comes with the first call,
    // ahead of the domains the grant turns on.
    expect(fake.fakeDebugger.commands.map((command) => command.method)).toEqual([
      "Target.setAutoAttach",
      // 008/T224: and the page domain, on every attachment, for the two dialog events alone.
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
    ]);
  });

  it("returns what the page logged since it attached, filtered and bounded", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_console"));

    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("checkout ok"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("checkout failed", "error"));
    fake.fakeDebugger.emit(AGENT_TAB, "Log.entryAdded", {
      entry: { level: "error", text: "GET /api 500", timestamp: 1_700_000_000_001 },
    });

    const all = await runner.run(request("read_console"));
    expect((all.result as { messages: Array<{ text: string }> }).messages.map((message) => message.text)).toEqual([
      "checkout ok",
      "checkout failed",
      "GET /api 500",
    ]);

    const errors = await runner.run(request("read_console", { onlyErrors: true }));
    expect((errors.result as { messages: Array<{ level: string }> }).messages.every((m) => m.level === "error")).toBe(
      true,
    );

    const filtered = await runner.run(request("read_console", { pattern: "failed" }));
    expect((filtered.result as { messages: Array<{ text: string }> }).messages).toEqual([
      { level: "error", text: "checkout failed", ts: 1_700_000_000_000 },
    ]);

    const oneOnly = await runner.run(request("read_console", { limit: 1 }));
    expect(oneOnly.result).toMatchObject({ truncated: true });
  });

  /**
   * C5 — a request that never completes still leaves an entry waiting for its response. The map
   * that holds them is what a page with a long-lived connection or a thousand failed fetches would
   * grow without bound, so a request Chrome reports as failed lets go of its place, and a status
   * arriving afterwards is not attached to a record that was never finished.
   */
  it("forgets a request Chrome says failed, and does not complete it afterwards", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_network"));

    fake.fakeDebugger.emit(AGENT_TAB, "Network.requestWillBeSent", {
      requestId: "req-9",
      type: "Fetch",
      wallTime: 1_700_000,
      request: { method: "GET", url: `${SITE}/api/never` },
    });
    fake.fakeDebugger.emit(AGENT_TAB, "Network.loadingFailed", { requestId: "req-9", errorText: "net::ERR_FAILED" });
    // Chrome does not send this after a failure; a page that could would otherwise write into a
    // record this worker had already finished with.
    fake.fakeDebugger.emit(AGENT_TAB, "Network.responseReceived", {
      requestId: "req-9",
      response: { status: 200 },
    });

    const response = await runner.run(request("read_network"));
    expect((response.result as { requests: Array<Record<string, unknown>> }).requests).toEqual([
      { method: "GET", url: `${SITE}/api/never`, type: "fetch", ts: 1_700_000_000 },
    ]);
  });

  it("says a pattern the engine cannot compile is a bad argument, not an empty page", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });

    const response = await runner.run(request("read_console", { pattern: "([" }));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-pattern" });
  });

  it("records requests as method, url, status and kind - and nothing else at all", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_network"));

    fake.fakeDebugger.emit(AGENT_TAB, "Network.requestWillBeSent", {
      requestId: "req-1",
      type: "XHR",
      wallTime: 1_700_000,
      request: {
        method: "POST",
        url: `${SITE}/api/login`,
        // Everything a real frame carries and this product refuses to keep.
        headers: { Cookie: "session=secret", Authorization: "Bearer secret" },
        postData: "user=ada&password=s3cret",
      },
    });
    fake.fakeDebugger.emit(AGENT_TAB, "Network.responseReceived", {
      requestId: "req-1",
      type: "XHR",
      response: { status: 200, headers: { "set-cookie": "session=secret" } },
    });

    const response = await runner.run(request("read_network"));

    expect(response.result).toEqual({
      requests: [
        { method: "POST", url: `${SITE}/api/login`, status: 200, type: "xhr", ts: 1_700_000_000 },
      ],
      truncated: false,
    });
    expect(JSON.stringify(response)).not.toMatch(/secret|s3cret|Cookie|Authorization/i);
  });

  it("asks the owner before evaluating a script on a site they have not waved through", async () => {
    const { runner, siteModes, prompts } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });

    const pending = runner.run(request("evaluate", { expression: "document.title" }));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    // The grant let the tool run at all; the mode still decides this call, because what a script
    // does to a page is exactly what an effect does (US6 scenario 3).
    expect(prompts.current()).toMatchObject({ site: SITE, tool: "evaluate" });
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.evaluate")).toBe(false);

    prompts.decide(prompts.current()?.promptId ?? "", false);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.evaluate")).toBe(false);
  });

  it("evaluates without asking on a site the owner set to skip-checks", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true, mode: "skip-checks" });

    const response = await runner.run(request("evaluate", { expression: "document.title" }));

    expect(response).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { value: "Form page", truncated: false },
    });
    const evaluated = fake.fakeDebugger.commands.find((command) => command.method === "Runtime.evaluate");
    // By value and awaiting the promise: an answer that was a remote object handle would be a
    // reference into a page this side cannot read, and one that did not await would report the
    // pending promise itself as the result.
    expect(evaluated?.params).toMatchObject({
      expression: "document.title",
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it("detaches when the owner revokes the grant, and forgets what it had buffered", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true, mode: "skip-checks" });
    await runner.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("before the revoke"));

    await siteModes.set(SITE, { diagnosticsGranted: false });
    await runner.revoke(SITE);

    // Chrome's own "is debugging this browser" bar names this extension while it is attached, so
    // the grant going away has to take the attachment with it (US6 scenario 5).
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    expect(runner.attached()).toEqual([]);

    await siteModes.set(SITE, { diagnosticsGranted: true });
    const after = await runner.run(request("read_console"));
    // A second grant is a fresh start, not a window onto what was collected under the first.
    expect(after.result).toEqual({ messages: [], truncated: false });
  });

  /**
   * 004/T161 (coverage repair, Phase 9 second review): revoking a grant while input's own,
   * still-valid consent holds the same tab does not detach at all - it goes through
   * `domains(tabId, "disable")` instead (004/B102, the packaged journey this mirrors). The
   * tool-boundary refusal asserted below is the stronger of the two claims the reviewer named, but
   * `domains(tabId, "disable")` swallows a failed `*.disable` per domain, so that refusal alone is
   * not proof the domains are actually off - only that this worker stopped serving them. Asserting
   * `state(tabId).diagnosticsEnabled === false` alongside it is the other half.
   */
  it("disables the domains rather than detaching when input still holds the tab, and says so in its own state", async () => {
    const attachments = createInputAttachments();
    const { runner, siteModes } = harness({ attachments });
    await siteModes.set(SITE, { diagnosticsGranted: true, mode: "skip-checks" });
    await attachments.acquire(AGENT_TAB, "input");
    await runner.run(request("read_console"));

    await siteModes.set(SITE, { diagnosticsGranted: false });
    await runner.revoke(SITE);

    // Input's own consent still holds the tab, so the attachment survives the revoke - only the
    // domains that made it a window on the page go with the grant.
    expect(fake.fakeDebugger.detached).toEqual([]);
    expect(attachments.attached()).toEqual([AGENT_TAB]);
    expect(attachments.state(AGENT_TAB)?.diagnosticsEnabled).toBe(false);

    const response = await runner.run(request("read_console"));
    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "diagnostics-not-granted" });
  });

  it("detaches when the tab goes away and when the session ends", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_console"));

    await runner.release(AGENT_TAB);
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);

    await runner.run(request("read_console"));
    expect(fake.fakeDebugger.attached).toEqual([AGENT_TAB]);

    await runner.releaseAll();
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);
  });

  it("clears the buffers when the tab leaves the site, and detaches when the new one has no grant", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("logged on the granted site"));

    fake.url.value = `${OTHER_SITE}/page`;
    await runner.refresh(AGENT_TAB);

    // What one site logged is not something the next site's owner granted anyone a look at.
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    const response = await runner.run(request("read_console"));
    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "diagnostics-not-granted" });
  });

  /**
   * C3 — the pattern comes from the agent and the text comes from the page, which is the pairing
   * that makes catastrophic backtracking reachable from outside. Two bounds answer it: the shape
   * that causes it is refused as a bad argument, and any pattern at all only ever sees a bounded
   * prefix of a line, so no single message can be made expensive to match.
   */
  it("refuses a pattern that could backtrack catastrophically, and matches only a bounded prefix", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged(`${"a".repeat(4_000)}!`));

    const started = Date.now();
    const response = await runner.run(request("read_console", { pattern: "(a+)+$" }));
    const elapsedMs = Date.now() - started;

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-pattern" });
    expect(elapsedMs, `matching took ${elapsedMs}ms`).toBeLessThan(50);

    // A pattern the engine can run still only sees the front of a line, so a 4000-character
    // message cannot be turned into 4000 characters of matching work either.
    const bounded = await runner.run(request("read_console", { pattern: "^a{600}" }));
    expect(bounded.outcome).toBe("ok");
    expect((bounded.result as { messages: unknown[] }).messages).toEqual([]);
  });

  /**
   * C1 — the tab can leave the granted site without this feature being asked to move it: a link the
   * agent clicked, a redirect, a form submit, or the owner typing a url into the tab themselves.
   * Only the `navigate` tool used to announce it, so every other way out left the debugger attached
   * to a page the grant never covered - and Chrome's bar still naming this extension for it.
   */
  it("detaches on a navigation nobody asked it about, and forgets the granted site's buffers", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.start();
    await runner.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("logged on the granted site"));
    expect(runner.attached()).toEqual([AGENT_TAB]);

    // Chrome's own event, for a navigation this worker did not start.
    fake.url.value = `${OTHER_SITE}/landing`;
    fake.tabs.update(AGENT_TAB, { status: "loading", url: `${OTHER_SITE}/landing` });
    await new Promise((tick) => setTimeout(tick, 5));

    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    expect(runner.attached()).toEqual([]);
    const response = await runner.run(request("read_console"));
    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "diagnostics-not-granted" });
  });

  /**
   * C1 — the worker is not a long-lived process. It can be evicted while a debugger it attached is
   * still up, and the restarted worker knows nothing about it: the owner would be left with the
   * debugging bar and no way to make it go away short of closing the tab.
   */
  it("lets go, at start, of an attachment the restarted worker no longer knows about", async () => {
    const { runner } = harness();
    fake.fakeDebugger.attached.push(41);
    fake.fakeDebugger.targets = [
      { tabId: 41, type: "page", attached: true },
      // Not attached at all, and not a page: neither is this worker's business.
      { tabId: 42, type: "page", attached: false },
      { type: "service_worker", attached: true },
    ];

    await runner.start();

    expect(fake.fakeDebugger.detached).toEqual([41]);
    expect(runner.attached()).toEqual([]);
  });
});
