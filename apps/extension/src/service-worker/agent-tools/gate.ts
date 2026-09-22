import { isAgentEffectTool, type AgentToolName, type SiteMode } from "@hallpass/contracts";

/** The tool that answers a page's dialog (008/US3); named once, used by `requiresGate`. */
const DIALOG_TOOL: AgentToolName = "dialog";

/**
 * The per-site gate (003/T025, FR-041, FR-042, R-107).
 *
 * One pure function, because the whole value of the gate is that the rule is legible: an effect the
 * owner has not consented to must not run, and every path to "it may run" is visible in one place.
 * Reading the site's mode, prompting, remembering the answer and carrying the effect out are all
 * somewhere else - the gate answers a question and touches nothing.
 *
 * Three modes, and the safe one is the default the store returns for a site nobody has decided
 * about. Note which way `follow-a-plan` fails: a call that is not the plan's next step is a
 * *prompt*, not a refusal. The owner approved a sequence, not a prohibition, so a step outside it is
 * exactly the case they should be asked about.
 */

/**
 * A sequence the owner approved as a whole for one site (data-model StatedPlan).
 *
 * The only way an agent states a plan is `browser_batch` under `follow-a-plan`: the batch is
 * projected to the panel as one question, the owner's yes - minus any steps they struck out -
 * becomes the plan for that site, and it is admitted here step by step. Nothing else produces one,
 * so a site in that mode with no approved batch behind it prompts, which is the answer `ask` gives
 * and never a wider one.
 */
export type StatedPlanStep = {
  tool: AgentToolName;
  args: Record<string, unknown>;
};

export type StatedPlan = {
  planId: string;
  /** The site the owner approved it for. A plan never carries across sites. */
  site: string;
  steps: readonly StatedPlanStep[];
  /** How many steps have already been admitted. The caller advances it; the gate only reads it. */
  admittedCount: number;
};

export type GateInput = {
  sessionId: string;
  tabId: number;
  /** The origin of the page the effect would land on, as `site-mode-store` keys it. */
  site: string;
  /** The owner's standing decision for that site, defaulted to `ask` by the store. */
  mode: SiteMode;
  tool: AgentToolName;
  args: Record<string, unknown>;
  plan?: StatedPlan | undefined;
};

export type GateDecision =
  /** `step` is present when a plan admitted it, so the caller knows which step to advance past. */
  | { decision: "admit"; step?: number }
  | { decision: "prompt" }
  | { decision: "refuse"; reason: string };

/**
 * Whether this tool's call is the owner's to consent to. Reads and tab tools never enter the gate.
 *
 * `evaluate` and `file_upload` are here beside the effects and are not among them. A script can
 * click, type and navigate (US6 scenario 3), and a file put into a form is a change to the page the
 * next click may send somewhere (US7) - so a site the owner has not waved through is a site they are
 * asked about before either happens. Both stay out of `AGENT_EFFECT_TOOL_NAMES` because that list
 * says which runner *carries an effect out*, and each of these is answered by its own runner behind
 * its own rules - different questions that happen to share this answer.
 */
export function requiresGate(tool: AgentToolName): boolean {
  return (
    isAgentEffectTool(tool) ||
    tool === "evaluate" ||
    tool === "file_upload" ||
    // 013/FR-174: a picture this session took, put into a form or dropped on the page, is the same
    // kind of change a file from disk is - the next click may send it somewhere.
    tool === "upload_image" ||
    // 008/US3, D-008-4: pressing OK on a page's dialog agrees to whatever it proposed - deleting
    // the three orders - so it is the owner's to consent to exactly as the click that raised it
    // was. The caller asks only for the cases that need asking: an alert, a dismiss and a chained
    // accept never reach this function (`dialogs.ts`).
    tool === DIALOG_TOOL ||
    // 008/US3, FR-115: leaving a page that asked to stay throws away work the owner may want, so
    // `force` is an effect under the site's mode. Only a forced call enters the gate; an ordinary
    // navigation changes nothing on either page and stays outside it, as it always has.
    tool === "navigate" ||
    tool === "tabs_close"
  );
}

/**
 * Stable equality for one step's arguments.
 *
 * Key order is not part of what the owner approved, so it is normalised away; anything else is. A
 * looser comparison - matching on the tool alone, say - would let an approved "click this" admit a
 * click on something else entirely.
 */
function sameArguments(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, nested: unknown) =>
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
        : nested,
    );
  return canonical(a) === canonical(b);
}

export function decideGate(input: GateInput): GateDecision {
  if (!requiresGate(input.tool)) {
    // Answering `admit` here would turn a wiring mistake into consent nobody was asked for, and
    // answering `prompt` would ask the owner about a read. Neither is this function's to give.
    return { decision: "refuse", reason: "not-a-gated-tool" };
  }
  if (input.mode === "skip-checks") {
    return { decision: "admit" };
  }
  if (input.mode === "follow-a-plan") {
    const plan = input.plan;
    if (!plan || plan.site !== input.site) {
      return { decision: "prompt" };
    }
    if (input.tool === DIALOG_TOOL) {
      // 008/FR-112, US3 scenario 7: the plan the owner approved is being carried out on this site,
      // and a dialog one of its steps raised is part of it - so pressing OK is admitted the way a
      // step is. No step is spent: the dialog is not one of the steps they read, and consuming one
      // would let a page skip the plan past an action nobody performed.
      return { decision: "admit" };
    }
    const next = plan.steps[plan.admittedCount];
    if (next && next.tool === input.tool && sameArguments(next.args, input.args)) {
      return { decision: "admit", step: plan.admittedCount };
    }
    return { decision: "prompt" };
  }
  return { decision: "prompt" };
}
