import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentStopSignals } from "../src/service-worker/agent-tools/stop.js";
import { createAgentWait } from "../src/service-worker/agent-tools/wait.js";

/**
 * 003/T049 — `wait` (US5, FR-048).
 *
 * A wait observes and changes nothing, so it never enters the gate and never asks the owner
 * anything. What it owes the agent is an *explicit ending*: the condition held, the bound was
 * reached, the owner stopped it, or the document it was watching went away. Each is a different
 * word here, because a wait that reported "not met" for a page that had navigated would send an
 * agent looking for an element on a document that no longer exists.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/waiting`;

function installChrome(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: { async get() { return {}; }, async set() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        const frame = message as { type: string };
        if (frame.type === "content.probe") return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        if (frame.type === "content.resolve-active-element") {
          return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_body" }] };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

type Evaluate = NonNullable<Parameters<typeof createAgentWait>[0]["evaluate"]>;

function harness(overrides: Partial<Parameters<typeof createAgentWait>[0]> = {}) {
  const stops = createAgentStopSignals();
  // Never holds, so a wait built on it can only end at its bound or at a Stop.
  const evaluate = overrides.evaluate ?? (vi.fn(async () => ({ ok: true, holds: false })) as unknown as Evaluate);
  const runner = createAgentWait({
    context: testSessionContexts(),
    bindings: createAgentPageBindings(),
    stops,
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    pollMs: 10,
    ...overrides,
    evaluate,
  });
  return { runner, stops, evaluate };
}

function waitRequest(args: Record<string, unknown>, callId = "call-1"): AgentNativeRequest {
  return { callId, sessionId: "session-h1", tool: "wait", tabId: AGENT_TAB, args: { tabId: AGENT_TAB, ...args } } as AgentNativeRequest;
}

describe("T049 wait", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("ends as soon as the condition holds, and says how long it waited", async () => {
    let asked = 0;
    const { runner } = harness({
      evaluate: vi.fn(async () => {
        asked += 1;
        return { ok: true, holds: asked >= 3 };
      }) as unknown as Evaluate,
    });

    const response = await runner.run(waitRequest({ condition: "present", ref: "t_result", maxMs: 5_000 }));

    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ outcome: "condition-met" });
    expect((response.result as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(0);
    expect(asked).toBe(3);
  });

  it("asks the page about the ref it was given, on the tab it was given", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { runner } = harness({
      evaluate: vi.fn(async (input: Record<string, unknown>) => {
        seen.push(input);
        return { ok: true, holds: true };
      }) as unknown as Evaluate,
    });

    await runner.run(waitRequest({ condition: "enabled", ref: "t_result", maxMs: 1_000 }));

    expect(seen[0]).toMatchObject({
      condition: "enabled",
      targetHandle: "t_result",
      expectedTabId: AGENT_TAB,
      canonicalOrigin: SITE,
      documentEpoch: "doc-1",
    });
  });

  it("ends at its bound with an explicit answer when the condition never holds", async () => {
    const { runner } = harness();

    const response = await runner.run(waitRequest({ condition: "present", ref: "t_never", maxMs: 60 }));

    expect(response).toEqual({ callId: "call-1", outcome: "failed", reason: "bound-reached" });
  });

  it("ends at once when the owner stops it (FR-048)", async () => {
    const { runner, stops } = harness();

    const pending = runner.run(waitRequest({ condition: "present", ref: "t_never", maxMs: 10_000 }));
    stops.stop("call-1");

    await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "stopped", reason: "owner-stopped" });
  });

  it("ends a wait running inside a batch when the batch is stopped", async () => {
    const { runner, stops } = harness();

    // The step's call id is the batch's with its position appended; a Stop naming the batch has to
    // reach it, or the batch would sit out this wait's whole bound before noticing.
    const pending = runner.run(waitRequest({ condition: "present", ref: "t_never", maxMs: 10_000 }, "call-1#2"));
    stops.stop("call-1");

    await expect(pending).resolves.toMatchObject({ outcome: "stopped", reason: "owner-stopped" });
  });

  /**
   * 006 FR-087 (S1 review nit 6): the owner's Release tabs lands mid-wait. The lease is read again
   * on every poll - it is local - so the wait stops evaluating a tab that is the owner's again and
   * answers the refusal any unheld tab gets, for a condition and for a fixed wait alike.
   */
  it("stops polling a tab the owner released mid-wait, and answers not-yours", async () => {
    let held = true;
    const { runner, evaluate } = harness({
      tabOwnership: async (_sessionId, tabId) => (held && tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    });

    const pending = runner.run(waitRequest({ condition: "present", ref: "t_never", maxMs: 10_000 }));
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalled());
    held = false;
    const response = await pending;
    const polled = (evaluate as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(response).toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((evaluate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(polled);

    held = true;
    const fixed = runner.run(waitRequest({ forMs: 10_000 }, "call-2"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    held = false;
    await expect(fixed).resolves.toMatchObject({ callId: "call-2", outcome: "denied", reason: "not-yours" });
  });

  it("reports a document that changed under it as stale, not as a condition that did not hold", async () => {
    const { runner } = harness({
      evaluate: vi.fn(async () => ({ ok: false, reason: "stale-context" })) as unknown as Evaluate,
    });

    const response = await runner.run(waitRequest({ condition: "present", ref: "t_result", maxMs: 5_000 }));

    expect(response).toEqual({ callId: "call-1", outcome: "stale", reason: "document-changed" });
  });

  it("waits a fixed time without asking the page anything", async () => {
    const { runner, evaluate } = harness();

    const started = Date.now();
    const response = await runner.run(waitRequest({ forMs: 40 }));

    expect(response.outcome).toBe("ok");
    expect((response.result as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("ends a fixed wait at once when the owner stops it", async () => {
    const { runner, stops } = harness();

    const pending = runner.run(waitRequest({ forMs: 10_000 }));
    stops.stop();

    await expect(pending).resolves.toMatchObject({ outcome: "stopped", reason: "owner-stopped" });
  });

  it("takes the baseline from the tab when a text-changed wait names no element", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { runner } = harness({
      evaluate: vi.fn(async (input: Record<string, unknown>) => {
        seen.push(input);
        return { ok: true, holds: true };
      }) as unknown as Evaluate,
    });

    const response = await runner.run(waitRequest({ condition: "visible-text-changed", maxMs: 1_000 }));

    expect(response.outcome).toBe("ok");
    // The handle the registry minted for what the tab has focused - `<body>` on a page nobody has
    // clicked into - so the baseline is the page's, and staleness has the one meaning it always has.
    expect(seen[0]).toMatchObject({ targetHandle: "t_body", condition: "visible-text-changed" });
  });

  it("addresses frame 0 with the binding's own identity on a page with no other frames (004/T160 regression)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { runner } = harness({
      evaluate: vi.fn(async (input: Record<string, unknown>) => {
        seen.push(input);
        return { ok: true, holds: true };
      }) as unknown as Evaluate,
    });

    await runner.run(waitRequest({ condition: "present", ref: "t_result", maxMs: 1_000 }));

    // No frame-discovery machinery leaks a frame identity into a single-document page's call - it
    // stays exactly what it was before T160.
    expect(seen[0]).not.toHaveProperty("frameId");
    expect(seen[0]).not.toHaveProperty("frameOrigin");
    expect(seen[0]).toMatchObject({ documentEpoch: "doc-1", canonicalOrigin: SITE });
  });

  it("threads the ref's own frame into every poll, not the binding's top-document identity (004/T160)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const discoverFrame = vi.fn(async () => ({
      frameId: 3,
      documentEpoch: "doc-frame-3",
      canonicalOrigin: "https://embed.test",
    }));
    const { runner } = harness({
      discoverFrame: discoverFrame as unknown as NonNullable<
        Parameters<typeof createAgentWait>[0]["discoverFrame"]
      >,
      evaluate: vi.fn(async (input: Record<string, unknown>) => {
        seen.push(input);
        return { ok: true, holds: true };
      }) as unknown as Evaluate,
    });

    await runner.run(waitRequest({ condition: "present", ref: "t_nested", maxMs: 1_000 }));

    expect(discoverFrame).toHaveBeenCalledWith(expect.anything(), expect.anything(), "t_nested");
    expect(seen[0]).toMatchObject({
      frameId: 3,
      documentEpoch: "doc-frame-3",
      frameOrigin: "https://embed.test",
      // The binding's own identity is still what the leased-tab check compares the page against -
      // only the frame-local facts change.
      canonicalOrigin: SITE,
    });
  });

  it("refuses a tab the session does not own, and arguments the contract does not admit", async () => {
    const { runner, evaluate } = harness();

    await expect(
      runner.run({
        callId: "call-1",
        sessionId: "session-h1",
        tool: "wait",
        tabId: 99,
        args: { tabId: 99, forMs: 10 },
      } as AgentNativeRequest),
    ).resolves.toEqual({ callId: "call-1", outcome: "denied", reason: "not-yours", refusal: { reason: "not-yours" } });

    await expect(runner.run(waitRequest({ condition: "present", maxMs: 100 }))).resolves.toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "invalid-arguments",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  /**
   * 005/T182 - `download-complete` (FR-078, R-124): decided by the worker against the session's
   * ring, never by the page. The observer is asked each poll for the next completion; a file that
   * finished before the wait began is still answered once, the same completion is never answered
   * twice, and a failure or cancellation is an ending in its own word.
   */
  describe("download-complete (005/T182)", () => {
    type Completion = { id: number; filename: string; url: string; state: "complete" | "failed" | "canceled" };
    const ZIP: Completion = { id: 3, filename: "C:\dl\master.zip", url: "https://agent.test/master.zip", state: "complete" };

    function downloads(answers: Array<Completion | undefined>) {
      const asked: string[] = [];
      return {
        asked,
        takeCompletion: vi.fn(async (sessionId: string) => {
          asked.push(sessionId);
          return answers.shift();
        }),
      };
    }

    it("answers a completion that happened before the wait began, once", async () => {
      const ring = downloads([ZIP]);
      const { runner, evaluate } = harness({ downloads: ring });

      const response = await runner.run(waitRequest({ condition: "download-complete", maxMs: 500 }));

      expect(response.outcome).toBe("ok");
      expect(response.result).toMatchObject({ outcome: "condition-met", download: ZIP });
      // The session's ring, and the page was never asked anything.
      expect(ring.asked).toEqual(["session-h1"]);
      expect(evaluate).not.toHaveBeenCalled();

      // The same completion satisfies no second wait: the observer hands nothing out and the
      // wait runs to its bound in the tool's own words.
      const again = await runner.run(waitRequest({ condition: "download-complete", maxMs: 40 }, "call-2"));
      expect(again).toEqual({ callId: "call-2", outcome: "failed", reason: "bound-reached" });
    });

    it("polls until the download ends, and reports a failure or a cancellation as the ending", async () => {
      const canceled: Completion = { ...ZIP, id: 4, state: "canceled" };
      const ring = downloads([undefined, undefined, canceled]);
      const { runner } = harness({ downloads: ring });

      const response = await runner.run(waitRequest({ condition: "download-complete", maxMs: 5_000 }));

      expect(response.outcome).toBe("ok");
      expect(response.result).toMatchObject({ outcome: "condition-met", download: canceled });
      expect(ring.takeCompletion).toHaveBeenCalledTimes(3);
    });

    it("ends at once when the owner stops it, and refuses a tab the session does not hold", async () => {
      const ring = downloads([]);
      const { runner, stops } = harness({ downloads: ring });

      const pending = runner.run(waitRequest({ condition: "download-complete", maxMs: 5_000 }));
      await vi.waitFor(() => expect(ring.takeCompletion).toHaveBeenCalled());
      stops.stop("call-1");
      await expect(pending).resolves.toEqual({ callId: "call-1", outcome: "stopped", reason: "owner-stopped" });

      await expect(
        runner.run({
          callId: "call-3",
          sessionId: "session-h1",
          tool: "wait",
          tabId: 99,
          args: { tabId: 99, condition: "download-complete", maxMs: 100 },
        } as AgentNativeRequest),
      ).resolves.toMatchObject({ callId: "call-3", outcome: "denied", reason: "not-yours" });
    });
  });

  /**
   * 008/T226 — a wait on a page a dialog is holding still (FR-111, US3 edge case).
   *
   * `wait` is one of the four calls a dialog does not block, and this is why: it is how an agent
   * that is waiting learns *why* nothing is happening. The condition can never become true while
   * the page is modal, so spending the whole bound on it would turn a one-second fact into a
   * thirty-second silence. `condition-unmet` is the ending that says something was observed - and
   * names it.
   */
  it("ends condition-unmet with the dialog when one is open on the tab it is watching", async () => {
    const dialog = {
      id: "d1",
      type: "confirm" as const,
      message: "Delete 3 orders?",
      openedAt: 1_700_000_000_000,
      tabId: AGENT_TAB,
    };
    let open = false;
    const evaluate = vi.fn(async () => {
      // The page opens its confirm while the wait is running, as it does on a real page.
      open = true;
      return { ok: true, holds: false };
    }) as unknown as Evaluate;
    const { runner } = harness({
      evaluate,
      currentDialog: (tabId) => (open && tabId === AGENT_TAB ? dialog : undefined),
    });

    const response = await runner.run(waitRequest({ condition: "present", ref: "t_result", maxMs: 5_000 }));

    expect(response.outcome).toBe("ok");
    expect(response.result).toMatchObject({ outcome: "condition-unmet", dialog });
    // Asked once, then told why: the wait does not keep polling a page nobody can change.
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("never asks the owner anything and never enters the gate", async () => {
    const { runner } = harness({ evaluate: vi.fn(async () => ({ ok: true, holds: true })) as unknown as Evaluate });

    // No site mode was ever set for this page: an effect here would prompt, and a wait does not.
    const response = await runner.run(waitRequest({ condition: "present", ref: "t_result", maxMs: 500 }));

    expect(response.outcome).toBe("ok");
  });
});
