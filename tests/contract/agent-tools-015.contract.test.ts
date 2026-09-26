import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 015 — honest answers: the shapes the press observation, the two new reasons and the pairing
 * withdrawal add (data-model.md, contracts/press-outcomes.md, batch-upload.md, pairing-withdraw.md).
 *
 * Every addition is optional or a new frame `type`: the observation and every frame on the link are
 * strict objects, so a required new key would make an old side's answer fail to parse, and the link
 * protocol does not move.
 */

const SESSION = "session-1";
const AGENT = "agent-1";

const BASE_OBSERVATION = {
  effect: "activated",
  documentChanged: false,
  verified: true,
  verdict: "verified",
} as const;

describe("T396 the press observation says what a press caused (FR-200 - FR-203)", () => {
  const observation = () => contractSchema("agentEffectObservationSchema");

  it("still parses the 014 observation with none of the new fields", () => {
    expectAccepted(observation(), BASE_OBSERVATION, "an observation without 015 fields");
  });

  it("accepts the url the tab reached", () => {
    expectAccepted(
      observation(),
      { ...BASE_OBSERVATION, documentChanged: true, verdict: "document-changed", url: "https://example.test/next" },
      "an observation with url",
    );
    expectRejected(observation(), { ...BASE_OBSERVATION, url: 42 }, "a non-string url");
  });

  it("accepts the tabs a press opened, never held", () => {
    const tab = { tabId: 7, url: "https://example.test/popup", held: false };
    expectAccepted(observation(), { ...BASE_OBSERVATION, newTabs: [tab] }, "one new tab");
    expectAccepted(
      observation(),
      { ...BASE_OBSERVATION, newTabs: Array.from({ length: 10 }, (_, i) => ({ ...tab, tabId: i })) },
      "ten new tabs",
    );
    expectRejected(observation(), { ...BASE_OBSERVATION, newTabs: [] }, "an empty newTabs");
    expectRejected(
      observation(),
      { ...BASE_OBSERVATION, newTabs: Array.from({ length: 11 }, (_, i) => ({ ...tab, tabId: i })) },
      "eleven new tabs",
    );
    expectRejected(observation(), { ...BASE_OBSERVATION, newTabs: [{ ...tab, held: true }] }, "a held new tab");
    expectRejected(observation(), { ...BASE_OBSERVATION, newTabs: [{ ...tab, tabId: 1.5 }] }, "a fractional tabId");
    expectRejected(observation(), { ...BASE_OBSERVATION, newTabs: [{ ...tab, title: "x" }] }, "a new tab with an unknown key");
  });

  it("accepts the downloads a press started", () => {
    const download = { id: 3, filename: "report.pdf", url: "https://example.test/report.pdf", state: "in_progress" };
    expectAccepted(observation(), { ...BASE_OBSERVATION, downloads: [download] }, "one download");
    expectRejected(observation(), { ...BASE_OBSERVATION, downloads: [] }, "an empty downloads");
    expectRejected(
      observation(),
      { ...BASE_OBSERVATION, downloads: Array.from({ length: 11 }, (_, i) => ({ ...download, id: i })) },
      "eleven downloads",
    );
    expectRejected(observation(), { ...BASE_OBSERVATION, downloads: [{ ...download, id: 1.5 }] }, "a fractional id");
    expectRejected(observation(), { ...BASE_OBSERVATION, downloads: [{ ...download, mime: "x" }] }, "a download with an unknown key");
  });

  it("accepts how long nothing was observed for", () => {
    expectAccepted(observation(), { ...BASE_OBSERVATION, observedForMs: 400 }, "observedForMs 400");
    expectAccepted(observation(), { ...BASE_OBSERVATION, observedForMs: 0 }, "observedForMs 0");
    expectRejected(observation(), { ...BASE_OBSERVATION, observedForMs: -1 }, "a negative observedForMs");
  });

  it("stays strict and keeps its required fields", () => {
    expectRejected(observation(), { ...BASE_OBSERVATION, navigatedTo: "x" }, "an unknown key");
    for (const key of Object.keys(BASE_OBSERVATION)) {
      const { [key]: _omitted, ...rest } = BASE_OBSERVATION as Record<string, unknown>;
      expectRejected(observation(), rest, `an observation without ${key}`);
    }
  });
});

describe("T396 the two reasons 015 adds, and the outcome each answers with", () => {
  it("pins page-not-responding to failed and batch-upload-too-large to denied", () => {
    const reasons = contractExport<Readonly<Record<string, string>>>("AGENT_015_REASON_OUTCOMES");
    // press-outcomes.md "Binding failure": the probe hit the content deadline, the page is still open.
    expect(reasons["page-not-responding"]).toBe("failed");
    // batch-upload.md rule 3: the whole batch is refused before anything is sent.
    expect(reasons["batch-upload-too-large"]).toBe("denied");

    const response = contractSchema("agentNativeResponseSchema");
    const outcomes = contractExport<readonly string[]>("AGENT_TOOL_OUTCOMES");
    for (const [reason, outcome] of Object.entries(reasons)) {
      expect(outcomes, reason).toContain(outcome);
      expectAccepted(response, { callId: "call-1", outcome, reason }, `an answer reading ${reason}`);
    }
  });
});

