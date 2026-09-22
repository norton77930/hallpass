import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest, PromptWaitingFrame } from "@hallpass/contracts";
import {
  AGENT_CALL_TIMEOUT_SLACK_MS as SLACK_MS,
  AGENT_MAX_CALL_TIMEOUT_MS as MAX_CALL_TIMEOUT_MS,
} from "@hallpass/contracts";
import { CallRouter, CALL_TIMEOUT_MS, KEEP_ALIVE_CAP_MS, KEEP_ALIVE_SLACK_MS } from "../src/router.js";

function request(callId: string, overrides: Partial<AgentNativeRequest> = {}): AgentNativeRequest {
  return { callId, sessionId: "session-1", tool: "tabs_context", args: {}, ...overrides };
}

describe("call router", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the call and answers the promise that carries its callId", async () => {
    const sent: unknown[] = [];
    const router = new CallRouter({ send: (frame) => sent.push(frame) });

    const first = router.call(request("call-1", { tabId: 7 }));
    const second = router.call(request("call-2", { tabId: 9 }));

    expect(sent).toEqual([
      // 004: the session travels with every call, so the relay can route several servers' calls.
      { callId: "call-1", sessionId: "session-1", tool: "tabs_context", tabId: 7, args: {} },
      { callId: "call-2", sessionId: "session-1", tool: "tabs_context", tabId: 9, args: {} },
    ]);

    // Out of order on purpose: correlation is by callId, never by arrival order.
    router.settle({ callId: "call-2", outcome: "ok", result: [] });
    router.settle({ callId: "call-1", outcome: "failed", reason: "page-gone" });

    await expect(first).resolves.toEqual({ callId: "call-1", outcome: "failed", reason: "page-gone" });
    await expect(second).resolves.toEqual({ callId: "call-2", outcome: "ok", result: [] });
  });

  it("refuses a second call on a tab that already has one in flight", async () => {
    const sent: unknown[] = [];
    const router = new CallRouter({ send: (frame) => sent.push(frame) });

    const first = router.call(request("call-1", { tabId: 7 }));
    const busy = await router.call(request("call-2", { tabId: 7 }));

    expect(busy).toEqual({ callId: "call-2", outcome: "busy", reason: "tab-in-flight" });
    // The refused call never reached the worker: a busy tab is decided here, not on the far side.
    expect(sent).toHaveLength(1);

    router.settle({ callId: "call-1", outcome: "ok" });
    await first;
    // Once the tab is free the next call goes through.
    void router.call(request("call-3", { tabId: 7 }));
    expect(sent).toHaveLength(2);
  });

  it("lets calls that name no tab run alongside each other", () => {
    const sent: unknown[] = [];
    const router = new CallRouter({ send: (frame) => sent.push(frame) });

    void router.call(request("call-1"));
    void router.call(request("call-2"));

    expect(sent).toHaveLength(2);
  });

  it("times a call out rather than leaving the agent waiting", async () => {
    const router = new CallRouter({ send: () => undefined });

    const pending = router.call(request("call-1", { tabId: 7 }));
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
    expect(CALL_TIMEOUT_MS).toBe(30_000);
    // The timed-out call released its tab; a late answer names a call nobody is waiting for.
    expect(router.settle({ callId: "call-1", outcome: "ok" })).toBe(false);
    void router.call(request("call-2", { tabId: 7 }));
  });

  /**
   * 003/T051 — a wait and a batch legitimately outlive the flat backstop, so the backstop is read
   * from the call's own arguments (`agentCallBoundMs`). Without this, the transport would give up on
   * a call that is doing exactly what the agent asked for.
   */
  it("gives a wait the bound its own arguments asked for, and not the flat one", async () => {
    const router = new CallRouter({ send: () => undefined });

    const pending = router.call(request("call-1", { tool: "wait", tabId: 7, args: { tabId: 7, forMs: 12_000 } }));
    await vi.advanceTimersByTimeAsync(12_000 + SLACK_MS - 1);
    // The bound the arguments named, plus the round trip - shorter than the flat backstop, which
    // would have left the agent waiting eighteen seconds past the wait it asked for.
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
  });

  it("lets a batch outlive the flat backstop, but never the cap", async () => {
    const router = new CallRouter({ send: () => undefined });

    const steps = Array.from({ length: 20 }, () => ({ tool: "wait", args: { forMs: 15_000 } }));
    const pending = router.call(
      request("call-1", { tool: "browser_batch", tabId: 7, args: { tabId: 7, steps } }),
    );
    // A batch of twenty full waits asks for far more than this; it is still running.
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    router.settle({ callId: "call-2", outcome: "ok" });
    expect(router.inFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_CALL_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
  });

  /**
   * 011/T285 — the backstop yields to a question the person has not seen yet (FR-148, FR-150).
   *
   * A pairing or consent card raised into a closed side panel waits two minutes, and the person has
   * to walk to their browser inside it. The backstop above is 30 s: without the worker's ticks it
   * would answer the agent `timed-out` while the card was still on screen, and the owner's answer a
   * minute later would land on a call nobody was waiting for. The tick carries the arithmetic
   * (`boundMs - waitedMs`) so nothing here has to remember what the worker decided.
   */
  describe("keep-alive from the worker's prompt-waiting ticks", () => {
    function tick(overrides: Record<string, unknown> = {}): PromptWaitingFrame {
      return {
        type: "prompt-waiting",
        sessionId: "session-1",
        callId: "call-1",
        kind: "ask",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 60_000,
        ...overrides,
      } as PromptWaitingFrame;
    }

    it("holds a call past the flat backstop and ends it when the prompt's own bound does", async () => {
      const router = new CallRouter({ send: () => undefined });

      const pending = router.call(request("call-1", { tabId: 7 }));
      await vi.advanceTimersByTimeAsync(5_000);
      router.noteWaiting(tick());

      // The moment the old backstop would have fired. The card is still on screen.
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 5_000);
      expect(router.inFlight).toBe(1);

      // What the tick asked for: the rest of the prompt's bound (55 s of it), plus a round trip so
      // the worker's own `timed-out` arrives first - which is the answer the agent should get.
      const rearmed = 5_000 + (60_000 - 5_000) + KEEP_ALIVE_SLACK_MS;
      await vi.advanceTimersByTimeAsync(rearmed - CALL_TIMEOUT_MS - 1);
      expect(router.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
    });

    it("never holds a call longer than the cap, whatever the ticks say", async () => {
      const router = new CallRouter({ send: () => undefined });

      const pending = router.call(request("call-1", { tabId: 7 }));
      await vi.advanceTimersByTimeAsync(5_000);
      // A worker that asked for ten minutes - a bug, or a frame from somewhere else. The host's
      // own promise is that a call always ends; the ticks may postpone it, never remove it.
      router.noteWaiting(tick({ boundMs: 600_000 }));

      // Measured from the call's admission, not from the tick: five seconds of the cap are already
      // spent by the time the first tick arrives.
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CAP_MS - 5_000 - 1);
      expect(router.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
      expect(KEEP_ALIVE_CAP_MS).toBe(130_000);
    });

    it("changes nothing for a call it does not hold, or a tick that names none", async () => {
      const router = new CallRouter({ send: () => undefined });

      const pending = router.call(request("call-1", { tabId: 7 }));
      // A tick for another session's call, and the pairing tick that names no call at all: neither
      // may extend a call this router is holding, or one session could hold another's open.
      router.noteWaiting(tick({ callId: "call-other" }));
      const { callId: _callId, ...pairing } = tick({ kind: "pairing" });
      router.noteWaiting(pairing as PromptWaitingFrame);

      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
    });

    it("never shortens a bound the call's own arguments asked for", async () => {
      const router = new CallRouter({ send: () => undefined });

      const steps = Array.from({ length: 20 }, () => ({ tool: "wait", args: { forMs: 15_000 } }));
      const pending = router.call(request("call-1", { tool: "browser_batch", tabId: 7, args: { tabId: 7, steps } }));
      // A batch legitimately outlives both the flat backstop and the cap. A tick raised mid-batch -
      // one of its steps asked the owner something - must not pull its ending forward.
      router.noteWaiting(tick());

      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CAP_MS);
      expect(router.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_CALL_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
    });

    /**
     * 011 review H1 — the tick a batch step raises names the batch, and the batch is what is held.
     *
     * A step runs under a call id derived from the batch's, so the worker's question is *about* the
     * step and the call this router is holding is the batch. The tick therefore names the batch,
     * and the ordinary arithmetic applies to it: a short batch whose step asked the owner something
     * is held for the question's own two minutes instead of ending while the card is on screen.
     */
    it("holds a short batch for the bound a step's question named", async () => {
      const router = new CallRouter({ send: () => undefined });

      // One click: the flat backstop plus the round-trip slack, and no longer - 35 s.
      const steps = [{ tool: "click", args: { target: { ref: "t_one" } } }];
      const pending = router.call(request("call-1", { tool: "browser_batch", tabId: 7, args: { tabId: 7, steps } }));
      await vi.advanceTimersByTimeAsync(5_000);
      router.noteWaiting(tick({ boundMs: 120_000 }));

      // The bound the arguments stated has passed and the card is still up.
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + SLACK_MS - 5_000);
      expect(router.inFlight).toBe(1);

      // What the tick asked for, measured from the call's admission and stopped at the cap: the
      // rest of the two minutes plus a round trip is 130 s, which is exactly the cap.
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CAP_MS - CALL_TIMEOUT_MS - SLACK_MS - 1);
      expect(router.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });
    });
  });

  it("fails every call in flight when the link goes away", async () => {
    const router = new CallRouter({ send: () => undefined });

    const first = router.call(request("call-1", { tabId: 7 }));
    const second = router.call(request("call-2", { tabId: 8 }));
    router.failAll("failed", "bridge-closed");

    await expect(first).resolves.toEqual({ callId: "call-1", outcome: "failed", reason: "bridge-closed" });
    await expect(second).resolves.toEqual({ callId: "call-2", outcome: "failed", reason: "bridge-closed" });
    // Nothing is left holding a timer that would fire into a dead link.
    expect(router.inFlight).toBe(0);
  });
});
