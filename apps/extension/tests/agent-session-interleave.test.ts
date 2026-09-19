import { describe, expect, it, vi } from "vitest";
import type { AgentBatchStepResult, AgentNativeRequest } from "@hallpass/contracts";
import { createAgentBatch } from "../src/service-worker/agent-tools/batch.js";
import { createAgentSessionContext, type AgentToolContext } from "../src/service-worker/agent-tools/context.js";
import type { AgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createStatedPlans } from "../src/service-worker/agent-tools/plans.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { createAgentStopSignals } from "../src/service-worker/agent-tools/stop.js";
import { createAgentUpload } from "../src/service-worker/agent-tools/upload.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";

/**
 * 004/T103a — two sessions interleaving across an `await` (US3, FR-034).
 *
 * The worker used to hand every runner deps that were *pointed* at the calling session by a single
 * mutable variable set in `handleToolCall`. An entry check is safe under that arrangement, because
 * it runs in the same microtask as the assignment. Two things are not, and both are forced here:
 *
 * 1. A batch dispatches its steps itself, so no step re-points anything. Every step's ownership
 *    check therefore reads whatever the pointer holds *now* - and a tab that changed hands during
 *    the batch (release then claim, which leases make an ordinary thing to do) is granted to the
 *    session that happens to be pointed at rather than to the batch's own.
 * 2. A read binds its page *after* awaiting the ownership check, so a call that landed in that
 *    await could hand it another session's channel nonce, runtime epoch and grant id.
 *
 * Both deps below are written so that the *runner* decides which session they answer about: given a
 * session id they use it, given none they can only fall back to the shared pointer, which is what
 * the worker did before this task. That is what makes these two tests honest rather than assertions
 * about a logged id - they run against the same code both ways, and only the threading changes the
 * answer.
 */

const TAB = 7;
const SITE = "https://fixtures.test:19443";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

function world() {
  /** The worker's shared session pointer: one variable, aimed at whichever frame arrived last. */
  let pointer = SESSION_A;
  const leases = new Map<number, string>([[TAB, SESSION_A]]);
  const contexts = new Map([
    [SESSION_A, createAgentSessionContext(SESSION_A)],
    [SESSION_B, createAgentSessionContext(SESSION_B)],
  ]);

  const tabOwnership = async (
    first: unknown,
    second?: unknown,
  ): Promise<{ state: "this" } | { state: "held-by-session"; sessionId: string } | { state: "not-yours" }> => {
    const threaded = typeof first === "string";
    const sessionId = threaded ? (first as string) : pointer;
    const tabId = threaded ? (second as number) : (first as number);
    const holder = leases.get(tabId);
    if (holder === sessionId) return { state: "this" };
    return holder === undefined ? { state: "not-yours" } : { state: "held-by-session", sessionId: holder };
  };

  const context = {
    forCall(first: string, second?: string): AgentToolContext {
      const sessionId = second === undefined ? pointer : first;
      const callId = second === undefined ? first : second;
      const session = contexts.get(sessionId);
      if (!session) throw new Error(`no context for ${sessionId}`);
      return session.forCall(callId);
    },
  };

  return {
    tabOwnership,
    context,
    contexts,
    /** Another session's frame arrives at the worker: the pointer moves, nothing else. */
    bArrives(): void {
      pointer = SESSION_B;
    },
    /** ...and the tab legitimately changes hands while it is here: A releases, B claims. */
    bTakesTheTab(): void {
      pointer = SESSION_B;
      leases.set(TAB, SESSION_B);
    },
  };
}

function recordingBindings(): AgentPageBindings & { seen: AgentToolContext[] } {
  const seen: AgentToolContext[] = [];
  return {
    seen,
    async bind(tabId, context) {
      seen.push(context);
      return {
        ok: true,
        binding: { tabId, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE },
      };
    },
    invalidate() {},
  };
}

type Collect = NonNullable<Parameters<typeof createAgentReads>[0]["collect"]>;

function collector(onCollect?: () => void): Collect {
  return (async () => {
    onCollect?.();
    return { visibleText: "page text", truncated: false };
  }) as unknown as Collect;
}

function readStep(): { tool: string; args: Record<string, unknown> } {
  return { tool: "get_page_text", args: {} };
}

