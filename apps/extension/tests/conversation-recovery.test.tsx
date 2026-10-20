import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationError, ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  commandsSent,
  installTabStorage,
  lastCommandId,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 020/T606 P1 - P3 - what the Conversation tab offers when it cannot go on: a conversation the agent
 * no longer has, a helper the panel cannot reach, and three agents already busy. Each says why and
 * offers the one press that helps.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const tab = (key: string) => screen.getByRole("tab", { name: new RegExp(`^${ui(key)}`) });

describe("T606 recovery in the Conversation tab", () => {
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

  /** Sends a first message from the empty conversation and has the worker refuse its start. */
  async function refuseStart(code: ConversationError["code"]) {
    await open(CONVERSATION_READY);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);
    const commandId = lastCommandId(port);
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId, ok: false, error: { code, detail: "redacted detail" } } });
    });
  }

  it.each(["en-US", "zh-TW"] as const)("P1: in %s a conversation the agent no longer has says so, offers a new one and removing it, and takes no message", async (locale) => {
    await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, resumable: false, state: "gone" }] }, locale);
    const t = (key: string) => lookup(key, locale);
    const notice = screen.getByRole("region", { name: t("conversation.cannotResume.body") });
    expect(box().disabled).toBe(true);
    expect(box().placeholder).toBe(t("conversation.cannotResume.placeholder"));

    fireEvent.click(within(notice).getByRole("button", { name: t("conversation.cannotResume.remove") }));
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.remove", payload: { conversationId: CONVERSATION_ID } });

    const fresh = within(notice).getByRole("button", { name: t("conversation.new") });
    expect(fresh.classList.contains("agent-primary")).toBe(true);
    fireEvent.click(fresh);
    expect(screen.getByRole("region", { name: t("conversation.welcome.title") })).toBeTruthy();
    expect(box().disabled).toBe(false);
  });

  it("P1: a conversation that can still continue shows no such notice", async () => {
    await open(CONVERSATION_OPEN);
    expect(screen.queryByRole("region", { name: ui("conversation.cannotResume.body") })).toBeNull();
    expect(box().disabled).toBe(false);
  });

  it("P2: an unreachable helper offers the way to Connections & sites", async () => {
    await open({ ...CONVERSATION_READY, available: false, reason: "broker-unavailable" });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.error.goConnections") }));
    expect(tab("agent.tabs.connections").getAttribute("aria-selected")).toBe("true");
  });

  it("P2: so does a refused command that says the helper is unreachable", async () => {
    await refuseStart("broker-unavailable");
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.error.goConnections") }));
    expect(tab("agent.tabs.connections").getAttribute("aria-selected")).toBe("true");
  });

  it("P3: three agents already busy offers the list of conversations", async () => {
    await refuseStart("too-many-running");
    expect(screen.queryByRole("button", { name: ui("conversation.error.goConnections") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.error.openList") }));
    expect(screen.getByRole("dialog", { name: ui("conversation.list.label") })).toBeTruthy();
  });

  it("P2/P3: any other refusal offers neither", async () => {
    await refuseStart("folder-missing");
    expect(screen.queryByRole("button", { name: ui("conversation.error.goConnections") })).toBeNull();
    expect(screen.queryByRole("button", { name: ui("conversation.error.openList") })).toBeNull();
  });
});
