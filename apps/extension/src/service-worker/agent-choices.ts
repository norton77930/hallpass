import {
  CONVERSATION_AGENTS,
  type AgentChoices,
  type ConversationAgent,
  type ConversationAgentAvailability,
} from "@hallpass/contracts";

/**
 * 024 R-380 (data-model "AgentChoices", D-024-2, D-024-15, FR-382..384, FR-396): which agents the
 * owner switched on, and the default the side panel's picker preselects.
 *
 * One record per browser in `chrome.storage.local`, written by the service worker alone - the settings
 * page changes it by command, the panel only reads it from the projection. Readiness is not stored:
 * it is the broker's, and is passed in by the caller each time a rule needs it.
 *
 * First run (no record yet): every agent on; the default is the agent the composer remembered
 * (`conversationLastAgent`, 020 R-335) while it is ready, else the first ready agent in the order
 * Claude, Codex, Hermes, DeepSeek, else none; then the old key is removed. A first run needs to know
 * which agents are ready, so while the broker has not said (no agents listed) nothing is decided or
 * written and the record reads as all on with no default.
 */

export const AGENT_CHOICES_STORAGE_KEY = "agentChoices";
/** 020 R-335: the composer's remembered agent, read once to seed the default and then removed. */
export const LEGACY_LAST_AGENT_STORAGE_KEY = "conversationLastAgent";

/** The part of `chrome.storage.local` this module uses. `remove` may be missing in a test stub. */
export type AgentChoicesStorage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove?(keys: string[]): Promise<void>;
};

/** frames.md `ui.settings.choices-set`: either half may be left out. */
export type AgentChoicesPatch = {
  enabled?: Partial<Record<ConversationAgent, boolean>> | undefined;
  default?: ConversationAgent | null | undefined;
};

/**
 * The outcome of a change. `defaultMovedTo` is present only when D-024-15 moved the default because
 * the owner switched it off - the agent it moved to, or `null` when none could take it.
 */
export type AgentChoicesOutcome =
  | { ok: true; choices: AgentChoices; defaultMovedTo?: ConversationAgent | null }
  | { ok: false; code: "agent-disabled" | "agent-not-ready" | "not-saved" };

export type AgentChoicesStore = {
  read(agents: readonly ConversationAgentAvailability[]): Promise<AgentChoices>;
  set(patch: AgentChoicesPatch, agents: readonly ConversationAgentAvailability[]): Promise<AgentChoicesOutcome>;
};

const isAgent = (value: unknown): value is ConversationAgent =>
  typeof value === "string" && (CONVERSATION_AGENTS as readonly string[]).includes(value);

/** data-model: Ready or Ready with warnings - the broker's `ready`, notes or not. */
export function isAgentReady(agent: ConversationAgent, agents: readonly ConversationAgentAvailability[]): boolean {
  return agents.some((entry) => entry.agent === agent && entry.availability === "ready");
}

/** D-024-15: the first agent in the fixed order that is enabled and ready, else none. */
function fallbackDefault(
  enabled: Record<ConversationAgent, boolean>,
  agents: readonly ConversationAgentAvailability[],
): ConversationAgent | null {
  return CONVERSATION_AGENTS.find((agent) => enabled[agent] && isAgentReady(agent, agents)) ?? null;
}

const allOn = (): Record<ConversationAgent, boolean> =>
  Object.fromEntries(CONVERSATION_AGENTS.map((agent) => [agent, true])) as Record<ConversationAgent, boolean>;

/**
 * A stored record as this worker reads it: every agent named (one a later release adds starts on),
 * and a default that is an enabled agent or none. Anything that is not a record at all is `undefined`,
 * which the caller treats as a first run.
 */
function normalise(value: unknown): AgentChoices | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { enabled, default: chosen } = value as { enabled?: unknown; default?: unknown };
  if (typeof enabled !== "object" || enabled === null) return undefined;
  const flags = allOn();
  for (const agent of CONVERSATION_AGENTS) {
    const flag = (enabled as Record<string, unknown>)[agent];
    if (typeof flag === "boolean") flags[agent] = flag;
  }
  return { enabled: flags, default: isAgent(chosen) && flags[chosen] ? chosen : null };
}

