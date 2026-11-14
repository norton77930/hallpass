import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { readMainWorldMarks } from "../src/chrome-adapters/main-world-marks.js";
import {
  enumerateFrameOffsets,
  enumerateTabFrames,
  enumerateTabFramesForRead,
} from "../src/chrome-adapters/scripting.js";
import { createAgentPageBindings, type AgentPageBinding } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentReads } from "../src/service-worker/agent-tools/reads.js";
import { findOnTab } from "../src/service-worker/agent-tools/refs.js";
import { readFrameFocus } from "../src/service-worker/agent-tools/frame-focus.js";
import type { BrowserFrame } from "../src/service-worker/agent-tools/frames.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";

/**
 * #71 option A: the read tools enumerate frames without waiting for them to load.
 *
 * An all-frames injection that waits for every frame never settles while a below-the-fold
 * `<iframe loading="lazy">` has not loaded; asked to inject immediately, the same call settled in a
 * few milliseconds with every frame answering, the unloaded ones as their initial empty
 * `about:blank` document. Only the reads take that path: the click locator, the frame offsets, the
 * main-world marks and the frame focus keep the bounded default, because the last two decide a
 * frame's site and must never see a not-yet-loaded frame as an about:blank document of the parent's
 * origin. And a read that could not see a frame's real document says `truncated: true`.
 */

const TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/lazy`;

type Injection = { target: { tabId: number; allFrames?: boolean; frameIds?: number[] }; injectImmediately?: boolean; func?: unknown };

/** Records every executeScript injection and answers each all-frames one with the top frame alone. */
function recordInjections(): Injection[] {
  const injections: Injection[] = [];
  vi.stubGlobal("chrome", {
    scripting: {
      async executeScript(injection: Injection) {
        injections.push(injection);
        return [{ frameId: 0, documentId: "d0", result: { url: PAGE_URL, path: [] } }];
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
  });
  return injections;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#71 which all-frames injections wait for frames to load", () => {
  it("the read enumeration injects immediately", async () => {
    const injections = recordInjections();
    await enumerateTabFramesForRead(TAB);
    expect(injections).toHaveLength(1);
    expect(injections[0]?.injectImmediately).toBe(true);
  });

  const waiting: Array<[string, () => Promise<unknown>]> = [
    ["enumerateTabFrames (the click ref locator's enumeration)", () => enumerateTabFrames(TAB)],
    ["enumerateFrameOffsets", () => enumerateFrameOffsets(TAB)],
    ["readMainWorldMarks", () => readMainWorldMarks(TAB, "key")],
    ["readFrameFocus", () => readFrameFocus(TAB)],
  ];
  for (const [name, call] of waiting) {
    it(`${name} keeps the default`, async () => {
      const injections = recordInjections();
      await call().catch(() => undefined);
      expect(injections.length).toBeGreaterThan(0);
      for (const injection of injections) expect(injection.injectImmediately).toBeUndefined();
    });
  }

  it("get_page_text and read_page enumerate through the immediate injection by default", async () => {
    const injections = recordInjections();
    const runner = createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
      collect: (async () => ({
        tabId: TAB,
        contextHandle: "snap",
        documentEpoch: "doc-1",
        canonicalOrigin: SITE,
        formValueItems: [],
        visibleText: "Top",
        semanticNodes: [],
        truncated: false,
      })) as never,
    });
    await runner.run({ callId: "c1", sessionId: "s1", tool: "get_page_text", tabId: TAB, args: { tabId: TAB } });
    await runner.run({ callId: "c2", sessionId: "s1", tool: "read_page", tabId: TAB, args: { tabId: TAB } });
    const allFrames = injections.filter((injection) => injection.target.allFrames === true);
    expect(allFrames).toHaveLength(2);
    for (const injection of allFrames) expect(injection.injectImmediately).toBe(true);
  });

  it("find enumerates through the immediate injection by default", async () => {
    const injections = recordInjections();
    const binding: AgentPageBinding = { tabId: TAB, documentEpoch: "doc-1", canonicalOrigin: SITE, site: SITE };
    await findOnTab(testSessionContexts().forCall("s1", "c1"), binding, "Save", 3);
    const allFrames = injections.filter((injection) => injection.target.allFrames === true);
    expect(allFrames).toHaveLength(1);
    expect(allFrames[0]?.injectImmediately).toBe(true);
  });
});

/** One frame as its own document sees itself: what `framePath` reads from its globals. */
type FrameScene = {
  frameId: number;
  href: string;
  readyState?: DocumentReadyState;
  /** Absent for the top frame; `null` for a holder the frame cannot reach (another origin). */
  holder?: { src?: string; srcdoc?: string } | null;
};

/**
 * Runs the injected function once per frame, each time against that frame's own `window`,
 * `location` and `document`, the way the browser runs it in every frame of the tab.
 */
function stubFrames(scenes: FrameScene[]): void {
  const top: Record<string | number, unknown> = { length: scenes.length - 1 };
  top.parent = top;
  top.top = top;
  const windows = scenes.map((scene, index) => {
    if (scene.holder === undefined) return top;
    const holder =
      scene.holder === null
        ? null
        : {
            getAttribute: (name: string) => (scene.holder as Record<string, string | undefined>)[name] ?? null,
            hasAttribute: (name: string) => (scene.holder as Record<string, string | undefined>)[name] !== undefined,
          };
    const child = { parent: top, top, length: 0, frameElement: holder };
    top[index - 1] = child;
    return child;
  });
  vi.stubGlobal("chrome", {
    scripting: {
      async executeScript(injection: { func: () => unknown }) {
        return scenes.map((scene, index) => {
          vi.stubGlobal("window", windows[index]);
          vi.stubGlobal("location", { href: scene.href });
          vi.stubGlobal("document", { readyState: scene.readyState ?? "complete", baseURI: PAGE_URL });
          return { frameId: scene.frameId, result: injection.func() };
        });
      },
    },
  });
}

const TOP: FrameScene = { frameId: 0, href: PAGE_URL };

describe("#71 a frame that has not loaded its real document", () => {
  async function unloadedIds(scenes: FrameScene[]): Promise<number[]> {
    stubFrames(scenes);
    const frames = await enumerateTabFramesForRead(TAB);
    return frames.filter((frame) => (frame as BrowserFrame).unloaded === true).map((frame) => frame.frameId);
  }

  it("is flagged while it is still the initial about:blank under a real src", async () => {
    expect(
      await unloadedIds([TOP, { frameId: 5, href: "about:blank", holder: { src: "https://embed.test/comments" } }]),
    ).toEqual([5]);
  });

  it("is flagged while a relative src has not loaded", async () => {
    expect(await unloadedIds([TOP, { frameId: 5, href: "about:blank", holder: { src: "/child" } }])).toEqual([5]);
  });

  it("is flagged while a srcdoc has not loaded", async () => {
    expect(await unloadedIds([TOP, { frameId: 5, href: "about:blank", holder: { srcdoc: "<p>x</p>" } }])).toEqual([5]);
  });

  it("is flagged while its document is still loading", async () => {
    expect(await unloadedIds([TOP, { frameId: 5, href: `${SITE}/child`, readyState: "loading", holder: {} }])).toEqual([5]);
  });

  it("is flagged when it is about:blank and its holder cannot be reached (fail-honest)", async () => {
    expect(await unloadedIds([TOP, { frameId: 5, href: "about:blank", holder: null }])).toEqual([5]);
  });

  it("is not flagged when it is legitimately blank, srcdoc, or loaded", async () => {
    expect(
      await unloadedIds([
        TOP,
        { frameId: 5, href: "about:blank", holder: {} },
        { frameId: 6, href: "about:blank", holder: { src: "about:blank" } },
        { frameId: 8, href: "about:srcdoc", holder: { srcdoc: "<p>x</p>" } },
        { frameId: 9, href: `${SITE}/child`, holder: { src: "/child" } },
        { frameId: 10, href: "https://embed.test/comments", holder: null },
      ]),
    ).toEqual([]);
  });

  it("the waiting enumeration never flags a frame", async () => {
    stubFrames([TOP, { frameId: 5, href: "about:blank", holder: { src: "https://embed.test/comments" } }]);
    const frames = await enumerateTabFrames(TAB);
    expect(frames.some((frame) => "unloaded" in frame)).toBe(false);
  });
});

describe("#71 a read over a page with a frame that has not loaded", () => {
  const LOADED: BrowserFrame = { frameId: 11, parentFrameId: 0, url: `${SITE}/child` };
  const LAZY: BrowserFrame = { frameId: 12, parentFrameId: 0, url: "about:blank", unloaded: true };
  const TOP_FRAME: BrowserFrame = { frameId: 0, parentFrameId: -1, url: PAGE_URL };

  function runner(frames: BrowserFrame[]) {
    recordInjections();
    const asked: Array<number | undefined> = [];
    const collect = vi.fn(async (input: { frameId?: number }) => {
      asked.push(input.frameId);
      const text = input.frameId === 11 ? "Child text" : input.frameId === 12 ? "" : "Top text";
      return {
        tabId: TAB,
        contextHandle: `snap-${input.frameId ?? 0}`,
        documentEpoch: `doc-${input.frameId ?? 0}`,
        canonicalOrigin: SITE,
        formValueItems: [],
        visibleText: text,
        semanticNodes: [{ role: "button", label: text, targetHandle: `t_${input.frameId ?? 0}`, depth: 1 }],
        truncated: false,
      };
    });
    const reads = createAgentReads({
      context: testSessionContexts(),
      bindings: createAgentPageBindings(),
      tabOwnership: async () => ({ state: "this" }),
      collect: collect as never,
      enumerateFrames: async () => frames,
      probeFrameSender: async () => ({}),
    });
    return { reads, asked };
  }

  function request(tool: "get_page_text" | "read_page"): AgentNativeRequest {
    const args = tool === "read_page" ? { tabId: TAB, filter: "all" } : { tabId: TAB };
    return { callId: "call-1", sessionId: "session-1", tool, tabId: TAB, args };
  }

  it("get_page_text answers the loaded frames, truncated, without asking the unloaded one", async () => {
    const { reads, asked } = runner([TOP_FRAME, LOADED, LAZY]);
    const answered = await reads.run(request("get_page_text"));
    expect(answered).toMatchObject({ outcome: "ok", result: { text: "Top text\nChild text", truncated: true } });
    expect(asked).not.toContain(12);
  });

  it("read_page lists the unloaded frame as unread and answers truncated, without asking it", async () => {
    const { reads, asked } = runner([TOP_FRAME, LOADED, LAZY]);
    const answered = (await reads.run(request("read_page"))) as { result: { truncated: boolean; frames: unknown[] } };
    expect(answered.result.truncated).toBe(true);
    expect(answered.result.frames).toContainEqual(
      expect.objectContaining({ url: "about:blank", readable: false, reason: "no-answer" }),
    );
    expect(asked).not.toContain(12);
  });

  it("a top document that has not loaded makes a single-document read truncated", async () => {
    const { reads } = runner([{ ...TOP_FRAME, unloaded: true }]);
    expect(await reads.run(request("get_page_text"))).toMatchObject({ result: { truncated: true } });
    expect(await reads.run(request("read_page"))).toMatchObject({ result: { truncated: true } });
  });

  it("a page whose frames all loaded is answered as whole, as before", async () => {
    const { reads } = runner([TOP_FRAME, LOADED]);
    expect(await reads.run(request("get_page_text"))).toMatchObject({
      result: { text: "Top text\nChild text", truncated: false },
    });
    expect(await reads.run(request("read_page"))).toMatchObject({ result: { truncated: false } });
  });
});
