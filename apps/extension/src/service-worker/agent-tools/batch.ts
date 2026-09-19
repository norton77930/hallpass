import {
  agentToolArgSchemas,
  isAgentEffectTool,
  type AgentBatchStepResult,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolName,
} from "@hallpass/contracts";
import type { SiteModeStore } from "../site-mode-store.js";
import type { StatedPlanStep } from "./gate.js";
import type { StatedPlanStore } from "./plans.js";
import type { AgentPromptController } from "./prompts.js";
import { batchStepCallId, type AgentStopSignals } from "./stop.js";
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
  dispatch: (request: AgentNativeRequest) => Promise<AgentNativeResponse>;
  reportDiagnostic?: (code: string) => void;
};

export type AgentBatchRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
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
  async function runBatch(request: AgentNativeRequest): Promise<AgentNativeResponse> {
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
        sessionId: request.sessionId,
        site,
        steps: steps.map((step, index) => ({
          tool: step.tool,
          summary: summariseToolCall(step.tool, stepArgs[index] ?? {}),
        })),
      });
      if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
      // FR-043's rule for a question nobody answered, applied to the whole batch: nothing ran.
      if (asked.decision === "timed-out") return answer(callId, "timed-out", "no-answer");
      // 006 FR-087: the owner's Stop, in the word every stopped call gets; nothing ran here either.
      if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
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
    try {
      for (const [index, step] of steps.entries()) {
        if (handle.stopped()) {
          // FR-046: Stop ends the current call and every queued step. The steps already answered
          // keep their answers - a step that reached the page is reported as what the page did,
          // never as prevented - and the ones that never started say so in the owner's word.
          for (let rest = index; rest < steps.length; rest += 1) {
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
        });
        /**
         * A step that raised a dialog stops the batch too (008/FR-111, US3 edge case).
         *
         * It is the existing stop-at-first-failure rule reaching one step further, because this
         * step did *not* fail: the click landed and the page asked a question about it. Every later
         * step would answer `blocked-by-dialog` anyway - the dispatch point sees to that - so
         * running them would spend the batch on refusals and bury the one answer that matters.
         */
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
    return { callId, outcome: "ok", result: { results } };
  }

  return {
    handles(tool) {
      return tool === "browser_batch";
    },
    run: runBatch,
  };
}
