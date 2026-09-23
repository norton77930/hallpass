import {
  agentToolArgSchemas,
  type AgentActivityItem,
  type AgentNativeResponse,
  type AgentNotice,
  type AgentToolName,
  type CurrentDialog,
  type SiteMode,
} from "@hallpass/contracts";
import type { TabOwnership } from "../agent-tab-manager.js";
import { decideGate, type StatedPlan } from "./gate.js";
import { ownershipRefusal } from "./ownership.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import type { AgentToolRequest } from "./stop.js";

/**
 * The dialogs a page opens, and the one decision answering them can cost (008/T225, US3,
 * FR-110..FR-117).
 *
 * A native dialog is the one thing that stops a page being a page: nothing is readable, nothing is
 * clickable, and every command this worker sends waits for a renderer that will not answer until
 * somebody presses a button. Both references live with that - they let the command time out and
 * tell the agent the renderer "may be frozen or unresponsive" (design-notes §3). This module
 * exists so the agent is told the truth instead: *which* dialog is in the way, in the page's own
 * words, and what it can do about it.
 *
 * Three rules shape everything here.
 *
 *   - **The dialog is heard, not searched for.** Two events - `Page.javascriptDialogOpening` and
 *     `Page.javascriptDialogClosed` - arrive on the tab's existing attachment and are the only
 *     things this module consumes (R-138). `onDebuggerEvent` is the switch that drops every other
 *     `Page.*` event, and it is deliberately the *only* subscriber to that domain in this worker:
 *     the exception the attachment's header states is worth exactly as much as this switch is.
 *   - **Accepting is an effect; dismissing is not.** Pressing OK on a confirm agrees to whatever
 *     the page was asking, so it goes through the same gate a click does (D-008-4, owner Q7).
 *     Cancel changes nothing and an alert has one button, so neither ever reaches the owner. The
 *     one exemption is *chaining*: a dialog that opened within a second of an effect the owner has
 *     just approved on that tab is part of that action, and asking again would be asking twice for
 *     one decision - so it is shown as a notice instead (R-139, FR-114).
 *   - **"Leave site?" is not the agent's to answer.** One the agent's own `navigate` or
 *     `tabs_close` raised is answered by policy at once - stay, so nothing unsaved is lost - and the
 *     call that ran into it is told so; `force` flips the policy for the length of that one gated
 *     call and nothing longer. One *nobody armed* belongs to the owner, who is still using their own
 *     browser on a tab an agent happens to hold, and is left untouched (R-140, FR-115).
 *
 * And one addition neither reference has: after any dialog is answered the tab is asked a trivial
 * question, and 300 ms of silence is reported as `page-unresponsive` (FR-116). A page that froze
 * on OK and a page that is merely slow are indistinguishable otherwise, and the difference is the
 * whole of what the agent's next move should be.
 */

/** How long after an approved effect a dialog still counts as part of it (R-139, FR-112). */
export const DIALOG_CHAIN_WINDOW_MS = 1000;

/** How long the tab is given to answer the trivial read after a dialog was handled (FR-116). */
export const DIALOG_LIVENESS_MS = 300;

/** The two dialog events this worker consumes, and the whole of what it consumes (R-138). */
const DIALOG_OPENING = "Page.javascriptDialogOpening";
const DIALOG_CLOSED = "Page.javascriptDialogClosed";

const DIALOG_TOOL: AgentToolName = "dialog";

/** The dialog's text, bounded as the contract bounds it: page-authored, carried whole, never read. */
const MESSAGE_MAX = 4000;

/**
 * What a "leave site?" prompt was answered with, for the `navigate` / `tabs_close` that caused it
 * (data-model BeforeunloadOutcome). It is never a current dialog: by the time any tool could ask
 * about it, it is already answered.
 */
export type BeforeunloadOutcome = { tabId: number; action: "stay" | "leave"; url: string; at: number };

/** One effect the gate admitted or the owner allowed, per tab (data-model LastApprovedEffect). */
export type ApprovedEffect = { tool: string; approvedAt: number };

/**
 * The policy in force for one call that may meet a "leave site?" prompt, and the outcome it is
 * waiting for. `end()` puts the tab back to `stay`, which is what makes `force` a property of one
 * call rather than of the tab.
 */
export type UnloadWatch = { settled: Promise<BeforeunloadOutcome>; end(): void };

