import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import {
  IDLE,
  NOT_PAIRED,
  installAgentPort,
  project,
  renderShell,
  shellState,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 006/T191 — the prompts, one at a time, on top of whatever else is on screen (FR-084, FR-085, US4).
 *
 * The pairing card and the consent card are the two moments the owner's authority is exercised,
 * so what is asserted is what they are told and what leaves when they answer: the agent's stated
 * name and the forwarding disclosure before pairing; the agent, the action and the site before an
 * effect; and three answers to the effect that are one command with three payloads.
 */
describe("T191 prompt cards", () => {
  let port: FakeAgentPort;
  const PENDING = { agentId: "agent-9", displayName: "New Agent", origin: "stdio:local" };
  const SITE = "https://fixtures.test:19443";
  const PROMPT = { promptId: "prompt-1", site: SITE, tool: "click" as const, argsSummary: "click a page element", targetLabel: "Save", targetRole: "button" };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("shows the pairing card on top of the not-paired page, with the disclosure, and pairs on accept", () => {
    renderShell();
    project(port, { ...NOT_PAIRED, pending: PENDING });

    expect(shellState()).toBe("not-connected");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(ui("agent.pairingTitle"));
    expect(dialog.textContent).toContain(ui("agent.pairingBody").replace("{agent}", "New Agent"));
    expect(dialog.textContent).toContain(ui("agent.pairingOrigin").replace("{origin}", "stdio:local"));
    // FR-035: the one sentence that says the agent may forward what it reads onward.
    expect(dialog.textContent).toContain(ui("agent.forwardingDisclosure"));

    fireEvent.click(screen.getByRole("button", { name: ui("agent.accept") }));
    expect(port.sent).toEqual([{ type: "ui.agent.pair-decide", payload: { agentId: "agent-9", accepted: true } }]);

    project(port, { ...NOT_PAIRED, pending: PENDING });
    fireEvent.click(screen.getByRole("button", { name: ui("agent.ignore") }));
    // FR-084: ignore is not a decline. The request is left to expire, never answered no.
    expect(port.sent[1]).toEqual({ type: "ui.agent.pair-ignore", payload: { agentId: "agent-9" } });
  });

  it("shows the consent card over the idle page: agent, action, site, and three answers", () => {
    renderShell();
    project(port, { ...IDLE, sites: [{ site: SITE, mode: "ask", diagnosticsGranted: false }], prompt: PROMPT });

    expect(shellState()).toBe("idle");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      ui("agent.consentBody").replace("{agent}", "Claude Code").replace("{action}", ui("agent.summary.click")).replace("{site}", SITE),
    );
    expect(dialog.textContent).toContain(ui("agent.promptTarget").replace("{role}", "button").replace("{label}", "Save"));
    // Reviewed copy for the tool, not the worker's own summary of the call (003/T068).
    expect(dialog.textContent).not.toContain(PROMPT.argsSummary);

    fireEvent.click(screen.getByRole("button", { name: ui("agent.allowOnce") }));
    expect(port.sent[0]).toEqual({ type: "ui.agent.effect-decide", payload: { promptId: "prompt-1", allow: true } });

    project(port, { ...IDLE, prompt: PROMPT });
    fireEvent.click(screen.getByRole("button", { name: ui("agent.allowAlways") }));
    expect(port.sent[1]).toEqual({
      type: "ui.agent.effect-decide",
      payload: { promptId: "prompt-1", allow: true, rememberMode: "skip-checks" },
    });

    project(port, { ...IDLE, prompt: PROMPT });
    fireEvent.click(screen.getByRole("button", { name: ui("agent.refuse") }));
    expect(port.sent[2]).toEqual({ type: "ui.agent.effect-decide", payload: { promptId: "prompt-1", allow: false } });
    for (const sent of port.sent) expect(agentPanelCommandSchema.safeParse(sent).success).toBe(true);
  });

  it("shows the crop of the point a position effect would land on, and nothing when there is none (T139a)", () => {
    renderShell();
    const crop = { mimeType: "image/png" as const, data: "aGVsbG8=", x: 1, y: 2, width: 30, height: 20 };
    project(port, { ...IDLE, prompt: { promptId: "p-2", site: SITE, tool: "computer", argsSummary: "click at a point", targetCrop: crop } });

    expect((screen.getByAltText(ui("agent.promptCropAlt")) as HTMLImageElement).getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");

    project(port, { ...IDLE, prompt: { promptId: "p-3", site: SITE, tool: "computer", argsSummary: "click at a point" } });
    expect(screen.queryByAltText(ui("agent.promptCropAlt"))).toBeNull();
  });

  it("keeps the plan card: every step, strike-outs carried with an approval, none with a refusal", () => {
    renderShell();
    const plan = {
      planId: "plan-1",
      site: SITE,
      steps: [
        { tool: "click" as const, summary: "click a page element" },
        { tool: "type" as const, summary: "type text" },
      ],
    };
    project(port, { ...IDLE, plan });

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(ui("agent.planTitle"));
    expect(dialog.textContent).toContain(ui("agent.summary.click"));
    expect(dialog.textContent).toContain(ui("agent.summary.type"));
    fireEvent.click(screen.getByLabelText(ui("agent.planExclude").replace("{step}", "2")));
    fireEvent.click(screen.getByRole("button", { name: ui("agent.approvePlan") }));
    expect(port.sent[0]).toEqual({ type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: true, excludedIndexes: [1] } });

    project(port, { ...IDLE, plan });
    fireEvent.click(screen.getByLabelText(ui("agent.planExclude").replace("{step}", "1")));
    fireEvent.click(screen.getByRole("button", { name: ui("agent.denyPlan") }));
    expect(port.sent[1]).toEqual({ type: "ui.agent.plan-decide", payload: { planId: "plan-1", approve: false } });
  });

  it("shows one prompt at a time, in arrival order: the earlier question first, the other once it is answered (FR-085)", () => {
    renderShell();
    const earlier = "2026-09-13T10:00:00.000Z";
    const later = "2026-09-13T10:00:05.000Z";
    // The consent arrived first: it stays on top even though a pairing request is pending.
    project(port, { ...IDLE, pending: { ...PENDING, requestedAt: later }, prompt: { ...PROMPT, raisedAt: earlier } });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: ui("agent.allowOnce") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: ui("agent.accept") })).toBeNull();

    project(port, { ...IDLE, pending: { ...PENDING, requestedAt: later } });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: ui("agent.accept") })).toBeTruthy();

    // The other way round: the pairing request came first, so it is answered first.
    project(port, { ...IDLE, pending: { ...PENDING, requestedAt: earlier }, prompt: { ...PROMPT, raisedAt: later } });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: ui("agent.accept") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: ui("agent.allowOnce") })).toBeNull();

    // A plan is dated the same way, and is the earliest of the three here.
    const plan = { planId: "plan-1", site: SITE, steps: [{ tool: "click" as const, summary: "click a page element" }], raisedAt: "2026-09-13T09:59:00.000Z" };
    project(port, { ...IDLE, pending: { ...PENDING, requestedAt: earlier }, prompt: { ...PROMPT, raisedAt: later }, plan });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: ui("agent.approvePlan") })).toBeTruthy();

    // An undated projection (a 004 worker) keeps the old precedence: pairing first.
    project(port, { ...IDLE, pending: PENDING, prompt: PROMPT });
    expect(screen.getByRole("button", { name: ui("agent.accept") })).toBeTruthy();
  });

  /**
   * 008/T227 — the two questions a dialog raises, and the one thing that is told rather than asked
   * (FR-114, FR-115, US3 scenarios 5, 6 and 10).
   *
   * An *unchained* accept is a decision the owner has not made yet, so it is the ordinary consent
   * card with two differences: the sentence says what pressing OK means, and the page's own words
   * are quoted beneath it - the one page-authored string this panel shows, because the owner cannot
   * decide about a question they cannot read. Refusing dismisses the dialog, which is the worker's
   * half; from here it is the same `allow: false` every other refusal sends.
   */
  it("asks about a dialog accept in its own words, with the page's text quoted", () => {
    renderShell();
    project(port, {
      ...IDLE,
      prompt: {
        promptId: "prompt-d1",
        site: SITE,
        tool: "dialog" as const,
        argsSummary: "dialog accept",
        kind: "dialog-accept" as const,
        dialogText: "Delete 3 orders? This cannot be undone.",
      },
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));
    expect(dialog.textContent).toContain("Delete 3 orders? This cannot be undone.");
    // The tool's own generic sentence is not what the owner is shown for this one.
    expect(dialog.textContent).not.toContain(ui("agent.summary.dialog"));

    fireEvent.click(screen.getByRole("button", { name: ui("agent.refuse") }));
    expect(port.sent[0]).toEqual({
      type: "ui.agent.effect-decide",
      payload: { promptId: "prompt-d1", allow: false },
    });
  });

  it("asks about discarding unsaved work in the words of what is lost", () => {
    renderShell();
    project(port, {
      ...IDLE,
      prompt: {
        promptId: "prompt-f1",
        site: SITE,
        tool: "navigate" as const,
        argsSummary: "navigate force",
        kind: "beforeunload-force" as const,
      },
    });

    expect(screen.getByRole("dialog").textContent).toContain(
      ui("agent.prompt.beforeunloadForce").replace("{site}", SITE),
    );
  });

  /**
   * The chained accept (FR-114): the owner approved the click a moment ago, so nothing is asked -
   * but something happened to their page, so they are told. Non-blocking: no question, one dismiss,
   * and it never takes focus from a card that *is* asking.
   */
  it("tells the owner about a chained accept without asking anything, and lets them dismiss it", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        {
          sessionId: "session-a",
          agentId: "agent-1",
          tabs: [],
          sites: ["shop.test"],
          state: "working",
          notice: {
            at: 1_700_000_003_000,
            kind: "dialog-accepted" as const,
            dialogText: "Delete 3 orders?",
            action: "click" as const,
          },
        },
      ],
    });

    const notice = document.querySelector(".agent-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(ui("agent.notice.dialogAccepted"));
    expect(notice?.textContent).toContain("Delete 3 orders?");
    expect(notice?.textContent).toContain(
      ui("agent.notice.dialogFollows").replace("{action}", ui("agent.summary.click")),
    );
    // Nothing to answer: it is not a dialog, and no command leaves when it goes.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ui("agent.notice.dismiss") }));
    expect(document.querySelector(".agent-notice")).toBeNull();
    expect(port.sent).toEqual([]);
  });

  it("names the session's agent on the consent card when the prompt belongs to a live session", () => {
    renderShell();
    project(port, {
      ...IDLE,
      paired: [...IDLE.paired, { agentId: "agent-2", displayName: "Second Agent", origin: "stdio:local", acceptedAt: "2026-09-13T00:00:00.000Z" }],
      sessions: [{ sessionId: "session-b", agentId: "agent-2", tabs: [], sites: [], state: "waiting" }],
      prompt: PROMPT,
    });

    expect(screen.getByRole("dialog").textContent).toContain(
      ui("agent.consentBody").replace("{agent}", "Second Agent").replace("{action}", ui("agent.summary.click")).replace("{site}", SITE),
    );
  });
});
