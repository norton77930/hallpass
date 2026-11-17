import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE, installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";

/**
 * 020/T606 B3, 036 FR-541 - the session card's header as drawn: a bar in the session's colour, the name in
 * bold, one line under it with the state, the agent and the tabs it holds, and the one primary action.
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

  it("puts a bar, the name in bold, and under it the state, the agent and the start, with the primary action beside them", () => {
    renderShell();
    project(port, { ...IDLE, sessions: [{ ...base, label: "shop-frontend" }] });
    const card = document.querySelector<HTMLElement>("[data-session-id]")!;
    const head = card.querySelector<HTMLElement>(".agent-session-head")!;
    expect(head.querySelector(".agent-session-bar")?.getAttribute("data-colour")).toBe("blue");
    expect(head.querySelector("h2")?.textContent).toBe("shop-frontend");
    const sub = head.querySelector<HTMLElement>(".agent-session-sub")!;
    expect(sub.querySelector(".agent-session-state")?.textContent).toBe(ui("agent.session.waiting"));
    expect(sub.querySelector(".agent-session-agent")?.textContent).toBe("Claude Code");
    // It holds no tab, so the line says no count; the start time is on the quiet last line.
    expect(sub.querySelector(".agent-session-tabs")).toBeNull();
    expect(head.lastElementChild?.classList.contains("agent-session-primary")).toBe(true);
    expect(head.lastElementChild?.textContent).toBe(ui("agent.session.answer"));
    expect(card.querySelector(".agent-session-foot")?.compareDocumentPosition(head)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(card.querySelector(".agent-session-tech summary")?.textContent).toBe(
      ui("agent.session.startedDetails").replace("{time}", "14:02"),
    );
  });

  it("names the agent in bold when no folder was reported, and says the start in zh-TW on the last line", () => {
    renderShell("zh-TW");
    project(port, { ...IDLE, sessions: [base] });
    const card = document.querySelector<HTMLElement>("[data-session-id]")!;
    expect(card.querySelector(".agent-session-head h2")?.textContent).toBe("Claude Code");
    expect(card.querySelector(".agent-session-tech summary")?.textContent).toBe("14:02 開始 · 技術資訊");
  });
});
