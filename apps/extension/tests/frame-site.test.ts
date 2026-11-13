import { describe, expect, it } from "vitest";
import {
  decideFrameSite,
  resolveFocusSite,
  resolvePointSite,
  sameDecidingSite,
  type DecidingSite,
  type FocusSitePorts,
  type FrameFocusAnswer,
  type FrameSiteReply,
} from "../src/service-worker/agent-tools/frame-site.js";
import { fakePointPage, type FakeFrame } from "./helpers/point-site.js";

/**
 * 030/T889 - which site decides an action inside a frame (FR-451, FR-452, FR-453, R-440, R-441).
 *
 * The values are the ones measured on 2026-11-07 (research.md, "Measured 2026-11-07 (T886)"): the
 * top site, a second site on another host, and a third origin on another port. Only the origin the
 * browser attached to the frame's message decides; what the frame wrote into the message is never
 * read, so a frame that lies is decided by its true site.
 */

const PAGE = "https://127.0.0.1:19443";
const SECOND = "https://localhost:19443";
const THIRD = "https://127.0.0.1:19445";

const claimed = { frameId: 4, documentId: "doc-4" } as const;

function reply(sender: FrameSiteReply["sender"], body: unknown = {}): FrameSiteReply {
  return { sender, body };
}

const fromClaimed = (origin: string | undefined, body: unknown = {}): FrameSiteReply =>
  reply({ origin, frameId: claimed.frameId, documentId: claimed.documentId }, body);

const unknownSite = { kind: "unknown", pageSite: PAGE, frameId: claimed.frameId, documentId: claimed.documentId };

describe("030 decideFrameSite", () => {
  it("gives the page's site when the sender origin is the page's", () => {
    expect(decideFrameSite(fromClaimed(PAGE, { origin: PAGE }), claimed, PAGE)).toEqual({
      kind: "page",
      site: PAGE,
      pageSite: PAGE,
      frameId: claimed.frameId,
      documentId: claimed.documentId,
    });
  });

  it("gives the sender's site when the body claims the page's site", () => {
    expect(decideFrameSite(fromClaimed(SECOND, { origin: PAGE, url: `${PAGE}/` }), claimed, PAGE)).toEqual({
      kind: "frame",
      site: SECOND,
      pageSite: PAGE,
      frameId: claimed.frameId,
      documentId: claimed.documentId,
    });
  });

  it("gives the page's site when the body claims another site but the sender is the page", () => {
    expect(decideFrameSite(fromClaimed(PAGE, { origin: SECOND, url: `${SECOND}/` }), claimed, PAGE)).toMatchObject({
      kind: "page",
      site: PAGE,
    });
  });

  it("never reads the message body", () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the body was read");
        },
        has() {
          throw new Error("the body was read");
        },
        ownKeys() {
          throw new Error("the body was read");
        },
      },
    );
    expect(decideFrameSite(fromClaimed(SECOND, untouchable), claimed, PAGE)).toMatchObject({
      kind: "frame",
      site: SECOND,
    });
  });

  it("gives a srcdoc frame its holder's site although it reports an opaque origin for itself", () => {
    // Measured: sender origin = the page's site, `location.origin` = "null".
    expect(decideFrameSite(fromClaimed(PAGE, { origin: "null" }), claimed, PAGE)).toMatchObject({
      kind: "page",
      site: PAGE,
    });
  });

  it("gives an about:blank frame written by its parent the parent's site", () => {
    expect(decideFrameSite(fromClaimed(PAGE, { origin: PAGE, url: "about:blank" }), claimed, PAGE)).toMatchObject({
      kind: "page",
      site: PAGE,
    });
  });

  it("gives a sandboxed frame no site although its body claims the page's", () => {
    // Measured: sender origin "null", `location.origin` = the page's site.
    expect(decideFrameSite(fromClaimed("null", { origin: PAGE }), claimed, PAGE)).toEqual(unknownSite);
  });

  it("gives no site for a missing, empty, unparseable or non-web sender origin", () => {
    for (const origin of [
      undefined,
      "",
      "not an origin",
      "file://",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "data:text/html,hi",
      "blob:https://127.0.0.1:19443/1234",
      "about:blank",
    ]) {
      expect(decideFrameSite(fromClaimed(origin, { origin: PAGE }), claimed, PAGE), String(origin)).toEqual(
        unknownSite,
      );
    }
  });

  it("gives no site when the sender frame id is missing or not the claimed one", () => {
    for (const frameId of [undefined, 5, 0]) {
      expect(
        decideFrameSite(reply({ origin: PAGE, frameId, documentId: claimed.documentId }), claimed, PAGE),
        String(frameId),
      ).toEqual(unknownSite);
    }
  });

  it("gives no site when the sender document id is missing or not the claimed one", () => {
    // Measured: a frame navigated to another origin answers with a new document id.
    for (const documentId of [undefined, "", "doc-5"]) {
      expect(
        decideFrameSite(reply({ origin: THIRD, frameId: claimed.frameId, documentId }), claimed, PAGE),
        String(documentId),
      ).toEqual(unknownSite);
    }
  });

  it("matches by full origin: another port, host, scheme or subdomain is another site", () => {
    for (const other of [THIRD, SECOND, "http://127.0.0.1:19443", "https://sub.fixtures.test"]) {
      expect(decideFrameSite(fromClaimed(other), claimed, PAGE), other).toMatchObject({ kind: "frame", site: other });
    }
    expect(decideFrameSite(fromClaimed("https://sub.fixtures.test"), claimed, "https://fixtures.test")).toMatchObject({
      kind: "frame",
      site: "https://sub.fixtures.test",
      pageSite: "https://fixtures.test",
    });
  });

  it("canonicalises the sender origin before comparing", () => {
    expect(decideFrameSite(fromClaimed("https://fixtures.test:443"), claimed, "https://fixtures.test")).toMatchObject({
      kind: "page",
      site: "https://fixtures.test",
    });
  });
});