export function createAgentChoicesStore(
  options: {
    storage?: () => AgentChoicesStorage | undefined;
    reportDiagnostic?: (code: string) => void;
  } = {},
): AgentChoicesStore {
  const storage = options.storage ?? (() => globalThis.chrome?.storage?.local as AgentChoicesStorage | undefined);
  const report = options.reportDiagnostic ?? ((): void => undefined);
  /** The record as last read or written; the worker is its only writer. */
  let cached: AgentChoices | undefined;
  /** One read-or-change at a time, so a first run is never decided twice and no change is lost. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /**
   * The record, and whether storage could be read at all. A read that failed is not a first run: the
   * owner's record may be there, so nothing is decided or written and it reads as undecided (all on,
   * no default) until a later read succeeds.
   */
  async function current(agents: readonly ConversationAgentAvailability[]): Promise<{ choices: AgentChoices; readable: boolean }> {
    if (cached !== undefined) return { choices: cached, readable: true };
    const area = storage();
    let items: Record<string, unknown>;
    try {
      items = (await area?.get([AGENT_CHOICES_STORAGE_KEY, LEGACY_LAST_AGENT_STORAGE_KEY])) ?? {};
    } catch {
      report("agent.choices.unread");
      return { choices: { enabled: allOn(), default: null }, readable: false };
    }
    const stored = normalise(items[AGENT_CHOICES_STORAGE_KEY]);
    if (stored !== undefined) {
      cached = stored;
      return { choices: stored, readable: true };
    }
    // First run, but which agents are ready is not known yet: decide nothing.
    if (agents.length === 0) return { choices: { enabled: allOn(), default: null }, readable: true };
    const enabled = allOn();
    const remembered = items[LEGACY_LAST_AGENT_STORAGE_KEY];
    const seeded: AgentChoices = {
      enabled,
      default: isAgent(remembered) && isAgentReady(remembered, agents) ? remembered : fallbackDefault(enabled, agents),
    };
    try {
      await area?.set({ [AGENT_CHOICES_STORAGE_KEY]: seeded });
      await area?.remove?.([LEGACY_LAST_AGENT_STORAGE_KEY]);
      cached = seeded;
    } catch {
      // Shown as decided, and decided again on the next read: nothing is lost but the write.
      report("agent.choices.unsaved");
    }
    return { choices: seeded, readable: true };
  }

  return {
    read(agents) {
      return serial(async () => (await current(agents)).choices);
    },
    set(patch, agents) {
      return serial(async (): Promise<AgentChoicesOutcome> => {
        const { choices: before, readable } = await current(agents);
        // A change made over a record that could not be read would replace the owner's choices.
        if (!readable) return { ok: false, code: "not-saved" };
        const enabled = { ...before.enabled };
        for (const agent of CONVERSATION_AGENTS) {
          const flag = patch.enabled?.[agent];
          if (flag !== undefined) enabled[agent] = flag;
        }
        let chosen = before.default;
        let moved: { to: ConversationAgent | null } | undefined;
        if (patch.default !== undefined) {
          // FR-382: only an enabled, ready agent may be the default; "none" is always allowed.
          if (patch.default !== null && !enabled[patch.default]) return { ok: false, code: "agent-disabled" };
          if (patch.default !== null && !isAgentReady(patch.default, agents)) return { ok: false, code: "agent-not-ready" };
          chosen = patch.default;
        } else if (chosen !== null && !enabled[chosen]) {
          // D-024-15, FR-383: the default was switched off.
          chosen = fallbackDefault(enabled, agents);
          moved = { to: chosen };
        }
        const next: AgentChoices = { enabled, default: chosen };
        try {
          await storage()?.set({ [AGENT_CHOICES_STORAGE_KEY]: next });
        } catch {
          report("agent.choices.unsaved");
          return { ok: false, code: "not-saved" };
        }
        cached = next;
        return moved === undefined ? { ok: true, choices: next } : { ok: true, choices: next, defaultMovedTo: moved.to };
      });
    },
  };
}
