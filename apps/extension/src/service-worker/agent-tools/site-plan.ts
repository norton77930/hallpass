import { agentProposeSitesArgsSchema, type AgentNativeResponse, type AgentToolName } from "@hallpass/contracts";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import type { AgentToolRequest } from "./stop.js";

/**
 * `propose_sites`: a session names the sites it will work across, and the owner answers once
 * (017 FR-249 - FR-253, FR-260, R-247, R-248).
 *
 * The runner grants nothing by itself. It refuses a proposal that breaks a rule before any card
 * goes up, naming the first entry that broke it (FR-250); raises one question; and writes a plan
 * only from the owner's approval, through the runtime's `approve` - which replaces the session's
 * plan, never merges with it, and refuses a session that has ended or been unpaired in the
 * meantime. It is not a batch step: a plan is a decision about the session, not about one page.
 */

/**
 * What an approval of a session site plan came to (017 R-246).
 *
 * `ok` only when the plan is written where the next call's gate will read it. A session that has
 * ended or whose agent is unpaired gets no plan - an approval must not outlive what carried it
 * (FR-258) - and a write that did not land is said as `site-plan-not-recorded`, never swallowed.
 */
export type AgentSitePlanApproval =
  | { ok: true }
  | { ok: false; reason: "session-ended" | "not-paired" | "site-plan-not-recorded" };

export type AgentSitePlanRunnerDeps = {
  prompts: AgentPromptController;
  /** The session's active plan, so a replacing proposal can mark what is already approved (FR-260). */
  activePlan(sessionId: string): Promise<readonly string[] | undefined>;
  /** The runtime's one writer of the plan store (`approveSitePlan`). */
  approve(sessionId: string, origins: readonly string[]): Promise<AgentSitePlanApproval>;
};

export type AgentSitePlanRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

/** The contract caps `hint`; a refusal is a sentence about one entry, never the whole proposal. */
const HINT_MAX_CHARS = 400;
const ENTRY_MAX_CHARS = 200;

/**
 * The failed approval's own words. `session-ended` is not passed on bare: the host reads that reason
 * as "greet again and place the call once more", which would put a second card in front of an owner
 * who has just answered the first.
 */
const APPROVAL_FAILURES: Record<Exclude<AgentSitePlanApproval, { ok: true }>["reason"], string> = {
  "site-plan-not-recorded": "site-plan-not-recorded",
  "session-ended": "site-plan-session-ended",
  "not-paired": "site-plan-not-paired",
};

type Issue = {
  code: string;
  path: PropertyKey[];
  message: string;
  minimum?: unknown;
  maximum?: unknown;
  origin?: unknown;
  keys?: string[];
  expected?: unknown;
};

/** `<entry>: <rule>` for the first issue: the origin itself when it is one, else where in the args. */
function refusalHint(args: Record<string, unknown>, issue: Issue): string {
  const [head, index] = issue.path;
  let entry: string;
  if (head === "origins" && typeof index === "number" && Array.isArray(args.origins)) {
    const value: unknown = args.origins[index];
    entry = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } else if (issue.path.length === 0) {
    entry = "arguments";
  } else {
    entry = issue.path
      .map((part, at) => (typeof part === "number" ? `[${part}]` : `${at === 0 ? "" : "."}${String(part)}`))
      .join("");
  }
  return `${entry.slice(0, ENTRY_MAX_CHARS)}: ${ruleOf(issue)}`.slice(0, HINT_MAX_CHARS);
}

function ruleOf(issue: Issue): string {
  switch (issue.code) {
    case "too_small":
      return typeof issue.minimum === "number" && issue.minimum > 1
        ? `at least ${issue.minimum} ${issue.origin === "array" ? "entries" : "characters"}`
        : "must not be empty";
    case "too_big":
      return `at most ${String(issue.maximum)} ${issue.origin === "array" ? "entries" : "characters"}`;
    case "unrecognized_keys":
      return `unknown key ${(issue.keys ?? []).join(", ")}`;
    case "invalid_type":
      return `expected ${String(issue.expected)}`;
    default:
      return issue.message;
  }
}

export function createAgentSitePlanRunner(deps: AgentSitePlanRunnerDeps): AgentSitePlanRunner {
  async function run(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId, sessionId } = request;
    const parsed = agentProposeSitesArgsSchema.safeParse(request.args);
    if (!parsed.success) {
      const first = parsed.error.issues[0] as Issue | undefined;
      return {
        callId,
        outcome: "failed",
        reason: "invalid-arguments",
        // FR-250: unlike the other runners' bare refusal, this one names the entry and the rule -
        // an agent that proposed ten sites needs to know which one to fix.
        ...(first === undefined ? {} : { hint: refusalHint(request.args, first) }),
      };
    }
    const { origins, purpose, steps } = parsed.data;
    // A plan that cannot be read marks nothing; the question is still worth asking.
    const active = await deps.activePlan(sessionId).catch(() => undefined);
    const asked = await deps.prompts.askSitePlan({
      callId,
      hostCallId: request.hostCallId,
      stopped: request.stopped,
      sessionId,
      origins,
      purpose,
      ...(steps === undefined ? {} : { steps }),
      ...(active === undefined || active.length === 0 ? {} : { alreadyApproved: [...active] }),
    });
    switch (asked.decision) {
      case "busy":
        return { callId, outcome: "busy", reason: "prompt-pending" };
      case "timed-out":
        return noAnswerResponse(callId, asked);
      case "stopped":
        return { callId, outcome: "stopped", reason: "owner-stopped" };
      case "interrupted":
        return { callId, outcome: "stopped", reason: "owner-interrupted" };
      case "released":
        // The owner handed the session's tabs back while the card stood: nothing was decided.
        return { callId, outcome: "stopped", reason: "owner-released-tabs" };
      case "declined":
        /**
         * The ONLY place in the worker that answers `declined` (017 data-model, R-251). A 0.9.0 host
         * parses answers with a strict outcome enum that lacks it and would drop the frame; such a
         * host never lists `propose_sites`, so this answer only ever reaches a host that knows the
         * word. Every other refusal keeps `denied`. Pinned by agent-tools-site-plan.test.ts.
         */
        return { callId, outcome: "declined" };
      case "approve": {
        const approval = await deps.approve(sessionId, asked.approved);
        if (!approval.ok) {
          return { callId, outcome: "failed", reason: APPROVAL_FAILURES[approval.reason] };
        }
        return { callId, outcome: "ok", result: { approved: asked.approved, leftOut: asked.leftOut } };
      }
    }
  }

  return {
    handles(tool) {
      return tool === "propose_sites";
    },
    run,
  };
}
