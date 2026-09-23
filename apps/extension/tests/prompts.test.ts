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