export type AgentDialogsDeps = {
  /** One protocol command on the tab's existing attachment (`input.ts`'s `send`). */
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  siteModes: {
    get(site: string): Promise<{ mode: SiteMode }>;
    set(site: string, patch: { mode: SiteMode }): Promise<unknown>;
  };
  prompts: Pick<AgentPromptController, "ask">;
  tabOwnership(sessionId: string, tabId: number): Promise<TabOwnership>;
  /**
   * The origin of the page the dialog belongs to, read from the browser's own record of the tab.
   *
   * Deliberately not the page binding every effect uses: a tab with a dialog open answers no
   * content message at all, so binding it would wait for the very page this call is about to
   * unblock. The browser knows where the tab is without asking the renderer.
   */
  siteOfTab(tabId: number): Promise<string | undefined>;
  /** Which session holds the tab, for the card an event-driven outcome is logged on. */
  holderOf(tabId: number): Promise<string | undefined>;
  onActivity(sessionId: string, item: AgentActivityItem): void;
  onNotice(sessionId: string, notice: AgentNotice): void;
  statedPlan?: (site: string) => StatedPlan | undefined;
  onAdmitted?: (site: string, step: number) => void;
  now?: () => number;
  livenessMs?: number;
  chainWindowMs?: number;
  reportDiagnostic?: (code: string) => void;
};

export type AgentDialogs = {
  handles(tool: string): boolean;
  /** The dispatch point's own request: the dialog's question reads the stop handle on it (FR-179). */
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
  /**
   * The debugger fan-out's one dialog consumer (R-138): exactly two methods are read and every
   * other event - of this domain or any other - is dropped here.
   */
  onDebuggerEvent(tabId: number, method: string, params: Record<string, unknown>): void;
  /** The dialog open on that tab, for the block every other tool answers with (FR-111). */
  current(tabId: number): CurrentDialog | undefined;
  /** Written by `effects.ts` when the gate admits or the owner allows (data-model LastApprovedEffect). */
  noteApprovedEffect(tabId: number, tool: string): void;
  /** Arms one call's "leave site?" policy and waits for its outcome (FR-115). */
  beginUnload(tabId: number, policy: "stay" | "leave"): UnloadWatch;
  /** The tab is not the session's any more: nothing about it is this module's to remember. */
  forget(tabId: number): void;
};

function refusalAnswer(
  callId: string,
  outcome: AgentNativeResponse["outcome"],
  refusal: Extract<
    AgentNativeResponse["refusal"],
    { reason: "no-dialog" | "page-unresponsive" | "refused" }
  >,
): AgentNativeResponse {
  return { callId, outcome, reason: refusal.reason, refusal };
}

/** The host a dialog belongs to, for the owner's activity list; never the whole url. */
function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

