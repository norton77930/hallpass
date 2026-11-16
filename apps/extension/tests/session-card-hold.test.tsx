import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { activityText } from "../src/side-panel/agent/SessionCard.js";
import {
  IDLE,
  installAgentPort,
  project,
  renderShell,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 034/T1015 - a session the owner stopped from the page (FR-512 - FR-525, R-521).
 *
 * The card says so, offers Resume, keeps End session and drops Interrupt (there is nothing to
 * interrupt while the session is held). The words are the FR-523 locale keys in both languages.
 */
describe("034 T1015 session card held from the page", () => {
  let port: FakeAgentPort;
  const HELD: AgentPanelState = {
    ...IDLE,
    sessions: [
      {
        sessionId: "session-h",
        agentId: "agent-1",
        tabs: [{ tabId: 7, url: "https://shop.test/cart", title: "Cart", active: false, holder: "this" }],
        sites: ["shop.test"],
        state: "working",
        inFlight: 1,
        heldAt: "2026-11-15T08:30:00.000Z",
        lastActivityAt: "2026-11-15T08:30:00.000Z",
      },
      {
        sessionId: "session-free",
        agentId: "agent-1",
        tabs: [],
        sites: [],
        state: "working",
        inFlight: 1,
      },
    ],
  };

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

  for (const locale of ["en-US", "zh-TW"] as const) {
    const w = (key: string): string => lookup(key, locale);

    it(`says it was stopped from the page, offers Resume and End session, and hides Interrupt (${locale})`, () => {
      renderShell(locale);
      project(port, HELD);

      const held = within(card("session-h"));
      expect(card("session-h").textContent).toContain(w("agent.session.heldFromPage"));
      expect(held.getByRole("button", { name: w("agent.session.resume") })).toBeTruthy();
      expect(held.getByRole("button", { name: w("agent.session.stop") })).toBeTruthy();
      expect(held.queryByRole("button", { name: w("agent.session.interrupt") })).toBeNull();

      // A session that is not held is unchanged: no held line, no Resume, Interrupt still there.
      const free = within(card("session-free"));
      expect(card("session-free").textContent).not.toContain(w("agent.session.heldFromPage"));
      expect(free.queryByRole("button", { name: w("agent.session.resume") })).toBeNull();
      expect(free.getByRole("button", { name: w("agent.session.interrupt") })).toBeTruthy();
    });

    it(`renders the hold and resume activity lines with their outcome words (${locale})`, () => {
      renderShell(locale);
      project(port, {
        ...IDLE,
        sessions: [
          {
            sessionId: "session-act",
            agentId: "agent-1",
            tabs: [],
            sites: [],
            state: "working",
            activity: [
              { at: 1_700_000_002_000, kind: "resume", outcome: "resumed" },
              { at: 1_700_000_001_000, kind: "hold", outcome: "held" },
            ],
          },
        ],
      });

      const items = within(card("session-act")).getAllByRole("listitem");
      expect(items[0]?.textContent).toContain(w("agent.activity.resume"));
      expect(items[0]?.textContent).toContain(w("agent.activity.resumed"));
      expect(items[1]?.textContent).toContain(w("agent.activity.hold"));
      expect(items[1]?.textContent).toContain(w("agent.activity.held"));
      expect(activityText({ at: 1, kind: "hold", outcome: "held" }, w)).toBe(w("agent.activity.hold"));
      expect(activityText({ at: 1, kind: "resume", outcome: "resumed" }, w)).toBe(w("agent.activity.resume"));
    });
  }

  it("sends exactly one session-resume for this session when Resume is pressed", () => {
    renderShell();
    project(port, HELD);

    fireEvent.click(within(card("session-h")).getByRole("button", { name: lookup("agent.session.resume", "en-US") }));

    expect(port.sent).toEqual([{ type: "ui.agent.session-resume", payload: { sessionId: "session-h" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });
});
