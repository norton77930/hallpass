import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import {
  AGENT_CALL_TIMEOUT_SLACK_MS as SLACK_MS,
  AGENT_MAX_CALL_TIMEOUT_MS as MAX_CALL_TIMEOUT_MS,
} from "@hallpass/contracts";
import { CallRouter, CALL_TIMEOUT_MS } from "../src/router.js";

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
