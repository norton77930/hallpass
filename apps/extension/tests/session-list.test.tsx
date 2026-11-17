import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPanelState } from "@hallpass/contracts";
import { IDLE, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 036 - the Sessions tab's list: two groups, the owner's open/fold choices, and Answer (FR-538 - FR-540,
 * FR-542, R-536, R-537, R-538). Every press here is panel-local: a card opening or folding sends nothing.
 */
type Session = AgentPanelState["sessions"][number];

const session = (sessionId: string, over: Partial<Session> = {}): Session =>
  ({ sessionId, agentId: "agent-1", tabs: [], sites: [], state: "idle", inFlight: 0, ...over }) as Session;

const PROMPT = { promptId: "prompt-1", site: "https://shop.test", tool: "click" as const, argsSummary: "click", targetLabel: "Save", targetRole: "button" };

describe("036 the session list", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const card = (sessionId: string): HTMLElement => {
    const node = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (!(node instanceof HTMLElement)) throw new Error(`no card for ${sessionId}`);
    return node;
  };
  const toggle = (sessionId: string): HTMLElement => card(sessionId).querySelector<HTMLElement>(".agent-session-toggle") as HTMLElement;
  const ids = (group: string): string[] =>
    [...document.querySelectorAll(`.agent-session-list[data-group="${group}"] > [data-session-id]`)].map((node) => node.getAttribute("data-session-id") ?? "");

  it("puts the sessions that need the owner first, then an Idle heading with the count and the idle ones, newest first", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        session("idle-old", { lastActivityAt: "2026-11-17T08:00:00.000Z" }),
        session("working", { state: "working", inFlight: 1, lastActivityAt: "2026-11-17T08:30:00.000Z" }),
        session("idle-new", { lastActivityAt: "2026-11-17T09:00:00.000Z" }),
        session("waiting", { state: "waiting", lastActivityAt: "2026-11-17T09:30:00.000Z" }),
        session("held", { heldAt: "2026-11-17T07:00:00.000Z", lastActivityAt: "2026-11-17T07:00:00.000Z" }),
      ],
    });

    expect(ids("attention")).toEqual(["waiting", "working", "held"]);
    expect(ids("idle")).toEqual(["idle-new", "idle-old"]);
    const heading = document.querySelector("[data-sessions-idle]") as HTMLElement;
    expect(heading.textContent).toBe(`${ui("agent.session.groupIdle")} 2`);
    expect(heading.compareDocumentPosition(card("idle-new")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(card("held")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("shows no Idle heading while nothing is idle, and no empty group", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("a", { state: "working" }), session("b", { state: "waiting" })] });

    expect(document.querySelector("[data-sessions-idle]")).toBeNull();
    expect(document.querySelector('.agent-session-list[data-group="idle"]')).toBeNull();
  });

  it("opens a card that needs the owner and folds an idle one, unless it is the only card", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("idle-a"), session("idle-b"), session("waiting", { state: "waiting" })] });
    expect(card("waiting").getAttribute("data-open")).toBe("true");
    expect(card("idle-a").getAttribute("data-open")).toBe("false");
    expect(toggle("idle-a").getAttribute("aria-expanded")).toBe("false");
    expect(card("idle-a").querySelector(".agent-session-body")).toBeNull();

    project(port, { ...IDLE, sessions: [session("idle-a")] });
    expect(card("idle-a").getAttribute("data-open")).toBe("true");
    expect(toggle("idle-a").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens and folds a card on the header press, naming the card, and sends nothing", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("idle-a", { label: "shop-frontend" }), session("idle-b")] });

    expect(toggle("idle-a").getAttribute("aria-label")).toBe("Show details for shop-frontend");
    fireEvent.click(toggle("idle-a"));
    expect(card("idle-a").getAttribute("data-open")).toBe("true");
    expect(toggle("idle-a").getAttribute("aria-label")).toBe("Hide details for shop-frontend");
    expect(toggle("idle-a").getAttribute("aria-controls")).toBe(card("idle-a").querySelector(".agent-session-body")?.id);
    fireEvent.click(toggle("idle-a"));
    expect(card("idle-a").getAttribute("data-open")).toBe("false");

    expect(port.sent).toEqual([]);
  });

  it("keeps a card's choice while the picture changes, and re-opens a card that starts to need the owner", () => {
    renderShell();
    const idle = (state: Session["state"], inFlight = 0): AgentPanelState => ({
      ...IDLE,
      sessions: [session("a", { state, inFlight }), session("b")],
    });
    project(port, idle("working", 1));
    expect(card("a").getAttribute("data-open")).toBe("true");

    // The owner folds a working card: it stays folded when it goes idle.
    fireEvent.click(toggle("a"));
    expect(card("a").getAttribute("data-open")).toBe("false");
    project(port, idle("idle"));
    expect(card("a").getAttribute("data-open")).toBe("false");
    // ...and it opens again the moment it needs the owner, whatever the owner chose before.
    project(port, idle("waiting", 1));
    expect(card("a").getAttribute("data-open")).toBe("true");

    // A card that was open while it needed the owner stays open when it goes idle, and can be folded.
    project(port, idle("idle"));
    expect(card("a").getAttribute("data-open")).toBe("true");
    fireEvent.click(toggle("a"));
    expect(card("a").getAttribute("data-open")).toBe("false");
  });

  it("forgets a card that is gone, so a session that comes back starts from its default", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("a"), session("b")] });
    fireEvent.click(toggle("a"));
    expect(card("a").getAttribute("data-open")).toBe("true");

    project(port, { ...IDLE, sessions: [session("b"), session("c")] });
    project(port, { ...IDLE, sessions: [session("a"), session("b"), session("c")] });
    expect(card("a").getAttribute("data-open")).toBe("false");
  });

  it("keeps the primary action on a folded card, and Resume sends the frame it always did", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("held", { heldAt: "2026-11-17T07:00:00.000Z" }), session("idle-b")] });

    // A card stopped from the page is in the attention group, open; fold it and the action stays in the header.
    fireEvent.click(toggle("held"));
    expect(card("held").getAttribute("data-open")).toBe("false");
    fireEvent.click(within(card("held")).getByRole("button", { name: ui("agent.session.resume") }));
    expect(port.sent).toEqual([{ type: "ui.agent.session-resume", payload: { sessionId: "held" } }]);
  });

  it("sends the frames it always did from an open card: end session, take back tabs, interrupt, withdraw the plan", () => {
    renderShell();
    project(port, {
      ...IDLE,
      sessions: [
        session("a", {
          state: "working",
          inFlight: 1,
          tabs: [{ tabId: 7, url: "https://shop.test/cart", title: "Cart", active: false, holder: "this" }],
          sites: ["shop.test"],
          sitePlan: { origins: ["https://shop.test"] },
        }),
      ],
    });

    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.interrupt") }));
    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.sitePlanWithdraw") }));
    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.takeBack").replace("{n}", "1") }));
    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.stop") }));
    expect(port.sent).toEqual([
      { type: "ui.agent.session-interrupt", payload: { sessionId: "a" } },
      { type: "ui.agent.site-plan-withdraw", payload: { sessionId: "a" } },
      { type: "ui.agent.session-release", payload: { sessionId: "a" } },
      { type: "ui.agent.session-stop", payload: { sessionId: "a" } },
    ]);
  });

  it("brings the question card into view and focuses it when Answer is pressed, and answers nothing", () => {
    renderShell();
    project(port, { ...IDLE, prompt: PROMPT, sessions: [session("a", { state: "waiting" }), session("b")] });

    const consent = document.getElementById("agent-consent-card");
    expect(consent, "the question card carries the id Answer looks for").not.toBeNull();
    expect(consent?.getAttribute("tabindex")).toBe("-1");
    // The card's own first control took focus when it appeared; the owner has since moved on.
    toggle("b").focus();
    expect(document.activeElement).not.toBe(consent);

    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.answer") }));

    expect(document.activeElement).toBe(consent);
    expect(port.sent).toEqual([]);
    expect(screen.getByRole("dialog", { name: ui("agent.promptTitle") })).toBe(consent);
  });

  it("changes nothing when Answer finds no question on screen", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [session("a", { state: "waiting" })] });

    fireEvent.click(within(card("a")).getByRole("button", { name: ui("agent.session.answer") }));

    expect(port.sent).toEqual([]);
    expect(card("a").getAttribute("data-open")).toBe("true");
  });
});
