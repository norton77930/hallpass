import { describe, expect, it, vi } from "vitest";
import { agentLinkFrameSchema, settingsMessageSchema } from "@hallpass/contracts";
import { DIAGNOSTICS_REPLY_WINDOW_MS, createConversationRelay, type SettingsReplyTarget } from "../src/service-worker/conversation-relay.js";

/**
 * 024 R-373, R-387 (contracts/frames.md) - the settings page's agent commands through the worker's
 * one broker relay. A page's command goes to the broker under the page's commandId as a panel's does;
 * its result, and the `{ agent }` form's diagnostics reply, go back to that page alone and never to
 * the panels. A `{ conversationId }` diagnostics reply still goes to every panel, as in 023.
 */

const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
const CONVERSATION = "conv-aaaaaaaaaaaaaaaa1";
const READ_AT = "2026-10-24T00:00:00.000Z";

function page() {
  const results: unknown[] = [];
  const diagnostics: unknown[] = [];
  const target: SettingsReplyTarget = {
    result: (payload) => void results.push(payload),
    diagnostics: (payload) => void diagnostics.push(payload),
  };
  return { target, results, diagnostics };
}

function harness() {
  const frames: Array<Record<string, unknown>> = [];
  const panels: unknown[] = [];
  const reports: string[] = [];
  let ids = 0;
  const relay = createConversationRelay({
    sendFrame: (frame) => frames.push(frame as Record<string, unknown>),
    toPanels: (message) => panels.push(message),
    reportDiagnostic: (code) => reports.push(code),
    schedule: () => undefined,
    mintId: () => `w-${++ids}`,
  });
  relay.relayStarted();
  relay.announce(BROKER);
  return { relay, frames, panels, reports };
}

