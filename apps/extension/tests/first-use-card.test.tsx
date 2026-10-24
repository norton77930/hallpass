import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationPanelState } from "@hallpass/contracts";
import {
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 019/T548 - the first-use card (US3, FR-299 - FR-302, D-019-5, D-019-7, R-314), as 024 leaves it.
 *
 * 024 FR-384, D-024-2: nothing is downloaded or installed from a conversation any more - the card has
 * no Download, no size and no registry line, and an agent that is not ready never reaches it (its
 * reason and the link to the settings page are covered in conversation-agents-024.test.tsx). What is
 * left is the one-time consent for an agent that is ready: the card says the agent runs with the
 * owner's own settings and that it will use this browser under the site rules; Allow sends the
 * consent, Cancel sends nothing.
 *
 * 020 FR-314: the card comes when the owner sends to the agent on the chip (composer first), not
 * when picking an agent; the held message itself is covered in composer.test.tsx.
 */

const FIRST_USE: ConversationPanelState = {
  ...CONVERSATION_READY,
  consent: "unknown",
  agents: [
    { agent: "claude-code", availability: "ready" },
    { agent: "codex", availability: "missing" },
  ],
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const sendButton = () => document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!;
const sendWords = (words = "what is on this page?") => {
  fireEvent.change(box(), { target: { value: words } });
  fireEvent.click(sendButton());
};
const card = () => screen.getByRole("region", { name: ui("conversation.firstUse.title").replace("{agent}", "Claude Code") });

describe("T548 the first-use card", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState = FIRST_USE, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("states the owner's own settings and the site rules, and offers no download", async () => {
    await open();
    sendWords();

    const text = card().textContent ?? "";
    expect(text).toContain(ui("conversation.firstUse.settings").replace("{agent}", "Claude Code"));
    expect(text).toContain(ui("conversation.firstUse.browser"));
    expect(text).not.toContain("npm registry your own npm is set up for");
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(commandsSent(port)).toEqual([]);
  });

  it("sends the consent alone on Allow, and starts once the worker reports it", async () => {
    await open();
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.allow") }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);

    project(port, withConversation({ ...FIRST_USE, consent: "granted" }));
    expect(commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.start")).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
    ]);
  });

  it("asks for nothing when the one-time consent was already given", async () => {
    await open({ ...FIRST_USE, consent: "granted" });
    sendWords();

    expect(screen.queryByRole("region", { name: /Claude Code/ })).toBeNull();
    expect(commandsSent(port).map((command) => (command as { type: string }).type)).toEqual(["ui.conversation.start"]);
  });

  it("sends nothing on Cancel and gives the words back", async () => {
    await open();
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.cancel") }));

    expect(commandsSent(port)).toEqual([]);
    expect(screen.queryByRole("region", { name: /Claude Code/ })).toBeNull();
    expect(box().value).toBe("what is on this page?");
  });

  it("does not offer the card for an agent that is not ready: Send stays off and nothing is sent", async () => {
    await open({ ...FIRST_USE, agents: [{ agent: "claude-code", availability: "needs-install", version: "2.1.0" }, FIRST_USE.agents[1]!] });
    fireEvent.change(box(), { target: { value: "what is on this page?" } });

    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector("[data-setup=first-use]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(commandsSent(port)).toEqual([]);
  });

  it("reads in zh-TW", async () => {
    await open(FIRST_USE, "zh-TW");
    sendWords();
    expect(screen.getByRole("region", { name: "為側欄設定 Claude Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "允許" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });
});
