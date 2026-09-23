import {
  agentToolArgSchemas,
  type AgentDownloadRecord,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentNavigateDownload,
  type AgentTabView,
  type AgentToolName,
} from "@hallpass/contracts";
import {
  createTab,
  getTabSnapshot,
  goBackInTab,
  goForwardInTab,
  navigateTab,
  queryTabSnapshots,
  removeTab,
  tabContentSize,
  watchTabSettle,
} from "../../chrome-adapters/tabs.js";
import { resizeWindow } from "../../chrome-adapters/windows.js";
import type { AgentTabManager } from "../agent-tab-manager.js";
import { siteOfUrl, type SiteModeStore } from "../site-mode-store.js";
import type { WindowRestoreRecord } from "../window-restore.js";
import type { ViewportEmulation } from "../viewport-emulation.js";
import type { AgentSessionContexts } from "./context.js";
import type { BeforeunloadOutcome } from "./dialogs.js";
import { decideGate, type StatedPlan } from "./gate.js";
import { inputUnavailable } from "./input.js";
import { ownershipRefusal } from "./ownership.js";
import type { AgentPageBindings } from "./page-binding.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import type { AgentToolRequest } from "./stop.js";

/**
 * The tab tools (003/T042, US4, FR-044..FR-046).
 *
 * These are the only tools that decide *which* pages the session can reach, so the rule they all
 * share is the group: `tabs_create` is the one door into it, and every other tool here refuses a
 * tab that is not behind that door (FR-034, SC-024). Nothing here enters the per-site gate. That is
 * not an omission: the gate is the owner's consent to *change a page*, and moving a tab to another
 * page changes nothing on either of them - what the agent may then do at the destination is decided
 * by the destination site's own mode, at the moment it tries (FR-045).
 *
 * The other rule is that an answer names what happened, not what was asked for. A navigation
 * reports the url the tab settled on, because a redirect and a refusal both end somewhere else; a
 * resize reports the size Chrome allowed, because the display is smaller than some requests.
 */

