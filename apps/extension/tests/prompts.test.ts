import { describe, expect, it, vi } from "vitest";
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
    await expect(pending).resolves.toEqual({ decision: "allow" });
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
    await expect(propose(prompts)).resolves.toEqual({ decision: "timed-out" });
  });
});