/**
 * 030/T897 - which frame is under a point, and whose site it is (FR-455, R-442 as settled by T886).
 *
 * The debugger only finds the frame: `DOM.getNodeForLocation`, descending into a frame's own
 * session when the point is over a frame in another process. That frame is then named to the
 * extension by a one-time nonce written through the debugger and read back across all frames, and
 * its site is the browser's sender origin - never the debugger's `securityOrigin`.
 */
describe("030 resolvePointSite hit-test walk", () => {
  const SANDBOX_BOX = { x: 700, y: 100, width: 200, height: 150 };
  const second = (overrides: Partial<FakeFrame> = {}): FakeFrame => ({
    cdpFrameId: "T-SECOND",
    box: { x: 100, y: 50, width: 300, height: 200 },
    outOfProcess: true,
    frameId: 5,
    documentId: "bdoc-5",
    sender: SECOND,
    // The debugger's own word for it: never the deciding site.
    securityOrigin: PAGE,
    ...overrides,
  });
  const srcdoc = (overrides: Partial<FakeFrame> = {}): FakeFrame => ({
    cdpFrameId: "F-SRCDOC",
    box: { x: 10, y: 400, width: 200, height: 100 },
    outOfProcess: false,
    frameId: 3,
    documentId: "bdoc-3",
    sender: PAGE,
    securityOrigin: "://",
    ...overrides,
  });

  const methods = (calls: Array<{ method: string }>) => calls.map((call) => call.method);

  it("gives page for a point in the top document, with no nonce, read-back or probe", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });

    const decided = await resolvePointSite({ x: 20, y: 20 }, PAGE, page);

    expect(decided).toEqual({ kind: "page", site: PAGE, pageSite: PAGE });
    expect(methods(page.calls)).not.toContain("Runtime.callFunctionOn");
    expect(methods(page.calls)).not.toContain("DOM.resolveNode");
    expect(page.marksRead).toEqual([]);
    expect(page.probed).toEqual([]);
  });

  it("gives page for a point on a frame holder's border, outside its content box", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });
    // The hit-test answers the holder at a point just outside its content box, as a border hit does.
    const holderHit = await page.send("DOM.getNodeForLocation", { x: 150, y: 100 });
    page.calls.length = 0;
    const send: typeof page.send = async (method, params, sessionId) =>
      method === "DOM.getNodeForLocation" && sessionId === undefined ? holderHit : page.send(method, params, sessionId);

    const decided = await resolvePointSite({ x: 99, y: 100 }, PAGE, { ...page, send });

    expect(decided).toEqual({ kind: "page", site: PAGE, pageSite: PAGE });
    expect(page.marksRead).toEqual([]);
    expect(page.probed).toEqual([]);
  });

  it("gives a same-process frame's own sender origin, found in the top session", async () => {
    // Measured: a frame on the page's host at another port shares its process.
    const page = fakePointPage([srcdoc({ cdpFrameId: "F-THIRD", frameId: 4, documentId: "bdoc-4", sender: THIRD })], {
      pageSite: PAGE,
    });

    const decided = await resolvePointSite({ x: 50, y: 420 }, PAGE, page);

    expect(decided).toEqual({ kind: "frame", site: THIRD, pageSite: PAGE, frameId: 4, documentId: "bdoc-4" });
    // One hit-test: the node is inside the frame already, so no session is entered.
    expect(page.calls.filter((call) => call.method === "DOM.getNodeForLocation")).toEqual([
      { method: "DOM.getNodeForLocation", params: expect.objectContaining({ x: 50, y: 420 }) },
    ]);
    expect(page.calls.every((call) => call.sessionId === undefined)).toBe(true);
    expect(page.probed).toEqual([4]);
  });

  it("gives a srcdoc frame its holder's site from the sender, whatever the debugger calls it", async () => {
    const page = fakePointPage([srcdoc()], { pageSite: PAGE });

    expect(await resolvePointSite({ x: 50, y: 420 }, PAGE, page)).toEqual({
      kind: "page",
      site: PAGE,
      pageSite: PAGE,
      frameId: 3,
      documentId: "bdoc-3",
    });
  });

  it("descends into an out-of-process frame's session with the point shifted by the holder's content box", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });

    const decided = await resolvePointSite({ x: 160, y: 90 }, PAGE, page);

    expect(decided).toEqual({ kind: "frame", site: SECOND, pageSite: PAGE, frameId: 5, documentId: "bdoc-5" });
    expect(page.calls.filter((call) => call.method === "DOM.getNodeForLocation")).toEqual([
      { method: "DOM.getNodeForLocation", params: expect.objectContaining({ x: 160, y: 90 }) },
      // The holder's child frame id is the frame's target id: its session is asked at (60, 40).
      { method: "DOM.getNodeForLocation", params: expect.objectContaining({ x: 60, y: 40 }), sessionId: "session-T-SECOND" },
    ]);
    // The nonce is written in the frame's own session, into the frame's main world.
    const writes = page.calls.filter((call) => call.method === "Runtime.callFunctionOn");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((call) => call.sessionId === "session-T-SECOND")).toBe(true);
  });

  // Measured in the 030 packaged gate (T905): the hit-test takes whole pixels only, and refuses the
  // centre of an element's box (hover at a point) or a point shifted by a holder at a fractional
  // offset (every out-of-process frame in a page with default body margins).
  it("asks the hit-test in whole pixels for a fractional point in the top document", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });

    expect(await resolvePointSite({ x: 90.89375305175781, y: 219.037504196167 }, PAGE, page)).toEqual({
      kind: "page",
      site: PAGE,
      pageSite: PAGE,
    });
  });

  it("descends into an out-of-process frame whose holder sits at a fractional offset", async () => {
    const page = fakePointPage([second({ box: { x: 8.8, y: 100.4, width: 480, height: 180 } })], { pageSite: PAGE });

    const decided = await resolvePointSite({ x: 326, y: 154 }, PAGE, page);

    expect(decided).toEqual({ kind: "frame", site: SECOND, pageSite: PAGE, frameId: 5, documentId: "bdoc-5" });
    // Rounded down, so the shifted point stays inside the frame's own viewport.
    expect(page.calls.filter((call) => call.method === "DOM.getNodeForLocation")[1]).toEqual({
      method: "DOM.getNodeForLocation",
      params: expect.objectContaining({ x: 317, y: 53 }),
      sessionId: "session-T-SECOND",
    });
  });

  it("finds the innermost frame through two processes", async () => {
    const inner: FakeFrame = {
      cdpFrameId: "T-INNER",
      box: { x: 20, y: 30, width: 100, height: 80 },
      outOfProcess: true,
      frameId: 9,
      documentId: "bdoc-9",
      sender: THIRD,
    };
    const page = fakePointPage([second({ children: [inner] })], { pageSite: PAGE });

    // (100, 50) + (20, 30) + (5, 5)
    const decided = await resolvePointSite({ x: 125, y: 85 }, PAGE, page);

    expect(decided).toEqual({ kind: "frame", site: THIRD, pageSite: PAGE, frameId: 9, documentId: "bdoc-9" });
    expect(page.calls.filter((call) => call.method === "DOM.getNodeForLocation").map((call) => call.sessionId)).toEqual([
      undefined,
      "session-T-SECOND",
      "session-T-INNER",
    ]);
  });

  it("names the frame by a nonce written through the debugger, read back across all frames, then cleared", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });
    let seenDuringRead: Array<{ frame: string; key: string }> = [];
    const readMarks: typeof page.readMarks = async (key) => {
      seenDuringRead = page.leftovers();
      return page.readMarks(key);
    };

    await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...page, readMarks });

    // Written into the frame found, and only there, at the moment of the read-back.
    expect(seenDuringRead).toHaveLength(1);
    expect(seenDuringRead[0]?.frame).toBe("T-SECOND");
    expect(page.marksRead).toEqual([seenDuringRead[0]?.key]);
    // Gone afterwards, and the remote object let go.
    expect(page.leftovers()).toEqual([]);
    expect(page.calls.some((call) => call.method === "Runtime.releaseObject")).toBe(true);
  });

  it("clears the nonce when the read-back finds no frame holding it", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE, unscriptable: [5] });

    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, page)).toEqual({ kind: "unknown", pageSite: PAGE });
    expect(page.leftovers()).toEqual([]);
    expect(page.probed).toEqual([]);
  });

  it("decides a sandboxed frame by its opaque sender origin, never by its securityOrigin", async () => {
    const page = fakePointPage(
      [second({ cdpFrameId: "T-SANDBOX", box: SANDBOX_BOX, frameId: 6, documentId: "bdoc-6", sender: "null", securityOrigin: PAGE })],
      { pageSite: PAGE },
    );

    expect(await resolvePointSite({ x: 750, y: 150 }, PAGE, page)).toEqual({
      kind: "unknown",
      pageSite: PAGE,
      frameId: 6,
      documentId: "bdoc-6",
    });
  });

  it("gives unknown when any step fails", async () => {
    const cases: Array<[string, ReturnType<typeof fakePointPage>]> = [
      ["frame tree", fakePointPage([second()], { pageSite: PAGE, failing: ["Page.getFrameTree"] })],
      ["hit-test", fakePointPage([second()], { pageSite: PAGE, failing: ["DOM.getNodeForLocation"] })],
      ["describe", fakePointPage([second()], { pageSite: PAGE, failing: ["DOM.describeNode"] })],
      ["box", fakePointPage([second()], { pageSite: PAGE, failing: ["DOM.getBoxModel"] })],
      ["no session for the frame", fakePointPage([second()], { pageSite: PAGE, missingSessions: ["T-SECOND"] })],
      ["resolve", fakePointPage([second()], { pageSite: PAGE, failing: ["DOM.resolveNode"] })],
      ["write", fakePointPage([second()], { pageSite: PAGE, failing: ["Runtime.callFunctionOn"] })],
    ];
    for (const [name, page] of cases) {
      expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, page), name).toMatchObject({ kind: "unknown", pageSite: PAGE });
      expect(page.probed, name).toEqual([]);
    }
  });

  it("gives unknown when the marks read-back rejects, and still clears the nonce", async () => {
    // eb221c1 review nit: the read-back is the call the all-frames bound can reject (a lazy frame).
    const page = fakePointPage([second()], { pageSite: PAGE });
    const readMarks: typeof page.readMarks = async () => {
      throw new Error("the read-back gave no answer");
    };

    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...page, readMarks })).toEqual({ kind: "unknown", pageSite: PAGE });
    expect(page.leftovers()).toEqual([]);
    expect(page.probed).toEqual([]);
  });

  it("gives unknown for a malformed hit-test answer, even over the top document", async () => {
    for (const answer of [{}, { backendNodeId: 1 }, { frameId: "top-frame" }]) {
      const page = fakePointPage([], { pageSite: PAGE });
      const send: typeof page.send = async (method, params, sessionId) =>
        method === "DOM.getNodeForLocation" ? answer : page.send(method, params, sessionId);
      expect(await resolvePointSite({ x: 1, y: 1 }, PAGE, { ...page, send }), JSON.stringify(answer)).toEqual({
        kind: "unknown",
        pageSite: PAGE,
      });
    }
  });

  it("gives unknown when more than one frame holds the nonce", async () => {
    const page = fakePointPage([second(), srcdoc()], { pageSite: PAGE });
    // A page that copies whatever lands in its window into a sibling (a same-origin frame can).
    const readMarks: typeof page.readMarks = async (key) => {
      page.plant("F-SRCDOC", key, page.globals.get("T-SECOND")?.[key]);
      return page.readMarks(key);
    };

    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...page, readMarks })).toEqual({ kind: "unknown", pageSite: PAGE });
    expect(page.probed).toEqual([]);
  });

  it("gives unknown when the probe says nothing, or answers from another document", async () => {
    const silent = fakePointPage([second()], { pageSite: PAGE });
    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...silent, probeSender: async () => ({}) })).toEqual({
      kind: "unknown",
      pageSite: PAGE,
      frameId: 5,
      documentId: "bdoc-5",
    });

    const navigated = fakePointPage([second()], { pageSite: PAGE });
    // The frame navigated between the read-back and the probe: a new document answers.
    const probeSender: typeof navigated.probeSender = async () => ({
      documentId: "bdoc-5-next",
      sender: { origin: SECOND, frameId: 5, documentId: "bdoc-5-next" },
    });
    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...navigated, probeSender })).toEqual({
      kind: "unknown",
      pageSite: PAGE,
      frameId: 5,
      documentId: "bdoc-5",
    });
  });

  it("gives unknown when the walk does not finish within its bound", async () => {
    const page = fakePointPage([second()], { pageSite: PAGE });
    const send: typeof page.send = (method, params, sessionId) =>
      method === "DOM.getNodeForLocation" ? new Promise(() => {}) : page.send(method, params, sessionId);

    expect(await resolvePointSite({ x: 160, y: 90 }, PAGE, { ...page, send, boundMs: 20 })).toEqual({
      kind: "unknown",
      pageSite: PAGE,
    });
  });
});

