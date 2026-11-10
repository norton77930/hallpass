import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 003/T054 — the diagnostics shapes (US6, FR-049, FR-050).
 *
 * Three claims are pinned here and nowhere else.
 *
 * What comes *back* is bounded and record-shaped. A console message is a level, a text and a time;
 * a network record is a method, a url, a status, a kind and a time. Neither shape can carry a body
 * or a header, and that is a fact about the contract rather than about the handler's discipline:
 * a field for them does not exist, so a future handler cannot start filling one.
 *
 * The grant is its own consent. `ui.agent.set-diagnostics` is a separate command from the site
 * mode, because "you may act on this site" and "you may attach a debugger to this site" are
 * different questions and FR-049 requires the second to be asked explicitly. It carries a site and
 * a boolean, and it cannot carry a mode.
 *
 * And the refusal is expressible: a call made without the grant answers in the closed outcome
 * vocabulary, with a stable reason, rather than through an error the agent has to read prose from.
 */

const TAB = 7;
const SITE = "https://fixtures.test:19443";

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T054 agent diagnostics contracts", () => {
  it("reads the console by tab, with an optional filter and a bounded count", () => {
    const console = args("read_console");
    expectAccepted(console, { tabId: TAB }, "every buffered message");
    expectAccepted(
      console,
      { tabId: TAB, pattern: "checkout-failed", onlyErrors: true, limit: 50 },
      "a filtered read",
    );
    expectRejected(console, {}, "a read naming no tab");
    expectRejected(console, { tabId: TAB, limit: 0 }, "a limit of nothing");
    expectRejected(console, { tabId: TAB, limit: 1001 }, "a limit past the bound");
    expectRejected(console, { tabId: TAB, since: 0 }, "a field nobody declared");
  });

  it("answers with levels, texts and times - and has nowhere to put a stack or an argument list", () => {
    const result = contractSchema("agentConsoleResultSchema");
    expectAccepted(
      result,
      { messages: [{ level: "error", text: "checkout failed", ts: 1_700_000_000_000 }], truncated: false },
      "one error message",
    );
    expectRejected(
      result,
      { messages: [{ level: "shout", text: "x", ts: 1 }], truncated: false },
      "a level nobody defined",
    );
    expectRejected(
      result,
      { messages: [{ level: "error", text: "x", ts: 1, stack: "at foo" }], truncated: false },
      "a stack trace",
    );
  });

  it("reads network records by tab, and the record shape has no room for a body or a header", () => {
    const network = args("read_network");
    expectAccepted(network, { tabId: TAB }, "every buffered request");
    expectAccepted(network, { tabId: TAB, pattern: "/api/", limit: 10 }, "a filtered read");
    expectRejected(network, { tabId: TAB, onlyErrors: true }, "a console field on a network read");

    const result = contractSchema("agentNetworkResultSchema");
    expectAccepted(
      result,
      {
        requests: [
          { method: "GET", url: "https://fixtures.test/api/items", status: 200, type: "xhr", ts: 1 },
        ],
        truncated: false,
      },
      "one request record",
    );
    // FR-050 says records, and the redaction ethos says why: a header carries the cookie and the
    // authorization, and a body carries whatever the page was sending.
    expectRejected(
      result,
      {
        requests: [{ method: "GET", url: "https://x.test/", status: 200, type: "xhr", ts: 1, headers: {} }],
        truncated: false,
      },
      "request headers",
    );
    expectRejected(
      result,
      {
        requests: [{ method: "POST", url: "https://x.test/", status: 200, type: "xhr", ts: 1, body: "{}" }],
        truncated: false,
      },
      "a request body",
    );
  });

  it("evaluates one expression and answers with one bounded value", () => {
    const evaluate = args("evaluate");
    expectAccepted(evaluate, { tabId: TAB, expression: "document.title" }, "one expression");
    expectRejected(evaluate, { tabId: TAB }, "an evaluate with nothing to evaluate");
    expectRejected(evaluate, { tabId: TAB, expression: "" }, "an empty expression");
    expectRejected(
      evaluate,
      { tabId: TAB, expression: "1", awaitPromise: false },
      "a caller overriding how the page is evaluated",
    );

    const result = contractSchema("agentEvaluateResultSchema");
    expectAccepted(result, { value: "Form page", truncated: false }, "a string value");
    expectAccepted(result, { value: "42", truncated: true }, "a value the bound cut");
    expectRejected(result, { value: "x" }, "a value that does not say whether it was cut");
  });

  it("makes the diagnostics grant its own decision, separate from the site's mode", () => {
    const command = contractSchema("agentPanelCommandSchema");
    expectAccepted(
      command,
      { type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: true } },
      "granting diagnostics for one site",
    );
    expectAccepted(
      command,
      { type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: false } },
      "revoking it again",
    );
    expectRejected(
      command,
      { type: "ui.agent.set-diagnostics", payload: { site: SITE, granted: true, mode: "skip-checks" } },
      "a grant that also sets the mode",
    );
    expectRejected(
      command,
      { type: "ui.agent.set-diagnostics", payload: { granted: true } },
      "a grant for no site in particular",
    );
    // And the other direction: setting a mode still cannot carry the grant.
    expectRejected(
      command,
      { type: "ui.agent.site-mode", payload: { site: SITE, mode: "ask", diagnosticsGranted: true } },
      "a mode change that also grants diagnostics",
    );
  });

  /**
   * 031 T933 (R-460, R-461, D-031-9): the grant is asked for on a card of its own kind, and only that
   * card's yes carries `grantDiagnostics`. The contract cannot see which card a `promptId` names - the
   * worker honours the flag only for a pending diagnostics question - but it can refuse the flag on
   * any answer that is shaped like another card's: a decline, a remembered mode, a remembered pair or
   * directory, or the session answer, which is a different choice on the same card.
   */
  it("projects a diagnostics question as its own card kind, and asks the client with the three short answers", () => {
    const prompt = contractSchema("agentEffectPromptSchema");
    const card = {
      promptId: "prompt-1",
      raisedAt: "2026-11-08T00:00:00.000Z",
      site: SITE,
      tool: "read_console",
      argsSummary: "turn on diagnostics to read the console",
    };
    expectAccepted(prompt, { ...card, kind: "diagnostics" }, "a diagnostics card");
    expectRejected(prompt, { ...card, kind: "diagnostics-always" }, "a card kind nobody declared");

    const raised = contractSchema("promptRaisedFrameSchema");
    const frame = {
      type: "prompt-raised",
      sessionId: "session-h1",
      callId: "call-1",
      promptId: "prompt-1",
      kind: "diagnostics",
      site: SITE,
      action: "turn on diagnostics to read the console",
      choices: ["once", "session", "deny"],
      boundMs: 120_000,
    };
    expectAccepted(raised, frame, "a diagnostics question for the client");
    // Always on this site is Chrome's alone (D-031-9): the client's choices have no word for it.
    expectRejected(raised, { ...frame, choices: ["once", "session", "always", "deny"] }, "an always for the client");
  });

  it("accepts grantDiagnostics only as the diagnostics card's own yes", () => {
    const command = contractSchema("agentPanelCommandSchema");
    const decide = (payload: Record<string, unknown>) => ({ type: "ui.agent.effect-decide", payload });
    expectAccepted(command, decide({ promptId: "prompt-1", allow: true, grantDiagnostics: true }), "Always on this site");
    expectAccepted(command, decide({ promptId: "prompt-1", allow: true, session: true }), "This session");
    expectAccepted(command, decide({ promptId: "prompt-1", allow: true }), "Allow once");
    expectAccepted(command, decide({ promptId: "prompt-1", allow: false }), "Refuse");

    expectRejected(command, decide({ promptId: "prompt-1", allow: false, grantDiagnostics: true }), "a refusal that grants");
    expectRejected(
      command,
      decide({ promptId: "prompt-1", allow: true, grantDiagnostics: true, rememberMode: "skip-checks" }),
      "a mode riding on the grant",
    );
    expectRejected(
      command,
      decide({ promptId: "prompt-1", allow: true, grantDiagnostics: true, rememberTransition: true }),
      "a transition card's always carrying the grant",
    );
    expectRejected(
      command,
      decide({ promptId: "prompt-1", allow: true, grantDiagnostics: true, rememberDirectory: true }),
      "a directory card's always carrying the grant",
    );
    expectRejected(
      command,
      decide({ promptId: "prompt-1", allow: true, grantDiagnostics: true, session: true }),
      "two answers to one question",
    );
    expectRejected(command, decide({ promptId: "prompt-1", allow: true, grantDiagnostics: false }), "a grant flag that says no");
  });

  it("refuses an ungranted diagnostics call in the closed vocabulary", () => {
    const response = contractSchema("agentNativeResponseSchema");
    expectAccepted(
      response,
      { callId: "call-1", outcome: "denied", reason: "diagnostics-not-granted" },
      "the refusal FR-049 requires",
    );
    // It is a `denied`, not a `failed`: the owner's decision is what refused it, and the agent can
    // tell the difference between "you may not" and "something broke".
    expect(contractExport<readonly string[]>("AGENT_TOOL_OUTCOMES")).toContain("denied");
  });
});
