import type { AgentInputAttachments } from "../../src/service-worker/agent-tools/input.js";

/**
 * A debugger attachment store for tests that are not about the attachment (004/T121).
 *
 * Every pointer effect goes over one now, so a runner built without it could not deliver anything;
 * this records what was sent instead of talking to Chrome. The refusal switch is here because
 * "the tab could not be attached" is an answer several suites need to reach.
 *
 * 031/T945: a call's `hold` acquires `input` the way the real one does - so `acquired` still lists
 * it - and `holds` records each one and whether its `done` has run.
 */
export function testInputAttachments(): {
  attachments: AgentInputAttachments;
  commands: Array<{ tabId: number; method: string; params: Record<string, unknown>; sessionId?: string }>;
  acquired: Array<{ tabId: number; holder: string }>;
  holds: Array<{ tabId: number; done: boolean }>;
  released: number[];
  refuse: { reason: "devtools-open" | "restricted-page" | undefined };
} {
  const commands: Array<{ tabId: number; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const acquired: Array<{ tabId: number; holder: string }> = [];
  const holds: Array<{ tabId: number; done: boolean }> = [];
  const released: number[] = [];
  const refuse: { reason: "devtools-open" | "restricted-page" | undefined } = { reason: undefined };
  async function acquire(tabId: number, holder: string) {
    acquired.push({ tabId, holder });
    return refuse.reason === undefined
      ? { ok: true as const }
      : { ok: false as const, unavailableReason: refuse.reason };
  }
  const attachments = {
    acquire,
    async hold(tabId: number) {
      const entry = { tabId, done: false };
      holds.push(entry);
      return { outcome: await acquire(tabId, "input"), done: () => void (entry.done = true) };
    },
    holders: () => [],
    async drop() {},
    async release(tabId: number) {
      released.push(tabId);
    },
    async releaseAll() {},
    async send(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string) {
      commands.push({ tabId, method, params: params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) });
      return {};
    },
    attached: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
    oopifSessions: () => [],
  } as unknown as AgentInputAttachments;
  return { attachments, commands, acquired, holds, released, refuse };
}
