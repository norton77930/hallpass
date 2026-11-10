import { describe, expect, it, vi } from "vitest";
import { CONSENT_TIMEOUT_HINT } from "@hallpass/contracts";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";

/**
 * 014/T356 — a question the owner interrupted rather than answered (FR-179, R-185 §3).
 *
 * The controller already had three ways out that are not answers: the question's own deadline, the
 * owner's Stop, and the tabs being handed back. 中斷 is a fourth, and it is not a spelling of any
 * of them. It is not `timed-out` - somebody did act, at once. It is not `stopped` - the session is
 * still there with its tabs. And it is emphatically not a decline: a decline is a decision about
 * the thing being asked, and this is the owner ending the step *before* deciding. The whole point
 * of the word is that nothing is recorded about the site, the pair or the directory.
 */

describe("T356 a question the owner interrupted", () => {
  function controller() {
    const changes: number[] = [];
    const prompts = createAgentPromptController({ timeoutMs: 60_000, onChange: () => changes.push(1) });
    return { prompts, changes };
  }

  const ask = (prompts: ReturnType<typeof createAgentPromptController>, sessionId = "session-a") =>
    prompts.ask({
      callId: "call-1",
      sessionId,
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });

  it("resolves the waiting call as interrupted and takes the card down", async () => {
    const { prompts } = controller();
    const pending = ask(prompts);
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());

    prompts.cancelSession("session-a", "interrupted");

    await expect(pending).resolves.toEqual({ decision: "interrupted" });
    // Withdrawn, not left on screen: the call it belonged to has already been answered, and an
    // Allow pressed afterwards would run an effect for a call nobody is waiting on.
    expect(prompts.current()).toBeUndefined();
  });

  it("carries no instruction, because nobody failed to answer in time", async () => {
    const { prompts } = controller();
    const pending = ask(prompts);
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());

    prompts.cancelSession("session-a", "interrupted");

    // `hint` is where the person has to click when a question expired unseen (011 FR-146). This
    // question did not expire; the owner was looking straight at it.
    await expect(pending).resolves.not.toHaveProperty("hint");
  });

  it("leaves another session's question standing", async () => {
    const { prompts } = controller();
    const pending = ask(prompts, "session-b");
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());

    prompts.cancelSession("session-a", "interrupted");

    expect(prompts.current(), "one agent's interrupt took another's question down").toBeDefined();
    prompts.decide(prompts.current()?.promptId ?? "", true);
    // 031 R-458: every answer says where it was given.
    await expect(pending).resolves.toEqual({ decision: "allow", answeredFrom: "browser" });
  });

  it("ends a whole batch's plan question the same way", async () => {
    const { prompts } = controller();
    const pending = prompts.askPlan({
      callId: "call-2",
      sessionId: "session-a",
      site: "https://agent.test",
      steps: [{ tool: "click", summary: "click a page element" }],
    });
    await vi.waitFor(() => expect(prompts.currentPlan()).toBeDefined());

    prompts.cancelSession("session-a", "interrupted");

    await expect(pending).resolves.toEqual({ decision: "interrupted" });
    expect(prompts.currentPlan()).toBeUndefined();
  });

  /**
   * T369 review F2 — the card that must never go up at all.
   *
   * The interrupt can land in the window between the dispatch point registering the call and the
   * runner getting as far as asking: the call has already been answered `owner-interrupted`, and
   * the question that follows belongs to nobody. Left to stand it is worse than untidy - the
   * owner's 繼續 on it delivers input, or records a decision about a site, for a call the agent was
   * told was over. So the question is refused at the moment it is raised, by the one thing that
   * knows: the call's own stop handle.
   */
  it("never raises a card for a call the owner has already interrupted", async () => {
    const { prompts, changes } = controller();

    const answered = await prompts.ask({
      callId: "call-1",
      sessionId: "session-a",
      stopped: () => true,
      site: "https://agent.test",
      tool: "click",
      argsSummary: "click a page element",
    });

    expect(answered).toEqual({ decision: "interrupted" });
    expect(prompts.current(), "a card went up for a call that had already been answered").toBeUndefined();
    // And the panel was not told to re-read a picture nothing in it changed.
    expect(changes).toEqual([]);
  });

  it("does the same for a whole batch's plan question", async () => {
    const { prompts } = controller();

    const answered = await prompts.askPlan({
      callId: "call-2",
      sessionId: "session-a",
      stopped: () => true,
      site: "https://agent.test",
      steps: [{ tool: "click", summary: "click a page element" }],
    });

    expect(answered).toEqual({ decision: "interrupted" });
    expect(prompts.currentPlan()).toBeUndefined();
  });

  it("makes a late answer to the withdrawn card run nothing", async () => {
    const { prompts } = controller();
    const pending = ask(prompts);
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    const promptId = prompts.current()?.promptId ?? "";

    prompts.cancelSession("session-a", "interrupted");
    await pending;

    // The same rule every other ending has: the question is dead, not merely off screen.
    expect(prompts.decide(promptId, true)).toBe(false);
  });
});

/**
 * 017/T472 — the site-plan question (R-247, FR-252, FR-253, FR-260).
 *
 * A third kind beside the effect and the batch plan, under the same one-question rule. The claims
 * that matter for authorization: the answer can only narrow the proposal - an origin it did not
 * name, or an approval of nothing, settles nothing and leaves the card up - and every ending that
 * is not the owner's press grants nothing.
 */