/**
 * 030/T908 - keys sent with no target are decided by the frame holding focus. Every frame says where
 * it hangs and which of its child frames holds its focus; the chain is followed from the top, the
 * frame found is named by the browser's ids on its answer, and its site is its sender origin.
 */
describe("030 resolveFocusSite", () => {
  const top = (focusedChild: unknown): FrameFocusAnswer => ({ frameId: 0, documentId: "bdoc-top", result: { path: [], focusedChild } });
  const child = (frameId: number, path: number[], focusedChild: unknown = -1): FrameFocusAnswer => ({
    frameId,
    documentId: `bdoc-${frameId}`,
    result: { path, focusedChild },
  });
  function ports(answers: FrameFocusAnswer[], senders: Record<number, string> = {}): FocusSitePorts & { probed: number[] } {
    const probed: number[] = [];
    return {
      probed,
      readFocus: async () => answers,
      probeSender: async (frameId) => {
        probed.push(frameId);
        const origin = senders[frameId];
        const documentId = `bdoc-${frameId}`;
        return origin === undefined ? {} : { documentId, sender: { origin, frameId, documentId } };
      },
    };
  }
  const unknown = { kind: "unknown", pageSite: PAGE };

  it("gives the page for focus in the top document, with no probe", async () => {
    const page = ports([top(-1), child(4, [0])], { 4: SECOND });
    expect(await resolveFocusSite(PAGE, page)).toEqual({ kind: "page", site: PAGE, pageSite: PAGE });
    expect(page.probed).toEqual([]);
  });

  it("follows the chain to the innermost frame and decides it by its sender origin", async () => {
    const page = ports([top(1), child(4, [0]), child(5, [1], 0), child(6, [1, 0])], { 6: THIRD });
    expect(await resolveFocusSite(PAGE, page)).toEqual({
      kind: "frame",
      site: THIRD,
      pageSite: PAGE,
      frameId: 6,
      documentId: "bdoc-6",
    });
    expect(page.probed).toEqual([6]);
  });

  it("gives the page's site for a focused child the browser gives the page's site (srcdoc, about:blank)", async () => {
    expect(await resolveFocusSite(PAGE, ports([top(0), child(4, [0])], { 4: PAGE }))).toEqual({
      kind: "page",
      site: PAGE,
      pageSite: PAGE,
      frameId: 4,
      documentId: "bdoc-4",
    });
  });

  it("gives unknown when a link of the chain did not answer, or two frames claim one place", async () => {
    expect(await resolveFocusSite(PAGE, ports([top(0)], { 4: SECOND }))).toEqual(unknown);
    expect(await resolveFocusSite(PAGE, ports([top(0), child(4, [0]), child(5, [0])], { 4: SECOND, 5: SECOND }))).toEqual(unknown);
    expect(await resolveFocusSite(PAGE, ports([], {}))).toEqual(unknown);
    // The top's place answered by a frame the browser does not number as the top.
    expect(await resolveFocusSite(PAGE, ports([{ ...top(-1), frameId: 3 }], {}))).toEqual(unknown);
  });

  it("gives unknown for a holder whose frame could not be named, or a malformed answer", async () => {
    expect(await resolveFocusSite(PAGE, ports([top(null), child(4, [0])], { 4: SECOND }))).toEqual(unknown);
    expect(await resolveFocusSite(PAGE, ports([top("0"), child(4, [0])], { 4: SECOND }))).toEqual(unknown);
    expect(await resolveFocusSite(PAGE, ports([{ frameId: 0, documentId: "bdoc-top", result: "page" }], {}))).toEqual(unknown);
    expect(await resolveFocusSite(PAGE, ports([{ frameId: 0, result: { path: [], focusedChild: -1 } }], {}))).toEqual(unknown);
  });

  it("gives unknown for a frame that answered path null (hung deeper than the cap, or unplaced)", async () => {
    const unplaced: FrameFocusAnswer = { frameId: 4, documentId: "bdoc-4", result: { path: null, focusedChild: -1 } };
    const page = ports([top(0), unplaced], { 4: SECOND });
    expect(await resolveFocusSite(PAGE, page)).toEqual(unknown);
    expect(page.probed).toEqual([]);
  });

  it("gives unknown, naming the frame, when its probe says nothing or answers from another document", async () => {
    const silent = ports([top(0), child(4, [0])], {});
    expect(await resolveFocusSite(PAGE, silent)).toEqual({ ...unknown, frameId: 4, documentId: "bdoc-4" });
    const moved: FocusSitePorts = {
      ...silent,
      probeSender: async (frameId) => ({ documentId: "bdoc-other", sender: { origin: SECOND, frameId, documentId: "bdoc-other" } }),
    };
    expect(await resolveFocusSite(PAGE, moved)).toEqual({ ...unknown, frameId: 4, documentId: "bdoc-4" });
  });

  it("gives unknown when the read fails or does not finish within its bound", async () => {
    expect(await resolveFocusSite(PAGE, { ...ports([]), readFocus: async () => Promise.reject(new Error("no tab")) })).toEqual(unknown);
    const never: FocusSitePorts = { ...ports([]), readFocus: () => new Promise(() => {}), boundMs: 20 };
    expect(await resolveFocusSite(PAGE, never)).toEqual(unknown);
  });
});

