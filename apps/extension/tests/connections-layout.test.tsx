import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 020/T606 B3 - the session card as drawn: a dot, a bold name and a state pill, the buttons in a row.
 *
 * 024 R-381: the rest of this file (one line per site with its mode chip and more button, the upload
 * folders, the explanations of the panel consent) described controls that moved to the settings page;
 * the settings page's own tests cover them.
 */

describe("T606 B3 a session card as drawn", () => {
  let port: FakeAgentPort;
  const base = {
    sessionId: "0123abcd-4567-89ef-0123-456789abcdef",
    agentId: "agent-1",
    tabs: [],
    sites: [],
    state: "waiting" as const,
    colour: "blue" as const,
    startedAt: new Date(2026, 9, 20, 14, 2, 0).toISOString(),
  };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("puts a dot, the name in bold with agent and start under it, and the state as a pill under them, the buttons in a row below", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [{ ...base, label: "shop-frontend" }] });
    const card = document.querySelector<HTMLElement>("[data-session-id]")!;
    const head = card.querySelector<HTMLElement>(".agent-session-head")!;
    expect(head.querySelector(".agent-session-stripe")?.getAttribute("data-colour")).toBe("blue");
    expect(head.querySelector("h2")?.textContent).toBe("shop-frontend");
    expect(head.querySelector(".agent-session-meta")?.textContent).toBe("Claude Code · started 14:02");
    expect(head.querySelector(".agent-session-state")?.textContent).toBe(ui("agent.session.waiting"));
    expect(head.lastElementChild?.classList.contains("agent-session-state")).toBe(true);
    expect(card.querySelector(".agent-session-actions")?.compareDocumentPosition(head)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it("names the agent in bold when no folder was reported, with only the start under it", () => {
    renderShell("zh-TW");
    project(port, { ...IDLE, sessions: [base] });
    const head = document.querySelector<HTMLElement>("[data-session-id] .agent-session-head")!;
    expect(head.querySelector("h2")?.textContent).toBe("Claude Code");
    expect(head.querySelector(".agent-session-meta")?.textContent).toBe("14:02 開始");
  });
});
