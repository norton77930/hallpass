import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDownloadRecord, AgentNativeRequest, AgentNativeResponse, CurrentDialog } from "@hallpass/contracts";
import { agentEffectObservationSchema } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentEffects, createTargetLocator, type TargetRect } from "../src/service-worker/agent-tools/effects.js";
import type { FrameOffsets } from "../src/service-worker/agent-tools/frames.js";
import { createAgentPageBindings, INPUT_NOT_ANSWERED_HINT } from "../src/service-worker/agent-tools/page-binding.js";
import { CONTENT_OPERATION_DEADLINE_MS } from "../src/service-worker/content-broker.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 015/T404 — what a press reports it caused (FR-200 – FR-202, contracts/press-outcomes.md, R-198).
 *
 * A press answered "ok, verified" whether it navigated the tab, opened another, started a download
 * or did nothing at all, so an agent that clicked a link and saw the same page could not tell a
 * link that opened a tab from one the page swallowed. The observation now says which of the three
 * happened inside the existing settle wait - collected by listeners armed before the press and
 * removed when the wait ends, so a press that caused nothing answers no later than it did before.
 *
 * Everything the browser would say is faked here: `tabs.onCreated` (with the opener the browser
 * would set), the tab's URL at the end of the wait, and the session's download observer.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/press-outcomes`;
const SETTLE_MS = 400;
const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const LINK_HINT =
  "The link was pressed, but nothing navigated, opened or downloaded within 400 ms. The page may handle it itself — read the page or wait before assuming it did nothing.";

type CreatedTab = { id?: number; openerTabId?: number; url?: string; pendingUrl?: string };

/** The browser as far as a press can see it, with the hooks a test uses to make things happen. */
function fakeBrowser() {
  const listeners = new Set<(tab: CreatedTab) => void>();
  const urls = new Map<number, string>([[AGENT_TAB, PAGE_URL]]);
  const hooks: {
    onRelease?: () => void;
    onProbe?: () => void;
    /** A protocol command the page holds (015/T402): its answer is this promise instead of `{}`. */
    hold?: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> | undefined;
  } = {};
  const sent: string[] = [];
  const downloads: AgentDownloadRecord[] = [];
  const createdSince = vi.fn(async (_sessionId: string, sinceMs: number) =>
    downloads.filter((record) => Date.parse(record.startedAt) >= sinceMs),
  );
  const attachments = {
    async acquire() {
      return { ok: true as const };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(_tabId: number, method: string, params?: Record<string, unknown>) {
      sent.push(method);
      const held = hooks.hold?.(method, params);
      if (held) return held;
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") hooks.onRelease?.();
      return {};
    },
    attached: () => [],
    oopifSessions: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
  } as unknown as AgentInputAttachments;
  return {
    attachments,
    hooks,
    sent,
    downloads,
    createdSince,
    urls,
    listeners,
    emit(tab: CreatedTab) {
      for (const listener of [...listeners]) listener(tab);
    },
    watchTabCreated(listener: (tab: CreatedTab) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function installChrome(): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
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
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        if ((message as { type: string }).type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error("unexpected frame");
      },
    },
  };
}

async function harness(
  options: {
    role?: string;
    /** What the post-press probe finds: the same document, or a new one. */
    after?: "same" | "replaced";
    /** The worker's own dialog map, as the runtime would expose it (016/T447). */
    currentDialog?: (tabId: number) => CurrentDialog | undefined;
  } = {},
) {
  const browser = fakeBrowser();
  const siteModes = createSiteModeStore();
  await siteModes.set(SITE, { mode: "skip-checks" });
  // The locator reports `link` exactly when the claiming frame gave the element the role `link`.
  const rect: TargetRect = { x: 100, y: 40, width: 80, height: 20, ...(options.role === "link" ? { link: true } : {}) };
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    attachments: browser.attachments,
    locate: async () => rect,
    confirm: async () => ({ outcome: "hit" }),
    probe: async () => {
      browser.hooks.onProbe?.();
      return options.after === "replaced"
        ? { ok: true, documentEpoch: "doc-2", canonicalOrigin: SITE }
        : { ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE };
    },
    settleMs: SETTLE_MS,
    watchTabCreated: browser.watchTabCreated,
    tabUrl: async (tabId) => browser.urls.get(tabId),
    downloads: { createdSince: browser.createdSince },
    ...(options.currentDialog === undefined ? {} : { currentDialog: options.currentDialog }),
  });
  return { runner, browser };
}

function request(tool: string, args: Record<string, unknown> = { target: { ref: "t_press" } }): AgentNativeRequest {
  return {
    callId: `call-${tool}`,
    sessionId: "session-p1",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

/** Runs one call through exactly the settle wait, and says whether it had answered by then. */
async function pressed(
  runner: { run(request: AgentNativeRequest): Promise<AgentNativeResponse> },
  call: AgentNativeRequest,
): Promise<{ response: AgentNativeResponse | undefined; answeredWithinSettle: boolean }> {
  let response: AgentNativeResponse | undefined;
  const pending = runner.run(call).then((answer) => {
    response = answer;
    return answer;
  });
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  const answeredWithinSettle = response !== undefined;
  return { response: await pending, answeredWithinSettle };
}

function observed(response: AgentNativeResponse | undefined): Record<string, unknown> {
  return ((response as { result?: { observed?: Record<string, unknown> } }).result?.observed ?? {}) as Record<
    string,
    unknown
  >;
}

function download(id: number, startedAt: number): AgentDownloadRecord {
  return {
    id,
    filename: `C:\\Users\\owner\\Downloads\\report-${id}.csv`,
    url: `${SITE}/press-outcomes/report.csv`,
    state: "in_progress",
    startedAt: new Date(startedAt).toISOString(),
    bytesReceived: 0,
    totalBytes: -1,
    danger: false,
    attribution: "session",
  };
}

describe("T404 press outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    installChrome();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("a press that caused nothing states the window, adds no wait, and carries no url", async () => {
    const { runner } = await harness({ role: "button" });

    const { response, answeredWithinSettle } = await pressed(runner, request("click"));

    expect(answeredWithinSettle).toBe(true);
    expect(response?.outcome).toBe("ok");
    expect(observed(response)).toMatchObject({ documentChanged: false, verified: true, observedForMs: SETTLE_MS });
    expect(observed(response)).not.toHaveProperty("url");
    expect(observed(response)).not.toHaveProperty("newTabs");
    expect(observed(response)).not.toHaveProperty("downloads");
    // A button that did nothing visible did what buttons often do: nothing to explain.
    expect(response).not.toHaveProperty("hint");
    expect(agentEffectObservationSchema.safeParse(observed(response)).success).toBe(true);
  });

  it("a link that caused nothing says so, in the contract's words", async () => {
    const { runner } = await harness({ role: "link" });

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).toMatchObject({ observedForMs: SETTLE_MS });
    expect(response?.hint).toBe(LINK_HINT);
  });

  it("a press that replaced the document carries where the tab is now, and no window", async () => {
    const { runner, browser } = await harness({ role: "link", after: "replaced" });
    browser.hooks.onRelease = () => browser.urls.set(AGENT_TAB, `${SITE}/ordinary?from=press-outcomes`);

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).toMatchObject({
      documentChanged: true,
      verified: false,
      verdict: "document-changed",
      url: `${SITE}/ordinary?from=press-outcomes`,
    });
    expect(observed(response)).not.toHaveProperty("observedForMs");
    expect(response).not.toHaveProperty("hint");
  });

  it("a replaced document whose url cannot be read omits the url rather than guessing", async () => {
    const { runner, browser } = await harness({ after: "replaced" });
    browser.urls.delete(AGENT_TAB);

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).toMatchObject({ documentChanged: true });
    expect(observed(response)).not.toHaveProperty("url");
  });

  it("a tab the press opened is reported, not held, with the tabs_claim hint", async () => {
    const { runner, browser } = await harness({ role: "link" });
    browser.hooks.onRelease = () =>
      browser.emit({ id: 12, openerTabId: AGENT_TAB, url: "", pendingUrl: `${SITE}/ordinary?from=new-tab` });

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).toMatchObject({
      documentChanged: false,
      newTabs: [{ tabId: 12, url: `${SITE}/ordinary?from=new-tab`, held: false }],
    });
    expect(observed(response)).not.toHaveProperty("observedForMs");
    expect(response?.hint).toBe(
      `The press opened tab 12 (${SITE}/ordinary?from=new-tab). It is not held by this session; use tabs_claim to act on it.`,
    );
    expect(agentEffectObservationSchema.safeParse(observed(response)).success).toBe(true);
  });

  it("a tab opened by another tab, or before the press, or after the wait is not this press's", async () => {
    const { runner, browser } = await harness({ role: "button" });
    browser.emit({ id: 20, openerTabId: AGENT_TAB, url: `${SITE}/before` });
    browser.hooks.onRelease = () => browser.emit({ id: 21, openerTabId: 99, url: `${SITE}/other-opener` });
    // The probe runs after the settle wait; the window has closed by then.
    browser.hooks.onProbe = () => browser.emit({ id: 22, openerTabId: AGENT_TAB, url: `${SITE}/late` });

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).not.toHaveProperty("newTabs");
    expect(observed(response)).toMatchObject({ observedForMs: SETTLE_MS });
    // Nothing is left listening once the call has answered.
    expect(browser.listeners.size).toBe(0);
  });

  it("a download the press started is reported in downloads_context's identity", async () => {
    const { runner, browser } = await harness({ role: "link" });
    browser.downloads.push(download(40, T0 - 5_000));
    browser.hooks.onRelease = () => browser.downloads.push(download(41, Date.now()));

    const { response } = await pressed(runner, request("click"));

    expect(browser.createdSince).toHaveBeenCalledWith("session-p1", T0);
    expect(observed(response)).toMatchObject({
      downloads: [
        { id: 41, filename: "C:\\Users\\owner\\Downloads\\report-41.csv", url: `${SITE}/press-outcomes/report.csv`, state: "in_progress" },
      ],
    });
    expect(observed(response)).not.toHaveProperty("observedForMs");
    expect(response).not.toHaveProperty("hint");
    expect(agentEffectObservationSchema.safeParse(observed(response)).success).toBe(true);
  });

  it("a press that caused several things reports all of them", async () => {
    const { runner, browser } = await harness({ role: "button", after: "replaced" });
    browser.hooks.onRelease = () => {
      browser.urls.set(AGENT_TAB, `${SITE}/ordinary`);
      browser.emit({ id: 12, openerTabId: AGENT_TAB, pendingUrl: `${SITE}/ordinary?from=window-open` });
      browser.downloads.push(download(41, Date.now()));
    };

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).toMatchObject({
      documentChanged: true,
      url: `${SITE}/ordinary`,
      newTabs: [{ tabId: 12, url: `${SITE}/ordinary?from=window-open`, held: false }],
      downloads: [{ id: 41 }],
    });
    expect(observed(response)).not.toHaveProperty("observedForMs");
    expect(response?.hint).toContain("tabs_claim");
  });

  it("every press of the click family reports, and so does computer's", async () => {
    for (const tool of ["double_click", "triple_click", "right_click"]) {
      const { runner } = await harness({ role: "button" });
      const { response } = await pressed(runner, request(tool));
      expect(observed(response), tool).toMatchObject({ observedForMs: SETTLE_MS });
    }
    const { runner, browser } = await harness();
    browser.hooks.onRelease = () => browser.emit({ id: 12, openerTabId: AGENT_TAB, url: `${SITE}/opened` });
    const { response } = await pressed(runner, request("computer", { action: "left_click", x: 400, y: 300 }));
    expect(observed(response)).toMatchObject({ newTabs: [{ tabId: 12, url: `${SITE}/opened`, held: false }] });
  });

  it("a runner that cannot see downloads never calls a press silent", async () => {
    const { browser } = await harness();
    const siteModes = createSiteModeStore();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const runner = createAgentEffects({
      context: testSessionContexts(),
      siteModes,
      bindings: createAgentPageBindings(),
      prompts: createAgentPromptController({ timeoutMs: 60 }),
      tabOwnership: async () => ({ state: "this" }),
      attachments: browser.attachments,
      locate: async () => ({ x: 100, y: 40, width: 80, height: 20, link: true }),
      confirm: async () => ({ outcome: "hit" }),
      probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
      settleMs: SETTLE_MS,
      watchTabCreated: browser.watchTabCreated,
      tabUrl: async (tabId) => browser.urls.get(tabId),
    });

    const { response } = await pressed(runner, request("click"));

    expect(observed(response)).not.toHaveProperty("observedForMs");
    expect(response).not.toHaveProperty("hint");
  });

  it("the locator calls a target a link exactly when its frame gave it the role link", async () => {
    const located = async (role: string) => {
      const locate = createTargetLocator({
        offsets: {} as FrameOffsets,
        enumerateFrames: async () => [{ frameId: 0, parentFrameId: -1, url: PAGE_URL }],
        collect: (async () => ({
          tabId: AGENT_TAB,
          contextHandle: "snap-1",
          documentEpoch: "doc-1",
          canonicalOrigin: SITE,
          formValueItems: [],
          semanticNodes: [{ role, targetHandle: "t_press", rect: { x: 1, y: 2, width: 3, height: 4 } }],
        })) as never,
      }).forDelivery();
      return locate({
        context: testSessionContexts().forCall("session-p1", "call-locate"),
        binding: { tabId: AGENT_TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
        ref: "t_press",
        scroll: true,
      });
    };

    expect(await located("link")).toEqual({ x: 1, y: 2, width: 3, height: 4, link: true });
    expect(await located("button")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("an effect that is not a press reports none of it", async () => {
    const { runner, browser } = await harness({ role: "link" });
    browser.hooks.onRelease = () => browser.emit({ id: 12, openerTabId: AGENT_TAB, url: `${SITE}/opened` });

    const { response } = await pressed(runner, request("hover"));

    expect(response?.outcome).toBe("ok");
    for (const field of ["url", "newTabs", "downloads", "observedForMs"]) {
      expect(observed(response)).not.toHaveProperty(field);
    }
    expect(response).not.toHaveProperty("hint");
    expect(browser.listeners.size).toBe(0);
  });
});

/**
 * 015/T402 — a press the page never answers (FR-206, R-197 rounds 3-5).
 *
 * `Input.dispatchMouseEvent` returns only once the renderer has handled the event, so a page whose
 * handler blocks its main thread - or Chromium's own block on a `window.open` after a cross-origin
 * round trip - left the call waiting until the host gave up with `timed-out / no-answer`. The
 * dispatch is bounded at the content deadline and answers what a binding that hit it answers.
 */
describe("T402 an input dispatch the page does not answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    installChrome();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function deferred() {
    let resolve!: (value: Record<string, unknown>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Record<string, unknown>>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  /** Runs one call and says whether it had answered just before, and just after, the deadline. */
  async function acrossDeadline(
    runner: { run(request: AgentNativeRequest): Promise<AgentNativeResponse> },
    call: AgentNativeRequest,
  ): Promise<{ beforeDeadline: AgentNativeResponse | undefined; response: AgentNativeResponse | undefined }> {
    let response: AgentNativeResponse | undefined;
    void runner.run(call).then((answer) => {
      response = answer;
    });
    await vi.advanceTimersByTimeAsync(CONTENT_OPERATION_DEADLINE_MS - 500);
    const beforeDeadline = response;
    await vi.advanceTimersByTimeAsync(1_500);
    return { beforeDeadline, response };
  }

  // Review F1: a dispatch that timed out was delivered - the agent must not be told to simply retry.
  const NOT_RESPONDING = { outcome: "failed", reason: "page-not-responding", hint: INPUT_NOT_ANSWERED_HINT };

  it("a click by ref whose release never returns answers page-not-responding at the deadline", async () => {
    const { runner, browser } = await harness({ role: "button" });
    browser.hooks.hold = (method, params) =>
      method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" ? new Promise(() => {}) : undefined;

    const { beforeDeadline, response } = await acrossDeadline(runner, request("click"));

    expect(beforeDeadline).toBeUndefined();
    expect(response).toEqual({ callId: "call-click", ...NOT_RESPONDING });
    // The press window was armed before the input left and is gone with the answer.
    expect(browser.listeners.size).toBe(0);
  });

  it("computer left_click answers the same", async () => {
    const { runner, browser } = await harness();
    browser.hooks.hold = (method) => (method === "Input.dispatchMouseEvent" ? new Promise(() => {}) : undefined);

    const { response } = await acrossDeadline(runner, request("computer", { action: "left_click", x: 400, y: 300 }));

    expect(response).toEqual({ callId: "call-computer", ...NOT_RESPONDING });
  });

  it("type answers the same when the keys are not taken", async () => {
    const { runner, browser } = await harness();
    browser.hooks.hold = (method) =>
      method === "Input.insertText" || method === "Input.dispatchKeyEvent" ? new Promise(() => {}) : undefined;

    const { response } = await acrossDeadline(runner, request("type", { text: "a", mode: "insert" }));

    expect(response).toEqual({ callId: "call-type", ...NOT_RESPONDING });
  });

  it("a late answer after the call was answered changes nothing, resolved or rejected", async () => {
    for (const late of ["resolve", "reject"] as const) {
      const { runner, browser } = await harness({ role: "button" });
      const release = deferred();
      browser.hooks.hold = (method, params) =>
        method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" ? release.promise : undefined;

      const { response } = await acrossDeadline(runner, request("click"));
      expect(response).toEqual({ callId: "call-click", ...NOT_RESPONDING });
      const sentBefore = browser.sent.length;

      if (late === "resolve") release.resolve({});
      else release.reject(new Error("Target closed."));
      await vi.advanceTimersByTimeAsync(CONTENT_OPERATION_DEADLINE_MS);

      // Nothing further went to the page, and nothing surfaced (an unhandled rejection fails the run).
      expect(browser.sent.length).toBe(sentBefore);
      expect(response).toEqual({ callId: "call-click", ...NOT_RESPONDING });
    }
  });

  /**
   * 016/T449 — a press held past the bound sends no release (FR-243, R-209, 015 review F3).
   *
   * The button-down may still land after the call has answered; a button-up sent then would be a
   * second input the agent was never told about. `click()` awaits the press before the release, so
   * the deadline's rejection ends the sequence - pinned here so it stays deliberate.
   */
  it("a press whose mousePressed outlives the deadline never sends mouseReleased, even after the late answer", async () => {
    const { runner, browser } = await harness({ role: "button" });
    const press = deferred();
    const mouseTypes: unknown[] = [];
    browser.hooks.hold = (method, params) => {
      if (method !== "Input.dispatchMouseEvent") return undefined;
      mouseTypes.push(params?.type);
      return params?.type === "mousePressed" ? press.promise : undefined;
    };

    const { response } = await acrossDeadline(runner, request("click"));
    expect(response).toEqual({ callId: "call-click", ...NOT_RESPONDING });

    press.resolve({});
    await vi.advanceTimersByTimeAsync(CONTENT_OPERATION_DEADLINE_MS);

    expect(mouseTypes).toContain("mousePressed");
    expect(mouseTypes).not.toContain("mouseReleased");
  });

  it("a dispatch that answers inside the deadline is delivered as before", async () => {
    const { runner, browser } = await harness({ role: "button" });
    browser.hooks.hold = (method, params) =>
      method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased"
        ? new Promise((resolve) => setTimeout(() => resolve({}), CONTENT_OPERATION_DEADLINE_MS - 1_000))
        : undefined;

    let response: AgentNativeResponse | undefined;
    void runner.run(request("click")).then((answer) => {
      response = answer;
    });
    await vi.advanceTimersByTimeAsync(CONTENT_OPERATION_DEADLINE_MS + SETTLE_MS + 1_000);

    expect(response?.outcome).toBe("ok");
    expect(observed(response)).toMatchObject({ verified: true });
  });
});

/**
 * 016/T447 — a keystroke that opens a dialog (FR-242, R-208, 015 review F2).
 *
 * `Input.dispatchKeyEvent` / `Input.insertText` wait for the renderer the way a mouse event does, so
 * a key handler that calls `alert` holds the dispatch for as long as the box is up. The click path
 * already races its dispatch against the worker's dialog map and answers with the dialog; a key,
 * typed text and the focusing click of a keyboard call must answer the same way, not with
 * page-not-responding at the deadline.
 */
describe("T447 a keyboard dispatch that opens a dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    installChrome();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const DIALOG: CurrentDialog = {
    id: "d1",
    type: "alert",
    message: "Saved!",
    openedAt: T0,
    tabId: AGENT_TAB,
  };

  /** A page whose `matches` input never returns, and whose dialog map reports the alert from then on. */
  async function dialogOn(matches: (method: string, params?: Record<string, unknown>) => boolean) {
    let open = false;
    const built = await harness({
      role: "textbox",
      currentDialog: (tabId) => (open && tabId === AGENT_TAB ? DIALOG : undefined),
    });
    built.browser.hooks.hold = (method, params) => {
      if (!matches(method, params)) return undefined;
      open = true;
      return new Promise(() => {});
    };
    return built;
  }

  /** Runs one call for a second - far inside the deadline - and past the deadline afterwards. */
  async function answeredWithin(
    runner: { run(request: AgentNativeRequest): Promise<AgentNativeResponse> },
    call: AgentNativeRequest,
  ): Promise<AgentNativeResponse | undefined> {
    let response: AgentNativeResponse | undefined;
    void runner.run(call).then((answer) => {
      response = answer;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const early = response;
    // The held dispatch's own deadline passes afterwards and must surface nothing.
    await vi.advanceTimersByTimeAsync(CONTENT_OPERATION_DEADLINE_MS);
    expect(response).toEqual(early);
    return early;
  }

  const isKey = (method: string) => method === "Input.dispatchKeyEvent" || method === "Input.insertText";

  it("a key whose dispatch never returns answers with the dialog it opened", async () => {
    const { runner } = await dialogOn(isKey);

    const response = await answeredWithin(runner, request("key", { key: "Enter" }));

    expect(response?.outcome).toBe("ok");
    expect(response?.result).toMatchObject({ dialog: DIALOG });
    expect(observed(response)).toMatchObject({ effect: "key-pressed", verified: false, verdict: "target-unconfirmed" });
  });

  it("typed text whose dispatch never returns answers with the dialog it opened", async () => {
    const { runner } = await dialogOn(isKey);

    const response = await answeredWithin(runner, request("type", { text: "a", mode: "insert" }));

    expect(response?.outcome).toBe("ok");
    expect(response?.result).toMatchObject({ dialog: DIALOG });
    expect(observed(response)).toMatchObject({ effect: "text-entered", verified: false, verdict: "target-unconfirmed" });
  });

  it("the focusing click of a keyboard call is raced the same way, and no key follows it", async () => {
    const { runner, browser } = await dialogOn(
      (method, params) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased",
    );

    const response = await answeredWithin(
      runner,
      request("type", { target: { ref: "t_press" }, text: "a", mode: "insert" }),
    );

    expect(response?.outcome).toBe("ok");
    expect(response?.result).toMatchObject({ dialog: DIALOG });
    expect(observed(response)).toMatchObject({ effect: "text-entered", charactersChanged: 0, verified: false });
    expect(browser.sent.filter(isKey)).toEqual([]);
  });
});