export function createAgentDialogs(deps: AgentDialogsDeps): AgentDialogs {
  const now = (): number => deps.now?.() ?? Date.now();
  const livenessMs = deps.livenessMs ?? DIALOG_LIVENESS_MS;
  const chainWindowMs = deps.chainWindowMs ?? DIALOG_CHAIN_WINDOW_MS;

  /** At most one per tab (data-model CurrentDialog); `beforeunload` never enters it. */
  const current = new Map<number, CurrentDialog>();
  /** Per tab, defaulting to `stay` by absence (data-model BeforeunloadPolicy). */
  const policies = new Map<number, "stay" | "leave">();
  /** The call waiting for one tab's "leave site?" outcome, if any. */
  const unloadWaiters = new Map<number, (outcome: BeforeunloadOutcome) => void>();
  const approved = new Map<number, ApprovedEffect>();
  /** The host the open dialog belongs to, taken from the event, for the owner's activity list. */
  const sites = new Map<number, string>();
  /**
   * The dialogs this worker itself answered. The browser sends `javascriptDialogClosed` for those
   * too, and without this the owner's card would read "closed by hand" about the agent's own OK.
   */
  const answeredByUs = new Set<string>();
  let counter = 0;

  function logActivity(tabId: number, item: Omit<AgentActivityItem, "at">, sessionId?: string): void {
    const at = now();
    if (sessionId !== undefined) {
      deps.onActivity(sessionId, { at, ...item });
      return;
    }
    // Event-driven outcomes have no call to tell them whose tab it is, so the lease is asked.
    void deps
      .holderOf(tabId)
      .then((holder) => {
        if (holder !== undefined) deps.onActivity(holder, { at, ...item });
      })
      .catch(() => deps.reportDiagnostic?.("agent.dialog.activity-failed"));
  }

  function opened(tabId: number, params: Record<string, unknown>): void {
    const type = params.type;
    if (type !== "alert" && type !== "confirm" && type !== "prompt" && type !== "beforeunload") {
      // A dialog kind this contract does not name is not answered by guesswork: it is left to the
      // owner's own browser, and the tools on that tab keep saying the page is busy.
      deps.reportDiagnostic?.("agent.dialog.unknown-type");
      return;
    }
    const url = typeof params.url === "string" ? params.url : "";
    const message = (typeof params.message === "string" ? params.message : "").slice(0, MESSAGE_MAX);
    const site = hostOf(url);

    if (type === "beforeunload") {
      /**
       * Answered here and now, by policy - but only for the call that armed it (R-140, FR-115).
       *
       * A held tab is still the owner's tab: they may press a link, close it, or reload it while
       * the session works elsewhere in the browser, and the "leave site?" prompt their own action
       * raised is theirs to answer. Nothing is armed then, so nothing here touches it - no button
       * is pressed on the owner's behalf and no line appears on the agent's card about a navigation
       * the agent never asked for. Armed by `navigate` / `tabs_close` (`beginUnload`), it is the
       * agent's own prompt and is answered at once.
       *
       * Not carried to the agent as a dialog either way: "the page has unsaved changes" is a fact
       * about the navigation that asked, and the agent gets it as that navigation's own answer.
       */
      const waiting = unloadWaiters.get(tabId);
      if (!waiting) return;
      const action = (policies.get(tabId) ?? "stay") === "leave" ? "leave" : "stay";
      void deps
        .send(tabId, "Page.handleJavaScriptDialog", { accept: action === "leave" })
        .catch(() => deps.reportDiagnostic?.("agent.dialog.handle-failed"));
      const outcome: BeforeunloadOutcome = { tabId, action, url, at: now() };
      waiting(outcome);
      logActivity(tabId, {
        kind: "dialog",
        outcome: action === "leave" ? "left" : "stayed",
        ...(site === undefined ? {} : { site }),
        ...(message === "" ? {} : { message }),
      });
      return;
    }

    counter += 1;
    if (site === undefined) sites.delete(tabId);
    else sites.set(tabId, site);
    const openedAt = now();
    const last = approved.get(tabId);
    const dialog: CurrentDialog = {
      id: `d${counter}`,
      type,
      message,
      openedAt,
      tabId,
      ...(type === "prompt" && typeof params.defaultPrompt === "string"
        ? { defaultValue: params.defaultPrompt.slice(0, MESSAGE_MAX) }
        : {}),
      ...(last && openedAt - last.approvedAt <= chainWindowMs ? { chainedTo: last } : {}),
    };
    current.set(tabId, dialog);
  }

  function closed(tabId: number): void {
    const dialog = current.get(tabId);
    if (!dialog) return;
    current.delete(tabId);
    if (answeredByUs.has(dialog.id)) {
      answeredByUs.delete(dialog.id);
      return;
    }
    // The owner pressed a button in their own browser while the agent was deciding (US3 scenario
    // 9). The card says so, and the next `dialog` call answers `no-dialog` rather than pretending.
    logActivity(tabId, {
      kind: "dialog",
      outcome: "closed-by-owner",
      ...(sites.get(tabId) === undefined ? {} : { site: sites.get(tabId) as string }),
      ...(dialog.message === "" ? {} : { message: dialog.message }),
    });
  }

  /**
   * One trivial question, and what 300 ms of silence means (FR-116, R-140).
   *
   * A command rather than a subscription: `Runtime.evaluate` on the attachment, never
   * `Runtime.enable`, so nothing this worker refuses elsewhere is produced by asking it - the same
   * shape `effects.ts` uses for its cross-frame nonce. An *error* is an answer: the tab replied,
   * even to say no. Only silence is unresponsiveness.
   */
  async function respondsQuickly(tabId: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = deps
      .send(tabId, "Runtime.evaluate", { expression: "1", returnByValue: true })
      .then(() => true)
      .catch(() => true);
    const silence = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), livenessMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([answered, silence]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Presses the dialog's button, and says whether the browser agreed that there was one.
   *
   * The command can be refused - "No dialog is showing" is Chrome's own words for a dialog the
   * owner answered, or a page that went away, between the event and this call. That is not an
   * error to throw at the caller: it is the same fact `no-dialog` already names, so the record of
   * the dialog goes (including this module's note that it was *ours* to close, which nothing would
   * ever remove otherwise) and the caller answers with it.
   */
  async function handle(dialog: CurrentDialog, accept: boolean, promptText?: string): Promise<boolean> {
    answeredByUs.add(dialog.id);
    current.delete(dialog.tabId);
    try {
      await deps.send(dialog.tabId, "Page.handleJavaScriptDialog", {
        accept,
        // Only a prompt has anything to type into, and an absent `promptText` submits the page's own
        // default - which is what pressing OK on it by hand would have sent (FR-112).
        ...(accept && dialog.type === "prompt"
          ? { promptText: promptText ?? dialog.defaultValue ?? "" }
          : {}),
      });
      return true;
    } catch {
      answeredByUs.delete(dialog.id);
      if (current.get(dialog.tabId)?.id === dialog.id) current.delete(dialog.tabId);
      deps.reportDiagnostic?.("agent.dialog.handle-failed");
      return false;
    }
  }

  async function runDialog(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const parsed = agentToolArgSchemas[DIALOG_TOOL].safeParse(request.args);
    if (!parsed.success) return { callId, outcome: "failed", reason: "invalid-arguments" };
    const args = parsed.data as { tabId: number; action: "accept" | "dismiss"; promptText?: string };
    const { tabId, action } = args;

    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") return ownershipRefusal(callId, ownership);

    const dialog = current.get(tabId);
    if (!dialog) {
      // Nothing to answer: never opened, already closed by the browser, or closed by the owner
      // while the agent was deciding (US3 scenario 9).
      return refusalAnswer(callId, "failed", { reason: "no-dialog" });
    }

    /**
     * Whether this costs the owner a decision (D-008-4, FR-112).
     *
     * An alert has one button and a dismiss changes nothing, so neither is ever asked about in any
     * mode. What is left is agreeing to what a confirm or a prompt proposed - which is an effect -
     * unless it rode in on an effect the owner approved a moment ago on this very tab.
     */
    const gated =
      action === "accept" && (dialog.type === "confirm" || dialog.type === "prompt") && dialog.chainedTo === undefined;

    if (gated) {
      const site = await deps.siteOfTab(tabId);
      if (site === undefined) {
        // No site means no mode to decide under: a page the owner cannot have consented to is not
        // one this worker presses OK on.
        return { callId, outcome: "failed", reason: "no-site" };
      }
      const record = await deps.siteModes.get(site);
      const decision = decideGate({
        sessionId: request.sessionId,
        tabId,
        site,
        mode: record.mode,
        tool: DIALOG_TOOL,
        args: args as unknown as Record<string, unknown>,
        ...(deps.statedPlan ? { plan: deps.statedPlan(site) } : {}),
      });
      if (decision.decision === "refuse") return { callId, outcome: "failed", reason: decision.reason };
      if (decision.decision === "admit" && decision.step !== undefined) deps.onAdmitted?.(site, decision.step);
      if (decision.decision === "prompt") {
        const asked = await deps.prompts.ask({
          callId,
          // Which call the host knows it as, when this answer is a batch step (011 review H1).
          hostCallId: request.hostCallId,
          // And whether the owner ended the call while the runner was still getting here (FR-179):
          // an Allow on a card nobody is waiting for would press OK on a page for a settled call.
          stopped: request.stopped,
          sessionId: request.sessionId,
          site,
          tool: DIALOG_TOOL,
          // 011: which sentence the person is told while this card waits; the panel's own wording
          // comes from `kind` below, which is a different question about a different reader.
          promptKind: "dialog",
          // The panel writes the sentence from `kind`; this stays the worker's own record of what
          // was asked, as it is for every other prompt.
          argsSummary: `dialog accept on ${site}`,
          kind: "dialog-accept",
          // The words the owner is deciding about (D-008-5, FR-114).
          dialogText: dialog.message,
        });
        if (asked.decision === "busy") return { callId, outcome: "busy", reason: "prompt-pending" };
        if (asked.decision === "timed-out") return noAnswerResponse(callId, asked);
        if (asked.decision === "stopped") return { callId, outcome: "stopped", reason: "owner-stopped" };
        // 014 FR-179: the step ended, the session did not. The dialog is left exactly as it is.
        if (asked.decision === "interrupted") return { callId, outcome: "stopped", reason: "owner-interrupted" };
        if (asked.decision === "deny") {
          // FR-114: refusing is not leaving the page stuck. The dialog is dismissed - which is the
          // answer that changes nothing - and the agent is told the owner said no. The owner's
          // refusal is the answer even when the dialog turned out to be gone already: `no-dialog`
          // there would report the race and hide the decision.
          await handle(dialog, false);
          logActivity(
            tabId,
            {
              kind: "dialog",
              outcome: "refused",
              ...(sites.get(tabId) === undefined ? {} : { site: sites.get(tabId) as string }),
              ...(dialog.message === "" ? {} : { message: dialog.message }),
            },
            request.sessionId,
          );
          return refusalAnswer(callId, "denied", { reason: "refused" });
        }
        const held = await deps.tabOwnership(request.sessionId, tabId);
        if (held.state !== "this") return ownershipRefusal(callId, held);
        if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
        if (asked.rememberMode) await deps.siteModes.set(site, { mode: asked.rememberMode as SiteMode });
        // The owner may have pressed the dialog's own button in their browser while the card was
        // up; answering a dialog that is no longer there would be a claim about nothing.
        if (current.get(tabId)?.id !== dialog.id) return refusalAnswer(callId, "failed", { reason: "no-dialog" });
      }
    }

    if (!(await handle(dialog, action === "accept", args.promptText))) {
      // The browser says there is no dialog to answer. Nothing was pressed, so nothing is logged
      // and nothing is claimed about the page.
      return refusalAnswer(callId, "failed", { reason: "no-dialog" });
    }

    if (action === "accept" && dialog.chainedTo) {
      /**
       * Spent (FR-112, S4 review): one approval covers one dialog.
       *
       * Left standing, the record would cover every confirm the page opened inside the window - and
       * a page that opens a second one the instant the first is accepted would turn a single click
       * the owner allowed into a sequence of accepts they were never asked about.
       */
      approved.delete(tabId);
      // Told, not asked (FR-114): the owner approved the action this rode in on a moment ago.
      deps.onNotice(request.sessionId, {
        at: now(),
        kind: "dialog-accepted",
        dialogText: dialog.message,
        action: dialog.chainedTo.tool as AgentToolName,
      });
    }
    logActivity(
      tabId,
      {
        kind: "dialog",
        outcome: action === "dismiss" ? "dismissed" : dialog.chainedTo ? "accepted-chained" : "accepted",
        ...(sites.get(tabId) === undefined ? {} : { site: sites.get(tabId) as string }),
        ...(dialog.message === "" ? {} : { message: dialog.message }),
      },
      request.sessionId,
    );

    if (!(await respondsQuickly(tabId))) {
      // FR-116: the dialog is answered and the page still is not there. Said out loud, because a
      // frozen page and a slow one call for different next moves and neither reference tells them
      // apart (design-notes §3).
      return refusalAnswer(callId, "failed", { reason: "page-unresponsive" });
    }
    return { callId, outcome: "ok", result: { ok: true, dialogId: dialog.id, type: dialog.type } };
  }

  return {
    handles(tool) {
      return tool === DIALOG_TOOL;
    },
    run: runDialog,
    onDebuggerEvent(tabId, method, params) {
      // The whole of what this worker consumes from the page-events domain (R-138, D-008-5). Every
      // other event of it - navigations, loads, lifecycle - is dropped here, unbuffered and
      // unreachable, which is what makes the attachment's stated exception checkable.
      if (method === DIALOG_OPENING) {
        opened(tabId, params);
        return;
      }
      if (method === DIALOG_CLOSED) closed(tabId);
    },
    current(tabId) {
      return current.get(tabId);
    },
    noteApprovedEffect(tabId, tool) {
      approved.set(tabId, { tool, approvedAt: now() });
    },
    beginUnload(tabId, policy) {
      policies.set(tabId, policy);
      let settle: ((outcome: BeforeunloadOutcome) => void) | undefined;
      const settled = new Promise<BeforeunloadOutcome>((resolve) => {
        settle = resolve;
      });
      if (settle) unloadWaiters.set(tabId, settle);
      return {
        settled,
        end() {
          // The policy was this call's, never the tab's (data-model BeforeunloadPolicy): a `force`
          // that outlived its call would be standing permission to throw away unsaved work.
          policies.delete(tabId);
          unloadWaiters.delete(tabId);
        },
      };
    },
    forget(tabId) {
      current.delete(tabId);
      policies.delete(tabId);
      unloadWaiters.delete(tabId);
      approved.delete(tabId);
    },
  };
}