describe("017 site plan", () => {
  const A = "https://a.test";
  const B = "https://b.test";
  const C = "https://c.test:8443";

  function controller() {
    const diagnostics: string[] = [];
    const prompts = createAgentPromptController({
      timeoutMs: 60_000,
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    return { prompts, diagnostics };
  }

  const propose = (
    prompts: ReturnType<typeof createAgentPromptController>,
    extra: { sessionId?: string; alreadyApproved?: string[]; stopped?: () => boolean } = {},
  ) =>
    prompts.askSitePlan({
      callId: "call-sp",
      sessionId: extra.sessionId ?? "session-a",
      origins: [A, B, C],
      purpose: "Compare the release notes",
      steps: ["read the notes"],
      ...(extra.alreadyApproved === undefined ? {} : { alreadyApproved: extra.alreadyApproved }),
      ...(extra.stopped === undefined ? {} : { stopped: extra.stopped }),
    });

  it("raises one question carrying the proposal, the active plan and when it was raised", async () => {
    const { prompts } = controller();
    void propose(prompts, { alreadyApproved: [A] });

    const question = prompts.currentSitePlan();
    expect(question).toEqual({
      proposalId: expect.stringMatching(/^site-plan-[0-9a-f]{16}$/),
      sessionId: "session-a",
      origins: [A, B, C],
      purpose: "Compare the release notes",
      steps: ["read the notes"],
      alreadyApproved: [A],
      raisedAt: "2026-10-02T12:00:00.000Z",
    });
    // Whose question it is, so the session card can say it is waiting (006 R-127).
    expect(prompts.currentSession()).toBe("session-a");
    // Not dressed up as either of the other two kinds.
    expect(prompts.current()).toBeUndefined();
    expect(prompts.currentPlan()).toBeUndefined();
  });

  it("mints a fresh id per proposal", async () => {
    const { prompts } = controller();
    void propose(prompts);
    const first = prompts.currentSitePlan()?.proposalId;
    prompts.decideSitePlan(first ?? "", false, []);
    void propose(prompts);
    expect(prompts.currentSitePlan()?.proposalId).not.toBe(first);
  });

  it("resolves an approval of a subset with what was approved and what was left out", async () => {
    const { prompts } = controller();
    const pending = propose(prompts);
    const { proposalId } = prompts.currentSitePlan() ?? { proposalId: "" };

    // Ticked in another order, and one twice: the answer is in the proposal's order, once each.
    expect(prompts.decideSitePlan(proposalId, true, [C, A, A])).toBe(true);

    await expect(pending).resolves.toEqual({ decision: "approve", approved: [A, C], leftOut: [B] });
    expect(prompts.currentSitePlan()).toBeUndefined();
  });

  it("refuses an approval naming an origin outside the proposal, and keeps the question up", async () => {
    const { prompts, diagnostics } = controller();
    let settled = false;
    void propose(prompts).then(() => (settled = true));
    const { proposalId } = prompts.currentSitePlan() ?? { proposalId: "" };

    expect(prompts.decideSitePlan(proposalId, true, [A, "https://evil.test"])).toBe(false);

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(prompts.currentSitePlan()?.proposalId).toBe(proposalId);
    expect(diagnostics).toContain("agent.site-plan.outside-proposal");
  });

  it("refuses an approval of nothing, and keeps the question up", async () => {
    const { prompts } = controller();
    void propose(prompts);
    const { proposalId } = prompts.currentSitePlan() ?? { proposalId: "" };

    expect(prompts.decideSitePlan(proposalId, true, [])).toBe(false);
    expect(prompts.currentSitePlan()?.proposalId).toBe(proposalId);
  });

  it("resolves a decline as declined, whatever origins came with it", async () => {
    const { prompts } = controller();
    const pending = propose(prompts);
    const { proposalId } = prompts.currentSitePlan() ?? { proposalId: "" };

    expect(prompts.decideSitePlan(proposalId, false, ["https://evil.test"])).toBe(true);

    await expect(pending).resolves.toEqual({ decision: "declined" });
  });

  it("settles nothing for an unknown or already-answered proposal", async () => {
    const { prompts, diagnostics } = controller();
    const pending = propose(prompts);
    const { proposalId } = prompts.currentSitePlan() ?? { proposalId: "" };

    expect(prompts.decideSitePlan("site-plan-0000000000000000", true, [A])).toBe(false);
    expect(diagnostics).toContain("agent.prompt.late-answer");
    expect(prompts.decideSitePlan(proposalId, true, [A])).toBe(true);
    await pending;
    // A second press on the same card is a late answer, never a second approval.
    expect(prompts.decideSitePlan(proposalId, true, [A, B])).toBe(false);
  });

  it("is busy while another question is up, and makes the next one wait the same way", async () => {
    const { prompts } = controller();
    void prompts.ask({
      callId: "call-1",
      sessionId: "session-b",
      site: A,
      tool: "click",
      argsSummary: "click a page element",
    });
    await expect(propose(prompts)).resolves.toEqual({ decision: "busy" });
    expect(prompts.currentSitePlan()).toBeUndefined();

    prompts.cancel();
    void propose(prompts);
    await expect(
      prompts.ask({ callId: "call-2", sessionId: "session-b", site: A, tool: "click", argsSummary: "click" }),
    ).resolves.toEqual({ decision: "busy" });
  });

  it("is withdrawn when its call ends, when its session ends, and on an interrupt - granting nothing", async () => {
    const { prompts } = controller();

    const byCall = propose(prompts);
    prompts.cancel("call-sp");
    await expect(byCall).resolves.toEqual({ decision: "timed-out" });
    expect(prompts.currentSitePlan()).toBeUndefined();

    const bySession = propose(prompts);
    prompts.cancelSession("session-other");
    expect(prompts.currentSitePlan(), "another session's end took this question down").toBeDefined();
    prompts.cancelSession("session-a");
    await expect(bySession).resolves.toEqual({ decision: "timed-out" });

    const byInterrupt = propose(prompts);
    prompts.cancelSession("session-a", "interrupted");
    await expect(byInterrupt).resolves.toEqual({ decision: "interrupted" });

    await expect(propose(prompts, { stopped: () => true })).resolves.toEqual({ decision: "interrupted" });
    expect(prompts.currentSitePlan()).toBeUndefined();
  });

  it("expires on the ordinary bound with no approval", async () => {
    const prompts = createAgentPromptController({ timeoutMs: 10 });
    // 031 R-455: an expiry always tells the agent to have the owner answer in Chrome.
    await expect(propose(prompts)).resolves.toEqual({ decision: "timed-out", hint: CONSENT_TIMEOUT_HINT });
  });
});

/**
 * 031/T915 — one question, two places, one answer (D-031-4, FR-471, R-450).
 *
 * The agent's own client is one more place an answer can come from, and it arrives by the call the
 * host was told about together with the question's own id (`decideByCall`), because a batch's
 * questions all share the host's call (T929 I1). Whichever answer
 * lands first settles the question; the other is logged as late and changes nothing - in either
 * order. What the client can say is the short-lived three (D-031-2): it can never leave a mode, a
 * remembered pair or a remembered directory behind.
 */
describe("031 an answer from the agent's client", () => {
  const SITE = "https://agent.test";

  function controller(extra: Partial<Parameters<typeof createAgentPromptController>[0]> = {}) {
    const diagnostics: string[] = [];
    const raised: Array<Record<string, unknown>> = [];
    const settled: Array<Record<string, unknown>> = [];
    const prompts = createAgentPromptController({
      timeoutMs: 60_000,
      reportDiagnostic: (code) => diagnostics.push(code),
      onRaised: (question) => raised.push({ ...question }),
      onSettled: (settlement) => settled.push({ ...settlement }),
      ...extra,
    });
    return { prompts, diagnostics, raised, settled };
  }

  const click = (prompts: ReturnType<typeof createAgentPromptController>, extra: Record<string, unknown> = {}) =>
    prompts.ask({
      callId: "call-1",
      sessionId: "session-a",
      site: SITE,
      tool: "click",
      argsSummary: "click a page element",
      ...extra,
    } as Parameters<typeof prompts.ask>[0]);

  /** The id of the question that is up, as `onRaised` told the host. */
  const open = (prompts: ReturnType<typeof createAgentPromptController>): string => prompts.current()?.promptId ?? "";

  it("settles the pending question by its call, and says where the answer came from", async () => {
    const { prompts, settled } = controller();
    const pending = click(prompts);

    expect(prompts.decideByCall("call-1", open(prompts), "once", "client")).toBe(true);

    await expect(pending).resolves.toEqual({ decision: "allow", answeredFrom: "client" });
    expect(prompts.current()).toBeUndefined();
    expect(settled).toEqual([
      { promptId: expect.any(String), callId: "call-1", sessionId: "session-a", answeredFrom: "client" },
    ]);
  });

  it("makes a card answer after the client's a late answer that changes nothing", async () => {
    const { prompts, diagnostics, settled } = controller();
    const pending = click(prompts);
    const promptId = prompts.current()?.promptId ?? "";

    expect(prompts.decideByCall("call-1", promptId, "deny", "client")).toBe(true);
    expect(prompts.decide(promptId, true, "skip-checks")).toBe(false);

    await expect(pending).resolves.toEqual({ decision: "deny", answeredFrom: "client" });
    expect(diagnostics).toContain("agent.prompt.late-answer");
    expect(settled, "settled once").toHaveLength(1);
  });

  it("makes a client answer after the card's a late answer that changes nothing", async () => {
    const { prompts, diagnostics, settled } = controller();
    const pending = click(prompts);
    const promptId = prompts.current()?.promptId ?? "";

    expect(prompts.decide(promptId, false)).toBe(true);
    expect(prompts.decideByCall("call-1", promptId, "once", "client")).toBe(false);

    await expect(pending).resolves.toEqual({ decision: "deny", answeredFrom: "browser" });
    expect(diagnostics).toContain("agent.prompt.late-answer");
    expect(settled).toEqual([{ promptId, callId: "call-1", sessionId: "session-a", answeredFrom: "browser" }]);
  });

  it("carries the card's session flag, and the client's, as a session allow", async () => {
    const card = controller();
    const byCard = click(card.prompts);
    card.prompts.decide(card.prompts.current()?.promptId ?? "", true, undefined, undefined, undefined, true);
    await expect(byCard).resolves.toEqual({ decision: "allow", session: true, answeredFrom: "browser" });

    const client = controller();
    const byClient = click(client.prompts);
    client.prompts.decideByCall("call-1", open(client.prompts), "session", "client");
    await expect(byClient).resolves.toEqual({ decision: "allow", session: true, answeredFrom: "client" });
  });

  it("never carries a remembered mode, pair or directory from the client (D-031-2)", async () => {
    for (const choice of ["once", "session", "deny"] as const) {
      const { prompts } = controller();
      const pending = click(prompts);
      prompts.decideByCall("call-1", open(prompts), choice, "client");
      const decision = await pending;
      expect(decision, choice).not.toHaveProperty("rememberMode");
      expect(decision, choice).not.toHaveProperty("rememberTransition");
      expect(decision, choice).not.toHaveProperty("rememberDirectory");
    }
  });

  it("offers the session answer only for a covered page action on a known site (R-457)", async () => {
    const covered = controller();
    void click(covered.prompts);
    expect(covered.raised).toEqual([
      {
        promptId: covered.prompts.current()?.promptId,
        callId: "call-1",
        sessionId: "session-a",
        kind: "effect",
        site: SITE,
        action: "click a page element",
        choices: ["once", "session", "deny"],
        boundMs: 60_000,
      },
    ]);

    for (const [tool, extra] of [
      ["dialog", { kind: "dialog-accept" }],
    ] as const) {
      const { prompts, raised } = controller();
      void click(prompts, { tool, ...extra });
      expect(raised[0]?.choices, `${tool} ${JSON.stringify(extra)}`).toEqual(["once", "session", "deny"]);
    }

    for (const [tool, extra] of [
      ["evaluate", {}],
      ["file_upload", {}],
      ["upload_image", {}],
      ["navigate", { kind: "beforeunload-force" }],
      ["tabs_close", {}],
      // A frame whose site is unknown has no site to hold a grant for (030 FR-458).
      ["click", { frame: { unknown: true } }],
    ] as const) {
      const { prompts, raised } = controller();
      void click(prompts, { tool, ...extra });
      expect(raised[0]?.choices, `${tool} ${JSON.stringify(extra)}`).toEqual(["once", "deny"]);
    }
  });

  it("names the frame's site when the frame decides", async () => {
    const { prompts, raised } = controller();
    void click(prompts, { frame: { site: "https://frame.test" } });
    expect(raised[0]).toMatchObject({ site: "https://frame.test", choices: ["once", "session", "deny"] });
  });

  it("raises a batch step's question under the call the host knows, and is answered by it", async () => {
    const { prompts, raised } = controller();
    const pending = click(prompts, { callId: "call-1#2", hostCallId: "call-1" });
    expect(raised[0]?.callId).toBe("call-1");
    expect(raised[0]?.promptId).toBe(open(prompts));
    expect(prompts.decideByCall("call-1#2", open(prompts), "once", "client"), "the step id is not the host's").toBe(
      false,
    );
    expect(prompts.decideByCall("call-1", open(prompts), "once", "client")).toBe(true);
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
  });

  it("never lets a batch step's late client answer settle the next step's question (T929 I1)", async () => {
    const { prompts, raised, diagnostics } = controller();
    const first = click(prompts, { callId: "call-1#0", hostCallId: "call-1" });
    const firstId = open(prompts);
    expect(prompts.decide(firstId, true)).toBe(true);
    await expect(first).resolves.toMatchObject({ decision: "allow", answeredFrom: "browser" });

    let secondSettled = false;
    const second = click(prompts, { callId: "call-1#1", hostCallId: "call-1" });
    void second.then(() => (secondSettled = true));
    const secondId = open(prompts);
    expect(raised.map((question) => question.callId)).toEqual(["call-1", "call-1"]);
    expect(secondId).not.toBe(firstId);

    // The client's answer to the first question, which lost the race to the card.
    expect(prompts.decideByCall("call-1", firstId, "session", "client", "session-a"), "a stale answer settled Q2").toBe(
      false,
    );
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(prompts.current()?.promptId).toBe(secondId);
    expect(diagnostics).toContain("agent.prompt.late-answer");

    // The second question is still answerable by its own id.
    expect(prompts.decideByCall("call-1", secondId, "once", "client", "session-a")).toBe(true);
    await expect(second).resolves.toEqual({ decision: "allow", answeredFrom: "client" });
  });

  it("refuses a session answer the question did not offer, and keeps it up", async () => {
    const { prompts, diagnostics } = controller();
    let resolved = false;
    void click(prompts, { tool: "evaluate" }).then(() => (resolved = true));

    expect(prompts.decideByCall("call-1", open(prompts), "session", "client")).toBe(false);

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(prompts.current()).toBeDefined();
    expect(diagnostics).toContain("agent.prompt.choice-not-offered");
  });

  it("changes nothing for an answer from another session", async () => {
    const { prompts, diagnostics } = controller();
    void click(prompts);

    expect(prompts.decideByCall("call-1", open(prompts), "once", "client", "session-b")).toBe(false);

    expect(prompts.current()).toBeDefined();
    expect(diagnostics).toContain("agent.prompt.other-session");
    expect(prompts.decideByCall("call-1", open(prompts), "once", "client", "session-a")).toBe(true);
  });

  it("is not answerable from the client for a question it was never asked", async () => {
    // A directory card is about the owner's own disk and stays Chrome's alone (032 FR-487): the
    // client is told nothing about it, so nothing it says can settle it. (Until 032 the transition
    // card was here too; it is now asked in the client - see "032 a site change and a site plan".)
    const { prompts, raised } = controller();
    void click(prompts, {
      kind: "upload-directory",
      tool: "file_upload",
      files: [{ path: "C:/x/a.txt", directory: "C:/x" }],
    });
    expect(raised).toEqual([]);
    for (const choice of ["once", "session", "deny"] as const) {
      expect(prompts.decideByCall("call-1", open(prompts), choice, "client"), choice).toBe(false);
    }
    expect(prompts.current()).toBeDefined();
  });

  it("tells the host once when the question ends without an answer", async () => {
    const { prompts, settled } = controller({ timeoutMs: 10 });
    await click(prompts);
    expect(settled).toEqual([
      { promptId: expect.any(String), callId: "call-1", sessionId: "session-a", answeredFrom: "none" },
    ]);
    prompts.cancel();
    expect(settled).toHaveLength(1);
  });
});

/**
 * 032 T954, T956 (R-484, FR-484..FR-487, FR-489): a site change and a site plan are asked in the
 * agent's client as well as on their cards, through the same raise and the same one-answer rules.
 * The client may say only "for this session" or "deny" (D-032-1); "always" and narrowing a plan
 * stay on the card. The plan card (a whole batch) and the directory card are never raised.
 */
describe("032 a site change and a site plan in the agent's client", () => {
  const FROM = "https://www.wikipedia.org";
  const TO = "https://zh.wikipedia.org";
  const A = "https://a.test";
  const B = "https://b.test";
  const C = "https://c.test:8443";

  function controller(extra: Partial<Parameters<typeof createAgentPromptController>[0]> = {}) {
    const diagnostics: string[] = [];
    const raised: Array<Record<string, unknown>> = [];
    const settled: Array<Record<string, unknown>> = [];
    const prompts = createAgentPromptController({
      timeoutMs: 60_000,
      reportDiagnostic: (code) => diagnostics.push(code),
      onRaised: (question) => raised.push({ ...question }),
      onSettled: (settlement) => settled.push({ ...settlement }),
      ...extra,
    });
    return { prompts, diagnostics, raised, settled };
  }

  /** The question `heldByTransition` raises for a tab that moved (agent-runtime.ts). */
  const moved = (prompts: ReturnType<typeof createAgentPromptController>, extra: Record<string, unknown> = {}) =>
    prompts.ask({
      callId: "call-1",
      sessionId: "session-a",
      site: TO,
      tool: "click",
      kind: "transition",
      transition: { from: FROM, to: TO },
      argsSummary: "click a page element",
      ...extra,
    } as Parameters<typeof prompts.ask>[0]);

  const propose = (prompts: ReturnType<typeof createAgentPromptController>, extra: Record<string, unknown> = {}) =>
    prompts.askSitePlan({
      callId: "call-sp",
      sessionId: "session-a",
      origins: [A, B, C],
      purpose: "Compare the release notes",
      ...extra,
    } as Parameters<typeof prompts.askSitePlan>[0]);

  const openEffect = (prompts: ReturnType<typeof createAgentPromptController>): string =>
    prompts.current()?.promptId ?? "";
  const openPlan = (prompts: ReturnType<typeof createAgentPromptController>): string =>
    prompts.currentSitePlan()?.proposalId ?? "";

  describe("a site change", () => {
    it("is raised with where the tab came from and where it went, offering session and deny", () => {
      const { prompts, raised } = controller();
      void moved(prompts);
      expect(raised).toEqual([
        {
          promptId: openEffect(prompts),
          callId: "call-1",
          sessionId: "session-a",
          kind: "transition",
          site: TO,
          from: FROM,
          action: "click a page element",
          choices: ["session", "deny"],
          boundMs: 60_000,
        },
      ]);
    });

    it("settles a client 'session' exactly as the card's Continue: an allow that remembers nothing", async () => {
      const client = controller();
      const byClient = moved(client.prompts);
      expect(client.prompts.decideByCall("call-1", openEffect(client.prompts), "session", "client")).toBe(true);
      // No `rememberTransition` (that is the card's Always) and no `session` flag: the runtime's
      // Continue already records the pair for this session only (FR-485).
      await expect(byClient).resolves.toEqual({ decision: "allow", answeredFrom: "client" });
      expect(client.settled).toEqual([
        { promptId: expect.any(String), callId: "call-1", sessionId: "session-a", answeredFrom: "client" },
      ]);

      const card = controller();
      const byCard = moved(card.prompts);
      card.prompts.decide(openEffect(card.prompts), true);
      await expect(byCard).resolves.toEqual({ decision: "allow", answeredFrom: "browser" });
    });

    it("settles a client 'deny' as a deny", async () => {
      const { prompts } = controller();
      const pending = moved(prompts);
      expect(prompts.decideByCall("call-1", openEffect(prompts), "deny", "client")).toBe(true);
      await expect(pending).resolves.toEqual({ decision: "deny", answeredFrom: "client" });
    });

    it("ignores 'once', which it never offered, and keeps the card up", async () => {
      const { prompts, diagnostics } = controller();
      let resolved = false;
      void moved(prompts).then(() => (resolved = true));
      expect(prompts.decideByCall("call-1", openEffect(prompts), "once", "client")).toBe(false);
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(prompts.current()).toBeDefined();
      expect(diagnostics).toContain("agent.prompt.choice-not-offered");
    });

    it("lets the card decide first, Always included, and makes the client's answer late", async () => {
      const { prompts, diagnostics, settled } = controller();
      const pending = moved(prompts);
      const promptId = openEffect(prompts);
      expect(prompts.decide(promptId, true, undefined, true)).toBe(true);
      expect(prompts.decideByCall("call-1", promptId, "session", "client")).toBe(false);
      await expect(pending).resolves.toEqual({ decision: "allow", rememberTransition: true, answeredFrom: "browser" });
      expect(diagnostics).toContain("agent.prompt.late-answer");
      expect(settled).toEqual([{ promptId, callId: "call-1", sessionId: "session-a", answeredFrom: "browser" }]);
    });

    it("asks each of a call's repeated moves as its own question, and a stale answer settles none (FR-489)", async () => {
      const { prompts, raised, diagnostics } = controller();
      const first = moved(prompts);
      const firstId = openEffect(prompts);
      prompts.decide(firstId, false);
      await first;

      let secondSettled = false;
      const second = moved(prompts, { site: "https://en.wikipedia.org", transition: { from: TO, to: "https://en.wikipedia.org" } });
      void second.then(() => (secondSettled = true));
      const secondId = openEffect(prompts);
      expect(raised.map((question) => question.promptId)).toEqual([firstId, secondId]);
      expect(secondId).not.toBe(firstId);

      expect(prompts.decideByCall("call-1", firstId, "session", "client")).toBe(false);
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(diagnostics).toContain("agent.prompt.late-answer");

      expect(prompts.decideByCall("call-1", secondId, "session", "client")).toBe(true);
      await expect(second).resolves.toEqual({ decision: "allow", answeredFrom: "client" });
    });

    it("refuses an answer after the question expired", async () => {
      const { prompts, diagnostics } = controller({ timeoutMs: 10 });
      const pending = moved(prompts);
      const promptId = openEffect(prompts);
      await expect(pending).resolves.toMatchObject({ decision: "timed-out" });
      expect(prompts.decideByCall("call-1", promptId, "session", "client")).toBe(false);
      expect(diagnostics).toContain("agent.prompt.late-answer");
    });
  });

  describe("a site plan", () => {
    it("is raised listing every proposed site, under the call the host knows, offering session and deny", () => {
      const { prompts, raised } = controller();
      void propose(prompts, { callId: "call-sp#1", hostCallId: "call-sp" });
      expect(raised).toEqual([
        {
          promptId: openPlan(prompts),
          callId: "call-sp",
          sessionId: "session-a",
          kind: "site-plan",
          site: A,
          sites: [A, B, C],
          action: "Compare the release notes",
          choices: ["session", "deny"],
          boundMs: 60_000,
        },
      ]);
    });

    it("approves every proposed site for a client 'session', leaving none out", async () => {
      const { prompts, settled } = controller();
      const pending = propose(prompts);
      expect(prompts.decideByCall("call-sp", openPlan(prompts), "session", "client", "session-a")).toBe(true);
      await expect(pending).resolves.toEqual({ decision: "approve", approved: [A, B, C], leftOut: [] });
      expect(prompts.currentSitePlan()).toBeUndefined();
      expect(settled).toEqual([
        { promptId: expect.any(String), callId: "call-sp", sessionId: "session-a", answeredFrom: "client" },
      ]);
    });

    it("declines for a client 'deny'", async () => {
      const { prompts } = controller();
      const pending = propose(prompts);
      expect(prompts.decideByCall("call-sp", openPlan(prompts), "deny", "client")).toBe(true);
      await expect(pending).resolves.toEqual({ decision: "declined" });
    });

    it("ignores a choice it never offered, another question's id and another session, and keeps the card up", async () => {
      const { prompts, diagnostics } = controller();
      let resolved = false;
      void propose(prompts).then(() => (resolved = true));
      const proposalId = openPlan(prompts);

      expect(prompts.decideByCall("call-sp", proposalId, "once", "client")).toBe(false);
      expect(diagnostics).toContain("agent.prompt.choice-not-offered");
      expect(prompts.decideByCall("call-sp", "site-plan-0000000000000000", "session", "client")).toBe(false);
      expect(prompts.decideByCall("call-other", proposalId, "session", "client")).toBe(false);
      expect(diagnostics).toContain("agent.prompt.late-answer");
      expect(prompts.decideByCall("call-sp", proposalId, "session", "client", "session-b")).toBe(false);
      expect(diagnostics).toContain("agent.prompt.other-session");

      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(prompts.currentSitePlan()?.proposalId).toBe(proposalId);
    });

    it("lets the card's narrowed approval decide first and makes the client's answer late", async () => {
      const { prompts, diagnostics } = controller();
      const pending = propose(prompts);
      const proposalId = openPlan(prompts);
      expect(prompts.decideSitePlan(proposalId, true, [B])).toBe(true);
      expect(prompts.decideByCall("call-sp", proposalId, "session", "client")).toBe(false);
      await expect(pending).resolves.toEqual({ decision: "approve", approved: [B], leftOut: [A, C] });
      expect(diagnostics).toContain("agent.prompt.late-answer");
    });
  });

  it("never raises a batch's plan card or a directory card, and nothing the client says settles them (FR-487)", async () => {
    const { prompts, raised } = controller();
    let resolved = false;
    void prompts
      .askPlan({ callId: "call-b", sessionId: "session-a", site: A, steps: [{ tool: "click", summary: "click" }] })
      .then(() => (resolved = true));
    const planId = prompts.currentPlan()?.planId ?? "";
    expect(raised).toEqual([]);
    for (const choice of ["once", "session", "deny"] as const) {
      expect(prompts.decideByCall("call-b", planId, choice, "client"), choice).toBe(false);
    }
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(prompts.currentPlan()).toBeDefined();
  });
});

/**
 * 032 T970 - one `onConcluded` per question that ended by an answer or by its own timeout (R-488).
 *
 * The controller is the one place every question ends and knows where the answer came from, so the
 * runtime's activity line is built from this report. A stop, an interrupt, a release, a session
 * ending or a question refused as busy report nothing: those have their own line or end the session.
 */
describe("032 a settled question reports its conclusion", () => {
  const SITE = "https://agent.test";
  const FROM = "https://www.wikipedia.org";
  const TO = "https://zh.wikipedia.org";
  const A = "https://a.test";
  const B = "https://b.test";

  type Prompts = ReturnType<typeof createAgentPromptController>;

  function controller(extra: Partial<Parameters<typeof createAgentPromptController>[0]> = {}) {
    const concluded: Array<Record<string, unknown>> = [];
    const prompts = createAgentPromptController({
      timeoutMs: 60_000,
      onConcluded: (conclusion) => concluded.push({ ...conclusion }),
      ...extra,
    });
    return { prompts, concluded };
  }

  const effect = (prompts: Prompts, extra: Record<string, unknown> = {}) =>
    prompts.ask({
      callId: "call-1",
      sessionId: "session-a",
      site: SITE,
      tool: "click",
      argsSummary: "click a page element",
      ...extra,
    } as Parameters<Prompts["ask"]>[0]);

  const open = (prompts: Prompts): string => prompts.current()?.promptId ?? "";
  const conclusion = (question: string, channel: string, answer: string, site = SITE) => ({
    sessionId: "session-a",
    question,
    site,
    channel,
    answer,
  });

  it("reports an effect allowed once from the card, and one denied", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts);
    prompts.decide(open(prompts), true);
    await first;
    const second = effect(prompts);
    prompts.decide(open(prompts), false);
    await second;
    expect(concluded).toEqual([conclusion("effect", "browser", "once"), conclusion("effect", "browser", "deny")]);
  });

  it("reports session from the card's session flag and always when a mode is remembered", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts);
    prompts.decide(open(prompts), true, undefined, undefined, undefined, true);
    await first;
    const second = effect(prompts);
    prompts.decide(open(prompts), true, "follow-a-plan");
    await second;
    expect(concluded).toEqual([
      conclusion("effect", "browser", "session"),
      conclusion("effect", "browser", "always"),
    ]);
  });

  it("reports the agent's client as the channel, and its session choice as session", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts);
    prompts.decideByCall("call-1", open(prompts), "session", "client");
    await first;
    const second = effect(prompts);
    prompts.decideByCall("call-1", open(prompts), "deny", "client");
    await second;
    const third = effect(prompts);
    prompts.decideByCall("call-1", open(prompts), "once", "client");
    await third;
    expect(concluded).toEqual([
      conclusion("effect", "client", "session"),
      conclusion("effect", "client", "deny"),
      conclusion("effect", "client", "once"),
    ]);
  });

  it("names a frame's own site when the frame decides the question", async () => {
    const { prompts, concluded } = controller();
    const pending = effect(prompts, { frame: { site: A } });
    prompts.decide(open(prompts), true);
    await pending;
    expect(concluded).toEqual([conclusion("effect", "browser", "once", A)]);
  });

  it("reports a diagnostics question: once, session, always for the grant checkbox", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts, { kind: "diagnostics" });
    prompts.decide(open(prompts), true);
    await first;
    const second = effect(prompts, { kind: "diagnostics" });
    prompts.decideByCall("call-1", open(prompts), "session", "client");
    await second;
    const third = effect(prompts, { kind: "diagnostics" });
    prompts.decide(open(prompts), true, undefined, undefined, undefined, undefined, true);
    await third;
    expect(concluded).toEqual([
      conclusion("diagnostics", "browser", "once"),
      conclusion("diagnostics", "client", "session"),
      conclusion("diagnostics", "browser", "always"),
    ]);
  });

  it("reports a site change by where the tab went: session from either place, always for a remembered pair", async () => {
    const { prompts, concluded } = controller();
    const moved = () => effect(prompts, { site: TO, kind: "transition", transition: { from: FROM, to: TO } });
    const first = moved();
    prompts.decideByCall("call-1", open(prompts), "session", "client");
    await first;
    const second = moved();
    prompts.decide(open(prompts), true);
    await second;
    const third = moved();
    prompts.decide(open(prompts), true, undefined, true);
    await third;
    const fourth = moved();
    prompts.decide(open(prompts), false);
    await fourth;
    expect(concluded).toEqual([
      conclusion("transition", "client", "session", TO),
      conclusion("transition", "browser", "session", TO),
      conclusion("transition", "browser", "always", TO),
      conclusion("transition", "browser", "deny", TO),
    ]);
  });

  it("reports an upload directory: once, and always when the directory is remembered", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts, { kind: "upload-directory" });
    prompts.decide(open(prompts), true);
    await first;
    const second = effect(prompts, { kind: "upload-directory" });
    prompts.decide(open(prompts), true, undefined, undefined, true);
    await second;
    expect(concluded).toEqual([
      conclusion("upload-directory", "browser", "once"),
      conclusion("upload-directory", "browser", "always"),
    ]);
  });

  it("reports the dialog and leave-the-page questions as dialog, allowed once", async () => {
    const { prompts, concluded } = controller();
    const first = effect(prompts, { kind: "dialog-accept" });
    prompts.decide(open(prompts), true);
    await first;
    const second = effect(prompts, { kind: "beforeunload-force" });
    prompts.decideByCall("call-1", open(prompts), "once", "client");
    await second;
    const third = effect(prompts, { kind: "dialog-accept" });
    prompts.decide(open(prompts), false);
    await third;
    expect(concluded).toEqual([
      conclusion("dialog", "browser", "once"),
      conclusion("dialog", "client", "once"),
      conclusion("dialog", "browser", "deny"),
    ]);
  });

  it("reports a batch plan: approved is once, declined is deny", async () => {
    const { prompts, concluded } = controller();
    const ask = () =>
      prompts.askPlan({ callId: "call-p", sessionId: "session-a", site: SITE, steps: [] } as Parameters<
        Prompts["askPlan"]
      >[0]);
    const first = ask();
    prompts.decidePlan(prompts.currentPlan()?.planId ?? "", true);
    await first;
    const second = ask();
    prompts.decidePlan(prompts.currentPlan()?.planId ?? "", false);
    await second;
    expect(concluded).toEqual([conclusion("plan", "browser", "once"), conclusion("plan", "browser", "deny")]);
  });

  it("reports a site plan by its first site: approved is session, from the card or the client, declined is deny", async () => {
    const { prompts, concluded } = controller();
    const propose = () =>
      prompts.askSitePlan({
        callId: "call-sp",
        sessionId: "session-a",
        origins: [A, B],
        purpose: "Compare the release notes",
      } as Parameters<Prompts["askSitePlan"]>[0]);
    const id = (): string => prompts.currentSitePlan()?.proposalId ?? "";
    const first = propose();
    prompts.decideSitePlan(id(), true, [B]);
    await first;
    const second = propose();
    prompts.decideByCall("call-sp", id(), "session", "client");
    await second;
    const third = propose();
    prompts.decideSitePlan(id(), false, []);
    await third;
    const fourth = propose();
    prompts.decideByCall("call-sp", id(), "deny", "client");
    await fourth;
    expect(concluded).toEqual([
      conclusion("site-plan", "browser", "session", A),
      conclusion("site-plan", "client", "session", A),
      conclusion("site-plan", "browser", "deny", A),
      conclusion("site-plan", "client", "deny", A),
    ]);
  });

  it("reports a question nobody answered in time as timed-out, with no channel", async () => {
    vi.useFakeTimers();
    try {
      const { prompts, concluded } = controller({ timeoutMs: 1_000 });
      const pending = effect(prompts, { kind: "transition", site: TO, transition: { from: FROM, to: TO } });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ decision: "timed-out" });
      expect(concluded).toEqual([conclusion("transition", "none", "timed-out", TO)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports nothing for a stop, an interrupt, a release, a withdrawn call or a question refused as busy", async () => {
    const { prompts, concluded } = controller();
    const stopped = effect(prompts);
    prompts.cancelSession("session-a", "stopped");
    await stopped;
    const interrupted = effect(prompts);
    prompts.cancelSession("session-a", "interrupted");
    await interrupted;
    const released = effect(prompts);
    prompts.cancelSession("session-a", "released");
    await released;
    const ended = effect(prompts);
    prompts.cancelSession("session-a");
    await ended;
    const withdrawn = effect(prompts);
    prompts.cancel("call-1");
    await withdrawn;
    const standing = effect(prompts);
    await expect(effect(prompts)).resolves.toEqual({ decision: "busy" });
    const plan = prompts.askPlan({ callId: "c", sessionId: "session-a", site: SITE, steps: [] } as Parameters<
      Prompts["askPlan"]
    >[0]);
    await expect(plan).resolves.toEqual({ decision: "busy" });
    expect(concluded).toEqual([]);
    prompts.decide(open(prompts), true);
    await standing;
    expect(concluded).toHaveLength(1);
  });

  it("reports nothing for a late or refused answer, and only once for the real one", async () => {
    const { prompts, concluded } = controller();
    const pending = effect(prompts, { kind: "transition", site: TO, transition: { from: FROM, to: TO } });
    const id = open(prompts);
    // A choice the transition card did not offer is refused and the card keeps waiting.
    expect(prompts.decideByCall("call-1", id, "once", "client")).toBe(false);
    expect(prompts.decide("prompt-nope", true)).toBe(false);
    expect(concluded).toEqual([]);
    prompts.decide(id, false);
    await pending;
    expect(prompts.decide(id, true)).toBe(false);
    expect(concluded).toHaveLength(1);
  });
});
