import { describe, expect, it } from "vitest";
import {
  FRAME_ANSWER_BOUND_MS,
  mergePageFrames,
  mergePageText,
  type BrowserFrame,
  type FrameSubtreeNode,
} from "../src/service-worker/agent-tools/frames.js";

/**
 * 004/T112 — one page tree out of every readable frame (US4 read half, R-114, FR-063).
 *
 * The thing under test is not "can the worker talk to a frame" - S2 settled that the declared
 * content script is in every frame from `document_start`. It is what the *answer* looks like when
 * some of the frames answer and some do not: the page a read describes has to be one tree, the
 * frame a node came from has to travel with the node, and a frame that stayed silent has to be a
 * *listed* part of the page rather than a missing one. A read that failed because one frame was
 * quiet would tell an agent the page is unreadable, when what is true is that a part of it is.
 *
 * The labels are opaque on purpose: `0`, `f1`, `f2`… in tree order, never Chrome's frame ids, for
 * the reason a ref is opaque - a browser-wide handle is a thing an agent could keep and re-use
 * after the document it named is gone.
 */

const TAB = 11;

function frame(frameId: number, parentFrameId: number, url: string): BrowserFrame {
  return { frameId, parentFrameId, url };
}

function node(role: string, name: string, depth: number, extra: Partial<FrameSubtreeNode> = {}): FrameSubtreeNode {
  return { role, name, depth, ...extra };
}

/** A frame that never answers at all - the T107a fact: this is what "no receiver" looks like too. */
function silent(): Promise<{ nodes: FrameSubtreeNode[] }> {
  return new Promise(() => {});
}

/** The same silence, for the text read. */
function silentText(): Promise<{ text: string; truncated: boolean }> {
  return new Promise(() => {});
}

function readerFor(subtrees: Record<number, () => Promise<{ nodes: FrameSubtreeNode[] }>>) {
  const asked: number[] = [];
  return {
    asked,
    read: async (input: { tabId: number; frameId: number }) => {
      asked.push(input.frameId);
      const answer = subtrees[input.frameId];
      if (!answer) throw new Error(`no subtree for frame ${input.frameId}`);
      return answer();
    },
  };
}

