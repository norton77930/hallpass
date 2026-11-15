import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import {
  ALL_FRAMES_BOUND_MS,
  AllFramesTimeoutError,
  createAllFramesCallMemo,
  executeInAllFrames,
} from "../src/chrome-adapters/all-frames.js";
import { enumerateFrameOffsets, enumerateTabFrames } from "../src/chrome-adapters/scripting.js";
import { createAgentEffects, createTargetLocator } from "../src/service-worker/agent-tools/effects.js";
import type { FrameOffsets } from "../src/service-worker/agent-tools/frames.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { testInputAttachments } from "./helpers/input-attachments.js";
import { oneDocumentAnswer, oneDocumentFocus } from "./helpers/point-site.js";

/**
 * #70: one stuck all-frames lookup per tool call, not one per lookup.
 *
 * An unloaded `<iframe loading="lazy">` keeps every all-frames injection pending, so each one waits
 * the whole bound (`executeInAllFrames`) before its caller takes its reject path - and a single tool
 * call makes several (a ref click claims the ref's frame before the gate, then locates it). Within
 * one call on one tab, once one of the call's own lookups has timed out, the next rejects at once
 * with the same error; the next call waits the bound again, because by then the frame may have
 * loaded. A lookup the call does not make itself is never touched.
 */

