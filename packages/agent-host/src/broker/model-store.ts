import { join } from "node:path";
import { z } from "zod";
import {
  conversationAgentSchema,
  conversationModelChoiceSchema,
  conversationModelOfferSchema,
  type ConversationAgent,
  type ConversationModelChoice,
  type ConversationModelOffer,
} from "@hallpass/contracts";
import { writeHostFileAtomically } from "../bridge-link.js";
import { readHostJsonFile } from "./index-store.js";

/**
 * 025 R-401 (data-model "Host file"): each agent's last reported model offer and the owner's last
 * choice for it, on this computer - `<data>\agent-models.json` =
 * `{ "version": 1, "agents": { <agent>: { offer, seenAt, choice? } } }`.
 *
 * - Written the way the conversation index is (`index-store.ts`): every change re-reads the file
 *   first and writes temp + rename (`writeHostFileAtomically`), so the brokers of two browsers keep
 *   each other's agents (the "two browsers" edge case).
 * - The pool replaces an agent's `offer` at each `session/new` of it (never a load or resume, whose
 *   list belongs to an older session) and writes `choice` when a start carried one or a change was
 *   accepted (D-025-4). A choice is kept only beside an offer.
 * - Unreadable (not JSON, an unknown field, another version): kept aside as
 *   `agent-models.json.bad-<time>`, logged, and the store starts empty - no panel notice; the cost is
 *   one "Default" chip until the agent's next start.
 * - FR-410: the file stays in the host data folder; no model name is ever logged.
 */

export function agentModelsPath(dataDir: string): string {
  return join(dataDir, "agent-models.json");
}

const agentModelsEntrySchema = z.strictObject({
  offer: conversationModelOfferSchema,
  seenAt: z.string().min(1).max(64),
  choice: conversationModelChoiceSchema.optional(),
});
export type AgentModelsEntry = z.infer<typeof agentModelsEntrySchema>;
export type AgentModels = Partial<Record<ConversationAgent, AgentModelsEntry>>;

const agentModelsFileSchema = z.strictObject({
  version: z.literal(1),
  agents: z.partialRecord(conversationAgentSchema, agentModelsEntrySchema),
});

export type ModelStore = {
  read(): Promise<AgentModels>;
  /** A `session/new` of the agent reported this offer; its choice stays. */
  recordOffer(agent: ConversationAgent, offer: ConversationModelOffer, seenAt: string): Promise<void>;
  /** The owner's choice for the agent; ignored while the store has no offer of it. */
  recordChoice(agent: ConversationAgent, choice: ConversationModelChoice): Promise<void>;
};

export type FileModelStoreOptions = {
  path: string;
  now?: () => number;
  log?: (code: string, detail?: string) => void;
};

/** One store's changes, applied to whatever the file holds now. */
type Change = (agents: AgentModels) => AgentModels;

const withOffer = (agent: ConversationAgent, offer: ConversationModelOffer, seenAt: string): Change => (agents) => {
  const choice = agents[agent]?.choice;
  return { ...agents, [agent]: { offer: structuredClone(offer), seenAt, ...(choice === undefined ? {} : { choice }) } };
};

const withChoice = (agent: ConversationAgent, choice: ConversationModelChoice): Change => (agents) => {
  const entry = agents[agent];
  return entry === undefined ? agents : { ...agents, [agent]: { ...entry, choice: structuredClone(choice) } };
};

export function fileModelStore(options: FileModelStoreOptions): ModelStore {
  const { path } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<AgentModels> => {
    const result = await readHostJsonFile(path, agentModelsFileSchema, now());
    switch (result.kind) {
      case "ok":
        return result.value.agents;
      case "absent":
        return {};
      case "kept-aside":
        log("broker.models-unreadable", result.keptAs);
        return {};
    }
  };

  const change = (apply: Change): Promise<void> => {
    const run = async () => {
      const before = await read();
      const after = apply(before);
      if (after === before) return;
      await writeHostFileAtomically(path, { version: 1, agents: after });
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    read,
    recordOffer: (agent, offer, seenAt) => change(withOffer(agent, offer, seenAt)),
    recordChoice: (agent, choice) => change(withChoice(agent, choice)),
  };
}

/** The same store in memory: the pool's default when it is given none (tests). */
export function memoryModelStore(initial: AgentModels = {}): ModelStore {
  let agents: AgentModels = structuredClone(initial);
  return {
    read: async () => structuredClone(agents),
    recordOffer: async (agent, offer, seenAt) => {
      agents = withOffer(agent, offer, seenAt)(agents);
    },
    recordChoice: async (agent, choice) => {
      agents = withChoice(agent, choice)(agents);
    },
  };
}