describe("004/T112 merging every readable frame into one page tree", () => {
  it("splices each child frame's nodes under the node that owns them, in tree order", async () => {
    const reader = readerFor({
      0: async () => ({
        nodes: [
          node("heading", "Top", 0),
          node("iframe", "left", 1, { frameOwner: true }),
          node("iframe", "right", 1, { frameOwner: true }),
          node("button", "Footer", 1),
        ],
      }),
      3: async () => ({ nodes: [node("button", "Inside left", 0)] }),
      7: async () => ({ nodes: [node("button", "Inside right", 0)] }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(3, 0, "https://fixtures.test/left.html"),
        frame(7, 0, "https://fixtures.test/right.html"),
      ],
      readSubtree: reader.read,
    });

    expect(page.nodes.map((entry) => [entry.name, entry.frame, entry.depth])).toEqual([
      ["Top", "0", 0],
      ["left", "0", 1],
      ["Inside left", "f1", 2],
      ["right", "0", 1],
      ["Inside right", "f2", 2],
      ["Footer", "0", 1],
    ]);
    expect(page.frames).toEqual([
      { frame: "0", parent: "0", url: "https://fixtures.test/frames.html", readable: true },
      { frame: "f1", parent: "0", url: "https://fixtures.test/left.html", readable: true },
      { frame: "f2", parent: "0", url: "https://fixtures.test/right.html", readable: true },
    ]);
    expect(page.truncated).toBe(false);
  });

  it("never lets a raw browser frame id reach the answer", async () => {
    const reader = readerFor({
      0: async () => ({ nodes: [node("iframe", "embed", 0, { frameOwner: true })] }),
      918: async () => ({ nodes: [node("button", "Deep", 0)] }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(918, 0, "https://fixtures.test/deep.html"),
      ],
      readSubtree: reader.read,
    });

    const labels = [...page.frames.map((entry) => entry.frame), ...page.frames.map((entry) => entry.parent)];
    expect(labels).toEqual(["0", "f1", "0", "0"]);
    expect(JSON.stringify(page)).not.toContain("918");
  });

  it("lists a frame that did not answer within the bound as no-answer and still succeeds", async () => {
    const reader = readerFor({
      0: async () => ({
        nodes: [node("iframe", "quiet", 0, { frameOwner: true }), node("button", "Top button", 0)],
      }),
      4: silent,
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(4, 0, "https://fixtures.test/quiet.html"),
      ],
      readSubtree: reader.read,
      boundMs: 5,
    });

    expect(page.frames[1]).toEqual({
      frame: "f1",
      parent: "0",
      url: "https://fixtures.test/quiet.html",
      readable: false,
      reason: "no-answer",
    });
    // The read still succeeded and carries everything else: a part of this page could not be read,
    // which is not the same fact as the page being unreadable (FR-063).
    expect(page.nodes.map((entry) => entry.name)).toEqual(["quiet", "Top button"]);
  });

  it("waits for the answer rather than matching an error string", async () => {
    let release: ((value: { nodes: FrameSubtreeNode[] }) => void) | undefined;
    const reader = readerFor({
      0: async () => ({ nodes: [node("iframe", "slow", 0, { frameOwner: true })] }),
      4: () =>
        new Promise<{ nodes: FrameSubtreeNode[] }>((resolve) => {
          release = resolve;
          setTimeout(() => resolve({ nodes: [node("button", "Late but here", 0)] }), 5);
        }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(4, 0, "https://fixtures.test/slow.html"),
      ],
      readSubtree: reader.read,
      boundMs: 500,
    });

    expect(release).toBeTypeOf("function");
    expect(page.frames[1]?.readable).toBe(true);
    expect(page.nodes.map((entry) => entry.name)).toEqual(["slow", "Late but here"]);
  });

  it("bounds the wait across the whole page rather than per frame", async () => {
    const reader = readerFor({
      0: async () => ({
        nodes: [
          node("iframe", "a", 0, { frameOwner: true }),
          node("iframe", "b", 0, { frameOwner: true }),
          node("iframe", "c", 0, { frameOwner: true }),
        ],
      }),
      1: silent,
      2: silent,
      3: silent,
    });

    const started = Date.now();
    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(1, 0, "https://fixtures.test/a.html"),
        frame(2, 0, "https://fixtures.test/b.html"),
        frame(3, 0, "https://fixtures.test/c.html"),
      ],
      readSubtree: reader.read,
      boundMs: 40,
    });

    // Three silent frames on one 40 ms page bound, not three 40 ms waits in a row.
    expect(Date.now() - started).toBeLessThan(110);
    expect(page.frames.slice(1).map((entry) => entry.reason)).toEqual(["no-answer", "no-answer", "no-answer"]);
  });

  it("lists a frame the browser forbids as not-allowed and never asks it", async () => {
    const reader = readerFor({
      0: async () => ({
        nodes: [node("iframe", "internal", 0, { frameOwner: true }), node("button", "Top button", 0)],
      }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(6, 0, "chrome://settings/"),
      ],
      readSubtree: reader.read,
    });

    expect(page.frames[1]).toEqual({
      frame: "f1",
      parent: "0",
      url: "chrome://settings/",
      readable: false,
      reason: "not-allowed",
    });
    expect(reader.asked).toEqual([0]);
    expect(page.nodes.map((entry) => entry.name)).toEqual(["internal", "Top button"]);
  });

  it("applies the node bound across the whole page and says which limit cut it", async () => {
    const reader = readerFor({
      0: async () => ({ nodes: [node("iframe", "one", 0, { frameOwner: true }), node("button", "Last", 0)] }),
      2: async () => ({ nodes: [node("button", "A", 0), node("button", "B", 0)] }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(2, 0, "https://fixtures.test/one.html"),
      ],
      readSubtree: reader.read,
      maxNodes: 3,
    });

    expect(page.nodes.map((entry) => entry.name)).toEqual(["one", "A", "B"]);
    expect(page.truncated).toBe(true);
    expect(page.truncatedBy).toBe("nodes");
    // The frames are still all listed: the page had a fourth node, not a fourth frame.
    expect(page.frames).toHaveLength(2);
  });

  it("applies the character bound across the whole page and says which limit cut it", async () => {
    const reader = readerFor({
      0: async () => ({ nodes: [node("iframe", "aaaa", 0, { frameOwner: true })] }),
      2: async () => ({ nodes: [node("button", "bbbb", 0), node("button", "cccc", 0)] }),
    });

    const page = await mergePageFrames(TAB, {
      enumerateFrames: async () => [
        frame(0, -1, "https://fixtures.test/frames.html"),
        frame(2, 0, "https://fixtures.test/one.html"),
      ],
      readSubtree: reader.read,
      maxChars: 8,
    });

    expect(page.nodes.map((entry) => entry.name)).toEqual(["aaaa", "bbbb"]);
    expect(page.truncated).toBe(true);
    expect(page.truncatedBy).toBe("chars");
  });

  it("has a default answer bound so a page with no bound given still ends", () => {
    expect(FRAME_ANSWER_BOUND_MS).toBeGreaterThan(0);
  });
});

