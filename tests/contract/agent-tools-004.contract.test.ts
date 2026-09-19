import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 004/T077 — the tool surface as 004 leaves it (contracts README §2, data-model.md).
 *
 * Everything here is additive to 003 with one exception that is not a shape at all: the refusals.
 * 003 answered "that tab is not yours" with one code because a session either owned a tab or nobody
 * did. With several sessions and the owner's own tabs in play there are two different facts - held
 * by *that* session, or held by nobody - and an agent behaves differently for each, so they are two
 * reasons carrying the evidence that distinguishes them.
 *
 * The regression net at the end is the other half of this test: 003's tools keep their argument
 * shapes exactly, so that "additive" is something the compiler and this file agree on rather than
 * something the change description claims.
 */

const TAB = 7;
const SESSION = "b7f0c3e1d9a24f5e";
const REF = "f0-12";

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

/** The parsed value, for the two places where the *default* is the contract rather than the shape. */
function parsed(schema: ZodLike, input: unknown): Record<string, unknown> {
  const result = (schema as { safeParse: (value: unknown) => { success: boolean; data?: unknown } }).safeParse(
    input,
  );
  expect(result.success, "input must parse").toBe(true);
  return result.data as Record<string, unknown>;
}

describe("T077 the 004 tool surface", () => {
  it("says who holds each tab, and in which window", () => {
    const tab = contractSchema("agentTabViewSchema");
    const row = { tabId: TAB, url: "https://example.test/", title: "Example", active: true, windowId: 3 };

    expectAccepted(tab, { ...row, holder: "this" }, "a tab this session holds");
    expectAccepted(tab, { ...row, holder: "none" }, "a tab nobody holds");
    expectAccepted(tab, { ...row, holder: { sessionId: SESSION } }, "a tab another session holds");

    // "Another session has it" is only actionable if the agent can say *which*, so the third case
    // carries the id rather than collapsing into a second bare word.
    expectRejected(tab, { ...row, holder: {} }, "a foreign holder naming no session");
    expectRejected(tab, { ...row, holder: "theirs" }, "a holder outside the closed set");
    expectRejected(tab, { ...row, holder: "this", windowId: -1 }, "a negative window");

    // FR-060 asks for "title, address, active state and window". The title is required for the same
    // reason `active` is: a listing that may or may not name the page is a listing an agent cannot
    // pick a tab out of, and the fact is one the browser's own tab record already holds.
    const { title: _title, ...untitled } = row;
    expectRejected(tab, { ...untitled, holder: "none" }, "a tab listed with no title");
    expectRejected(tab, { ...row, title: "t".repeat(2049), holder: "none" }, "an unbounded title");
  });

  it("projects the browser's tabs to the panel, with their holder and no page content", () => {
    const state = contractSchema("agentPanelStateSchema");
    const base = { paired: [], sessions: [], sites: [], tabs: [], bridge: "connected" };
    const row = { tabId: TAB, url: "https://example.test/", title: "Example", active: true, windowId: 3 };

    // 004/T109a: the panel's tab list is the browser's, not one session's. Held by nobody is the
    // case the owner could never see while the projection carried only each session's own tabs -
    // and it is the one that tells them the agent is working on a tab they opened.
    expectAccepted(state, { ...base, tabs: [{ ...row, holder: "none" }] }, "a tab nobody holds");
    expectAccepted(
      state,
      { ...base, tabs: [{ ...row, holder: { sessionId: SESSION } }] },
      "a tab a session holds",
    );

    // Required, for the reason `title` and `active` are on the tab view: a projection that may
    // omit the browser's tabs is one the owner cannot tell "no tabs" from "I did not look" in.
    const { tabs: _tabs, ...withoutTabs } = base;
    expectRejected(state, withoutTabs, "a projection carrying no tab list");

    // "this" is not a fact from the panel's vantage - the panel is nobody's session, so a row
    // claiming to be held by the reader could only be a session's list mislabelled as the browser's.
    expectRejected(state, { ...base, tabs: [{ ...row, holder: "this" }] }, "a browser tab held by \"this\"");
    expectRejected(state, { ...base, tabs: [row] }, "a browser tab with no holder");

    // The same rule `tabs_context` follows: the panel is told what the browser records about a tab
    // and never a word read out of its document.
    expectRejected(
      state,
      { ...base, tabs: [{ ...row, holder: "none", text: "Account balance 4,201.55" }] },
      "a tab row carrying page content",
    );
  });

  it("claims one tab into the session's group and releases it again", () => {
    const claim = args("tabs_claim");
    const release = args("tabs_release");

    expectAccepted(claim, { tabId: TAB }, "tabs_claim");
    expectRejected(claim, {}, "tabs_claim naming no tab");
    expectRejected(claim, { tabId: TAB, sessionId: SESSION }, "tabs_claim naming a session");

    expectAccepted(release, { tabId: TAB }, "tabs_release");
    expectRejected(release, {}, "tabs_release naming no tab");

    const claimResult = contractSchema("agentTabsClaimResultSchema");
    expectAccepted(claimResult, { tabId: TAB, groupId: 12 }, "the claimed tab and its group");
    expectRejected(claimResult, { tabId: TAB }, "a claim that names no group");

    const releaseResult = contractSchema("agentTabsReleaseResultSchema");
    // The same rule `tabs_close` follows: a release that did not happen is an outcome, not an `ok`
    // carrying a quiet no.
    expectAccepted(releaseResult, { released: true }, "a release");
    expectRejected(releaseResult, { released: false }, "a release that says it did not happen");
  });

  it("bounds a read by characters as well as by nodes and depth", () => {
    const read = args("read_page");

    expectAccepted(read, { tabId: TAB }, "read_page with defaults");
    expectAccepted(read, { tabId: TAB, max_chars: 1_000 }, "read_page with a character bound");
    expectAccepted(read, { tabId: TAB, max_chars: 50_000 }, "read_page at the character ceiling");
    expectRejected(read, { tabId: TAB, max_chars: 50_001 }, "read_page past the character ceiling");
    expectRejected(read, { tabId: TAB, max_chars: 0 }, "read_page asking for no characters");

    // 004/T137b: the ceiling is the deepest nesting the answer can even express - the collection
    // counts a node's depth up to 64 and the node shape carries it up to 64 - because a ceiling
    // below that is a limit a real page reaches. Measured: 32 returned 550 of 587 matched elements
    // on the repository page, with 35 deeper still, so 32 provably cannot reach one.
    expectAccepted(read, { tabId: TAB, depth: 64 }, "read_page at the depth ceiling");
    expectRejected(read, { tabId: TAB, depth: 65 }, "read_page past the depth ceiling");

    // The default is part of the contract: an agent that names no depth gets the same read as one
    // that asked for 15, and the host describes that number to it.
    expect(parsed(read, { tabId: TAB }).depth, "read_page's default depth").toBe(15);
    expect(contractExport<number>("AGENT_READ_PAGE_DEFAULT_DEPTH")).toBe(15);

    // 004/T137b: and `filter: "all"` is the read that asks for everything, so no depth is put on it
    // that the caller did not ask for. A caller may still name one and gets exactly that.
    expect(parsed(read, { tabId: TAB, filter: "all" }).depth, "a full read's depth").toBeUndefined();
    expect(parsed(read, { tabId: TAB, filter: "all", depth: 20 }).depth, "a full read's own depth").toBe(20);
    expect(parsed(read, { tabId: TAB, filter: "interactive" }).depth, "the working read's depth").toBe(15);

    expect(contractExport<number>("AGENT_READ_PAGE_MAX_CHARS")).toBe(50_000);
    expect(contractExport<number>("AGENT_READ_PAGE_MAX_NODES")).toBe(10_000);
    expect(contractExport<number>("AGENT_READ_PAGE_MAX_DEPTH")).toBe(64);
  });

  it("gives the text read the same character ceiling the structured read has", () => {
    const text = args("get_page_text");

    // 004/T135a: the two reads answer about the same page, so an agent choosing between them must
    // not have to know which of the two returns more of it.
    expectAccepted(text, { tabId: TAB }, "get_page_text with defaults");
    expectAccepted(text, { tabId: TAB, max_chars: 1_000 }, "get_page_text with a character bound");
    expectAccepted(text, { tabId: TAB, max_chars: 50_000 }, "get_page_text at the character ceiling");
    expectRejected(text, { tabId: TAB, max_chars: 50_001 }, "get_page_text past the character ceiling");
    expectRejected(text, { tabId: TAB, max_chars: 0 }, "get_page_text asking for no characters");

    const result = contractSchema("agentPageTextResultSchema");
    expectAccepted(result, { text: "t".repeat(50_000), truncated: false }, "the whole of a large page");
    // Which limit ran out, as `read_page` says it: a text read has one ceiling, and naming it is
    // what tells the agent the next call may raise it.
    expectAccepted(result, { text: "cut", truncated: true, truncatedBy: "chars" }, "a read cut by the ceiling");
    // A frame that stayed quiet is not a limit anybody can raise, so there is nothing to name.
    expectAccepted(result, { text: "cut", truncated: true }, "a read cut by something with no limit");
    expectRejected(result, { text: "cut", truncated: true, truncatedBy: "nodes" }, "a text read cut by nodes");
  });

  it("lists the frames a read covered, and which frame each node came from", () => {
    const result = contractSchema("agentReadPageResultSchema");
    const frames = [
      { frame: "0", parent: "0", url: "https://example.test/", readable: true },
      { frame: "f1", parent: "0", url: "https://embed.test/", readable: false, reason: "not-allowed" },
      { frame: "f2", parent: "f1", url: "https://embed.test/deep", readable: false, reason: "no-answer" },
    ];
    const nodes = [
      { frame: "0", role: "button", name: "Save", depth: 2, ref: REF },
      {
        frame: "f1",
        role: "textbox",
        depth: 3,
        href: "https://example.test/next",
        type: "email",
        placeholder: "you@example.test",
        options: ["one", "two"],
        hidden: false,
      },
    ];

    expectAccepted(result, { frames, nodes, truncated: false }, "a read across three frames");

    // An unreadable frame that gives no reason is the answer this shape exists to prevent: the
    // agent would see a gap in the page and have nothing to decide about it.
    expectRejected(
      result,
      { frames: [{ frame: "f1", parent: "0", url: "https://embed.test/", readable: false }], nodes, truncated: false },
      "an unreadable frame with no reason",
    );
    expectRejected(
      result,
      {
        frames: [{ frame: "f1", parent: "0", url: "https://embed.test/", readable: false, reason: "busy" }],
        nodes,
        truncated: false,
      },
      "a reason outside the closed set",
    );
    expectRejected(
      result,
      { frames, nodes: [{ ...nodes[0], selector: "#save" }], truncated: false },
      "a node carrying page markup",
    );

    // 004/T137b: which ceiling ran out, including the one an agent is most able to raise. A read
    // told only "truncated" cannot know whether to raise a bound or narrow the read; `depth` is a
    // limit the next call may simply ask past.
    expectAccepted(result, { nodes, truncated: true, truncatedBy: "depth" }, "a read cut by depth");
    expectAccepted(result, { nodes, truncated: true, truncatedBy: "chars" }, "a read cut by characters");
    expectAccepted(result, { nodes, truncated: true, truncatedBy: "nodes" }, "a read cut by nodes");
    expectRejected(result, { nodes, truncated: true, truncatedBy: "filter" }, "a cut with no limit to raise");
  });

  it("acts by position through the nine computer actions", () => {
    const computer = args("computer");
    const at = (rest: Record<string, unknown>) => ({ tabId: TAB, ...rest });

    // 004/T139: the tab is named, as it is on every other tool. `contracts/README.md` §2's first
    // table omitted it and the schema followed literally, which left the one tool that changes a
    // page unable to say which page - and "the tab the call happened to arrive about" is not a
    // meaning this caller may have when a session holds several.
    expectRejected(computer, { action: "screenshot" }, "a computer call naming no tab");
    expectRejected(computer, { action: "left_click", x: 1, y: 2 }, "a position click naming no tab");

    for (const action of ["left_click", "right_click", "double_click", "triple_click"]) {
      expectAccepted(computer, at({ action, x: 120, y: 240 }), `${action} at a point`);
      // A click is *by position*; without one there is nothing for the browser-level input to aim
      // at, and "wherever the pointer happens to be" is not a target an agent stated.
      expectRejected(computer, at({ action }), `${action} with no point`);
      expectRejected(computer, at({ action, x: 120 }), `${action} with half a point`);
      expectRejected(computer, at({ action, x: -1, y: 240 }), `${action} outside the viewport's origin`);
    }

    expectAccepted(computer, at({ action: "screenshot" }), "a screenshot");
    expectRejected(computer, at({ action: "screenshot", x: 1, y: 1 }), "a screenshot at a point");

    expectAccepted(computer, at({ action: "type", text: "hello" }), "typing into the focused element");
    expectAccepted(computer, at({ action: "type", text: "hello", x: 10, y: 20 }), "typing at a point");
    expectRejected(computer, at({ action: "type" }), "typing nothing");

    expectAccepted(computer, at({ action: "key", key: "Enter" }), "a key press");
    expectRejected(computer, at({ action: "key" }), "a key press naming no key");

    expectAccepted(computer, at({ action: "scroll", x: 10, y: 20, amount: 3 }), "a scroll at a point");
    expectRejected(computer, at({ action: "scroll", amount: 3 }), "a scroll with no point");

    expectAccepted(computer, at({ action: "wait", ms: 500 }), "a wait");
    expectRejected(computer, at({ action: "wait" }), "a wait of no stated length");

    expectRejected(computer, at({ action: "drag", x: 1, y: 2 }), "an action outside the nine");
  });

  it("refuses with the evidence the agent needs to act on the refusal", () => {
    const refusal = contractSchema("agentRefusalSchema");

    expectAccepted(refusal, { reason: "held-by-session", sessionId: SESSION }, "a tab another session holds");
    expectRejected(refusal, { reason: "held-by-session" }, "held by a session nobody names");

    expectAccepted(refusal, { reason: "not-yours" }, "a tab nobody holds");
    expectAccepted(
      refusal,
      { reason: "input-unavailable", unavailableReason: "devtools-open" },
      "input the browser will not deliver",
    );
    expectRejected(refusal, { reason: "input-unavailable" }, "unavailable input with no cause");
    expectAccepted(refusal, { reason: "bridge-lost" }, "a call in flight when the link dropped");
    expectAccepted(
      refusal,
      { reason: "outside-viewport", width: 1280, height: 720 },
      "a point outside the viewport",
    );
    // The size is the whole use of this refusal: it is what lets the agent aim the next attempt.
    expectRejected(refusal, { reason: "outside-viewport", width: 1280 }, "a viewport with no height");
    expectAccepted(refusal, { reason: "stale-reference" }, "003's stale reference, unchanged");
    expectRejected(refusal, { reason: "tab-owned-by-another-session" }, "003's flattened ownership refusal");
  });

  it("leaves every 003 tool's arguments exactly as they were", () => {
    expectAccepted(args("click"), { tabId: TAB, target: { ref: REF } }, "click on a ref");
    expectAccepted(args("click"), { tabId: TAB, target: { x: 4, y: 5 } }, "click on a point");
    expectRejected(args("click"), { tabId: TAB, target: { ref: REF }, x: 4 }, "click with a stray field");

    expectAccepted(args("tabs_close"), { tabId: TAB }, "tabs_close");
    expectAccepted(args("navigate"), { tabId: TAB, url: "https://example.test/" }, "navigate to a url");
    expectRejected(args("navigate"), { tabId: TAB }, "navigate with no destination");

    expectAccepted(args("type"), { tabId: TAB, text: "hi" }, "type into the focused element");
    expectAccepted(args("key"), { tabId: TAB, key: "Tab", modifiers: ["Shift"] }, "shift-tab");
    expectRejected(args("key"), { tabId: TAB, key: "Enter", modifiers: ["Shift"] }, "shift with a second key");

    expectAccepted(args("get_page_text"), { tabId: TAB }, "get_page_text");

    // The worker's half of the upload boundary: bytes, never paths (003/FR-051).
    expectAccepted(
      args("file_upload"),
      { tabId: TAB, ref: REF, files: [{ name: "one.pdf", type: "application/pdf", bytesBase64: "AA==" }] },
      "file_upload",
    );
    expectRejected(
      args("file_upload"),
      { tabId: TAB, ref: REF, paths: ["C:/receipts/one.pdf"] },
      "file_upload naming a path",
    );

    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    expect(names).toContain("tabs_claim");
    expect(names).toContain("tabs_release");
    expect(names).toContain("computer");

    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    for (const name of ["tabs_claim", "tabs_release", "computer"]) {
      expect(
        descriptors.find((descriptor) => descriptor.name === name),
        `the host describes ${name} to the agent`,
      ).toBeDefined();
    }

    // FR-066: refs outlive a read now, so the sentence telling agents to re-read must not survive
    // in the prose the agent is handed - a description that still says it would be the only thing
    // an agent could act on.
    for (const name of ["read_page", "find"]) {
      const descriptor = descriptors.find((entry) => entry.name === name);
      expect(descriptor?.description, `${name} still tells the agent its refs go stale`).not.toMatch(
        /stale afterwards|replaces the page's refs/,
      );
    }
  });
});
