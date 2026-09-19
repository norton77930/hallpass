import type { AgentInputAttachments } from "../../src/service-worker/agent-tools/input.js";

/**
 * A debugger attachment store for tests that are not about the attachment (004/T121).
 *
 * Every pointer effect goes over one now, so a runner built without it could not deliver anything;
 * this records what was sent instead of talking to Chrome. The refusal switch is here because
 * "the tab could not be attached" is an answer several suites need to reach.
 */
export function testInputAttachments(): {
  attachments: AgentInputAttachments;
  commands: Array<{ tabId: number; method: string; params: Record<string, unknown>; sessionId?: string }>;
  acquired: Array<{ tabId: number; holder: string }>;
  released: number[];
  refuse: { reason: "devtools-open" | "restricted-page" | undefined };
} {
  const commands: Array<{ tabId: number; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const acquired: Array<{ tabId: number; holder: string }> = [];
  const released: number[] = [];
  const refuse: { reason: "devtools-open" | "restricted-page" | undefined } = { reason: undefined };
  const attachments = {
    async acquire(tabId: number, holder: string) {
      acquired.push({ tabId, holder });
      return refuse.reason === undefined
        ? { ok: true as const }
        : { ok: false as const, unavailableReason: refuse.reason };
    },
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
  return { attachments, commands, acquired, released, refuse };
}
