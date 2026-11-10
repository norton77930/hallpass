import { AGENT_SITE_PLAN_COVERED_TOOLS, type AgentToolName } from "@hallpass/contracts";
import type { SessionGrantStore } from "../session-grant-store.js";
import type { PromptAnswerSource, PromptDecision } from "./prompts.js";

/**
 * 031 R-456, R-457: a session's page-actions grants, as the effect runners see them.
 *
 * The owner's "This session" answer is the 017 site plan's twin for one session: on the site it was
 * given for it stands in for the card on the covered page actions (`AGENT_SITE_PLAN_COVERED_TOOLS`)
 * and nothing else. The runners only ask and add; where the grant lives, and which sessions are
 * still the runtime's own, is the runtime's business.
 */
export type PageActionGrants = {
  /** Whether this session holds a page-actions grant for the site. Absent session: no. */
  covers(sessionId: string, site: string): Promise<boolean>;
  /** Record one, from where the owner answered. A session the runtime no longer knows gets none. */
  add(sessionId: string, site: string, source: PromptAnswerSource): Promise<void>;
};

/**
 * The runners' view over the store. `agentOf` is the runtime's own answer to "is this session still
 * mine, and whose is it": a session it no longer knows is never covered and never granted, so a
 * grant left in `chrome.storage.session` by a session that ended cannot carry a later one with the
 * same id. The store is asked for the session's current agent, so a grant another agent left under
 * the same id (a greeting after a worker restart) covers nothing either.
 */
export function pageActionGrantsFrom(
  store: Pick<SessionGrantStore, "covers" | "add">,
  agentOf: (sessionId: string) => string | undefined,
): PageActionGrants {
  return {
    async covers(sessionId, site) {
      const agentId = agentOf(sessionId);
      if (agentId === undefined) return false;
      return store.covers(sessionId, agentId, site, "page-actions");
    },
    async add(sessionId, site, source) {
      const agentId = agentOf(sessionId);
      if (agentId === undefined) return;
      await store.add(sessionId, agentId, { site, kind: "page-actions", source });
    },
  };
}

/**
 * 031 R-460: the same view for a session's `diagnostics` grants - the "This session" answer to a
 * diagnostics question. It answers the diagnostics check of `read_console`, `read_network` and
 * `evaluate` and nothing else: it is never read by the effect gate, and a page-actions grant never
 * answers it (data-model "Session grant"). The same liveness and agent rules as the page-actions view.
 */
export type DiagnosticsGrants = PageActionGrants;

export function diagnosticsGrantsFrom(
  store: Pick<SessionGrantStore, "covers" | "add">,
  agentOf: (sessionId: string) => string | undefined,
): DiagnosticsGrants {
  return {
    async covers(sessionId, site) {
      const agentId = agentOf(sessionId);
      if (agentId === undefined) return false;
      return store.covers(sessionId, agentId, site, "diagnostics");
    },
    async add(sessionId, site, source) {
      const agentId = agentOf(sessionId);
      if (agentId === undefined) return;
      await store.add(sessionId, agentId, { site, kind: "diagnostics", source });
    },
  };
}

/** Whether a grant may stand in for the card on this tool (R-457): the 017 covered set, exactly. */
export function isGrantCoveredTool(tool: AgentToolName): boolean {
  return (AGENT_SITE_PLAN_COVERED_TOOLS as readonly AgentToolName[]).includes(tool);
}

/**
 * The gate's covered flag for one decision (R-456): this session's site plan names the site, or it
 * holds a page-actions grant for it. The plan is asked first so a session with neither store wired
 * reads exactly as before.
 */
export async function pageActionsCovered(
  deps: {
    sitePlanCovers?: ((sessionId: string, site: string) => Promise<boolean>) | undefined;
    sessionGrants?: PageActionGrants | undefined;
  },
  sessionId: string,
  site: string,
): Promise<boolean> {
  if ((await deps.sitePlanCovers?.(sessionId, site)) === true) return true;
  return (await deps.sessionGrants?.covers(sessionId, site)) === true;
}

/**
 * Write the grant an Allow asked for, when it may be one (R-456, FR-470): only an Allow with
 * `session`, only for a covered tool, only for a known site. Anything else the answer is treated as
 * the once it otherwise is - a client cannot turn "session" on page JavaScript into a grant, and a
 * card for a frame whose site is unknown has no site to hold one.
 */
export async function recordSessionGrant(
  grants: PageActionGrants | undefined,
  sessionId: string,
  site: string | null,
  tool: AgentToolName,
  asked: PromptDecision,
  reportDiagnostic?: (code: string) => void,
): Promise<void> {
  if (asked.decision !== "allow" || asked.session !== true) return;
  if (grants === undefined || site === null || !isGrantCoveredTool(tool)) {
    reportDiagnostic?.("agent.session-grant.not-applicable");
    return;
  }
  try {
    await grants.add(sessionId, site, asked.answeredFrom ?? "browser");
  } catch {
    // The owner said yes to this action, which runs; only the "for the rest of the session" part
    // is lost, and the next action asks again - the safe direction.
    reportDiagnostic?.("agent.session-grant.not-recorded");
  }
}
