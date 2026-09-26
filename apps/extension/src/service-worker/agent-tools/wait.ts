import {
  agentToolArgSchemas,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolName,
  type AgentWaitCondition,
  type AgentWaitDownload,
  type CurrentDialog,
  type WaitCondition,
} from "@hallpass/contracts";
import { evaluateConditionOnLeasedTab } from "../content-broker.js";
import { DEFAULT_WAIT_POLL_MS } from "../shared-port.js";
import type { AgentSessionContexts, AgentToolContext } from "./context.js";
import { bindingFailureResponse, type AgentPageBinding, type AgentPageBindings } from "./page-binding.js";
import { discoverRefFrame, resolveRef, type RefFrame } from "./refs.js";
import type { AgentStopSignals } from "./stop.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";

/**
 * `wait` (003/T050, US5, FR-048).
 *
 * The tool that observes and changes nothing, which is why it is the one tool with no site mode
 * anywhere near it: there is nothing here for the owner to consent to. What it owes the agent is an
 * *explicit ending*, and there are four - the condition held, the bound was reached, the owner
 * stopped it, or the document it was watching went away - because an agent does different things
 * for each, and a single "not met" would have flattened three of them into a page it should look at
 * again.
 *
 * It is 002's wait, asked on an explicit tab. The condition is decided by the content runtime
 * against a handle the registry already holds (`evaluateConditionOnLeasedTab`), at 002's poll
 * interval, so the four conditions mean exactly what they mean for the remote caller and a page is
 * never asked anything a plan step would not have asked it.
 *
 * The bound belongs to the worker, as every deadline that means something does: the host's own
 * timeout for a wait is this bound plus slack (`agentCallBoundMs`), so the agent is told
 * `bound-reached` in the tool's words rather than losing the call to the transport.
 *
 * One condition is not the page's to decide (005/T182, FR-078, R-124): `download-complete` asks
 * the worker's own record of the browser's downloads, each poll, for the session's next completion.
 * It shares everything else with the four - the tab check, the bound, the Stop - and never sends the
 * page a frame.
 */

export type AgentWaitDeps = {
  context: AgentSessionContexts;
  bindings: AgentPageBindings;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  /** FR-048: a Stop ends a wait at once, wherever it is - including inside a batch. */
  stops: AgentStopSignals;
  evaluate?: typeof evaluateConditionOnLeasedTab;
  /** 004/T160: which frame owns `ref`, when it names one. Overridable the way `evaluate` is. */
  discoverFrame?: typeof discoverRefFrame;
  /** How finely the interval up to the bound is sampled; 002's, because it is the same page. */
  pollMs?: number;
  /**
   * The session's next download completion, if there is one to answer (`DownloadObserver`). Asked
   * once per poll of a `download-complete` wait; answering it is what moves the session's watermark.
   */
  downloads?: { takeCompletion(sessionId: string): Promise<AgentWaitDownload | undefined> };
  /**
   * The dialog open on the tab being waited on (008/T226, FR-111).
   *
   * A wait is one of the four calls a dialog does not block, and that is deliberate: it is how an
   * agent that is waiting finds out *why* nothing is happening. A page held still by a confirm will
   * never satisfy any condition, so the wait ends at once with the dialog attached rather than
   * spending its whole bound on a document nobody can change.
   */
  currentDialog?: (tabId: number) => CurrentDialog | undefined;
  reportDiagnostic?: (code: string) => void;
};

export type AgentWaitRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
};

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

