import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_TIMEOUT_HINT, type AgentNativeRequest, type AgentNativeResponse } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentDiagnostics } from "../src/service-worker/agent-tools/diagnostics.js";
import { createInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { diagnosticsGrantsFrom } from "../src/service-worker/agent-tools/page-action-grants.js";
import {
  createAgentPromptController,
  type AgentPromptController,
  type PromptRaised,
} from "../src/service-worker/agent-tools/prompts.js";
import { createSessionGrantStore } from "../src/service-worker/session-grant-store.js";
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

function installChrome(): {
  fakeDebugger: FakeDebugger;
  url: { value: string };
  /** A navigation the tab has started but not committed, as `chrome.tabs.Tab.pendingUrl` reports it. */
  pending: { value: string | undefined };
  tabs: FakeTabs;
} {
  const local: Record<string, unknown> = {};
  const listeners: Array<(source: { tabId?: number }, method: string, params?: unknown) => void> = [];
  const updateListeners: Array<
    (tabId: number, changeInfo: { status?: string; url?: string }, tab?: { url?: string }) => void
  > = [];
  const url = { value: `${SITE}/form` };
  const pending: { value: string | undefined } = { value: undefined };
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
        return {
          id: AGENT_TAB,
          url: url.value,
          ...(pending.value === undefined ? {} : { pendingUrl: pending.value }),
          groupId: 1,
          windowId: 900,
          active: false,
        };
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
  return { fakeDebugger, url, pending, tabs };
}

const AGENT = "agent-1";

/** `chrome.storage.session` as the session grant store reads it, one per harness. */
function sessionArea() {
  const area: Record<string, unknown> = {};
  return {
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in area) out[key] = area[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(area, values);
    },
  };
}

function harness(
  overrides: Partial<Parameters<typeof createAgentDiagnostics>[0]> = {},
  promptOptions: { timeoutMs?: number } = {},
) {
  const siteModes = createSiteModeStore();
  const raised: PromptRaised[] = [];
  const prompts = createAgentPromptController({
    timeoutMs: promptOptions.timeoutMs ?? 60,
    onRaised: (question) => raised.push(question),
  });
  const store = createSessionGrantStore({ session: sessionArea() });
  const runner = createAgentDiagnostics({
    context: testSessionContexts(),
    siteModes,
    prompts,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    // 031 R-456: the sessions' "This session" answers; both test sessions belong to one agent.
    diagnosticsGrants: diagnosticsGrantsFrom(store, (sessionId) =>
      sessionId === "session-h1" || sessionId === "session-h2" ? AGENT : undefined,
    ),
    ...overrides,
  });
  return { runner, siteModes, prompts, store, raised };
}

/**
 * 031 D-031-9: an ungranted diagnostics call asks, and the owner's refusal is the old answer. The
 * cases that only care that a call is no longer served say so through this.
 */
async function refusedAfterAsking(
  runner: ReturnType<typeof harness>["runner"],
  prompts: AgentPromptController,
  call: AgentNativeRequest,
): Promise<AgentNativeResponse> {
  const pending = runner.run(call);
  await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
  prompts.decide(prompts.current()?.promptId ?? "", false);
  return pending;
}