describe("T397 the host withdraws a pairing question it stopped waiting for (FR-216 - FR-219)", () => {
  const frame = () => contractSchema("agentControlFrameSchema");
  const REQUEST = "pair-req-1";

  it("parses pair-withdraw with and without a requestId", () => {
    expectAccepted(frame(), { type: "pair-withdraw", agentId: AGENT, sessionId: SESSION }, "pair-withdraw");
    expectAccepted(
      frame(),
      { type: "pair-withdraw", agentId: AGENT, sessionId: SESSION, requestId: REQUEST },
      "pair-withdraw with requestId",
    );
    expectRejected(frame(), { type: "pair-withdraw", agentId: AGENT }, "pair-withdraw without sessionId");
    expectRejected(frame(), { type: "pair-withdraw", sessionId: SESSION }, "pair-withdraw without agentId");
    expectRejected(
      frame(),
      { type: "pair-withdraw", agentId: AGENT, sessionId: SESSION, reason: "x" },
      "pair-withdraw with an unknown key",
    );
  });

  it("lets pair-request and pair-result carry the exchange's requestId, optionally", () => {
    const request = { type: "pair-request", agentId: AGENT, displayName: "Agent", origin: "mcp", sessionId: SESSION };
    const result = { type: "pair-result", agentId: AGENT, sessionId: SESSION, accepted: true };
    expectAccepted(frame(), request, "pair-request without requestId");
    expectAccepted(frame(), { ...request, requestId: REQUEST }, "pair-request with requestId");
    expectAccepted(frame(), result, "pair-result without requestId");
    expectAccepted(frame(), { ...result, requestId: REQUEST }, "pair-result with requestId");

    for (const bad of ["", "x".repeat(129)]) {
      expectRejected(frame(), { ...request, requestId: bad }, `pair-request requestId of length ${bad.length}`);
      expectRejected(frame(), { ...result, requestId: bad }, `pair-result requestId of length ${bad.length}`);
      expectRejected(
        frame(),
        { type: "pair-withdraw", agentId: AGENT, sessionId: SESSION, requestId: bad },
        `pair-withdraw requestId of length ${bad.length}`,
      );
    }
  });

  it("keeps the link protocol at 2", () => {
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});

/**
 * 015/T412 — one resolver: a batch step and a standalone upload cannot be checked two ways (FR-211).
 *
 * Read from the host's source, in the spirit of 014/T381: the claim is that everything which turns
 * a path into bytes, or an image id into a picture, sits inside `prepareUpload` - so a second copy
 * written for the batch (or anything else) goes red here rather than in a review, and the batch
 * path is asserted to reach the one function rather than merely to exist.
 */
describe("T412 the host has one upload check, and the batch path goes through it", () => {
  const server = readFileSync(resolve("packages/agent-host/src/mcp-server.ts"), "utf8");

  /**
   * The span of a named function's body: from the `{` after its parameter list to the matching `}`.
   * Comments, strings and template literals are skipped, so a brace in prose cannot move the end.
   */
  function bodyOf(name: string): { start: number; end: number } {
    const at = server.indexOf(`function ${name}(`);
    expect(at, `function ${name} must exist`).toBeGreaterThan(0);
    let depth = 0;
    let open = -1;
    let parens = 0;
    for (let index = server.indexOf("(", at); index < server.length; index += 1) {
      const char = server[index];
      const next = server[index + 1];
      if (char === "/" && next === "/") {
        index = server.indexOf("\n", index);
        continue;
      }
      if (char === "/" && next === "*") {
        index = server.indexOf("*/", index) + 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        let close = index + 1;
        while (server[close] !== char) close += server[close] === "\\" ? 2 : 1;
        index = close;
        continue;
      }
      if (open < 0) {
        if (char === "(") parens += 1;
        if (char === ")") parens -= 1;
        if (char === "{" && parens === 0) {
          open = index;
          depth = 1;
        }
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return { start: open, end: index };
      }
    }
    throw new Error(`no body found for ${name}`);
  }

  /** Every call of `needle` in the source; a declaration (`function name(`) is not a call. */
  function calls(needle: string): number[] {
    const found: number[] = [];
    for (let index = server.indexOf(needle); index >= 0; index = server.indexOf(needle, index + 1)) {
      if (server.slice(Math.max(0, index - 9), index) !== "function ") found.push(index);
    }
    return found;
  }

  it("reads files, asks the owner, remembers directories and takes pictures only inside prepareUpload", () => {
    const check = bodyOf("prepareUpload");
    for (const call of ["resolveUploadFiles(", "screenshots.take(", "askUploadConsent(", "uploadRoots.add("]) {
      const found = calls(call);
      expect(found.length, `${call} must still be called`).toBeGreaterThan(0);
      for (const index of found) {
        expect(index > check.start && index < check.end, `${call} at offset ${index} is outside prepareUpload`).toBe(
          true,
        );
      }
    }
  });

  it("sends a batch's upload steps and a standalone upload through the same function", () => {
    const batch = bodyOf("prepareBatchUploads");
    const place = bodyOf("placeCall");
    const callers = calls("prepareUpload(");
    // Exactly two callers: the standalone branch of `placeCall` and the batch pre-pass.
    expect(callers).toHaveLength(2);
    expect(callers.filter((index) => index > batch.start && index < batch.end)).toHaveLength(1);
    expect(callers.filter((index) => index > place.start && index < place.end)).toHaveLength(1);
    // And `placeCall` hands every `browser_batch` to the pre-pass before the call is placed.
    const branch = server.indexOf('if (tool === "browser_batch")', place.start);
    expect(branch > place.start && branch < place.end, "placeCall must special-case browser_batch").toBe(true);
    const handed = server.indexOf("prepareBatchUploads(callId, args)", branch);
    expect(handed > branch && handed < server.indexOf("router.call(", place.start)).toBe(true);
  });
});
