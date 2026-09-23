import {
  agentToolArgSchemas,
  isAgentEffectTool,
  type AgentBatchStepResult,
  type AgentNativeResponse,
  type AgentToolName,
} from "@hallpass/contracts";
import type { SiteModeStore } from "../site-mode-store.js";
import type { StatedPlanStep } from "./gate.js";
import type { StatedPlanStore } from "./plans.js";
import { hintWithTransitionNotice } from "./transitions.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import { batchStepCallId, type AgentStopSignals, type AgentToolRequest } from "./stop.js";
import { summariseToolCall } from "./summaries.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";

/**
 * `browser_batch` (003/T048, US5, FR-046, FR-047).
 *
 * The batch is a *sequencer*, not a second way to act on a page. Every step is handed to the same
 * dispatch a single call would have taken, with the batch's tab attached, so "each effect is subject
 * to the site's mode exactly as if it had been sent alone" is true by construction: there is no
 * second copy of the gate here to fall out of step with the first. That is also why a `navigate`
 * step needs no special handling - the step after it binds the tab again and reads the destination
 * site's own mode (US5 scenario 3).
 *
 * One thing the batch does decide, and it is the whole of `follow-a-plan` (US3 scenario 5). On a
 * site the owner set to that mode, the batch is projected as one question - the steps, in words -
 * and their yes becomes the session's StatedPlan for that site. The gate then admits exactly those
 * steps, in order, once each; anything else on that site is still an `ask`. Under `ask` the batch
 * asks nothing of its own and each effect prompts as it is reached, which is the rule that keeps a
 * batch from ever being *wider* than the mode it runs under.
 *
 * The batch's own outcome is `ok` whenever it ran at all: what each step did is in the results, and
 * folding a failed step into the call's outcome would lose that list entirely - the host reports a
 * non-`ok` call as its outcome and reason alone. A batch that never started - an unowned tab, a
 * plan the owner refused - answers with that refusal and no results, because nothing ran.
 */

export type AgentBatchDeps = {
  siteModes: SiteModeStore;
  /** Where the owner's approved batch lives while it runs; the gate reads it through the effects. */
  plans: StatedPlanStore;
  prompts: Pick<AgentPromptController, "askPlan">;
  stops: AgentStopSignals;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  /**
   * The site the tab is on right now, as `site-mode-store` keys it - the same value the gate will
   * use for each step. Undefined when the tab cannot be bound at all (a blank tab a `navigate` step
   * is about to fix), in which case the batch states no plan and every step decides for itself.
   */
  siteOfTab: (sessionId: string, tabId: number, callId: string) => Promise<string | undefined>;
  /** One step, answered exactly as it would have been if the agent had sent it by itself. */
  dispatch: (request: AgentToolRequest) => Promise<AgentNativeResponse>;
  /**
   * The move nobody has decided about yet, on the tab this batch is running on (014 FR-187).
   *
   * Asked here, before each step, rather than left to the step's own dispatch, because the answer
   * would otherwise be a card raised in the middle of a sequence the owner is not watching - and
   * the person deciding "may this session work on that site" deserves to be asked about *the
   * session*, not about step four of something they approved as a whole. The batch stops instead,
   * says where the tab went, and the agent's next single call is what asks.
   */
  pendingTransition?: (sessionId: string, tabId: number) => Promise<{ from: string; to: string } | undefined>;
  reportDiagnostic?: (code: string) => void;
};