export type AgentTabToolDeps = {
  context: AgentSessionContexts;
  tabs: AgentTabManager;
  /**
   * Navigation is what makes a page binding a lie: the epoch, the origin and every ref minted under
   * them belong to a document that is gone. The binding cache is told so here rather than
   * discovering it at the next effect.
   */
  bindings: Pick<AgentPageBindings, "invalidate">;
  /** How long a navigation is given to reach `complete` before it is reported unfinished. */
  navigationTimeoutMs?: number;
  /**
   * Told whenever the session's tabs, or where they point, changed.
   *
   * The panel's per-site list is built from the sites the session's tabs are on, so without this
   * the owner would have no entry to set a mode on for a page the agent had just opened - the very
   * page it is about to ask them about (FR-042). It is announced by the tools rather than watched
   * for on `chrome.tabs.onUpdated`, because only these tools know the change was the session's.
   */
  onTabsChanged?: () => void;
  /**
   * Told when a tab left the page it was on (003/T057). Anything bound to that *page* rather than to
   * the tab has to hear about it: the diagnostics grant is per site, so a tab that moved may have
   * moved out from under the owner's yes.
   */
  onTabNavigated?: (tabId: number) => void;
  /** Told when a tab this session had is gone, whoever closed it. */
  onTabReleased?: (tabId: number) => void;
  /**
   * Where this call is about to send the tab (014 rule (e), FR-185).
   *
   * Registered *before* the move and released when the call answers, because the arrival is heard
   * on `tabs.onUpdated` - a signal that says where a tab is, never who sent it there. Without the
   * expectation every navigation the agent made itself would look exactly like a redirect nobody
   * asked for, and the agent would be held behind a card for going where it said it was going.
   *
   * It is the *requested* origin and nothing more: a redirect onward from there is not what this
   * call asked for, and it is a move the owner is still owed (US2 scenario 1).
   */
  transitions?: {
    expectNavigate(sessionId: string, tabId: number, url: string): Promise<void>;
    endNavigate(sessionId: string, tabId: number): Promise<void>;
  };
  /**
   * The worker's record of the session's downloads (005/US2). A url the browser downloads rather
   * than renders never commits, so its navigation would run to the bound; the record that appears
   * for it is what ends the navigation instead, with the download in the answer.
   */
  downloads?: { list(sessionId: string): Promise<AgentDownloadRecord[]> };
  /**
   * The "leave site?" half of leaving a page (008/US3, FR-115, R-140).
   *
   * A page with unsaved work can refuse to be left, and the browser asks the *owner* about it. This
   * worker answers it by policy instead: stay, always, unless this very call was allowed to leave.
   * `beginUnload` arms that policy for the length of one call and hands back the outcome to wait on.
   */
  dialogs?: {
    beginUnload(tabId: number, policy: "stay" | "leave"): { settled: Promise<BeforeunloadOutcome>; end(): void };
  };
  /**
   * The owner's decision about discarding unsaved work (FR-115, D-008-4).
   *
   * These tools have never entered the gate and still do not: moving a tab to another page changes
   * nothing on either of them. `force: true` is the exception, and it is one because of what it
   * destroys - work the owner has not saved - so it is an effect under the site's mode, gated
   * exactly where the site's mode is read for a click.
   */
  /**
   * What `resize_window` un-maximised, for the runtime to give back (008/FR-118, R-141).
   *
   * Write-only from here: this tool knows *that* the window was taken out of its state, and
   * nothing else in the worker can know it, but when it is owed back is a fact about the session's
   * tabs rather than about this call.
   */
  windowRestores?: { remember(record: WindowRestoreRecord): Promise<void> };
  /**
   * The emulated viewport `viewport` puts on a tab and takes off again (012/US1, FR-156, FR-159).
   *
   * Required rather than optional, unlike the two above: a tool cannot answer "the page is now
   * 375 wide" out of a module that was not composed, and the compiler asking for it here is what
   * keeps the runtime's wiring and this dispatch one thing. The clearing on every release path is
   * the module's own business (`onBeforeRelease`), not this tool's.
   */
  viewport: Pick<ViewportEmulation, "set" | "reset">;
  siteModes?: Pick<SiteModeStore, "get" | "set">;
  prompts?: Pick<AgentPromptController, "ask">;
  statedPlan?: (site: string) => StatedPlan | undefined;
  onAdmitted?: (site: string, step: number) => void;
  reportDiagnostic?: (code: string) => void;
};

export type AgentTabToolRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

/**
 * FR-045's bound on a navigation.
 *
 * Strictly under the host router's 30 s call bound (003/B4), for the reason every worker-side
 * deadline in this feature is: the page that is still loading has to be reported by the worker, in
 * the tool contract's own words, rather than lost to a transport timeout the agent cannot
 * interpret. At thirty seconds the two raced and the transport usually won.
 */
export const NAVIGATION_TIMEOUT_MS = 25_000;

/**
 * How often a just-created tab is re-read for its committed address (004/T167), and how often a
 * pending navigation looks for the download it may have become (005/US2).
 */
const COMMIT_POLL_MS = 100;

/**
 * How long a call that may meet a "leave site?" prompt waits for its outcome (FR-115, §3.1).
 *
 * The reference's own race budget, and it is a race rather than a poll: a dismissed prompt resolves
 * the waiter the moment the event lands, and an accepted one resolves when the tab actually leaves.
 * The bound only covers the case where no prompt was raised at all, which is every ordinary page.
 */
const BEFOREUNLOAD_WAIT_MS = 300;

const TAB_TOOL_NAMES = [
  "tabs_context",
  "tabs_create",
  "tabs_close",
  "tabs_claim",
  "tabs_release",
  "navigate",
  "resize_window",
  // 012: the page's size rather than the window's, decided by the same ownership check.
  "viewport",
] as const;

type TabToolName = (typeof TAB_TOOL_NAMES)[number];

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