export function createAgentWait(deps: AgentWaitDeps): AgentWaitRunner {
  const evaluate = deps.evaluate ?? evaluateConditionOnLeasedTab;
  const discoverFrame = deps.discoverFrame ?? discoverRefFrame;
  const pollMs = Math.max(1, deps.pollMs ?? DEFAULT_WAIT_POLL_MS);

  /**
   * The handle whose text is the baseline for a `visible-text-changed` wait that named none.
   *
   * The registry records an element's visible text when it mints its handle, so "has the text
   * changed" is always a question about *some* handle. Without a ref the worker asks the tab what
   * it currently has focused - `<body>` on a page nobody has clicked into - through the same
   * live-element resolution a point goes through, so this baseline has the one lifetime every other
   * ref has and goes stale with the same navigation.
   */
  async function baselineRef(
    context: AgentToolContext,
    binding: AgentPageBinding,
  ): Promise<{ ok: true; ref: string } | { ok: false; response: (callId: string) => AgentNativeResponse }> {
    const resolved = await resolveRef(context, binding, undefined);
    if (resolved.ok) return resolved;
    return {
      ok: false,
      response: (callId) =>
        resolved.reason === "stale"
          ? answer(callId, "stale", "stale-context")
          : answer(callId, "failed", resolved.reason),
    };
  }

  async function runWait(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    // Registered before the first `await`, so a Stop that arrives in the same turn as the call -
    // the batch case, where the step and the Stop are both already in flight - is not missed.
    const handle = deps.stops.begin(callId, request.sessionId);
    /**
     * What ended it, in the registry's own word (014 FR-180).
     *
     * The literal used to be written here because there was one way to end a call. There are
     * two now, and they say opposite things about what is left standing, so the runner reports
     * the word the control that ended it set rather than one of its own. The fallback is the
     * word this line always had, for a flag set by something that named no reason.
     */
    const endedByOwner = (): AgentNativeResponse =>
      answer(callId, "stopped", handle.reason() ?? "owner-stopped");
    try {
      const parsed = agentToolArgSchemas.wait.safeParse(request.args);
      if (!parsed.success) {
        return answer(callId, "failed", "invalid-arguments");
      }
      const args = parsed.data as {
        tabId: number;
        forMs?: number;
        condition?: AgentWaitCondition;
        ref?: string;
        maxMs?: number;
      };
      const ownership = await deps.tabOwnership(request.sessionId, args.tabId);
      if (ownership.state !== "this") {
        return ownershipRefusal(callId, ownership);
      }
      /**
       * The lease, read again before every poll (006 FR-087). The owner can hand the tab back from
       * the panel while a wait is running, and a wait that kept asking about it would be a session
       * still watching a page that is no longer its own. The read is local, so it costs nothing a
       * poll does not already cost; `undefined` means the tab is still held.
       */
      const released = async (): Promise<AgentNativeResponse | undefined> => {
        const held = await deps.tabOwnership(request.sessionId, args.tabId);
        return held.state === "this" ? undefined : ownershipRefusal(callId, held);
      };

      const startedAt = Date.now();
      // Wall-clock deltas, floored at zero: the machine can step its clock back mid-wait, and
      // `waitedMs` is a non-negative number in the contract.
      const elapsedMs = (): number => Math.max(0, Date.now() - startedAt);

      if (args.forMs !== undefined) {
        const boundMs = args.forMs;
        while (elapsedMs() < boundMs) {
          if (handle.stopped()) return endedByOwner();
          const refusal = await released();
          if (refusal) return refusal;
          await sleep(Math.min(pollMs, Math.max(1, boundMs - elapsedMs())));
        }
        if (handle.stopped()) return endedByOwner();
        // A fixed wait's condition is the time itself, so it ends the one way a wait can end well.
        return { callId, outcome: "ok", result: { outcome: "condition-met", waitedMs: elapsedMs() } };
      }

      const boundMs = args.maxMs ?? 0;

      if (args.condition === "download-complete") {
        // Decided here, against the session's ring, and the page is never asked: the record is the
        // browser's, and a document that navigated or went away changes nothing about it.
        for (;;) {
          if (handle.stopped()) return endedByOwner();
          const refusal = await released();
          if (refusal) return refusal;
          let download: AgentWaitDownload | undefined;
          try {
            download = await deps.downloads?.takeCompletion(request.sessionId);
          } catch {
            deps.reportDiagnostic?.("agent.wait.downloads-failed");
            return answer(callId, "failed", "evaluate-failed");
          }
          if (handle.stopped()) return endedByOwner();
          if (download) {
            return { callId, outcome: "ok", result: { outcome: "condition-met", waitedMs: elapsedMs(), download } };
          }
          const elapsed = elapsedMs();
          if (elapsed >= boundMs) {
            return answer(callId, "failed", "bound-reached");
          }
          await sleep(Math.min(pollMs, Math.max(1, boundMs - elapsed)));
        }
      }

      const condition = args.condition as WaitCondition;
      const context = deps.context.forCall(request.sessionId, callId);
      const bound = await deps.bindings.bind(args.tabId, context);
      if (!bound.ok) {
        return bindingFailureResponse(callId, bound, "not-actionable");
      }
      const binding = bound.binding;
      let targetHandle = args.ref;
      if (targetHandle === undefined) {
        const baseline = await baselineRef(context, binding);
        if (!baseline.ok) return baseline.response(callId);
        targetHandle = baseline.ref;
      }

      // 004/T160: these refs carry no frame identity of their own - resolved once, here, rather
      // than on every tick, since the frame a ref lives in does not change while the wait runs.
      const frame: RefFrame | undefined = await discoverFrame(context, binding, targetHandle);

      /**
       * The one ending that is neither the condition nor the bound (008/FR-111, US3 edge case).
       *
       * A dialog holds the document still, so the condition cannot become true and the page cannot
       * even be asked. `condition-unmet` says exactly that - something *was* observed, and it was
       * the reason - and it carries the dialog so the next call is `dialog` rather than another
       * wait. Checked each turn rather than once, because the dialog usually opens mid-wait.
       */
      const interrupted = (): AgentNativeResponse | undefined => {
        const dialog = deps.currentDialog?.(args.tabId);
        return dialog === undefined
          ? undefined
          : { callId, outcome: "ok", result: { outcome: "condition-unmet", waitedMs: elapsedMs(), dialog } };
      };

      for (;;) {
        if (handle.stopped()) return endedByOwner();
        const refusal = await released();
        if (refusal) return refusal;
        const blocked = interrupted();
        if (blocked) return blocked;
        let reply: Awaited<ReturnType<typeof evaluateConditionOnLeasedTab>>;
        try {
          reply = await evaluate({
            taskId: context.taskId,
            operationId: context.operationId,
            runtimeEpochId: context.runtimeEpochId,
            nonce: context.nonce,
            expectedTabId: binding.tabId,
            canonicalOrigin: binding.canonicalOrigin,
            documentEpoch: frame ? frame.documentEpoch : binding.documentEpoch,
            generalPageReadGrantId: context.generalPageReadGrantId,
            targetHandle,
            condition,
            ...(frame ? { frameId: frame.frameId, frameOrigin: frame.canonicalOrigin } : {}),
          });
        } catch {
          deps.reportDiagnostic?.("agent.wait.evaluate-failed");
          return answer(callId, "failed", "evaluate-failed");
        }
        if (handle.stopped()) return endedByOwner();
        if (!reply.ok) {
          const stale =
            reply.reason === "stale-context" || reply.reason === "stale-binding" || reply.reason === "stale-target";
          if (stale) {
            // The document the wait was watching is gone, and so is every handle bound to it. That
            // is not "the condition did not hold"; nothing was observed at all.
            deps.bindings.invalidate(binding.tabId);
            return answer(callId, "stale", "document-changed");
          }
          return answer(callId, "failed", "evaluate-failed");
        }
        if (reply.holds) {
          return { callId, outcome: "ok", result: { outcome: "condition-met", waitedMs: elapsedMs() } };
        }
        const elapsed = elapsedMs();
        if (elapsed >= boundMs) {
          // FR-048: reaching the bound is an explicit answer, not a silence.
          return answer(callId, "failed", "bound-reached");
        }
        await sleep(Math.min(pollMs, Math.max(1, boundMs - elapsed)));
      }
    } finally {
      handle.end();
    }
  }

  return {
    handles(tool) {
      return tool === "wait";
    },
    run: runWait,
  };
}
