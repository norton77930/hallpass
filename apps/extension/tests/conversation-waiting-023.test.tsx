import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent, ConversationEvent, ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_READY, VIEW, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 023/T709 (US2, D-023-5, R-370, FR-367, FR-368, FR-373) - what the panel says while it waits:
 * the starting line for every agent with its expected time, and from the moment a message is sent
 * until the turn's first update, "Waiting for the model… N s" with a hint from 30 s. Panel only.
 */

const FOUR_READY: ConversationPanelState = {
  ...CONVERSATION_READY,
  agents: [
    { agent: "claude-code", availability: "ready", version: "2.1.0" },
    { agent: "codex", availability: "ready", version: "0.50.0" },
    { agent: "hermes", availability: "ready", version: "0.22.2" },
    { agent: "deepseek", availability: "ready", version: "0.2.1-rc.2", notes: ["pre-release"] },
  ],
};
const withView = (view: Partial<ConversationView>): ConversationPanelState => ({
  ...FOUR_READY,
  conversations: [{ ...VIEW, ...view }],
  active: CONVERSATION_ID,
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const HINT = "No reply yet. Check that the model server is reachable (network or VPN).";

describe("023 waiting feedback", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  describe("the starting line", () => {
    it.each([
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["hermes", "Hermes"],
    ] as const)("says %s is starting and that the first start can take 30–60 s", async (agent: ConversationAgent, name: string) => {
      await open(withView({ agent, state: "starting" }));

      expect(screen.getByText(`Starting ${name}… (first start can take 30–60 s)`)).toBeTruthy();
      expect(screen.queryByText(/few minutes/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Cancel starting ${name}` }));
      expect(commandsSent(port)).toEqual([{ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } }]);
    });

    it("keeps DeepSeek's own longer sentence and its Cancel", async () => {
      await open(withView({ agent: "deepseek", state: "starting" }));

      expect(screen.getByText("Starting DeepSeek…")).toBeTruthy();
      expect(screen.getByText("The first start can take a few minutes.")).toBeTruthy();
      expect(document.body.textContent).not.toContain("30–60");
      expect(screen.getByRole("button", { name: "Cancel starting DeepSeek" })).toBeTruthy();
    });

    it("says it in zh-TW", async () => {
      await open(withView({ agent: "hermes", state: "starting" }), "zh-TW");

      expect(screen.getByText("正在啟動 Hermes…（第一次啟動可能要 30–60 秒）")).toBeTruthy();
      expect(document.body.textContent).not.toContain("Starting");
    });
  });

  describe("from send to the turn's first update", () => {
    const send = (seq = 1) => {
      emitEvent(port, seq, { type: "text", role: "owner", text: "Summarise the page" });
      emitEvent(port, seq + 1, { type: "state", state: "running" });
    };
    const tick = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    const line = () => document.querySelector<HTMLElement>("[data-model-wait]");
    const counter = () => line()?.querySelector<HTMLElement>("[data-model-wait-text]") ?? null;
    // S3a a11y: the one polite status for the wait sits beside the message log, not inside it.
    const announcer = () => document.querySelector<HTMLElement>("[data-model-wait-status]");

    async function sent() {
      await open(withView({ state: "idle" }));
      vi.useFakeTimers({ now: new Date("2026-10-23T09:00:00Z") });
      send();
    }

    it("counts the seconds from the moment the message is sent", async () => {
      await sent();
      expect(counter()!.textContent).toBe("Waiting for the model… 0 s");
      tick(1000);
      expect(counter()!.textContent).toBe("Waiting for the model… 1 s");
      tick(4000);
      expect(counter()!.textContent).toBe("Waiting for the model… 5 s");
    });

    it("shows the server hint from 30 s and not at 29 s", async () => {
      await sent();
      tick(29_000);
      expect(counter()!.textContent).toBe("Waiting for the model… 29 s");
      expect(document.body.textContent).not.toContain(HINT);
      tick(1000);
      expect(counter()!.textContent).toBe("Waiting for the model… 30 s");
      expect(screen.getAllByText(HINT).length).toBeGreaterThan(0);
    });

    it("keeps Stop available the whole time", async () => {
      await sent();
      tick(31_000);
      fireEvent.click(screen.getByRole("button", { name: /^Stop/ }));
      expect(commandsSent(port)).toContainEqual({ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } });
    });

    it("tells a screen reader nothing each second: the counter is hidden from it and the hint is announced once, politely, at 30 s", async () => {
      await sent();
      expect(counter()!.closest("[aria-hidden='true']")).not.toBeNull();
      expect(announcer()!.getAttribute("aria-live")).toBe("polite");
      expect(announcer()!.textContent).toBe("");
      tick(29_000);
      expect(announcer()!.textContent).toBe("");
      tick(1000);
      expect(announcer()!.textContent).toBe(HINT);
      tick(10_000);
      expect(announcer()!.textContent).toBe(HINT);
      expect(counter()!.closest("[aria-hidden='true']")).not.toBeNull();
    });

    it("is announced once: the status is outside the polite message log, and nothing live inside the log repeats the hint", async () => {
      await sent();
      tick(30_000);
      const log = screen.getByRole("log");
      expect(announcer()!.closest("[aria-live]")).toBe(announcer());
      expect(log.contains(announcer())).toBe(false);
      expect(log.querySelector("[data-model-wait] [aria-live], [data-model-wait] [role='status']")).toBeNull();
      expect(document.querySelectorAll("[data-model-wait-status]")).toHaveLength(1);
      // The wait ends: so does its status.
      emitEvent(port, 3, { type: "text", role: "agent", text: "Here" });
      expect(announcer()).toBeNull();
    });

    it("says it in zh-TW", async () => {
      await open(withView({ state: "idle" }), "zh-TW");
      vi.useFakeTimers({ now: new Date("2026-10-23T09:00:00Z") });
      send();
      tick(30_000);
      expect(counter()!.textContent).toBe("等待模型回覆… 30 秒");
      expect(document.body.textContent).toContain("還沒有回覆。請確認模型伺服器連得上（網路或 VPN）。");
    });

    const updates: [string, ConversationEvent][] = [
      ["a message chunk", { type: "text", role: "agent", text: "Here" }],
      ["a tool call", { type: "tool", toolCallId: "t1", kind: "read", title: "Read page", inputSummary: "", status: "running" }],
      ["a permission card", { type: "permission", requestId: "r1", toolCallId: "t1", kind: "read", title: "Read page", detail: "" }],
      // 023 R-371: a reasoning model thinks before it answers; it has answered the panel.
      ["the agent thinking", { type: "activity", activity: "thinking" }],
    ];

    it("says Thinking… while the agent thinks, once, and drops it when the answer comes", async () => {
      await sent();
      tick(35_000);
      emitEvent(port, 3, { type: "activity", activity: "thinking" });
      expect(screen.getAllByText("Thinking…")).toHaveLength(1);
      expect(announcer()).toBeNull();
      tick(60_000);
      expect(document.body.textContent).not.toContain(HINT);
      emitEvent(port, 4, { type: "text", role: "agent", text: "Here" });
      expect(screen.queryByText("Thinking…")).toBeNull();
    });
    it.each(updates)("is cleared by %s, hint and all", async (_name, event) => {
      await sent();
      tick(35_000);
      expect(line()).not.toBeNull();
      emitEvent(port, 3, event);
      expect(line()).toBeNull();
      expect(document.body.textContent).not.toContain(HINT);
      expect(document.body.textContent).not.toContain("Waiting for the model");
      tick(5000);
      expect(document.body.textContent).not.toContain("Waiting for the model");
    });

    it("starts again from 0 for the next message", async () => {
      await sent();
      tick(12_000);
      emitEvent(port, 3, { type: "text", role: "agent", text: "Done" });
      emitEvent(port, 4, { type: "state", state: "idle" });
      expect(line()).toBeNull();
      send(5);
      expect(counter()!.textContent).toBe("Waiting for the model… 0 s");
    });
  });
});