/** 030/T901 - the decision right before the gesture must be the one the owner answered. */
describe("030 sameDecidingSite", () => {
  const frame: DecidingSite = { kind: "frame", site: SECOND, pageSite: PAGE, frameId: 5, documentId: "bdoc-5" };

  it("holds for the same site, frame and document", () => {
    expect(sameDecidingSite(frame, { ...frame })).toBe(true);
    expect(sameDecidingSite({ kind: "page", site: PAGE, pageSite: PAGE }, { kind: "page", site: PAGE, pageSite: PAGE })).toBe(true);
    expect(sameDecidingSite({ kind: "unknown", pageSite: PAGE }, { kind: "unknown", pageSite: PAGE })).toBe(true);
  });

  it("fails for another site, frame, document or kind", () => {
    expect(sameDecidingSite(frame, { ...frame, site: THIRD })).toBe(false);
    expect(sameDecidingSite(frame, { ...frame, frameId: 6 })).toBe(false);
    expect(sameDecidingSite(frame, { ...frame, documentId: "bdoc-5-next" })).toBe(false);
    expect(sameDecidingSite(frame, { kind: "unknown", pageSite: PAGE, frameId: 5, documentId: "bdoc-5" })).toBe(false);
    expect(
      sameDecidingSite(
        { kind: "page", site: PAGE, pageSite: PAGE },
        { kind: "page", site: PAGE, pageSite: PAGE, frameId: 3, documentId: "bdoc-3" },
      ),
    ).toBe(false);
  });
});