const TAB = 7;
const OTHER_TAB = 8;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/lazy`;

type Stub = { allFrames: number[]; answer: boolean };

/**
 * The browser: an all-frames injection on a tab never settles (a lazy frame below the fold) unless
 * `answer` is set, which answers it with the top document alone. The rest is what an effect's
 * binding and site-mode store need from a one-document page.
 */
function installChrome(): Stub {
  const stub: Stub = { allFrames: [], answer: false };
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
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
    scripting: {
      executeScript(details: { target: { tabId: number; allFrames?: boolean } }) {
        if (details.target.allFrames !== true) return Promise.resolve([]);
        stub.allFrames.push(details.target.tabId);
        if (stub.answer) return Promise.resolve([{ frameId: 0, documentId: "d", result: { url: PAGE_URL, path: [] } }]);
        return new Promise(() => undefined);
      },
    },
    tabs: {
      async get(tabId: number) {
        return { id: tabId, url: PAGE_URL };
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
  return stub;
}

/** The call's outcome after `ms` of fake time, or "pending" when it has not settled by then. */
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("an all-frames call memory (#70)", () => {
  /** A memory and the two lookups a call makes through it, as the effects runner wires them. */
  function callLookups() {
    const memo = createAllFramesCallMemo();
    return {
      memo,
      frames: memo.guard((tabId: number) => enumerateTabFrames(tabId)),
      offsets: memo.guard(enumerateFrameOffsets),
    };
  }

  it("rejects a later lookup in the same call at once, with the same timeout error, without asking again", async () => {
    const stub = installChrome();
    const { memo, frames, offsets } = callLookups();
    const close = memo.open(TAB);
    try {
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");

      const second = offsets(TAB);
      expect(await outcomeAfter(second, 0)).toBe("rejected");
      await expect(second).rejects.toBeInstanceOf(AllFramesTimeoutError);
      expect(stub.allFrames).toEqual([TAB]);
    } finally {
      close();
    }
  });

  it("waits the full bound again in a new call on the same tab", async () => {
    installChrome();
    const { memo, frames } = callLookups();
    const first = memo.open(TAB);
    expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");
    first();

    const second = memo.open(TAB);
    try {
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    } finally {
      second();
    }
    // And outside any call, exactly as before #70.
    expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
  });

  it("leaves another tab's lookups alone", async () => {
    installChrome();
    const { memo, frames } = callLookups();
    const close = memo.open(TAB);
    const other = memo.open(OTHER_TAB);
    try {
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");
      expect(await outcomeAfter(frames(OTHER_TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    } finally {
      close();
      other();
    }
  });

  it("remembers nothing from a lookup that answered", async () => {
    const stub = installChrome();
    const { memo, frames } = callLookups();
    const close = memo.open(TAB);
    try {
      stub.answer = true;
      expect(await outcomeAfter(frames(TAB), 0)).toBe("resolved");
      stub.answer = false;
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    } finally {
      close();
    }
  });

  it("does not let a lookup that outlived its call mark the next call", async () => {
    installChrome();
    const { memo, frames } = callLookups();
    const first = memo.open(TAB);
    const late = frames(TAB);
    first();
    const second = memo.open(TAB);
    try {
      expect(await outcomeAfter(late, ALL_FRAMES_BOUND_MS)).toBe("rejected");
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    } finally {
      second();
    }
  });

  it("remembers nothing while two calls are open on one tab, and neither shares the other's", async () => {
    const stub = installChrome();
    const { memo, frames } = callLookups();
    const first = memo.open(TAB);
    const second = memo.open(TAB);
    try {
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");
      // Neither call's lookup is refused on the strength of a timeout the other may have seen.
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
      second();
      // Nothing was charged while two were open, so the call left open has nothing to remember.
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
      expect(stub.allFrames).toEqual([TAB, TAB, TAB]);
    } finally {
      first();
      second();
    }
  });

  it("leaves a lookup made outside the call alone", async () => {
    const stub = installChrome();
    const { memo, frames } = callLookups();
    const close = memo.open(TAB);
    try {
      // Attaching the tab, `wait`, the uploads: their own lookups, not the call's.
      expect(await outcomeAfter(enumerateTabFrames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");
      stub.answer = true;
      expect(await outcomeAfter(enumerateTabFrames(TAB), 0)).toBe("resolved");
      expect(stub.allFrames).toEqual([TAB, TAB]);
      // Nor did their timeout mark the call: its own lookup still waits the bound.
      stub.answer = false;
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    } finally {
      close();
    }
  });

  it("leaves a lookup made outside the call alone after the call's own lookup timed out", async () => {
    const stub = installChrome();
    const { memo, frames } = callLookups();
    const close = memo.open(TAB);
    try {
      expect(await outcomeAfter(frames(TAB), ALL_FRAMES_BOUND_MS)).toBe("rejected");
      stub.answer = true;
      // A waiting lookup and the reads' immediate one, made by something else on the tab.
      expect(await outcomeAfter(enumerateTabFrames(TAB), 0)).toBe("resolved");
      expect(await outcomeAfter(enumerateTabFrames(TAB, { injectImmediately: true }), 0)).toBe("resolved");
      expect(stub.allFrames).toEqual([TAB, TAB, TAB]);
    } finally {
      close();
    }
  });

  it("passes the bound a caller gave to a remembered timeout's error", async () => {
    installChrome();
    const memo = createAllFramesCallMemo();
    const injection = { target: { tabId: TAB, allFrames: true }, func: () => 1 };
    const lookup = memo.guard((_tabId: number) => executeInAllFrames(injection, 50));
    const close = memo.open(TAB);
    try {
      expect(await outcomeAfter(lookup(TAB), 50)).toBe("rejected");
      const remembered = lookup(TAB);
      expect(await outcomeAfter(remembered, 0)).toBe("rejected");
      await expect(remembered).rejects.toThrow("within 50 ms");
    } finally {
      close();
    }
  });
});

describe("an effect on a page with a stuck all-frames lookup (#70)", () => {
  function clickRequest(callId: string): AgentNativeRequest {
    return { callId, sessionId: "session-h1", tool: "click", tabId: TAB, args: { tabId: TAB, target: { ref: "t_save" } } };
  }

  /**
   * The effects runner with the real pre-gate claim (`discoverRefFrame`) and a real locator looking
   * up under the runner's own memory, so both of the click's all-frames lookups run; only the page's
   * own answers are stubbed. `readFrameFocus` is the real all-frames read unless one is given.
   */
  function runner(
    options: {
      siteModes?: ReturnType<typeof createSiteModeStore>;
      prompts?: ReturnType<typeof createAgentPromptController>;
      readFrameFocus?: typeof oneDocumentFocus;
    } = {},
  ) {
    const siteModes = options.siteModes ?? createSiteModeStore();
    const input = testInputAttachments();
    const recorded = input.attachments.send.bind(input.attachments);
    input.attachments.send = async (tabId, method, params, sessionId) => {
      const answered = await recorded(tabId, method, params, sessionId);
      return oneDocumentAnswer(method) ?? answered;
    };
    const collect = (async () => ({
      tabId: TAB,
      contextHandle: "snap-1",
      documentEpoch: "doc-1",
      canonicalOrigin: SITE,
      formValueItems: [],
      semanticNodes: [{ role: "button", label: "Save", targetHandle: "t_save", rect: { x: 100, y: 40, width: 80, height: 20 } }],
      truncated: false,
    })) as unknown as NonNullable<Parameters<typeof createTargetLocator>[0]["collect"]>;
    const allFramesMemo = createAllFramesCallMemo();
    const locator = createTargetLocator({
      offsets: {} as FrameOffsets,
      collect,
      enumerateFrames: allFramesMemo.guard((tabId: number) => enumerateTabFrames(tabId)),
    });
    const prompts = options.prompts ?? createAgentPromptController({ timeoutMs: 60 });
    const effects = createAgentEffects({
      context: testSessionContexts(),
      siteModes,
      bindings: createAgentPageBindings(),
      prompts,
      tabOwnership: async (_sessionId, tabId) => (tabId === TAB ? { state: "this" } : { state: "not-yours" }),
      attachments: input.attachments,
      cursor: () => {},
      locate: (located) => locator.forDelivery()(located),
      confirm: async () => ({ outcome: "hit" as const }),
      execute: vi.fn(),
      probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
      ...(options.readFrameFocus ? { readFrameFocus: options.readFrameFocus } : {}),
      allFramesMemo,
      settleMs: 0,
    });
    return { effects, siteModes, prompts, input, allFramesMemo };
  }

  it("spends one bound, not one per lookup, and still clicks", async () => {
    const stub = installChrome();
    const { effects, siteModes } = runner({ readFrameFocus: oneDocumentFocus });
    await siteModes.set(SITE, { mode: "skip-checks" });

    const response = effects.run(clickRequest("call-1"));
    let answered: Awaited<typeof response> | undefined;
    void response.then((value) => {
      answered = value;
    });
    await vi.advanceTimersByTimeAsync(ALL_FRAMES_BOUND_MS + 100);

    expect(answered).toMatchObject({ callId: "call-1", outcome: "ok", result: { observed: { effect: "activated" } } });
    expect(stub.allFrames).toEqual([TAB]);
  });

  it("re-checks focus under the memory after the owner answers an ask card, with no second bound", async () => {
    const stub = installChrome();
    const prompts = createAgentPromptController({ timeoutMs: 60_000 });
    const { effects, siteModes, input } = runner({ prompts });
    await siteModes.set(SITE, { mode: "ask" });

    const response = effects.run({
      callId: "call-1",
      sessionId: "session-h1",
      tool: "key",
      tabId: TAB,
      args: { tabId: TAB, key: "Enter" },
    });
    // The focus read before the gate waits out the bound; the frame keys reach is then unknown, which asks.
    await vi.advanceTimersByTimeAsync(ALL_FRAMES_BOUND_MS + 100);
    expect(prompts.current()).toMatchObject({ site: SITE, frame: { unknown: true }, tool: "key" });
    expect(stub.allFrames).toEqual([TAB]);

    prompts.decide(prompts.current()?.promptId ?? "", true);
    // The re-check before the first key reads focus again: refused at once, so it is unknown again -
    // what the owner just answered - and the key goes without a second bound.
    expect(await outcomeAfter(response, 0)).toBe("resolved");
    expect(await response).toMatchObject({ callId: "call-1", outcome: "ok" });
    expect(input.commands.some((command) => command.method === "Input.dispatchKeyEvent")).toBe(true);
    expect(stub.allFrames).toEqual([TAB]);
  });

  it("closes the call's memory when the call throws", async () => {
    const stub = installChrome();
    const store = createSiteModeStore();
    // The gate's site-mode read fails after the pre-gate claim has already timed out.
    const failing = { ...store, get: async () => Promise.reject(new Error("storage gone")) } as typeof store;
    const { effects, allFramesMemo } = runner({ siteModes: failing, readFrameFocus: oneDocumentFocus });

    const response = effects.run(clickRequest("call-1"));
    expect(await outcomeAfter(response, ALL_FRAMES_BOUND_MS + 100)).toBe("rejected");
    // The call's claim did time out before the throw, so its memory held that timeout.
    expect(stub.allFrames).toEqual([TAB]);

    // A memory left open would be the tab's only one, still holding that timeout, and would refuse
    // a lookup made through the runner's memory at once.
    const lookup = allFramesMemo.guard((tabId: number) => enumerateTabFrames(tabId));
    expect(await outcomeAfter(lookup(TAB), ALL_FRAMES_BOUND_MS - 1)).toBe("pending");
    expect(stub.allFrames).toEqual([TAB, TAB]);
  });
});
