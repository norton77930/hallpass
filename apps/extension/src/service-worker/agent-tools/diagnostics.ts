import {
  agentToolArgSchemas,
  AGENT_CONSOLE_LEVELS,
  AGENT_DIAGNOSTICS_MAX_LIMIT,
  AGENT_EVALUATE_MAX_CHARS,
  type AgentConsoleResult,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentNetworkResult,
  type AgentToolName,
  type SiteMode,
} from "@hallpass/contracts";
import { getTabSnapshot, watchTabUpdates, type TabUpdate } from "../../chrome-adapters/tabs.js";
import type { DebuggerAdapter } from "../../chrome-adapters/debugger.js";
import { createInputAttachments, type AgentInputAttachments } from "./input.js";
import { siteOfUrl, type SiteModeStore } from "../site-mode-store.js";
import type { AgentSessionContexts } from "./context.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import { decideGate, type StatedPlan } from "./gate.js";
import type { AgentPromptController } from "./prompts.js";
import { summariseToolCall } from "./summaries.js";

/**
 * The diagnostics tools (003/T057, US6, FR-049, FR-050).
 *
 * Two consents, and they are not the same one. The *grant* is per site and explicit: without it
 * none of these three tools does anything at all, and with it the worker attaches a debugger to
 * that tab - which Chrome announces to the owner in its own bar for as long as it lasts. The *mode*
 * is the same per-site decision every effect passes, and `evaluate` passes it too: a script can do
 * everything a click can, so a page the owner has not waved through is a page they are asked about
 * before anything is evaluated on it (US6 scenario 3).
 *
 * The attachment is deliberately narrow in time. It happens on the first granted call for a tab,
 * never at startup, and it ends on every event that means the owner's yes has stopped applying: a
 * revoke, the tab closing, the session ending, or the tab moving to a site with no grant of its
 * own. The buffers go with it, because what one site logged is not something the next site's owner
 * agreed to show anybody.
 *
 * What is kept from the protocol is a deliberately small subset. A console message is a level, a
 * text and a time; a network record is a method, a url, a status, a kind and a time. Headers,
 * cookies and bodies are dropped where the event arrives rather than filtered on the way out, so
 * there is no buffer in this worker that has ever held them.
 */

export type AgentDiagnosticsDeps = {
  context: AgentSessionContexts;
  siteModes: SiteModeStore;
  prompts: AgentPromptController;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  /** `evaluate` is gated like an effect, so it reads the same plan a batch may have stated. */
  statedPlan?: (site: string) => StatedPlan | undefined;
  onAdmitted?: (site: string, step: number) => void;
  debug?: DebuggerAdapter;
  /**
   * The attachment this runner shares with input (004/R-113).
   *
   * 003 owned the debugger outright and let go of it on every navigation. It is now one attachment
   * per held tab with two holders, and only this one ever enables the domains: the *grant* is still
   * per site, the attachment is per lease, and the two lifetimes are kept apart in `input.ts`.
   */
  attachments?: AgentInputAttachments;
  /**
   * How this runner hears about a navigation nobody asked it about (C1). Injected so a test can
   * drive Chrome's event without a browser; the default is the tabs adapter's subscription.
   */
  watchTabs?: (listener: (tabId: number, update: TabUpdate) => void) => () => void;
  reportDiagnostic?: (code: string) => void;
};

export type AgentDiagnosticsRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
  /**
   * Begins watching the browser, and squares this worker's belief with it (C1).
   *
   * Two things are only true from here on: a tab that navigates on its own is noticed, and an
   * attachment left behind by a worker Chrome evicted is let go of. Both are about the owner's
   * browser rather than about any agent, so this is called when the worker starts, not when a
   * session pairs.
   */
  start(): Promise<void>;
  /** One tab's attachment is over: it closed, or it is no longer the session's. */
  release(tabId: number): Promise<void>;
  /** The MCP session ended; nothing this session attached may outlive it. */
  releaseAll(): Promise<void>;
  /** The owner revoked the grant for one site: every tab on it lets go at once (FR-049). */
  revoke(site: string): Promise<void>;
  /** The tab may be on a different site now, so the grant that applied may no longer. */
  refresh(tabId: number): Promise<void>;
  /** Which tabs this worker currently has a debugger on. The panel's truth and a journey's. */
  attached(): number[];
};