describe("024 settings commands through the conversation relay", () => {
  it("forwards a page's command under its commandId and answers that page alone", () => {
    const { relay, frames, panels } = harness();
    const one = page();

    relay.command({ type: "ui.conversation.check-agents", payload: { agent: "hermes" }, commandId: "s-1" }, one.target);
    relay.command({ type: "ui.conversation.test", payload: { agent: "codex" }, commandId: "s-2" }, one.target);
    relay.command({ type: "ui.conversation.install-cancel", payload: { agent: "deepseek" }, commandId: "s-3" }, one.target);

    expect(frames).toEqual([
      { type: "conversation-command", sessionId: BROKER, commandId: "s-1", command: { type: "ui.conversation.check-agents", payload: { agent: "hermes" } } },
      { type: "conversation-command", sessionId: BROKER, commandId: "s-2", command: { type: "ui.conversation.test", payload: { agent: "codex" } } },
      { type: "conversation-command", sessionId: BROKER, commandId: "s-3", command: { type: "ui.conversation.install-cancel", payload: { agent: "deepseek" } } },
    ]);
    for (const frame of frames) expect(agentLinkFrameSchema.safeParse(frame).success).toBe(true);

    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "s-1", ok: true } as never);
    relay.receive({
      type: "conversation-result",
      sessionId: BROKER,
      commandId: "s-2",
      ok: false,
      error: { code: "agent-missing", detail: "Codex is not installed." },
    } as never);

    expect(one.results).toEqual([
      { commandId: "s-1", ok: true },
      { commandId: "s-2", ok: false, error: { code: "agent-missing", detail: "Codex is not installed." } },
    ]);
    for (const payload of one.results) {
      expect(settingsMessageSchema.safeParse({ type: "worker.settings.result", payload }).success).toBe(true);
    }
    expect(panels, "a page's result is not a panel's").toEqual([]);
  });

  it("answers the page at once when no broker is attached, and fails its commands in flight when the broker leaves", () => {
    const { relay, panels } = harness();
    const one = page();
    relay.command({ type: "ui.conversation.check-agents", payload: {}, commandId: "s-1" }, one.target);

    relay.ended(BROKER);
    relay.command({ type: "ui.conversation.test", payload: { agent: "codex" }, commandId: "s-2" }, one.target);

    expect(one.results).toEqual([
      { commandId: "s-1", ok: false, error: { code: "broker-unavailable", detail: expect.any(String) } },
      { commandId: "s-2", ok: false, error: { code: "broker-unavailable", detail: expect.any(String) } },
    ]);
    expect(panels).toEqual([]);
  });

  it("R-387: an { agent } diagnostics reply goes to the page that asked, once, and never to a panel", () => {
    const { relay, panels, reports } = harness();
    const asking = page();
    const other = page();

    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "codex" }, commandId: "s-1" }, asking.target);
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "s-1", ok: true } as never);
    const reply = { type: "conversation-diagnostics", sessionId: BROKER, agent: "codex", readAt: READ_AT, conversationId: CONVERSATION, lines: ["INFO up"] };
    expect(relay.receive(reply as never)).toBe(true);

    expect(asking.results).toEqual([{ commandId: "s-1", ok: true }]);
    expect(asking.diagnostics).toEqual([{ agent: "codex", readAt: READ_AT, conversationId: CONVERSATION, lines: ["INFO up"] }]);
    expect(settingsMessageSchema.safeParse({ type: "worker.settings.diagnostics", payload: asking.diagnostics[0] }).success).toBe(true);
    expect(other.diagnostics).toEqual([]);
    expect(panels).toEqual([]);

    // A second reply nobody asked for is dropped and said, never fanned out.
    expect(relay.receive(reply as never)).toBe(true);
    expect(asking.diagnostics).toHaveLength(1);
    expect(panels).toEqual([]);
    expect(reports).toContain("agent.conversation.diagnostics-unclaimed");
  });

  it("R-387: replies for one agent go to the pages in the order they asked; a test's run names no conversation", () => {
    const { relay } = harness();
    const first = page();
    const second = page();
    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "deepseek" }, commandId: "s-1" }, first.target);
    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "deepseek" }, commandId: "s-2" }, second.target);

    relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "deepseek", readAt: READ_AT, lines: ["one"] } as never);
    relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "deepseek", readAt: READ_AT, lines: ["two"] } as never);

    expect(first.diagnostics).toEqual([{ agent: "deepseek", readAt: READ_AT, lines: ["one"] }]);
    expect(second.diagnostics).toEqual([{ agent: "deepseek", readAt: READ_AT, lines: ["two"] }]);
  });

  it("R-387: a refused diagnostics request leaves nobody waiting for its reply", () => {
    const { relay, reports } = harness();
    const asking = page();
    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "hermes" }, commandId: "s-1" }, asking.target);
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "s-1", ok: false, error: { code: "not-found" } } as never);

    relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "hermes", readAt: READ_AT, lines: [] } as never);

    expect(asking.diagnostics).toEqual([]);
    expect(reports).toContain("agent.conversation.diagnostics-unclaimed");
  });

  it("R-387: a page that closed while waiting does not take the next asker's reply", () => {
    const { relay } = harness();
    let open = true;
    const gone = page();
    const goneTarget: SettingsReplyTarget = { ...gone.target, isOpen: () => open };
    const next = page();
    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "codex" }, commandId: "s-1" }, goneTarget);
    open = false;
    relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "codex" }, commandId: "s-2" }, next.target);

    relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "codex", readAt: READ_AT, lines: ["for next"] } as never);

    expect(gone.diagnostics).toEqual([]);
    expect(next.diagnostics).toEqual([{ agent: "codex", readAt: READ_AT, lines: ["for next"] }]);
  });

  it("R-387: a wait no reply follows within DIAGNOSTICS_REPLY_WINDOW_MS is dropped, so a later asker gets its own reply", async () => {
    vi.useFakeTimers();
    try {
      const reports: string[] = [];
      const relay = createConversationRelay({ sendFrame: () => undefined, reportDiagnostic: (code) => reports.push(code) });
      relay.relayStarted();
      relay.announce(BROKER);
      const stale = page();
      const later = page();
      relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "hermes" }, commandId: "s-1" }, stale.target);

      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_REPLY_WINDOW_MS - 1);
      relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "codex" }, commandId: "s-2" }, later.target);
      expect(reports).not.toContain("agent.conversation.diagnostics-expired");
      await vi.advanceTimersByTimeAsync(1);
      expect(reports).toContain("agent.conversation.diagnostics-expired");

      relay.command({ type: "ui.conversation.diagnostics", payload: { agent: "hermes" }, commandId: "s-3" }, later.target);
      relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "hermes", readAt: READ_AT, lines: ["for later"] } as never);
      expect(stale.diagnostics).toEqual([]);
      expect(later.diagnostics).toEqual([{ agent: "hermes", readAt: READ_AT, lines: ["for later"] }]);

      // The codex wait asked inside the window is still there for its reply.
      relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, agent: "codex", readAt: READ_AT, lines: ["codex"] } as never);
      expect(later.diagnostics).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("023: a { conversationId } diagnostics reply still goes to every panel, without the agent fields", () => {
    const { relay, panels } = harness();
    relay.receive({ type: "conversation-diagnostics", sessionId: BROKER, conversationId: CONVERSATION, lines: ["a"] } as never);
    expect(panels).toEqual([{ type: "conversation-diagnostics", payload: { conversationId: CONVERSATION, lines: ["a"] } }]);
  });

  it("a page's consent answer is recorded like the panel's", () => {
    const { relay } = harness();
    const one = page();
    relay.command({ type: "ui.conversation.consent", payload: { granted: true }, commandId: "s-1" }, one.target);
    relay.receive({ type: "conversation-result", sessionId: BROKER, commandId: "s-1", ok: true } as never);
    expect(relay.panelState(true).consent).toBe("granted");
    expect(one.results).toEqual([{ commandId: "s-1", ok: true }]);
  });
});