export type AgentBatchRunner = {
  handles(tool: AgentToolName): boolean;
  /** The dispatch point's own request: a batch reads the stop handle on it (014 FR-179). */
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

type ParsedStep = { tool: AgentToolName; args: Record<string, unknown> };

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

/**
 * The arguments as the tool itself will read them, defaults and all.
 *
 * It matters only for the stated plan: the gate compares a later call's *parsed* arguments against
 * the plan's, so a plan holding the raw ones would fail to match its own step the moment a schema
 * default filled a field in. A step whose arguments the schema refuses is kept as it came - it will
 * be refused with `invalid-arguments` when it is reached, before it ever meets the gate.
 */
function parsedArgs(tool: AgentToolName, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = agentToolArgSchemas[tool].safeParse(args);
  return parsed.success ? (parsed.data as Record<string, unknown>) : args;
}

export function createAgentBatch(deps: AgentBatchDeps): AgentBatchRunner {
  async function runBatch(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const parsed = agentToolArgSchemas.browser_batch.safeParse(request.args);
    if (!parsed.success) {
      // Nesting, a step naming its own tab, a tab tool that would change which tab this is about:
      // the contract refuses all three, and the batch is refused whole rather than partly run.
      return answer(callId, "failed", "invalid-arguments");
    }
    const { tabId, steps } = parsed.data as { tabId: number; steps: ParsedStep[] };
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") {
      return ownershipRefusal(callId, ownership);
    }

    // The batch's tab, on every step. A step carries none of its own (the contract refuses one), so
    // this is the single place the tab a step runs on can come from.
    const stepArgs = steps.map((step) => ({ ...step.args, tabId }));
    const excluded = new Set<number>();
    let planId: string | undefined;

    const site = await deps.siteOfTab(request.sessionId, tabId, callId);
    const mode = site === undefined ? undefined : (await deps.siteModes.get(site)).mode;
    if (site !== undefined && mode === "follow-a-plan") {
      const asked = await deps.prompts.askPlan({
        callId,
        // Whether the owner ended this batch before its one question could be raised (014 FR-179).
        stopped: request.stopped,
        sessionId: request.sessionId,
        site,
        steps: steps.map((step, index) => ({
          tool: step.tool,
          summary: summariseToolCall(step.tool, stepArgs[index] ?? {}),
        })),
      });
      if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
      // FR-043's rule for a question nobody answered, applied to the whole batch: nothing ran.
      if (asked.decision === "timed-out") return noAnswerResponse(callId, asked);
      // 006 FR-087: the owner's Stop, in the word every stopped call gets; nothing ran here either.
      if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
      // 014 FR-179: interrupted before a single step ran, so there is no partial report to make.
      if (asked.decision === "interrupted") return answer(callId, "stopped", "owner-interrupted");
      if (asked.decision === "deny") return answer(callId, "denied", "owner-denied");
      // The tab may have been handed back while the plan stood (006 FR-087, S1 review): every
      // step would refuse on its own, but a plan stated for a tab the session no longer holds is
      // consent for nothing, so the batch is refused whole before any of it is admitted.
      const held = await deps.tabOwnership(request.sessionId, tabId);
      if (held.state !== "this") return ownershipRefusal(callId, held);
      if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
      for (const index of asked.excluded) excluded.add(index);
      planId = asked.planId;
      const stated: StatedPlanStep[] = [];
      for (const [index, step] of steps.entries()) {
        // Only the effects, and only the ones the owner left in. The gate sees effects and nothing
        // else, so a plan that counted a read among its steps would admit them out of step with
        // itself; a struck-out step is not in the plan because the owner did not approve it.
        if (excluded.has(index) || !isAgentEffectTool(step.tool)) continue;
        stated.push({ tool: step.tool, args: parsedArgs(step.tool, stepArgs[index] ?? {}) });
      }
      deps.plans.set({ planId, site, steps: stated, admittedCount: 0 });
    }

    const handle = deps.stops.begin(callId, request.sessionId);
    const results: AgentBatchStepResult[] = [];
    /**
     * Where the owner's 中斷 caught it, and what its step said (014 FR-180).
     *
     * `undefined` is an ordinary batch, which answers exactly what it always did. When it is set,
     * the answer stops being `ok`: the sequence did not finish and saying it did - with a list the
     * agent would have to read backwards to discover otherwise - is the dishonest shape this
     * feature exists to avoid.
     */
    let interruptedAt: number | undefined;
    /** Where the *browser* stopped it: the tab is somewhere nobody has decided about (FR-187). */
    let stoppedAt: number | undefined;
    try {
      for (const [index, step] of steps.entries()) {
        const moved = await deps.pendingTransition?.(request.sessionId, tabId);
        if (moved) {
          // The step never started, and it says why in the same three lists an interrupt uses:
          // what ran, where it stopped, what was never attempted.
          stoppedAt = index;
          // The same bound the single call's answer applies (T369 review F7): the notice gives way
          // to the field's 400 characters, never the step's own three words about what happened.
          const notice = hintWithTransitionNotice(moved.from, moved.to);
          results.push({
            index,
            outcome: "stopped",
            reason: "site-transition",
            ...(notice === undefined ? {} : { hint: notice }),
          });
          for (let rest = index + 1; rest < steps.length; rest += 1) {
            results.push({ index: rest, outcome: "stopped", reason: "not-run" });
          }
          break;
        }
        if (handle.stopped()) {
          /**
           * 014 FR-180: the owner interrupted between steps, so this is the step the batch was on.
           *
           * It is named as the interrupted one, and it is deliberately *not* in `completed`: the
           * three lists together say that nothing of it ran, which is more than its own line could
           * say on its own. A stop keeps the word it has always had for every remaining step.
           */
          if (handle.reason() === "owner-interrupted") {
            interruptedAt = index;
            results.push({ index, outcome: "stopped", reason: "owner-interrupted" });
          }
          // FR-046: Stop ends the current call and every queued step. The steps already answered
          // keep their answers - a step that reached the page is reported as what the page did,
          // never as prevented - and the ones that never started say so in the owner's word.
          for (let rest = interruptedAt === undefined ? index : index + 1; rest < steps.length; rest += 1) {
            results.push({ index: rest, outcome: "stopped", reason: "not-run" });
          }
          break;
        }
        if (excluded.has(index)) {
          results.push({ index, outcome: "denied", reason: "excluded" });
          continue;
        }
        const response = await deps.dispatch({
          callId: batchStepCallId(callId, index),
          // The call the host is holding and the relay can route (011 review H1). A question this
          // step raises says it is still waiting under this id, because the step's own is a name
          // only this worker knows - a tick carrying it is dropped on the way back.
          hostCallId: callId,
          // 004 S1: a step belongs to the session the batch belongs to - one call frame, one
          // session. Nothing reads it yet; S1 is the slice that routes on it.
          sessionId: request.sessionId,
          tool: step.tool,
          tabId,
          args: stepArgs[index] ?? {},
        });
        results.push({
          index,
          outcome: response.outcome,
          ...(response.result === undefined ? {} : { result: response.result }),
          ...(response.reason === undefined ? {} : { reason: response.reason }),
          // 011 FR-146: the step's own answer may carry the person's instruction, and a batch is
          // where a consent card most often meets a closed panel. Passed on, never composed here.
          ...(response.hint === undefined ? {} : { hint: response.hint }),
        });
        /**
         * A step that raised a dialog stops the batch too (008/FR-111, US3 edge case).
         *
         * It is the existing stop-at-first-failure rule reaching one step further, because this
         * step did *not* fail: the click landed and the page asked a question about it. Every later
         * step would answer `blocked-by-dialog` anyway - the dispatch point sees to that - so
         * running them would spend the batch on refusals and bury the one answer that matters.
         */
        /**
         * The step itself was interrupted (014 FR-180): the dispatch point answered it while it
         * was in flight, so the batch stops here and carries the step's own sentence outwards -
         * only that step knows whether its input had already reached the page (FR-181).
         */
        if (response.outcome === "stopped" && response.reason === "owner-interrupted") {
          interruptedAt = index;
          for (let rest = index + 1; rest < steps.length; rest += 1) {
            results.push({ index: rest, outcome: "stopped", reason: "not-run" });
          }
          break;
        }
        const raisedDialog =
          response.outcome === "ok" &&
          typeof response.result === "object" &&
          response.result !== null &&
          "dialog" in (response.result as Record<string, unknown>);
        if (response.outcome !== "ok" || raisedDialog) {
          // FR-047: the batch stops at the first failure. The rest are reported as what they are -
          // not attempted - rather than as failures of their own.
          for (let rest = index + 1; rest < steps.length; rest += 1) {
            results.push({ index: rest, outcome: "failed", reason: "not-run" });
          }
          break;
        }
      }
    } finally {
      handle.end();
      // The plan belonged to this batch. Leaving it behind would be standing consent for a call the
      // owner approved once, as part of a sequence that is over.
      if (planId !== undefined) deps.plans.clear(planId);
    }
    if (stoppedAt !== undefined) {
      /**
       * The same shape an interrupt answers with, and for the same reason (S1 ruling): the host
       * composes an error reply from the outcome and the reason alone, so a top-level `stopped`
       * would reach the agent with none of the three lists. The word `site-transition` is on the
       * step, which is where the agent reads why the sequence ended.
       */
      return {
        callId,
        outcome: "ok",
        result: {
          results,
          completed: results.filter((step) => step.outcome === "ok").map((step) => step.index),
          stoppedAt,
          notRun: results.filter((step) => step.index > stoppedAt).map((step) => step.index),
        },
      };
    }
    if (interruptedAt === undefined) return { callId, outcome: "ok", result: { results } };
    /**
     * The three groups the agent asked for by asking "how far did it get" (014 FR-180, US1
     * scenario 2).
     *
     * `completed` is what ended `ok` - the only outcome that means the page did the thing - and
     * the two lists around it are positions, not prose: the steps that never started are named so
     * the agent can re-send exactly them, and the interrupted one is named so it can decide
     * whether to check the page first.
     *
     * The answer stays `ok`, which is what a partially-run batch has always answered: the host
     * composes an *error* reply from the outcome and the reason alone and drops the result with
     * them (`mcp-server.ts` `toolReply`), so a `stopped` batch would reach the agent as three
     * words and none of the three lists. The interruption is therefore said where it survives the
     * trip - on the step it happened to, which carries `owner-interrupted` and, when its input had
     * already gone out, the sentence that says so (FR-181).
     */
    return {
      callId,
      outcome: "ok",
      result: {
        results,
        completed: results.filter((step) => step.outcome === "ok").map((step) => step.index),
        interruptedAt,
        notRun: results.filter((step) => step.index > interruptedAt).map((step) => step.index),
      },
    };
  }

  return {
    handles(tool) {
      return tool === "browser_batch";
    },
    run: runBatch,
  };
}
