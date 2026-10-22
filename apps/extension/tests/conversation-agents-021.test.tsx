import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPanelCommandSchema,
  type ConversationError,
  type ConversationPanelState,
  type ConversationView,
} from "@hallpass/contracts";
import { createConversationRelay, type ConversationCommandFrame } from "../src/service-worker/conversation-relay.js";
import { ConversationTab } from "../src/side-panel/agent/conversation/ConversationTab.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_READY, VIEW, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 021/T671, T675, T677 - what a conversation with Hermes or DeepSeek says while it starts, when
 * its model cannot be reached, and when its earlier messages cannot be shown (US4, US5, FR-354,
 * FR-355, FR-357). Hallpass never asks for a key: the notice names where the agent's own setting
 * lives and offers no field.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};

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

describe("021 conversations in the panel", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  describe("T671 a conversation that is starting", () => {
    it("says it is starting DeepSeek, that the first start can take a few minutes, and Cancel stops the start", async () => {
      await open(withView({ agent: "deepseek", state: "starting" }));

      expect(screen.getByText("Starting DeepSeek…")).toBeTruthy();
      expect(screen.getByText("The first start can take a few minutes.")).toBeTruthy();
      const cancel = screen.getByRole("button", { name: "Cancel starting DeepSeek" });
      expect(cancel.tagName).toBe("BUTTON");
      fireEvent.click(cancel);
      expect(commandsSent(port)).toEqual([{ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } }]);
      expectValidCommands(port);
    });

    it("says it is starting Hermes without the slow-start sentence, and Cancel still stops it", async () => {
      await open(withView({ agent: "hermes", state: "starting" }));

      expect(screen.getByText("Starting Hermes…")).toBeTruthy();
      expect(screen.queryByText(/first start can take/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel starting Hermes" }));
      expect(commandsSent(port)).toEqual([{ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } }]);
    });

    it("says the same in zh-TW and offers Cancel to the keyboard and the screen reader", async () => {
      await open(withView({ agent: "deepseek", state: "starting" }), "zh-TW");

      const line = document.querySelector(".agent-conversation-state")!;
      expect(line.getAttribute("aria-live")).toBe("polite");
      expect(line.textContent).toContain("DeepSeek");
      expect(line.textContent).not.toContain("Starting");
      expect(document.body.textContent).not.toContain("The first start can take");
      const cancel = document.querySelector<HTMLButtonElement>(".agent-conversation-state button")!;
      expect(cancel.getAttribute("aria-label")).toContain("DeepSeek");
      expect(cancel.tabIndex).toBe(0);
    });

    it("is not started once the broker reports start-cancelled: stopped for that reason, and Cancel is gone", async () => {
      await open(withView({ agent: "deepseek", state: "starting" }));
      emitEvent(port, 1, { type: "state", state: "stopped", code: "start-cancelled" });

      expect(screen.queryByText("Starting DeepSeek…")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Cancel starting/ })).toBeNull();
      expect(screen.getByText("Start cancelled.")).toBeTruthy();
      expect(screen.queryByText(ui("conversation.state.stopped"))).toBeNull();
    });

    it("holds the first message while a new conversation starts, and gives the words back on start-cancelled", () => {
      const sent: unknown[] = [];
      const view = (lastError?: ConversationError) => (
        <ConversationTab
          conversation={FOUR_READY}
          logs={{}}
          locale="en-US"
          send={(command) => sent.push(command)}
          {...(lastError === undefined ? {} : { lastError })}
        />
      );
      const { rerender } = render(view());
      fireEvent.click(document.querySelector("button[data-chip=agent]")!);
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^DeepSeek/ }));
      const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
      fireEvent.change(box(), { target: { value: "summarise this" } });
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));

      expect(sent).toEqual([{ type: "ui.conversation.start", payload: { agent: "deepseek", folder: { kind: "scratch" } } }]);
      expect(screen.getByText("Starting DeepSeek…")).toBeTruthy();
      expect(screen.getByText("The first start can take a few minutes.")).toBeTruthy();

      rerender(view({ code: "start-cancelled", detail: "The start was stopped." }));
      expect(screen.queryByText("Starting DeepSeek…")).toBeNull();
      expect(box().value).toBe("summarise this");
      expect(box().readOnly).toBe(false);
      expect(document.querySelector("[data-notice-code=start-cancelled]")?.textContent).toContain(ui("conversation.error.start-cancelled"));
      expect(sent).toHaveLength(1); // no send: the conversation did not start
    });
  });

  /**
   * T692: the projection here is the worker relay's own (`createConversationRelay`), fed the broker's
   * frames as the broker sends them: the new conversation is listed `starting` long before the start
   * is answered, and nothing names it `active` but the relay.
   */
  describe("follow-up: a new conversation is listed while it starts", () => {
    const NEW_ID = "conv-fedcba9876543210";
    const BROKER = "broker-aaaaaaaaaaaaaaaaaaaaaaaa";
    const entry = (state: ConversationView["state"]): ConversationView => ({
      ...VIEW,
      conversationId: NEW_ID,
      agent: "deepseek",
      title: "New conversation",
      resumable: false,
      state,
    });
    const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
    function begin(sent: unknown[]) {
      const frames: ConversationCommandFrame[] = [];
      let lastError: ConversationError | undefined;
      let ids = 0;
      const relay = createConversationRelay({
        sendFrame: (frame) => frames.push(frame),
        toPanels: (message) => {
          if (message.type === "conversation-result" && !message.payload.ok) lastError = message.payload.error;
        },
        mintId: () => `w-${++ids}`,
      });
      relay.relayStarted();
      relay.announce(BROKER);
      const overview = (conversations: ConversationView[]) =>
        relay.receive({ type: "conversation-overview", sessionId: BROKER, conversations, agents: FOUR_READY.agents, folders: [], consent: "granted" });
      overview([]);
      const view = (logs: Record<string, unknown[]> = {}) => (
        <ConversationTab
          conversation={relay.panelState(true)}
          logs={logs as never}
          locale="en-US"
          send={(command) => {
            sent.push(command);
            relay.command(command as never);
          }}
          {...(lastError === undefined ? {} : { lastError })}
        />
      );
      const rendered = render(view());
      fireEvent.click(document.querySelector("button[data-chip=agent]")!);
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^DeepSeek/ }));
      fireEvent.change(box(), { target: { value: "summarise this" } });
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
      const startFrame = frames.at(-1)!;
      expect(startFrame.command.type).toBe("ui.conversation.start");
      const answer = (outcome: { conversationId: string } | { code: ConversationError["code"] }) =>
        relay.receive(
          "code" in outcome
            ? { type: "conversation-result", sessionId: BROKER, commandId: startFrame.commandId, ok: false, error: { code: outcome.code, detail: "The start was stopped." } }
            : { type: "conversation-result", sessionId: BROKER, commandId: startFrame.commandId, ok: true, value: outcome },
        );
      return { frames, overview, answer, rerender: (logs?: Record<string, unknown[]>) => rendered.rerender(view(logs)), relay };
    }
    const sends = (sent: unknown[]) => sent.filter((command) => (command as { type: string }).type === "ui.conversation.send");

    it("sends the held first message only once the conversation is no longer starting", () => {
      const sent: unknown[] = [];
      const { overview, answer, rerender } = begin(sent);

      overview([entry("starting")]);
      rerender();
      expect(sends(sent)).toEqual([]);
      expect(screen.getByText("Starting DeepSeek…")).toBeTruthy();

      // The broker indexes it, lists it idle, then answers the start.
      overview([entry("idle")]);
      answer({ conversationId: NEW_ID });
      rerender();
      expect(sends(sent)).toEqual([{ type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "summarise this" } }]);
      rerender();
      expect(sends(sent)).toHaveLength(1);
    });

    it("offers Cancel for it while the start is unanswered, which stops it by id; on start-cancelled the words return to the composer", () => {
      const sent: unknown[] = [];
      const { frames, overview, answer, rerender, relay } = begin(sent);
      overview([entry("starting")]);
      rerender();
      expect(relay.panelState(true).active, "no start result yet").toBe(NEW_ID);

      fireEvent.click(screen.getByRole("button", { name: "Cancel starting DeepSeek" }));
      expect(sent.at(-1)).toEqual({ type: "ui.conversation.stop", payload: { conversationId: NEW_ID } });
      expect(frames.at(-1)!.command).toEqual({ type: "ui.conversation.stop", payload: { conversationId: NEW_ID } });

      // The broker removes it and the start is refused as cancelled.
      overview([]);
      answer({ code: "start-cancelled" });
      rerender();
      expect(relay.panelState(true).active).toBeUndefined();
      expect(screen.queryByText("Starting DeepSeek…")).toBeNull();
      expect(box().value).toBe("summarise this");
      expect(sends(sent)).toEqual([]);
    });

    it("gives the words back and sends nothing when the log says start-cancelled while it is still listed", () => {
      const sent: unknown[] = [];
      const { overview, rerender } = begin(sent);
      overview([entry("starting")]);
      rerender();

      rerender({ [NEW_ID]: [{ seq: 0, event: { type: "state", state: "stopped", code: "start-cancelled" } }] });
      expect(sends(sent)).toEqual([]);
      expect(box().value).toBe("summarise this");
      expect(screen.queryByText("Starting DeepSeek…")).toBeNull();
    });

    it("an early Cancel whose agent is killed after `initialize`: `gone` comes before start-cancelled, and the held words are not sent into it", () => {
      // As the broker sends it (measured): the killed agent's run says `gone`, then the start ends start-cancelled.
      const sent: unknown[] = [];
      const { overview, answer, rerender } = begin(sent);
      overview([entry("starting")]);
      rerender();
      fireEvent.click(screen.getByRole("button", { name: "Cancel starting DeepSeek" }));
      const starting = { seq: 0, event: { type: "state", state: "starting" } };
      const gone = { seq: 1, event: { type: "state", state: "gone" } };

      rerender({ [NEW_ID]: [starting, gone] });
      expect(sends(sent), "nothing goes to a start that is being stopped").toEqual([]);

      rerender({ [NEW_ID]: [starting, gone, { seq: 2, event: { type: "state", state: "stopped", code: "start-cancelled" } }] });
      overview([]);
      answer({ code: "start-cancelled" });
      rerender({ [NEW_ID]: [starting, gone, { seq: 2, event: { type: "state", state: "stopped", code: "start-cancelled" } }] });
      expect(sends(sent)).toEqual([]);
      expect(box().value).toBe("summarise this");
      expect(box().readOnly).toBe(false);
      expect(screen.queryByText("Starting DeepSeek…")).toBeNull();
    });
  });

  describe("a Hermes that is not installed", () => {
    it("asks for its model to be set up in a terminal, where Claude Code and Codex are asked to sign in", async () => {
      await open({ ...FOUR_READY, agents: FOUR_READY.agents.map((entry) => (entry.agent === "hermes" ? { agent: "hermes" as const, availability: "missing" as const } : entry)) });
      fireEvent.click(document.querySelector("button[data-chip=agent]")!);
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^Hermes/ }));
      const card = screen.getByRole("heading", { name: ui("conversation.missing.title").replace("{agent}", "Hermes") }).closest("section")!;
      expect(card.textContent).toContain("set up its model in a terminal");
      expect(card.textContent).not.toContain("sign in");
    });
  });

  describe("T675 an agent that cannot reach its model", () => {
    const unreachable = () =>
      emitEvent(port, 1, { type: "notice", code: "agent-model-unreachable", text: "connection refused (ECONNREFUSED); variable DEEPSEEK_API_KEY is not set" });
    const notice = () => document.querySelector("[data-notice-code=agent-model-unreachable]")!;

    it("tells a Hermes owner where Hermes keeps its settings, and asks for no key", async () => {
      await open(withView({ agent: "hermes" }));
      unreachable();

      const text = notice().textContent ?? "";
      expect(text).toContain(ui("conversation.error.agent-model-unreachable"));
      expect(text).toContain("%LOCALAPPDATA%\\hermes, or HERMES_HOME if set");
      expect(text).toContain("never asks for a key");
      expect(screen.getAllByRole("textbox")).toHaveLength(1); // the message box alone
      expect(screen.queryByLabelText(/key/i)).toBeNull();
    });

    it("tells a DeepSeek owner about its own settings and the key variable its provider names", async () => {
      await open(withView({ agent: "deepseek" }));
      unreachable();

      const text = notice().textContent ?? "";
      expect(text).toContain("DeepSeek reads its model settings from its own settings");
      expect(text).toContain("environment variable");
      expect(text).toContain("never asks for a key");
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
    });

    it("gives the same hint when the command that started the agent was refused", () => {
      const view = (agent: "hermes" | "deepseek") => (
        <ConversationTab
          conversation={withView({ agent })}
          logs={{}}
          locale="en-US"
          send={() => undefined}
          lastError={{ code: "agent-model-unreachable", detail: "The model did not answer." }}
        />
      );
      const { rerender } = render(view("hermes"));
      expect(document.querySelector("[data-notice-code=agent-model-unreachable]")?.textContent).toContain("%LOCALAPPDATA%\\hermes");
      rerender(view("deepseek"));
      expect(document.querySelector("[data-notice-code=agent-model-unreachable]")?.textContent).toContain("environment variable");
    });

    it("names no place for an agent whose setting Hallpass has no words for, and says it in zh-TW", async () => {
      await open(withView({ agent: "claude-code" }));
      unreachable();
      expect(notice().textContent).not.toContain("%LOCALAPPDATA%");
      cleanup();

      await open(withView({ agent: "hermes" }), "zh-TW");
      unreachable();
      const zh = notice().textContent ?? "";
      expect(zh).toContain("%LOCALAPPDATA%\\hermes");
      expect(zh).toContain("HERMES_HOME");
      expect(zh).not.toContain("never asks for a key");
      expect(zh).not.toContain("could not reach its model");
    });
  });

  describe("T677 a conversation whose earlier messages cannot be shown", () => {
    it("says so and lets the owner continue", async () => {
      await open(withView({ agent: "deepseek", replay: "none" }));

      expect(screen.getByText("DeepSeek cannot show the earlier messages of this conversation. You can continue it.")).toBeTruthy();
      const box = document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
      expect(box.disabled).toBe(false);
      expect(box.readOnly).toBe(false);
      fireEvent.change(box, { target: { value: "carry on" } });
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
      expect(commandsSent(port)).toEqual([{ type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "carry on" } }]);
      expectValidCommands(port);
    });

    it("is a note, said in zh-TW, and only for a conversation marked replay: none", async () => {
      await open(withView({ agent: "deepseek", replay: "none" }), "zh-TW");
      const note = document.querySelector(".agent-conversation-replay-note")!;
      expect(note).not.toBeNull();
      expect(note.getAttribute("role")).toBe("note");
      expect(note.textContent).toContain("DeepSeek");
      expect(note.textContent).not.toContain("cannot show");
      cleanup();

      await open(withView({ agent: "hermes" }));
      expect(document.querySelector(".agent-conversation-replay-note")).toBeNull();
    });
  });
});