const DIAGNOSTICS_TOOL_NAMES = ["read_console", "read_network", "evaluate"] as const;

type DiagnosticsToolName = (typeof DIAGNOSTICS_TOOL_NAMES)[number];

/** How long one `evaluate` may take before the worker stops waiting for the page. */
export const EVALUATE_TIMEOUT_MS = 10_000;

/**
 * How much of one buffered line a `pattern` is matched against (C3).
 *
 * A filter is for finding the message, and the front of a line is where a message says what it is;
 * a bound here is what keeps the cost of matching independent of how much a page chose to log.
 */
export const MATCH_PREFIX_CHARS = 512;

/**
 * The pattern shapes whose matching time is exponential in the input: a quantified group whose own
 * body is quantified (`(a+)+`, `(a*)*`, `(a+)*`). They are refused rather than run, because there
 * is no bound on the *text* that makes them safe.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*]/u;

type ConsoleMessage = AgentConsoleResult["messages"][number];
type NetworkRecord = AgentNetworkResult["requests"][number];

type TabDiagnostics = {
  /** The site the grant was checked against when this tab attached. */
  site: string;
  console: ConsoleMessage[];
  network: NetworkRecord[];
  /** Network records by their protocol request id, so a response can complete its request. */
  pending: Map<string, NetworkRecord>;
  /** Whether a buffer bound has already thrown something away. */
  overflowed: boolean;
};

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

/**
 * Chrome's console levels, mapped onto the closed set the contract declares.
 *
 * `warn`, `assert` and the `console.table` family all arrive as their own words; anything this
 * mapping does not know becomes `log` rather than being invented, because the level is something
 * the agent branches on and a made-up one would be a branch taken for the wrong reason.
 */
function consoleLevel(raw: unknown): ConsoleMessage["level"] {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "error" || value === "assert" || value === "exception") return "error";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "debug" || value === "verbose") return "debug";
  if (value === "info") return "info";
  return (AGENT_CONSOLE_LEVELS as readonly string[]).includes(value)
    ? (value as ConsoleMessage["level"])
    : "log";
}

/** One console argument as text. A structured value is stringified; nothing is walked into. */
function argumentText(value: unknown): string {
  const argument = value as { value?: unknown; description?: unknown } | undefined;
  if (argument === undefined || argument === null) return "";
  if (typeof argument.value === "string") return argument.value;
  if (argument.value !== undefined) {
    try {
      return JSON.stringify(argument.value) ?? "";
    } catch {
      return "";
    }
  }
  return typeof argument.description === "string" ? argument.description : "";
}