export function createAgentTabTools(deps: AgentTabToolDeps): AgentTabToolRunner {
  const navigationTimeoutMs = deps.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;

  /**
   * Starts something that changes a tab's document and waits for the tab to settle.
   *
   * The watcher is armed *before* the action, because Chrome can report `complete` before the
   * promise that started the navigation resolves; arming afterwards is how a fast page becomes a
   * timeout. The action's own throw is kept separate from the bound passing: "the browser refused
   * this url" and "the page never finished" are different facts and the agent acts on each.
   */
  /**
   * Announces a just-created tab a second time, once its address has committed (004/T167).
   *
   * `chrome.tabs.create({ url })` resolves before the document commits, so the record `tabs_create`
   * announces from can still read `about:blank`, and the panel's per-site list - built from where
   * the session's tabs are, refreshed only when a tool says so - then has no entry for the very
   * page the agent just opened. The call is not held for the commit: a tab is created the moment
   * Chrome says so, and a page that never loads is not this tool's failure to report. The record
   * is re-read instead, on the navigation bound, and the panel told again when the address is
   * there. Polling rather than `tabs.onUpdated`: the commit can land between the create and any
   * listener armed after it, and a missed event here is exactly the timeout this exists to end.
   */
  async function announceOnceCommitted(tabId: number): Promise<void> {
    const deadline = Date.now() + navigationTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(COMMIT_POLL_MS, deadline - Date.now())));
      const tab = await getTabSnapshot(tabId);
      // Gone already: whoever closed it announced that.
      if (!tab) return;
      if (tab.url !== "about:blank") {
        deps.onTabsChanged?.();
        return;
      }
    }
  }

  /**
   * The download a pending navigation became, if it did (005/US2, T187 B19).
   *
   * A url the browser downloads never commits, so nothing on `tabs.onUpdated` will ever end the
   * watcher: the probe's zip url ran to the full bound and was reported `navigation-timeout` about a
   * file that had landed within the second. The session's download records are the fact that says
   * what happened, so they are polled beside the watcher. The record is this navigation's when it
   * is for the url asked for - the record keeps the pre-redirect url, so equality holds - and began
   * no earlier than the navigation did; an older record of the same url, or another url's, is not.
   * `over` is the watcher's own ending: a poll that outlived it must not stop a watcher that has
   * already answered.
   */
  async function downloadInsteadOf(
    sessionId: string,
    url: string,
    begunAt: number,
    isOver: () => boolean,
  ): Promise<AgentDownloadRecord | undefined> {
    const deadline = begunAt + navigationTimeoutMs;
    while (!isOver() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(COMMIT_POLL_MS, Math.max(0, deadline - Date.now()))));
      if (isOver()) return undefined;
      const records = await deps.downloads?.list(sessionId).catch(() => []);
      const found = records?.find((record) => record.url === url && Date.parse(record.startedAt) >= begunAt);
      if (found) return found;
    }
    return undefined;
  }

  async function settleAfter(
    tabId: number,
    action: () => Promise<void>,
    mayDownload?: { sessionId: string; url: string },
  ): Promise<
    { ok: true; download?: AgentNavigateDownload } | { ok: false; reason: "navigation-refused" | "navigation-timeout" }
  > {
    // Where the tab is *before* the action, so a `complete` announcing the page it is leaving is
    // not mistaken for this navigation's (B4).
    const before = await getTabSnapshot(tabId);
    const begunAt = Date.now();
    const watcher = watchTabSettle(tabId, navigationTimeoutMs, {
      ...(before === undefined ? {} : { fromUrl: before.url }),
    });
    try {
      await action();
    } catch {
      watcher.stop();
      return { ok: false, reason: "navigation-refused" };
    }
    if (mayDownload === undefined || deps.downloads === undefined) {
      const settled = await watcher.settled;
      return settled ? { ok: true } : { ok: false, reason: "navigation-timeout" };
    }
    let over = false;
    const settling = watcher.settled.then((settled) => {
      over = true;
      return settled;
    });
    const found = await Promise.race([
      downloadInsteadOf(mayDownload.sessionId, mayDownload.url, begunAt, () => over),
      settling.then(() => undefined),
    ]);
    if (found) {
      watcher.stop();
      return { ok: true, download: { id: found.id, filename: found.filename, url: found.url, state: found.state } };
    }
    const settled = await settling;
    return settled ? { ok: true } : { ok: false, reason: "navigation-timeout" };
  }

  /**
   * The owner's consent to throw away unsaved work (FR-115, D-008-4).
   *
   * `undefined` means "carry on"; anything else is this call's answer. The site is read from the
   * browser's record of the tab rather than from a page binding, for the reason `dialogs.ts` reads
   * it that way: the page may already be holding a prompt, and nothing in it will answer.
   */
  async function decideForce(
    request: AgentToolRequest,
    tool: TabToolName,
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<AgentNativeResponse | undefined> {
    const { callId } = request;
    if (!deps.siteModes || !deps.prompts) return undefined;
    const tab = await getTabSnapshot(tabId);
    const site = tab === undefined ? undefined : siteOfUrl(tab.url);
    // No site is no mode: a page the owner cannot have decided about is not one whose unsaved work
    // this worker discards on an agent's say-so.
    if (site === undefined) return answer(callId, "failed", "no-site");
    const record = await deps.siteModes.get(site);
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
    if (decision.decision === "admit") {
      if (decision.step !== undefined) deps.onAdmitted?.(site, decision.step);
      return undefined;
    }
    const asked = await deps.prompts.ask({
      callId,
      // Which call the host knows it as, when this navigation is a batch step (011 review H1).
      hostCallId: request.hostCallId,
      // And whether the owner ended the call while the runner was still getting here (FR-179).
      stopped: request.stopped,
      sessionId: request.sessionId,
      site,
      tool,
      argsSummary: `${tool} force on ${site}`,
      // The panel writes this card's own sentence: what is being decided is the loss of the
      // owner's unsaved work, which "go to a page" does not say (FR-115).
      kind: "beforeunload-force",
    });
    if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
    if (asked.decision === "timed-out") return noAnswerResponse(callId, asked);
    if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
    // 014 FR-179: the step ended, the session did not.
    if (asked.decision === "interrupted") return answer(callId, "stopped", "owner-interrupted");
    if (asked.decision === "deny") return answer(callId, "denied", "owner-denied");
    const held = await deps.tabs.ownership(request.sessionId, tabId);
    if (held.state !== "this") return ownershipRefusal(callId, held);
    if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
    if (asked.rememberMode) await deps.siteModes.set(site, { mode: asked.rememberMode });
    return undefined;
  }

  /** The page asked to stay, and this call is over (FR-115): which page, so `force` has an aim. */
  function blockedByBeforeunload(callId: string, url: string): AgentNativeResponse {
    return {
      callId,
      outcome: "failed",
      reason: "blocked-by-beforeunload",
      refusal: { reason: "blocked-by-beforeunload", url },
    };
  }

  /**
   * The "leave site?" outcome, if one lands before the bound (§3.1: event-driven, not polled).
   *
   * A never-settling promise stands in for "this call cannot meet one", so the race below reads the
   * same whether the dialogs module is wired or not.
   */
  function stayedWithin(
    watch: { settled: Promise<BeforeunloadOutcome> } | undefined,
    ms: number,
  ): Promise<BeforeunloadOutcome | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      void watch?.settled.then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  async function runTool(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const tool = request.tool as TabToolName;
    const sessionId = request.sessionId;
    const parsed = agentToolArgSchemas[tool].safeParse(request.args);
    if (!parsed.success) {
      return answer(callId, "failed", "invalid-arguments");
    }
    const args = parsed.data as Record<string, unknown>;

    if (tool === "tabs_context") {
      /**
       * Every tab the browser has, not just this session's (004/T104, FR-057).
       *
       * The list is what a claim is made from, so a list of only the tabs the session already holds
       * would leave an agent unable to make its first one. It needs no lease for the same reason:
       * what is read here is the browser's own record of a tab - its address, its window, whether
       * the owner is looking at it - and never a word of the page, which is what a lease is about.
       *
       * The session's own record is reconciled on the way past: a tab the owner closed is dropped
       * from it and its lease with it, which is the bookkeeping 003 did on this call (FR-044).
       */
      await deps.tabs.context(sessionId);
      const [live, leases] = await Promise.all([queryTabSnapshots(), deps.tabs.leases()]);
      const holders = new Map(leases.map((lease) => [lease.tabId, lease.sessionId]));
      const tabs: AgentTabView[] = live.map((tab) => {
        const holder = holders.get(tab.id);
        return {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
          holder: holder === undefined ? "none" : holder === sessionId ? "this" : { sessionId: holder },
        };
      });
      return { callId, outcome: "ok", result: tabs };
    }

    if (tool === "tabs_create") {
      const url = typeof args.url === "string" ? args.url : "about:blank";
      const created = await createTab(url);
      if (!created) {
        return answer(callId, "failed", "tab-not-created");
      }
      try {
        // Adoption is what makes the tab the session's *and* what puts the visible "Agent" marking
        // on the group. A tab created but not adopted would be a tab no later tool could touch.
        await deps.tabs.adopt(sessionId, created.id);
      } catch {
        deps.reportDiagnostic?.("agent.tabs.adopt-failed");
        return answer(callId, "failed", "tab-not-adopted");
      }
      deps.onTabsChanged?.();
      if (url !== "about:blank" && created.url === "about:blank") {
        void announceOnceCommitted(created.id);
      }
      return { callId, outcome: "ok", result: { tabId: created.id } };
    }

    const tabId = args.tabId as number;

    if (tool === "tabs_claim") {
      /**
       * The one tool that acts on a tab this session does not hold, which is its whole point
       * (R-117). The lease store decides: it is the thing that can say "somebody else has it"
       * without racing another claim in the same turn.
       */
      const claimed = await deps.tabs.claim(sessionId, tabId);
      if (!claimed.ok) {
        return claimed.reason === "tab-gone"
          ? answer(callId, "stale", "tab-gone")
          : claimed.reason === "held-by-session"
            ? {
                callId,
                outcome: "denied",
                reason: "held-by-session",
                refusal: { reason: "held-by-session", sessionId: claimed.sessionId },
              }
            : {
                callId,
                outcome: "denied",
                reason: "restricted-page",
                refusal: { reason: "restricted-page" },
              };
      }
      // The group is read back from Chrome rather than assumed, for the reason a navigation reports
      // the url it settled on: it is what the *owner* sees in their tab strip, and reporting a
      // group the tab is not in would be a claim they could check and find false.
      const tab = await getTabSnapshot(tabId);
      if (!tab) {
        return answer(callId, "stale", "tab-gone");
      }
      deps.onTabsChanged?.();
      return { callId, outcome: "ok", result: { tabId, groupId: tab.groupId } };
    }

    const ownership = await deps.tabs.ownership(sessionId, tabId);
    if (ownership.state !== "this") {
      return ownershipRefusal(callId, ownership);
    }

    if (tool === "tabs_release") {
      // Handing the tab back: the lease goes, the marking goes with it, and the tab stays open on
      // whatever page it is on. The owner asked for none of this and gets their tab back as it is.
      await deps.tabs.release(sessionId, tabId);
      deps.bindings.invalidate(tabId);
      deps.onTabReleased?.(tabId);
      deps.onTabsChanged?.();
      return { callId, outcome: "ok", result: { released: true } };
    }

    if (tool === "tabs_close") {
      const force = args.force === true;
      if (force) {
        const decided = await decideForce(request, tool, tabId, args);
        if (decided) return decided;
      }
      // Armed before the close, because the prompt is raised by the close itself (FR-115).
      const watch = deps.dialogs?.beginUnload(tabId, force ? "leave" : "stay");
      try {
        return await closeTab(request, tabId, watch);
      } finally {
        // The policy was this call's; the tab goes back to staying put (data-model
        // BeforeunloadPolicy).
        watch?.end();
      }
    }

    if (tool === "navigate") {
      const force = args.force === true;
      if (force) {
        const decided = await decideForce(request, tool, tabId, args);
        if (decided) return decided;
      }
      const watch = deps.dialogs?.beginUnload(tabId, force ? "leave" : "stay");
      try {
        return await navigateTabTool(request, tabId, args, watch);
      } finally {
        watch?.end();
      }
    }

    const tab = await getTabSnapshot(tabId);
    if (!tab) {
      return answer(callId, "stale", "tab-gone");
    }

    if (tool === "viewport") {
      /**
       * 012/US1 — the page is laid out at a size this session chose, and the window is not touched.
       *
       * Not an effect: nothing on the page changes, nothing is typed or clicked, and the owner's
       * own window is where they left it - so it is governed by the lease alone, like every other
       * tool in this file (FR-161). The refusal it can meet is the attachment's: Chrome will not
       * let an extension debug a tab with developer tools open on it, and an emulation with no
       * attachment behind it is not something to claim.
       */
      if (args.action === "set") {
        const size = { width: args.width as number, height: args.height as number };
        const applied = await deps.viewport.set(sessionId, tabId, size);
        if (!applied.ok) return inputUnavailable(callId, applied.unavailableReason);
        return { callId, outcome: "ok", result: { ...size, emulated: true } };
      }
      const cleared = await deps.viewport.reset(sessionId, tabId);
      // 012/S2c F4: the clear never went out, so the page is still the size the agent gave it.
      // Answering `emulated: false` here would be this worker telling the agent something it has
      // no reason to believe - and the refusal is the attachment's, in the attachment's words.
      if (!cleared.ok) return inputUnavailable(callId, cleared.unavailableReason);
      // The page could not be measured - it was never emulated, so there was no attachment to ask
      // through - and the tab's own content area is then the last fact left about its size. Not the
      // *window's* bounds (012/S2c F4): those include the browser's own furniture, and an agent
      // given them would aim every later coordinate at a viewport that is smaller than it was told.
      const measured = cleared.real ?? (await tabContentSize(tabId));
      if (measured?.width === undefined || measured.height === undefined) {
        // The window went between the two reads, which takes the tab with it. A size made up here
        // would be a fact about nothing, and `stale` is the word for a tab that is not there.
        return answer(callId, "stale", "tab-gone");
      }
      return {
        callId,
        outcome: "ok",
        result: { width: measured.width, height: measured.height, emulated: false },
      };
    }

    try {
      const { size, priorState } = await resizeWindow(tab.windowId, {
        width: args.width as number,
        height: args.height as number,
      });
      // The window was taken out of a state the owner had put it in, so that a size could be
      // honoured at all (003 FR-045). That is remembered here - the one call that knows it happened
      // - and given back when the session lets the window go (008 FR-118, FR-120).
      if (priorState === "maximized" || priorState === "fullscreen") {
        await deps.windowRestores
          ?.remember({ windowId: tab.windowId, priorState, sessionId, setSize: size })
          .catch(() => undefined);
      }
      return { callId, outcome: "ok", result: size };
    } catch {
      return answer(callId, "failed", "window-not-resized");
    }
  }

  /** 003's close, with 008's one addition: a page that asked to stay is not closed (FR-115). */
  async function closeTab(
    request: AgentNativeRequest,
    tabId: number,
    watch: { settled: Promise<BeforeunloadOutcome> } | undefined,
  ): Promise<AgentNativeResponse> {
    const { callId, sessionId } = request;
    {
      try {
        await removeTab(tabId);
      } catch {
        // The owner closed it between the ownership check and here (B7). Chrome throws, but nothing
        // is broken: this is FR-044's ordinary case, and it gets FR-044's word rather than a
        // handler error. A tab that is somehow still there is a different fact and says so.
        const survivor = await getTabSnapshot(tabId);
        await deps.tabs.release(sessionId, tabId);
        deps.bindings.invalidate(tabId);
        deps.onTabReleased?.(tabId);
        deps.onTabsChanged?.();
        return survivor === undefined
          ? answer(callId, "stale", "tab-gone")
          : answer(callId, "failed", "tab-not-closed");
      }
      /**
       * The page asked to stay, and it is still open (FR-115, §3.1).
       *
       * Only worth asking when the close *looked* like it worked: `removeTab` resolves either way,
       * and the tab that is still there a moment later is the page refusing to go. The wait is the
       * reference's 300 ms race budget and it is event-driven - the outcome resolves the waiter the
       * moment the prompt is answered by policy.
       */
      const stayed = await stayedWithin(watch, BEFOREUNLOAD_WAIT_MS);
      if (stayed?.action === "stay") {
        const survivor = await getTabSnapshot(tabId);
        if (survivor !== undefined) return blockedByBeforeunload(callId, stayed.url || survivor.url);
      }
      // Released rather than left to reconciliation: a tab the session closed itself is not a tab
      // the owner took away, and reporting it `gone` later would be a fact about nobody's action.
      await deps.tabs.release(sessionId, tabId);
      deps.bindings.invalidate(tabId);
      deps.onTabReleased?.(tabId);
      deps.onTabsChanged?.();
      return { callId, outcome: "ok", result: { closed: true } };
    }
  }

  /**
   * 003's navigation, with 008's one addition (a page that asked to stay is not left, FR-115) and
   * 014's: the origin this call asked for is on the record while it moves (rule (e), FR-185).
   *
   * Around the whole call rather than around the move alone, and released in a `finally`: the
   * arrival is heard asynchronously, and an expectation dropped the instant `navigateTab` resolved
   * would be gone before the commit it was registered for was reported. A history move registers
   * nothing - it names no origin, so there is nothing to expect and the destination is whatever
   * the tab was on before, which the session already knows.
   */
  async function navigateTabTool(
    request: AgentNativeRequest,
    tabId: number,
    args: Record<string, unknown>,
    watch: { settled: Promise<BeforeunloadOutcome> } | undefined,
  ): Promise<AgentNativeResponse> {
    const asked = typeof args.url === "string" ? args.url : undefined;
    if (asked === undefined) return navigateTabNow(request, tabId, args, watch);
    await deps.transitions?.expectNavigate(request.sessionId, tabId, asked);
    try {
      return await navigateTabNow(request, tabId, args, watch);
    } finally {
      await deps.transitions?.endNavigate(request.sessionId, tabId);
    }
  }

  async function navigateTabNow(
    request: AgentNativeRequest,
    tabId: number,
    args: Record<string, unknown>,
    watch: { settled: Promise<BeforeunloadOutcome> } | undefined,
  ): Promise<AgentNativeResponse> {
    const { callId, sessionId } = request;
    const url = typeof args.url === "string" ? args.url : undefined;
    const direction = args.direction as "back" | "forward" | undefined;
    const settling = settleAfter(
      tabId,
      async () => {
        if (url !== undefined) {
          await navigateTab(tabId, url);
          return;
        }
        await (direction === "back" ? goBackInTab(tabId) : goForwardInTab(tabId));
      },
      // Only a url can be one the browser downloads; history moves go to pages it rendered.
      url === undefined ? undefined : { sessionId, url },
    );
    /**
     * Raced, not awaited (FR-115, §3.1: the reference's own shape).
     *
     * A page that asked to stay never settles anything - the navigation simply does not happen -
     * so awaiting the watcher would spend the whole navigation bound before saying the one thing
     * the agent needed to hear. The stay outcome answers at once; a `leave` outcome resolves
     * nothing here and the navigation's own settle is what ends the call, as it always did.
     */
    const raced = await Promise.race([
      settling.then((settled) => ({ kind: "settled" as const, settled })),
      stayedWithin(watch, BEFOREUNLOAD_WAIT_MS).then((outcome) =>
        outcome?.action === "stay"
          ? { kind: "stayed" as const, outcome }
          : new Promise<never>(() => {}),
      ),
    ]);
    if (raced.kind === "stayed") {
      // Nothing moved: the document is the one it was, so no binding is invalidated and nothing is
      // announced. The agent is told which page refused, which is what `force` is then aimed at.
      const here = await getTabSnapshot(tabId);
      return blockedByBeforeunload(callId, raced.outcome.url || here?.url || "");
    }
    const settled = raced.settled;
    // Whether or not it settled, the document the refs were minted against may already be gone.
    deps.bindings.invalidate(tabId);
    deps.onTabNavigated?.(tabId);
    // Announced even when the navigation failed: the tab may still have left the page it was on.
    deps.onTabsChanged?.();
    if (!settled.ok) {
      return answer(callId, "failed", settled.reason);
    }
    const after = await getTabSnapshot(tabId);
    if (!after) {
      return answer(callId, "stale", "tab-gone");
    }
    return {
      callId,
      outcome: "ok",
      result: { url: after.url, ...(settled.download === undefined ? {} : { download: settled.download }) },
    };
  }

  return {
    handles(tool) {
      return (TAB_TOOL_NAMES as readonly string[]).includes(tool);
    },
    run: runTool,
  };
}