/**
 * 004/T115 — the same page, read as text (US4 read half, FR-036).
 *
 * The text read answers in the shape it always had: a string and whether it was cut. It gains no
 * frame list, because the structured read is where frame accounting belongs, so what has to hold
 * here is that the string is the frames' text *in frame order*, that the ceiling is one ceiling for
 * the page rather than one per frame, and that a frame which said nothing costs the answer its text
 * and not its success.
 */
describe("004/T115 merging every readable frame into one page text", () => {
  const FRAMES: BrowserFrame[] = [
    frame(0, -1, "https://fixtures.test/frames.html"),
    frame(3, 0, "https://fixtures.test/left.html"),
    frame(7, 0, "https://fixtures.test/right.html"),
  ];

  it("concatenates the readable frames' text in frame order", async () => {
    const page = await mergePageText(TAB, {
      enumerateFrames: async () => FRAMES,
      readText: async ({ frameId }) => ({ text: `frame-${frameId}`, truncated: false }),
    });

    expect(page).toEqual({ text: "frame-0\nframe-3\nframe-7", truncated: false });
  });

  it("applies the character ceiling across the whole page, not once per frame", async () => {
    const page = await mergePageText(TAB, {
      enumerateFrames: async () => FRAMES,
      readText: async ({ frameId }) => ({ text: `frame-${frameId}`, truncated: false }),
      maxChars: 10,
    });

    // 004/T135a: which limit ran out, so the agent knows the next call may raise it.
    expect(page).toEqual({ text: "frame-0\nfr", truncated: true, truncatedBy: "chars" });
  });

  it("leaves out a frame that said nothing and says the text is not all of the page", async () => {
    const page = await mergePageText(TAB, {
      enumerateFrames: async () => FRAMES,
      readText: async ({ frameId }) =>
        frameId === 3 ? silentText() : { text: `frame-${frameId}`, truncated: false },
      boundMs: 20,
    });

    expect(page).toEqual({ text: "frame-0\nframe-7", truncated: true });
  });

  it("carries a frame's own truncation up to the page", async () => {
    const page = await mergePageText(TAB, {
      enumerateFrames: async () => FRAMES,
      readText: async ({ frameId }) => ({ text: `frame-${frameId}`, truncated: frameId === 7 }),
    });

    expect(page).toEqual({ text: "frame-0\nframe-3\nframe-7", truncated: true, truncatedBy: "chars" });
  });
});