function boundedText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function createAgentDiagnostics(deps: AgentDiagnosticsDeps): AgentDiagnosticsRunner {
  const tabs = new Map<number, TabDiagnostics>();
  let shared: AgentInputAttachments | undefined;
  let wired = false;
  /** Whether the browser-wide navigation subscription is up; `start` is idempotent (C1). */
  let watching = false;

  function attachments(): AgentInputAttachments {
    shared ??=
      deps.attachments ??
      createInputAttachments({
        ...(deps.debug ? { debug: deps.debug } : {}),
        ...(deps.reportDiagnostic ? { reportDiagnostic: deps.reportDiagnostic } : {}),
      });
    if (!wired) {
      wired = true;
      shared.onEvent(record);
      // Chrome let go on its own - the tab closed, or the owner dismissed the debugging bar. The
      // buffers go with it: nothing is filling them any more, and answering from them would be
      // reporting a page nobody is watching.
      shared.onDetach((tabId) => {
        tabs.delete(tabId);
      });
    }
    return shared;
  }

  /** Keeps a buffer at its bound, oldest first, and remembers that something was dropped. */
  function push<T>(state: TabDiagnostics, buffer: T[], entry: T): void {
    buffer.push(entry);
    if (buffer.length > AGENT_DIAGNOSTICS_MAX_LIMIT) {
      buffer.shift();
      state.overflowed = true;
    }
  }

  function record(tabId: number, method: string, params: Record<string, unknown>): void {
    const state = tabs.get(tabId);
    if (!state) return;
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(params.args) ? params.args : [];
      push(state, state.console, {
        level: consoleLevel(params.type),
        text: boundedText(args.map(argumentText).join(" ").trim(), 4_000),
        ts: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = (params.exceptionDetails ?? {}) as {
        text?: unknown;
        exception?: { description?: unknown };
      };
      const description =
        typeof details.exception?.description === "string"
          ? details.exception.description
          : typeof details.text === "string"
            ? details.text
            : "uncaught exception";
      push(state, state.console, {
        level: "error",
        text: boundedText(description, 4_000),
        ts: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = (params.entry ?? {}) as { level?: unknown; text?: unknown; timestamp?: unknown };
      push(state, state.console, {
        level: consoleLevel(entry.level),
        text: boundedText(typeof entry.text === "string" ? entry.text : "", 4_000),
        ts: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const request = (params.request ?? {}) as { method?: unknown; url?: unknown };
      // Only these four fields ever leave the event. `request.headers` and `request.postData` are
      // right there and are deliberately not read: FR-050 asks for records, and a record with the
      // cookie in it is the page's session in this worker's memory.
      const entry: NetworkRecord = {
        method: boundedText(typeof request.method === "string" ? request.method : "GET", 16),
        url: boundedText(typeof request.url === "string" ? request.url : "", 2_048),
        type: boundedText(typeof params.type === "string" ? params.type.toLowerCase() : "other", 32),
        ts: typeof params.wallTime === "number" ? Math.round(params.wallTime * 1000) : Date.now(),
      };
      if (entry.url.length === 0) return;
      push(state, state.network, entry);
      if (typeof params.requestId === "string") state.pending.set(params.requestId, entry);
      // C5: a request whose response never arrives would otherwise wait here for ever. The map is
      // for completing records that are still in the buffer, so it is kept to the same window:
      // once a record has aged out of the buffer, the id that would have completed it is dropped
      // too, oldest first (a Map iterates in insertion order).
      while (state.pending.size > AGENT_DIAGNOSTICS_MAX_LIMIT) {
        const oldest = state.pending.keys().next();
        if (oldest.done === true) break;
        state.pending.delete(oldest.value);
      }
      return;
    }
    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      // The request is over, unsuccessfully. The record stays - a failed request is a fact about
      // the page worth reporting - but nothing is waiting to complete it any more.
      state.pending.delete(requestId);
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const entry = state.pending.get(requestId);
      if (!entry) return;
      const response = (params.response ?? {}) as { status?: unknown };
      if (typeof response.status === "number") entry.status = response.status;
      state.pending.delete(requestId);
    }
  }

  /**
   * This runner's interest in the tab is over: the grant stopped applying, or the tab did.
   *
   * The buffers go now, always - what one site logged is not something the next site's owner
   * agreed to show anybody - and the domains go with them. Whether the *attachment* also ends is
   * no longer this module's to decide: it ends when no holder is left, so a tab an agent is acting
   * in stays attached with nothing enabled on it (R-113).
   */
  async function detach(tabId: number): Promise<void> {
    tabs.delete(tabId);
    await attachments().drop(tabId, "diagnostics");
  }

  /** The tab's site right now, which is the only site a grant may be checked against (FR-049). */
  async function siteOfTab(tabId: number): Promise<string | undefined> {
    const tab = await getTabSnapshot(tabId);
    return tab === undefined ? undefined : siteOfUrl(tab.url);
  }

  async function ensureAttached(tabId: number, site: string): Promise<boolean> {
    const existing = tabs.get(tabId);
    if (existing) {
      if (existing.site === site) return true;
      // The tab moved. Whatever was buffered belongs to the page it was on, and the grant that
      // allowed this attachment was for that site.
      await detach(tabId);
    }
    // The buffers exist before the domains do, because enabling them is what starts filling these.
    tabs.set(tabId, { site, console: [], network: [], pending: new Map(), overflowed: false });
    const acquired = await attachments().acquire(tabId, "diagnostics");
    if (!acquired.ok) {
      tabs.delete(tabId);
      return false;
    }
    return true;
  }

  /**
   * A caller-supplied pattern, compiled once and bounded in what it may cost (C3).
   *
   * The pattern is the agent's and the text is the page's, so the classic backtracking blow-up is
   * reachable from outside this worker - and it would burn the *browser's* CPU, not the agent's.
   * Two bounds, both cheap: a nested quantifier - the shape that makes matching exponential - is an
   * argument this tool does not accept, and every match runs against the front of a line rather
   * than all of it, so no single logged message can be made expensive to test.
   *
   * An uncompilable pattern and a dangerous one are the same answer, `invalid-pattern`: both mean
   * the agent has to send a different one, and neither is an empty page.
   */
  function matcher(pattern: unknown): { ok: true; test: (value: string) => boolean } | { ok: false } {
    if (typeof pattern !== "string") return { ok: true, test: () => true };
    if (NESTED_QUANTIFIER.test(pattern)) return { ok: false };
    try {
      const expression = new RegExp(pattern, "u");
      return { ok: true, test: (value: string) => expression.test(boundedText(value, MATCH_PREFIX_CHARS)) };
    } catch {
      return { ok: false };
    }
  }

  async function evaluate(
    callId: string,
    tabId: number,
    expression: string,
  ): Promise<AgentNativeResponse> {
    let result: Record<string, unknown>;
    try {
      result = await Promise.race([
        attachments().send(tabId, "Runtime.evaluate", {
          expression,
          // By value and awaiting the promise: a remote object handle would be a reference into a
          // page this side cannot read, and an unawaited promise would report itself as the answer.
          returnByValue: true,
          awaitPromise: true,
          timeout: EVALUATE_TIMEOUT_MS,
        }),
        new Promise<Record<string, unknown>>((_resolve, reject) =>
          setTimeout(() => reject(new Error("evaluate-timeout")), EVALUATE_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      return answer(
        callId,
        error instanceof Error && error.message === "evaluate-timeout" ? "timed-out" : "failed",
        error instanceof Error && error.message === "evaluate-timeout" ? "evaluate-timeout" : "evaluate-failed",
      );
    }
    if (result.exceptionDetails !== undefined) {
      // The page threw. That is an answer about the page, not a failure of the tool, and it is
      // named rather than dressed up as a value.
      return answer(callId, "failed", "evaluate-threw");
    }
    const value = (result.result ?? {}) as { value?: unknown; description?: unknown; type?: unknown };
    const text =
      typeof value.value === "string"
        ? value.value
        : value.value !== undefined
          ? (JSON.stringify(value.value) ?? "")
          : typeof value.description === "string"
            ? value.description
            : "";
    const truncated = text.length > AGENT_EVALUATE_MAX_CHARS;
    return {
      callId,
      outcome: "ok",
      result: { value: truncated ? text.slice(0, AGENT_EVALUATE_MAX_CHARS) : text, truncated },
    };
  }

  async function run(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const tool = request.tool as DiagnosticsToolName;
    const parsed = agentToolArgSchemas[tool].safeParse(request.args);
    if (!parsed.success) return answer(callId, "failed", "invalid-arguments");
    const args = parsed.data as Record<string, unknown>;
    const tabId = typeof args.tabId === "number" ? args.tabId : request.tabId;
    if (tabId === undefined) return answer(callId, "failed", "no-tab");
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") return ownershipRefusal(callId, ownership);

    const site = await siteOfTab(tabId);
    if (site === undefined) {
      // A page with no origin cannot hold a decision, so there is no grant that could cover it.
      await release(tabId);
      return answer(callId, "denied", "diagnostics-not-granted");
    }
    const record = await deps.siteModes.get(site);
    if (!record.diagnosticsGranted) {
      // FR-049: the refusal comes before anything attaches, so an ungranted call never puts the
      // browser into its debugging state at all.
      await release(tabId);
      return answer(callId, "denied", "diagnostics-not-granted");
    }

    if (tool === "evaluate") {
      const decision = decideGate({
        sessionId: request.sessionId,
        tabId,
        site,
        mode: record.mode,
        tool,
        args,
        ...(deps.statedPlan ? { plan: deps.statedPlan(site) } : {}),
      });
      if (decision.decision === "refuse") return answer(callId, "failed", decision.reason);
      if (decision.decision === "admit" && decision.step !== undefined) {
        deps.onAdmitted?.(site, decision.step);
      }
      if (decision.decision === "prompt") {
        const asked = await deps.prompts.ask({
          callId,
          sessionId: request.sessionId,
          site,
          tool,
          argsSummary: summariseToolCall(tool, args),
        });
        if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
        if (asked.decision === "timed-out") return answer(callId, "timed-out", "no-answer");
        if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
        if (asked.decision === "deny") return answer(callId, "denied", "owner-denied");
        // 006 FR-087: the tab may have been handed back while the question stood (see effects.ts).
        const held = await deps.tabOwnership(request.sessionId, tabId);
        if (held.state !== "this") return ownershipRefusal(callId, held);
        if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
        if (asked.rememberMode) {
          await deps.siteModes.set(site, { mode: asked.rememberMode as SiteMode });
        }
      }
    }

    if (!(await ensureAttached(tabId, site))) {
      return answer(callId, "failed", "debugger-not-attached");
    }

    if (tool === "evaluate") {
      return evaluate(callId, tabId, String(args.expression));
    }

    const state = tabs.get(tabId);
    if (!state) return answer(callId, "failed", "debugger-not-attached");
    const limit = typeof args.limit === "number" ? args.limit : AGENT_DIAGNOSTICS_MAX_LIMIT;
    const filter = matcher(args.pattern);
    if (!filter.ok) return answer(callId, "failed", "invalid-pattern");

    if (tool === "read_console") {
      const onlyErrors = args.onlyErrors === true;
      const matched = state.console.filter(
        (message) => (!onlyErrors || message.level === "error") && filter.test(message.text),
      );
      const messages = matched.slice(-limit);
      return {
        callId,
        outcome: "ok",
        // Cut either by this call's own limit or by the buffer's bound: both mean the agent is not
        // looking at everything the page said.
        result: { messages, truncated: state.overflowed || messages.length < matched.length },
      };
    }

    const matched = state.network.filter((entry) => filter.test(entry.url));
    const requests = matched.slice(-limit);
    return {
      callId,
      outcome: "ok",
      result: { requests, truncated: state.overflowed || requests.length < matched.length },
    };
  }

  async function release(tabId: number): Promise<void> {
    if (!tabs.has(tabId)) return;
    await detach(tabId);
  }

  async function refresh(tabId: number): Promise<void> {
    const state = tabs.get(tabId);
    if (!state) return;
    const site = await siteOfTab(tabId);
    if (site === state.site) return;
    // The tab is somewhere else. Even if the new site is granted too, the attachment is re-made
    // on the next call rather than carried across, so the buffers can never mix two pages.
    await detach(tabId);
  }

  return {
    handles(tool) {
      return (DIAGNOSTICS_TOOL_NAMES as readonly string[]).includes(tool);
    },
    run,
    release,
    async releaseAll() {
      for (const tabId of [...tabs.keys()]) await detach(tabId);
    },
    async revoke(site) {
      for (const [tabId, state] of [...tabs.entries()]) {
        if (state.site === site) await detach(tabId);
      }
    },
    refresh,
    async start() {
      if (!watching) {
        watching = true;
        // Every tab change, not only the ones a tool started: a clicked link, a redirect, a form
        // submit and the owner's own url entry are all ways out of the granted site (C1).
        (deps.watchTabs ?? watchTabUpdates)((tabId, update) => {
          if (update.status === undefined && update.url === undefined) return;
          if (!tabs.has(tabId)) return;
          void refresh(tabId).catch(() => deps.reportDiagnostic?.("agent.diagnostics.refresh-failed"));
        });
      }
      try {
        const live = await attachments().attachedTabIds();
        for (const tabId of live) {
          if (tabs.has(tabId)) continue;
          // Something is attached to a page this worker has no record of. If it is this
          // extension's - the usual case, a worker that was evicted mid-session - the owner is
          // still looking at the debugging bar for a grant nobody is using; if it is somebody
          // else's, the detach fails and nothing has happened.
          try {
            await attachments().detachStray(tabId);
            deps.reportDiagnostic?.("agent.diagnostics.reconciled");
          } catch {
            deps.reportDiagnostic?.("agent.diagnostics.detach-noop");
          }
        }
      } catch {
        // No debugger API, or Chrome refused to enumerate. Neither is a reason not to run.
        deps.reportDiagnostic?.("agent.diagnostics.reconcile-failed");
      }
    },
    attached() {
      return [...tabs.keys()];
    },
  };
}
