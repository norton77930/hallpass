import { agentAppearanceSchema, type AgentAppearance } from "@hallpass/contracts";

/**
 * 024 R-382, D-024-20 (data-model "AgentAppearance"): the one theme and language choice the settings
 * page's top bar sets and both the page and the side panel follow.
 *
 * Kept in `chrome.storage.local` under `agentAppearance`, written by the service worker alone (on the
 * page's `ui.settings.appearance-set`); the two documents read it and follow `chrome.storage.onChanged`.
 * Nothing stored, or a record this worker cannot read, is System / System - today's behaviour.
 */

export const AGENT_APPEARANCE_STORAGE_KEY = "agentAppearance";
export const DEFAULT_AGENT_APPEARANCE: AgentAppearance = { theme: "system", language: "system" };

type Storage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};

export type AgentAppearanceStore = {
  read(): Promise<AgentAppearance>;
  /** Either half may be left out; the other keeps what was stored. Rejects when it cannot be saved. */
  set(patch: { theme?: AgentAppearance["theme"] | undefined; language?: AgentAppearance["language"] | undefined }): Promise<AgentAppearance>;
};

export function createAgentAppearanceStore(
  options: { storage?: () => Storage | undefined } = {},
): AgentAppearanceStore {
  const storage = options.storage ?? (() => globalThis.chrome?.storage?.local as Storage | undefined);
  /** One change at a time, so two quick presses of the top bar keep both halves. */
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<AgentAppearance> {
    const items = (await storage()?.get([AGENT_APPEARANCE_STORAGE_KEY]).catch(() => undefined)) ?? {};
    const parsed = agentAppearanceSchema.safeParse(items[AGENT_APPEARANCE_STORAGE_KEY]);
    return parsed.success ? parsed.data : { ...DEFAULT_AGENT_APPEARANCE };
  }

  return {
    read,
    set(patch) {
      const work = async (): Promise<AgentAppearance> => {
        const next: AgentAppearance = {
          ...(await read()),
          ...(patch.theme === undefined ? {} : { theme: patch.theme }),
          ...(patch.language === undefined ? {} : { language: patch.language }),
        };
        const area = storage();
        if (area === undefined) throw new Error("no storage");
        await area.set({ [AGENT_APPEARANCE_STORAGE_KEY]: next });
        return next;
      };
      const next = queue.then(work, work);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