describe("T103a session-scoped tool deps", () => {
  it("does not let a batch step act on a tab that changed hands while an earlier step awaited", async () => {
    const w = world();
    const bindings = recordingBindings();
    let firstStep = true;
    const reads = createAgentReads({
      context: w.context,
      bindings,
      tabOwnership: w.tabOwnership,
      // The await inside step 0 is where the other session's call lands. The tab changes hands in
      // it, which is exactly the sequence leases make ordinary.
      collect: collector(() => {
        if (!firstStep) return;
        firstStep = false;
        w.bTakesTheTab();
      }),
    });
    const batch = createAgentBatch({
      siteModes: createSiteModeStore(),
      plans: createStatedPlans(),
      prompts: createAgentPromptController({ timeoutMs: 50 }),
      stops: createAgentStopSignals(),
      tabOwnership: w.tabOwnership,
      siteOfTab: async () => SITE,
      // `dispatchTool` as the worker calls it for a step: straight to the runner, with nothing
      // re-pointed on the way in.
      dispatch: (request) => reads.run(request),
    });

    const response = await batch.run({
      callId: "call-batch",
      sessionId: SESSION_A,
      tool: "browser_batch",
      tabId: TAB,
      args: { tabId: TAB, steps: [readStep(), readStep()] },
    } as AgentNativeRequest);

    const results = (response.result as { results: AgentBatchStepResult[] }).results;
    // Step 0 ran while A still held the tab, and is reported as what it did.
    expect(results[0]).toMatchObject({ index: 0, outcome: "ok" });
    // Step 1 belongs to A, and A no longer holds this tab. It is refused, and the batch stops.
    expect(results[1]).toMatchObject({ index: 1, outcome: "denied", reason: "held-by-session" });
    // ...and nothing of B's was read on A's behalf: only step 0 ever reached the page.
    expect(bindings.seen).toHaveLength(1);
    expect(bindings.seen[0]?.taskId).toBe(SESSION_A);
  });

  it("binds a read with its own session's context when another call lands in the ownership await", async () => {
    const w = world();
    const bindings = recordingBindings();
    const reads = createAgentReads({
      context: w.context,
      bindings,
      tabOwnership: async (first: unknown, second?: unknown) => {
        const owned = await w.tabOwnership(first, second);
        // The ownership check is a storage read, and this is the await B's frame lands in. A still
        // holds the tab; all that moved is the worker's pointer.
        await Promise.resolve();
        w.bArrives();
        return owned;
      },
      collect: collector(),
    });

    const response = await reads.run({
      callId: "call-read",
      sessionId: SESSION_A,
      tool: "get_page_text",
      tabId: TAB,
      args: { tabId: TAB },
    } as AgentNativeRequest);

    expect(response.outcome).toBe("ok");
    const bound = bindings.seen[0];
    expect(bound?.taskId).toBe(SESSION_A);
    // The nonce is the binding between this worker and the pages one session is driving: A's page
    // must never be spoken to with B's.
    expect(bound?.nonce).toBe(w.contexts.get(SESSION_A)?.forCall("other").nonce);
  });

  it("puts an upload on the wire under its own session's identifiers", async () => {
    const w = world();
    const bindings = recordingBindings();
    const siteModes = createSiteModeStore();
    await siteModes.set(SITE, { mode: "skip-checks" });
    const setFiles = vi.fn(async () => ({ ok: true as const, files: [{ name: "receipt.txt", size: 5 }] }));
    const upload = createAgentUpload({
      context: w.context,
      siteModes,
      bindings,
      prompts: createAgentPromptController({ timeoutMs: 50 }),
      tabOwnership: async (first: unknown, second?: unknown) => {
        const owned = await w.tabOwnership(first, second);
        await Promise.resolve();
        w.bArrives();
        return owned;
      },
      setFiles: setFiles as unknown as NonNullable<Parameters<typeof createAgentUpload>[0]["setFiles"]>,
    });

    const response = await upload.run({
      callId: "call-upload",
      sessionId: SESSION_A,
      tool: "file_upload",
      tabId: TAB,
      args: { tabId: TAB, ref: "t_attachment", files: [{ name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" }] },
    } as AgentNativeRequest);

    expect(response.outcome).toBe("ok");
    expect(bindings.seen[0]?.taskId).toBe(SESSION_A);
    // The frame that reaches the page carries them too, which is the half that would be invisible
    // if only the binding were checked.
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: SESSION_A, nonce: w.contexts.get(SESSION_A)?.forCall("other").nonce }),
    );
  });
});