function request(
  tool: string,
  args: Record<string, unknown> = {},
  call: { callId?: string; sessionId?: string } = {},
): AgentNativeRequest {
  return {
    callId: call.callId ?? "call-1",
    sessionId: call.sessionId ?? "session-h1",
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

  /**
   * 031 T931 (D-031-9, FR-476) - the grant is asked for, not refused. The question names the site
   * and the tool, and the debugger stays off until the owner has answered it: a question asked
   * after attaching would be asking about something that has already happened.
   */
  it("asks the owner on a site the owner has not granted, and attaches nothing before an answer", async () => {
    const { runner, prompts } = harness();

    for (const tool of ["read_console", "read_network", "evaluate"]) {
      const pending = runner.run(request(tool, tool === "evaluate" ? { expression: "document.title" } : {}));
      await vi.waitFor(() => expect(prompts.current(), tool).toBeDefined());
      expect(prompts.current(), tool).toMatchObject({ kind: "diagnostics", site: SITE, tool });
      // Not merely refused after the fact: nothing is attached while the question stands, so Chrome
      // never tells the owner this extension is debugging their browser for a call not yet allowed.
      expect(fake.fakeDebugger.attached, tool).toEqual([]);
      expect(fake.fakeDebugger.commands, tool).toEqual([]);

      // A refusal is the answer it always was (US3 scenario 6).
      prompts.decide(prompts.current()?.promptId ?? "", false);
      await expect(pending, tool).resolves.toEqual({
        callId: "call-1",
        outcome: "denied",
        reason: "diagnostics-not-granted",
      });
    }
    expect(fake.fakeDebugger.attached).toEqual([]);
  });

  it("runs the one call for Allow once, records nothing, and asks again on the next call", async () => {
    const { runner, prompts, siteModes, store } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true);
    await expect(first).resolves.toEqual({ callId: "call-1", outcome: "ok", result: { messages: [], truncated: false } });
    // A once-yes stops applying when the call returns, and the debugger goes with it (R-466).
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);

    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
    expect(await store.list("session-h1", AGENT)).toEqual([]);

    // US3 scenario 2: the next diagnostics call on the site is asked about.
    const second = runner.run(request("read_console", {}, { callId: "call-2" }));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics", site: SITE }));
    prompts.decide(prompts.current()?.promptId ?? "", false);
    await expect(second).resolves.toEqual({ callId: "call-2", outcome: "denied", reason: "diagnostics-not-granted" });
  });

  it("lets go of a once-allowed evaluate's debugger when the script returns", async () => {
    const { runner, prompts, siteModes } = harness();
    await siteModes.set(SITE, { mode: "skip-checks" });

    const pending = runner.run(request("evaluate", { expression: "document.title" }));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "ok", result: { value: "Form page", truncated: false } });
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);
  });

  it("treats a yes whose grant could not be recorded as once, and lets go after the call", async () => {
    const { runner, prompts, siteModes } = harness({
      grantDiagnostics: async () => {
        throw new Error("storage refused");
      },
    });

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true, undefined, undefined, undefined, undefined, true);

    await expect(first).resolves.toMatchObject({ outcome: "ok" });
    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);
  });

  it("keeps an attachment input still holds after a once, with the diagnostics domains off", async () => {
    const attachments = createInputAttachments();
    const { runner, prompts } = harness({ attachments });
    await attachments.acquire(AGENT_TAB, "input");

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });

    // Input's lease is its own: only the diagnostics holder ends with the once.
    expect(fake.fakeDebugger.detached).toEqual([]);
    expect(attachments.holders(AGENT_TAB)).toEqual(["input"]);
    expect(attachments.state(AGENT_TAB)?.diagnosticsEnabled).toBe(false);
    expect(runner.attached()).toEqual([]);
  });

  it("carries nothing buffered under a once into a later granted call", async () => {
    const { runner, prompts, siteModes } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("after the once"));

    await siteModes.set(SITE, { diagnosticsGranted: true });
    const later = await runner.run(request("read_console", {}, { callId: "call-2" }));
    expect(later.result).toEqual({ messages: [], truncated: false });
  });

  it("leaves nothing attached when the call after a once is refused or goes unanswered", async () => {
    const { runner, prompts } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });

    const refused = await refusedAfterAsking(runner, prompts, request("read_console", {}, { callId: "call-2" }));
    expect(refused).toMatchObject({ outcome: "denied", reason: "diagnostics-not-granted" });
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);

    const unanswered = await runner.run(request("read_network", {}, { callId: "call-3" }));
    expect(unanswered).toMatchObject({ outcome: "timed-out", reason: "no-answer" });
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(runner.attached()).toEqual([]);
  });

  it("records a diagnostics grant for This session, runs later calls unasked, and leaves the checkbox off", async () => {
    const { runner, prompts, siteModes, store } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true, undefined, undefined, undefined, true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });
    // A recorded answer outlives the call, and so does the buffering it allowed.
    expect(runner.attached()).toEqual([AGENT_TAB]);

    expect(await store.list("session-h1", AGENT)).toEqual([
      expect.objectContaining({ site: SITE, kind: "diagnostics", source: "browser" }),
    ]);
    // US3 scenario 3: a session answer is not the site's grant.
    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
    // And it covers diagnostics only, never a page action (data-model "Session grant").
    expect(await store.covers("session-h1", AGENT, SITE, "page-actions")).toBe(false);

    const second = await runner.run(request("read_network", {}, { callId: "call-2" }));
    expect(second).toMatchObject({ callId: "call-2", outcome: "ok" });
    expect(prompts.current()).toBeUndefined();

    // Another session on the same site is asked as if nothing had been said.
    const other = runner.run(request("read_console", {}, { callId: "call-3", sessionId: "session-h2" }));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", false);
    await expect(other).resolves.toMatchObject({ outcome: "denied", reason: "diagnostics-not-granted" });
  });

  it("offers the agent's client once, session and deny, and records the client as the source", async () => {
    const { runner, prompts, raised, store, siteModes } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(raised).toHaveLength(1));
    // T935: the client is asked a diagnostics question, with the three short-lived answers.
    expect(raised[0]).toMatchObject({
      callId: "call-1",
      sessionId: "session-h1",
      kind: "diagnostics",
      site: SITE,
      choices: ["once", "session", "deny"],
      boundMs: 60,
    });
    expect(raised[0]?.action.length).toBeGreaterThan(0);

    expect(prompts.decideByCall("call-1", raised[0]?.promptId ?? "", "session", "client", "session-h1")).toBe(true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });
    expect(await store.list("session-h1", AGENT)).toEqual([
      expect.objectContaining({ site: SITE, kind: "diagnostics", source: "client" }),
    ]);
    // The client can never give the site's grant (D-031-9: always is Chrome's alone).
    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
  });

  it("sets the site's diagnostics grant for Always on this site, as the checkbox does", async () => {
    const { runner, prompts, siteModes, store } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true, undefined, undefined, undefined, undefined, true);
    await expect(first).resolves.toMatchObject({ outcome: "ok" });

    expect(runner.attached()).toEqual([AGENT_TAB]);
    // US3 scenario 4: the same stored grant the checkbox writes; the mode is untouched.
    expect(await siteModes.get(SITE)).toMatchObject({ diagnosticsGranted: true, mode: "ask" });
    expect(await store.list("session-h1", AGENT)).toEqual([]);

    const second = await runner.run(request("read_console", {}, { callId: "call-2", sessionId: "session-h2" }));
    expect(second).toMatchObject({ outcome: "ok" });
    expect(prompts.current()).toBeUndefined();
  });

  it("never reads a remembered mode from an answer to the diagnostics question", async () => {
    const { runner, prompts, siteModes } = harness();

    const first = runner.run(request("read_console"));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    prompts.decide(prompts.current()?.promptId ?? "", true, "skip-checks");
    await expect(first).resolves.toMatchObject({ outcome: "ok" });

    // The question was about debugging access, not about what the agent may do on the page.
    expect(await siteModes.get(SITE)).toMatchObject({ mode: "ask", diagnosticsGranted: false });
  });

  it("refuses without attaching when the tab moved to another site while the question stood", async () => {
    const { runner, prompts } = harness();

    for (const tool of ["read_console", "read_network", "evaluate"]) {
      fake.url.value = `${SITE}/form`;
      const pending = runner.run(request(tool, tool === "evaluate" ? { expression: "document.title" } : {}));
      await vi.waitFor(() => expect(prompts.current(), tool).toMatchObject({ kind: "diagnostics", site: SITE }));

      // The page navigates itself away while the owner reads the question about `SITE`.
      fake.url.value = `${OTHER_SITE}/landing`;
      prompts.decide(prompts.current()?.promptId ?? "", true);

      await expect(pending, tool).resolves.toMatchObject({ callId: "call-1", outcome: "stale", reason: "stale-context" });
      expect(fake.fakeDebugger.attached, tool).toEqual([]);
      expect(fake.fakeDebugger.commands, tool).toEqual([]);
      expect(runner.attached(), tool).toEqual([]);
    }
  });

  it("answers an unanswered question with the timeout and its hint, and attaches nothing", async () => {
    const { runner } = harness();

    const response = await runner.run(request("read_console"));

    expect(response).toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer", hint: CONSENT_TIMEOUT_HINT });
    expect(fake.fakeDebugger.attached).toEqual([]);
  });

  /**
   * FR-477: the diagnostics answer says the tool may run at all; the site's mode still decides
   * whether this script may, so a site in `ask` mode asks a second, separate question - and that
   * question's answer can never grant diagnostics.
   */
  it("still asks about the script itself after a diagnostics allow for evaluate", async () => {
    const { runner, prompts, siteModes } = harness({}, { timeoutMs: 5_000 });

    const pending = runner.run(request("evaluate", { expression: "document.title" }));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    const diagnosticsQuestion = prompts.current()?.promptId ?? "";
    prompts.decide(diagnosticsQuestion, true);

    await vi.waitFor(() => {
      const current = prompts.current();
      expect(current).toBeDefined();
      expect(current?.promptId).not.toBe(diagnosticsQuestion);
    });
    expect(prompts.current()?.kind).toBeUndefined();
    expect(prompts.current()).toMatchObject({ site: SITE, tool: "evaluate" });
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.evaluate")).toBe(false);

    // An "always" flag on the script's question is not the diagnostics question's answer.
    prompts.decide(prompts.current()?.promptId ?? "", false, undefined, undefined, undefined, undefined, true);
    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "owner-denied" });
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.evaluate")).toBe(false);
    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
  });

  it("ignores Always on this site given to the script's question, even with a yes", async () => {
    const { runner, prompts, siteModes } = harness({}, { timeoutMs: 5_000 });

    const pending = runner.run(request("evaluate", { expression: "document.title" }));
    await vi.waitFor(() => expect(prompts.current()).toMatchObject({ kind: "diagnostics" }));
    const diagnosticsQuestion = prompts.current()?.promptId ?? "";
    prompts.decide(diagnosticsQuestion, true);
    await vi.waitFor(() => {
      const current = prompts.current();
      expect(current).toMatchObject({ tool: "evaluate" });
      expect(current?.promptId).not.toBe(diagnosticsQuestion);
    });
    prompts.decide(prompts.current()?.promptId ?? "", true, undefined, undefined, undefined, undefined, true);

    await expect(pending).resolves.toMatchObject({ outcome: "ok" });
    expect((await siteModes.get(SITE)).diagnosticsGranted).toBe(false);
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

  /**
   * Security review 2026-11-05 S1 — the site is read once at the top of the call, and the call then
   * waits on the owner's card. A page that moves the tab to another site inside that wait would
   * otherwise have the script run there, under a grant and a mode the owner gave for the site the
   * card named. The same last-moment check every CDP gesture already makes (`stillOnOrigin`)
   * applies here: the tab's address is read again right before anything attaches or evaluates.
   */
  it("refuses to evaluate when the tab moved to another site while the owner's card stood", async () => {
    const { runner, siteModes, prompts } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });

    const pending = runner.run(request("evaluate", { expression: "document.title" }));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    expect(prompts.current()).toMatchObject({ site: SITE });

    // The page navigates itself away while the owner is reading the card about `SITE`.
    fake.url.value = `${OTHER_SITE}/landing`;
    prompts.decide(prompts.current()?.promptId ?? "", true);

    await expect(pending).resolves.toMatchObject({ callId: "call-1", outcome: "stale", reason: "stale-context" });
    // Nothing attached and nothing ran: the other site has neither a grant nor a mode decision.
    expect(fake.fakeDebugger.attached).toEqual([]);
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.evaluate")).toBe(false);
    expect(fake.fakeDebugger.commands.some((command) => command.method === "Runtime.enable")).toBe(false);
    expect(runner.attached()).toEqual([]);
  });

  it("refuses to evaluate when a navigation to another site is already pending, even under skip-checks", async () => {
    const { runner, siteModes } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true, mode: "skip-checks" });
    fake.pending.value = `${OTHER_SITE}/landing`;

    const response = await runner.run(request("evaluate", { expression: "document.title" }));

    expect(response).toMatchObject({ callId: "call-1", outcome: "stale", reason: "stale-context" });
    expect(fake.fakeDebugger.attached).toEqual([]);
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
    const { runner, siteModes, prompts } = harness({ attachments });
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

    const response = await refusedAfterAsking(runner, prompts, request("read_console"));
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
    const { runner, siteModes, prompts } = harness();
    await siteModes.set(SITE, { diagnosticsGranted: true });
    await runner.run(request("read_console"));
    fake.fakeDebugger.emit(AGENT_TAB, "Runtime.consoleAPICalled", logged("logged on the granted site"));

    fake.url.value = `${OTHER_SITE}/page`;
    await runner.refresh(AGENT_TAB);

    // What one site logged is not something the next site's owner granted anyone a look at.
    expect(fake.fakeDebugger.detached).toEqual([AGENT_TAB]);
    const response = await refusedAfterAsking(runner, prompts, request("read_console"));
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
    const { runner, siteModes, prompts } = harness();
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
    const response = await refusedAfterAsking(runner, prompts, request("read_console"));
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
