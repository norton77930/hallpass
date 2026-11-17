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

    it(`reads a hold followed by a resume as one row, and each alone as its own row, without outcome words (${locale})`, () => {
      const rowsFor = (activity: AgentPanelState["sessions"][number]["activity"]): string[] => {
        project(port, {
          ...IDLE,
          sessions: [{ sessionId: "session-act", agentId: "agent-1", tabs: [], sites: [], state: "working", activity }],
        });
        return [...card("session-act").querySelectorAll(".agent-session-activity > li")].map(
          (row) => row.querySelector(".agent-activity-text")?.textContent ?? "",
        );
      };
      renderShell(locale);

      // 036 FR-549, R-539: the pair collapses into one sentence; the sentence says both halves, so there is no result under it.
      expect(
        rowsFor([
          { at: 1_700_000_002_000, kind: "resume", outcome: "resumed" },
          { at: 1_700_000_001_000, kind: "hold", outcome: "held" },
        ]),
      ).toEqual([w("agent.activity.holdResume")]);
      expect(card("session-act").querySelector(".agent-activity-result")).toBeNull();
      expect(rowsFor([{ at: 1_700_000_001_000, kind: "hold", outcome: "held" }])).toEqual([w("agent.activity.hold")]);
      expect(rowsFor([{ at: 1_700_000_002_000, kind: "resume", outcome: "resumed" }])).toEqual([w("agent.activity.resume")]);
      expect(activityText({ at: 1, kind: "hold", outcome: "held" }, w)).toBe(w("agent.activity.hold"));
      expect(activityText({ at: 1, kind: "resume", outcome: "resumed" }, w)).toBe(w("agent.activity.resume"));
    });
  }

  it("addresses the owner in the second person in zh-TW (FR-555)", () => {
    const zh = (key: string): string => lookup(key, "zh-TW");
    for (const key of ["agent.activity.interrupt", "agent.activity.hold", "agent.activity.resume", "agent.activity.holdResume"]) {
      expect(zh(key), key).toContain("你");
    }
  });

  it("sends exactly one session-resume for this session when Resume is pressed", () => {
    renderShell();
    project(port, HELD);

    fireEvent.click(within(card("session-h")).getByRole("button", { name: lookup("agent.session.resume", "en-US") }));

    expect(port.sent).toEqual([{ type: "ui.agent.session-resume", payload: { sessionId: "session-h" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });
});
