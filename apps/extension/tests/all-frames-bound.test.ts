import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { readMainWorldMarks } from "../src/chrome-adapters/main-world-marks.js";
import { enumerateFrameOffsets, enumerateTabFrames } from "../src/chrome-adapters/scripting.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { readFrameFocus } from "../src/service-worker/agent-tools/frame-focus.js";
import { FRAME_ANSWER_BOUND_MS } from "../src/service-worker/agent-tools/frames.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";

/**
 * The all-frames injections are bounded (fix-lazy-iframe).
 *
 * `chrome.scripting.executeScript({ target: { allFrames: true } })` never settles while the tab holds
 * an `<iframe loading="lazy">` that has not loaded (measured on a page with a lazy comments frame at
 * its bottom, scrolled to the top). Nothing bounded those calls, so every read hung until the host
 * gave up. Each of the four callers now rejects once the frame bound passes, and each caller already
 * has a path for a rejected call.
 */

const TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/lazy`;

/** An all-frames injection that waits on a frame which never loads: no answer, ever. */
function stubNeverSettling(): { calls: number } {
  const state = { calls: 0 };
  (globalThis as { chrome?: unknown }).chrome = {
    scripting: {
      executeScript() {
        state.calls += 1;
        return new Promise(() => undefined);
      },
    },
    tabs: {
      async get() {
        return { id: TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        if ((message as { type: string }).type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        throw new Error("unexpected message");
      },
    },
  };
  return state;
}

/** Settles with the call's outcome after `ms` of fake time, or reports it as still pending. */
async function outcomeAfter(call: Promise<unknown>, ms: number): Promise<"pending" | "rejected" | "resolved"> {
  let outcome: "pending" | "rejected" | "resolved" = "pending";
  call.then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe("a never-settling allFrames executeScript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const callers: Array<[string, () => Promise<unknown>]> = [
    ["enumerateTabFrames", () => enumerateTabFrames(TAB)],
    ["enumerateFrameOffsets", () => enumerateFrameOffsets(TAB)],
    ["readMainWorldMarks", () => readMainWorldMarks(TAB, "key")],
    ["readFrameFocus", () => readFrameFocus(TAB)],
  ];

  for (const [name, call] of callers) {
    it(`${name} rejects within the frame bound`, async () => {
      stubNeverSettling();
      const pending = call();
      const settled = outcomeAfter(pending, FRAME_ANSWER_BOUND_MS);
      expect(await settled).toBe("rejected");
    });

    it(`${name} is still waiting just before the bound`, async () => {
      stubNeverSettling();
      expect(await outcomeAfter(call(), FRAME_ANSWER_BOUND_MS - 1)).toBe("pending");
    });
  }

  it("leaves no timer behind when the injection answers in time", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: { executeScript: async () => [{ frameId: 0, documentId: "d", result: "m" }] },
    };
    await readMainWorldMarks(TAB, "key");
    expect(vi.getTimerCount()).toBe(0);
  });

  /** A reads runner over a collector that answers the top document only. */
  function readsRunner(enumerateFrames?: typeof enumerateTabFrames) {
    const collect = vi.fn(async () => ({
      tabId: TAB,
      contextHandle: "snap-1",
      documentEpoch: "doc-1",
      canonicalOrigin: SITE,
      formValueItems: [],
      visibleText: "Top document text",
      semanticNodes: [{ role: "button", label: "Save", targetHandle: "t_save", depth: 1 }],
      truncated: false,
    }));
    return createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async (_sessionId, tabId) => (tabId === TAB ? { state: "this" } : { state: "not-yours" }),
      collect: collect as unknown as typeof import("../src/service-worker/content-broker.js").collectFromActiveTab,
      ...(enumerateFrames === undefined ? {} : { enumerateFrames }),
    });
  }

  function request(tool: "get_page_text" | "read_page"): AgentNativeRequest {
    return { callId: "call-1", sessionId: "session-h1", tool, tabId: TAB, args: { tabId: TAB } };
  }

  async function answerWithin(runner: ReturnType<typeof readsRunner>, tool: "get_page_text" | "read_page", ms: number) {
    const response = runner.run(request(tool));
    let answered: Awaited<typeof response> | undefined;
    void response.then((value) => {
      answered = value;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return answered;
  }

  // eb221c1 review I1: a timed-out enumeration left loaded child frames out, so the answer is the
  // top document only and must say it is not the whole page.
  it("get_page_text answers the top document's text, marked truncated, when the enumeration times out", async () => {
    const state = stubNeverSettling();

    const answered = await answerWithin(readsRunner(), "get_page_text", FRAME_ANSWER_BOUND_MS);

    expect(state.calls).toBeGreaterThan(0);
    expect(answered).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { text: "Top document text", truncated: true },
    });
  });

  it("read_page answers the top document's nodes, marked truncated, when the enumeration times out", async () => {
    stubNeverSettling();

    const answered = await answerWithin(readsRunner(), "read_page", FRAME_ANSWER_BOUND_MS);

    expect(answered).toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { nodes: [{ ref: "t_save", role: "button", name: "Save", depth: 1 }], truncated: true },
    });
  });

  it("an enumeration that fails for another reason still reads as the top document alone", async () => {
    stubNeverSettling(); // the page probe still needs the tab; the enumeration is the injected one
    const failing = (async () => {
      throw new Error("no such tab");
    }) as typeof enumerateTabFrames;

    const text = await answerWithin(readsRunner(failing), "get_page_text", 0);
    const page = await answerWithin(readsRunner(failing), "read_page", 0);

    expect(text).toMatchObject({ result: { text: "Top document text", truncated: false } });
    expect(page).toMatchObject({ result: { truncated: false } });
  });

  it("a single-document page, enumerated quickly, is still answered as whole", async () => {
    stubNeverSettling();
    const single = (async () => [{ frameId: 0, parentFrameId: -1, url: PAGE_URL }]) as typeof enumerateTabFrames;

    const text = await answerWithin(readsRunner(single), "get_page_text", 0);
    const page = await answerWithin(readsRunner(single), "read_page", 0);

    expect(text).toMatchObject({ result: { text: "Top document text", truncated: false } });
    expect(page).toMatchObject({ result: { truncated: false } });
  });
});
