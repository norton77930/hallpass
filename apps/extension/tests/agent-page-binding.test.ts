import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import type { AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 015/T400 — a page that did not answer is not a page that went away (FR-205, FR-206, R-197).
 *
 * Measured on the gate: the call that answered `stale` took 10 033 ms, the content deadline, on a
 * tab that was `complete`, on the right URL and not discarded. The probe had simply not been
 * answered in time, and the binding reported that as `stale` - the word for a tab that is gone or a
 * document that was replaced - so the agent re-read a page that was still there. The deadline is now
 * its own answer, `failed / page-not-responding`, with a hint that says the page is still open and
 * the call may be retried. The two real `stale` answers keep their words.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;
const NOT_RESPONDING_HINT =
  "The page did not answer for 10 s; it is still open. Retry the call, or take a screenshot to see its state.";

type ProbeBehaviour = "answer" | "hang" | "refuse";

function installChrome(state: { probe: ProbeBehaviour; tabExists: boolean }): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (!state.tabExists || tabId !== AGENT_TAB) throw new Error(`No tab with id: ${tabId}.`);
        return { id: AGENT_TAB, url: PAGE_URL, status: "complete" };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        if (frame.type !== "content.probe") return Promise.reject(new Error(`unexpected frame ${frame.type}`));
        if (state.probe === "hang") return new Promise(() => {});
        if (state.probe === "refuse") return Promise.resolve({ ok: false, reason: "stale-binding" });
        return Promise.resolve({ documentEpoch: "doc-1", canonicalOrigin: SITE });
      },
    },
  };
}

function fakeAttachments(): AgentInputAttachments {
  return {
    async acquire() {
      return { ok: true as const };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send() {
      return {};
    },
    attached: () => [],
    oopifSessions: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
  } as unknown as AgentInputAttachments;
}

function effects(overrides: Partial<Parameters<typeof createAgentEffects>[0]> = {}) {
  return createAgentEffects({
    context: testSessionContexts(),
    siteModes: createSiteModeStore(),
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    attachments: fakeAttachments(),
    locate: async () => ({ x: 10, y: 10, width: 40, height: 20 }),
    confirm: async () => ({ outcome: "hit" }),
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...overrides,
  });
}

function click(): AgentNativeRequest {
  return {
    callId: "call-click",
    sessionId: "session-b1",
    tool: "click",
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, target: { ref: "t_link" } },
  };
}

describe("T400 binding failures name their reason", () => {
  const state = { probe: "answer" as ProbeBehaviour, tabExists: true };

  beforeEach(() => {
    state.probe = "answer";
    state.tabExists = true;
    installChrome(state);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("a probe that hits the content deadline is page-not-responding, not stale", async () => {
    vi.useFakeTimers();
    state.probe = "hang";
    const bindings = createAgentPageBindings();
    const context = testSessionContexts().forCall("session-b1", "call-1");

    const pending = bindings.bind(AGENT_TAB, context);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({ ok: false, reason: "page-not-responding" });
  });

  it("a tab that is gone stays stale", async () => {
    state.tabExists = false;
    const bindings = createAgentPageBindings();
    const context = testSessionContexts().forCall("session-b1", "call-1");

    expect(await bindings.bind(AGENT_TAB, context)).toEqual({ ok: false, reason: "stale" });
  });

  it("a runtime that answered, and refused the binding, stays stale", async () => {
    state.probe = "refuse";
    const bindings = createAgentPageBindings();
    const context = testSessionContexts().forCall("session-b1", "call-1");

    expect(await bindings.bind(AGENT_TAB, context)).toEqual({ ok: false, reason: "stale" });
  });

  it("an effect on a page that did not answer is failed / page-not-responding, with the retry hint", async () => {
    vi.useFakeTimers();
    state.probe = "hang";
    const runner = effects();

    const pending = runner.run(click());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({
      callId: "call-click",
      outcome: "failed",
      reason: "page-not-responding",
      hint: NOT_RESPONDING_HINT,
    });
  });

  it("a tab the owner closed stays stale / tab-gone", async () => {
    const runner = effects({ tabOwnership: async () => ({ state: "gone" }) });

    expect(await runner.run(click())).toEqual({ callId: "call-click", outcome: "stale", reason: "tab-gone" });
  });

  it("a ref whose document was replaced stays stale / stale-reference", async () => {
    const siteModes = createSiteModeStore();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const runner = effects({ siteModes, locate: async () => ({ stale: true }) });

    expect(await runner.run(click())).toMatchObject({
      callId: "call-click",
      outcome: "stale",
      reason: "stale-reference",
    });
  });
});
