import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPanelCommandSchema, CONVERSATION_ERROR_CODES, CONVERSATION_NOTICES } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import {
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  commandsSent,
  lastCommandId,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  emitEvent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 019/T545 - the Conversation tab (US1, US2, FR-285 - FR-294).
 *
 * What the owner sees is the `conversation` part of the projection (no content) plus the events the
 * worker forwards; what leaves is one `ui.conversation.*` command per press, each checked against
 * the panel command schema. The mode switch is the safety-relevant control: it must offer exactly
 * the two modes and nothing that approves everything (FR-292).
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const header = () => screen.getByRole("region", { name: ui("conversation.header.label") });
const modeChip = (mode: "strict" | "agent-review") =>
  screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui(`conversation.mode.${mode}`)) });
/** 020 FR-312, FR-314: no conversation open - type into the empty conversation and send. */
const composeAndSend = (words = "hello") => {
  fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: words } });
  fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
};
const log = () => screen.getByRole("log", { name: ui("conversation.messages.label") });
/** 020 FR-320: the mode chip (strict until a mode event says otherwise) opens the modes. */
const openModeMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) }));
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};

describe("T545 the Conversation tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation = CONVERSATION_OPEN, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("offers both agents with their availability, and starts a scratch conversation with a ready one", async () => {
    await open({ ...CONVERSATION_READY, agents: [CONVERSATION_READY.agents[0]!, { agent: "codex", availability: "missing" }] });

    // 020 FR-313: the agents are the agent chip's menu; sending starts the conversation (FR-314).
    fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
    const agents = screen.getByRole("menu", { name: ui("conversation.agentMenu.label") });
    const claude = within(agents).getByRole("menuitemradio", { name: /^Claude Code/ });
    const codex = within(agents).getByRole("menuitemradio", { name: /^Codex/ });
    expect(claude.textContent).toContain(ui("conversation.availability.ready"));
    // 024 D-024-3: an agent that cannot start says why on a line of its own, and cannot be chosen.
    expect(codex.hasAttribute("disabled")).toBe(true);
    expect(codex.closest("li")?.querySelector(".agent-conversation-reason")?.textContent).toBe(
      ui("conversation.agentMenu.notReady.missing").replace("{agent}", "Codex"),
    );

    fireEvent.click(claude);
    composeAndSend();

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
    ]);
    expectValidCommands(port);
  });

  it("says why there is no conversation when the host is too old or its helper is not there", async () => {
    await open({ ...CONVERSATION_READY, available: false, reason: "host-outdated" });
    expect(screen.getByText(ui("conversation.unavailable.host-outdated"))).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();

    await open({ ...CONVERSATION_READY, available: false, reason: "broker-unavailable" });
    expect(screen.getByText(ui("conversation.unavailable.broker-unavailable"))).toBeTruthy();
  });

  // 020 FR-320, FR-321 (T598): the header keeps the agent and the folder; the mode is its chip's.
  it("shows the agent and the folder in the header, and the mode on its chip", async () => {
    await open();
    const region = header();
    expect(region.textContent).toContain("Claude Code");
    expect(region.textContent).toContain(ui("conversation.folder.scratch"));
    expect(region.textContent).not.toContain(ui("conversation.mode.strict"));
    expect(modeChip("strict")).toBeTruthy();
    cleanup();

    await open({
      ...CONVERSATION_OPEN,
      conversations: [{ ...VIEW, agent: "codex", folder: { kind: "project", path: "D:\\work\\shop" }, mode: "agent-review" }],
    });
    expect(header().textContent).toContain("Codex");
    // T607 (A1): the folder's name; the whole path is its title.
    expect(header().querySelector(".agent-conversation-folder")?.textContent).toBe("shop");
    expect(header().querySelector(".agent-conversation-folder")?.getAttribute("title")).toBe("D:\\work\\shop");
    expect(modeChip("agent-review")).toBeTruthy();
  });

  it("follows a mode event on the mode chip", async () => {
    await open();
    emitEvent(port, 1, { type: "mode", mode: "agent-review" });
    expect(modeChip("agent-review")).toBeTruthy();
  });

  it("appends streamed text to one message in a polite live log, and keeps the owner's words apart", async () => {
    await open();
    emitEvent(port, 1, { type: "text", role: "owner", text: "summarise this table" });
    emitEvent(port, 2, { type: "text", role: "agent", text: "The table has " });
    emitEvent(port, 3, { type: "text", role: "agent", text: "three rows." });

    const messages = log();
    expect(messages.getAttribute("aria-live")).toBe("polite");
    const items = messages.querySelectorAll("[data-message-role]");
    expect([...items].map((item) => item.getAttribute("data-message-role"))).toEqual(["owner", "agent"]);
    expect(items[0]?.textContent).toContain("summarise this table");
    expect(items[1]?.textContent).toContain("The table has three rows.");
  });

  it("drops a repeated event and ignores another conversation's", async () => {
    await open();
    emitEvent(port, 1, { type: "text", role: "agent", text: "once" });
    emitEvent(port, 1, { type: "text", role: "agent", text: "once" });
    emitEvent(port, 1, { type: "text", role: "agent", text: "elsewhere" }, "conv-ffffffffffffffff");

    expect(log().textContent).toContain("once");
    expect(log().textContent).not.toContain("onceonce");
    expect(log().textContent).not.toContain("elsewhere");
  });

  it("lists each action with what it is, its input and its latest status, marking one allowed by rule", async () => {
    await open();
    emitEvent(port, 1, { type: "tool", toolCallId: "t-1", kind: "read", title: "Read page", inputSummary: "https://shop.test/", status: "running" });
    emitEvent(port, 2, { type: "tool", toolCallId: "t-2", kind: "edit", title: "Write table.csv", inputSummary: "table.csv", status: "done", byRule: true });
    emitEvent(port, 3, { type: "tool", toolCallId: "t-1", kind: "read", title: "Read page", inputSummary: "https://shop.test/", status: "done" });
    emitEvent(port, 4, { type: "tool", toolCallId: "t-3", kind: "execute", title: "Run rm", inputSummary: "rm table.csv", status: "refused" });

    // 020 FR-318: the turn is over (the conversation is idle), so the steps are folded and the
    // refused action stays in view beside them; expanding shows FR-287's detail.
    const refused = screen.getByRole("list", { name: ui("conversation.turn.problems") });
    expect(within(refused).getAllByRole("listitem")).toHaveLength(1);
    expect(refused.textContent).toContain(ui("conversation.action.status.refused"));
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.turn.steps").replace("{count}", "2") }));

    const list = screen.getByRole("list", { name: ui("conversation.actions.label") });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Read page");
    expect(rows[0]?.textContent).toContain("https://shop.test/");
    expect(rows[0]?.getAttribute("data-status")).toBe("done");
    expect(rows[0]?.textContent).toContain(ui("conversation.action.status.done"));
    expect(rows[1]?.textContent).toContain(ui("conversation.action.byRule"));
    expect(rows[0]?.textContent).not.toContain(ui("conversation.action.byRule"));
  });

  it("offers Stop while the agent works, and sends it for this conversation", async () => {
    await open();
    expect(screen.queryByRole("button", { name: ui("conversation.stop") })).toBeNull();
    emitEvent(port, 1, { type: "state", state: "running" });

    fireEvent.click(screen.getByRole("button", { name: ui("conversation.stop") }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION_ID } }]);
    expectValidCommands(port);

    emitEvent(port, 2, { type: "state", state: "stopped" });
    expect(screen.getByText(ui("conversation.state.stopped"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: ui("conversation.stop") })).toBeNull();
  });

  it("shows a permission card with exactly three answers, sends the owner's, and leaves when closed", async () => {
    await open();
    emitEvent(port, 1, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "edit", title: "Write table.csv", detail: "+3 lines" });

    const card = screen.getByRole("group", { name: /Write table\.csv/ });
    expect(card.textContent).toContain("+3 lines");
    const answers = within(card).getAllByRole("button");
    // T606 (C5): allow once, allow for this conversation, reject.
    expect(answers.map((button) => button.textContent)).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.allow-conversation"),
      ui("conversation.permission.reject"),
    ]);

    fireEvent.click(within(card).getByRole("button", { name: ui("conversation.permission.allow-conversation") }));
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.answer", payload: { conversationId: CONVERSATION_ID, requestId: "r-1", answer: "allow-conversation" } },
    ]);
    expectValidCommands(port);

    emitEvent(port, 2, { type: "permission-closed", requestId: "r-1", answer: "allow-conversation" });
    expect(screen.queryByRole("group", { name: /Write table\.csv/ })).toBeNull();
  });

  it.each(["read", "search", "think"] as const)(
    "T572: offers no 'allow for this conversation' on a %s card, which the broker keeps no rule for",
    async (kind) => {
      await open();
      emitEvent(port, 1, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind, title: "Look it up", detail: "" });

      const card = screen.getByRole("group", { name: /Look it up/ });
      expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual([
        ui("conversation.permission.allow-once"),
        ui("conversation.permission.reject"),
      ]);
    },
  );

  it("offers exactly two modes, and sends the switch", async () => {
    await open();
    // 020 FR-320: the modes are the mode chip's menu.
    openModeMenu();
    const switcher = screen.getByRole("radiogroup", { name: ui("conversation.mode.label") });
    const radios = within(switcher).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(["strict", "agent-review"]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(switcher.textContent?.toLowerCase()).not.toMatch(/full|bypass|yolo|never ask/);

    fireEvent.click(radios[1]!);

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.set-mode", payload: { conversationId: CONVERSATION_ID, mode: "agent-review" } },
    ]);
    expectValidCommands(port);
  });

  it("says Codex works read-only and asks, and what its own rules still allow, with the strict mode (FR-293)", async () => {
    // 020 FR-320: the note is in the mode chip's menu, under the strict choice, for Codex only.
    // FR-293 stays on screen without opening the menu: a disclosure, not a detail.
    await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, agent: "codex" }] });
    expect(screen.getByText(ui("conversation.mode.codexStrictNote")).closest(".agent-conversation-mode")).toBeNull();
    openModeMenu();
    const note = screen.getByText(ui("conversation.mode.codexStrictNote"));
    expect(note.closest(".agent-conversation-mode-option")?.querySelector("input")?.value).toBe("strict");
    cleanup();

    await open();
    openModeMenu();
    expect(screen.queryByText(ui("conversation.mode.codexStrictNote"))).toBeNull();
  });

  it.each(CONVERSATION_ERROR_CODES)("puts a notice with code %s into the conversation in the panel's own words", async (code) => {
    await open();
    emitEvent(port, 1, { type: "notice", code, text: "redacted detail" });

    const notice = log().querySelector(`[data-notice-code='${code}']`);
    expect(notice?.textContent).toContain(ui(`conversation.error.${code}`));
    expect(notice?.textContent).toContain("redacted detail");
  });

  // 023 R-368: the two notices that carry an agent (and a variable) are worded, and tested, in conversation-notices-023.
  it.each(CONVERSATION_NOTICES.filter((code) => code !== "browser-tools-missing" && code !== "key-env-not-in-browser"))(
    "says the notice %s in the panel's own words, the broker's detail under it",
    async (code) => {
      await open();
      emitEvent(port, 1, { type: "notice", code, text: "what was asked" });

      const notice = log().querySelector(`[data-notice-code='${code}']`);
      expect(notice?.textContent).toContain(ui(`conversation.notice.${code}`));
      expect(notice?.textContent).toContain("what was asked");
    },
  );

  it("says a declined sandbox-permissions request in zh-TW too (R-317)", async () => {
    await open(CONVERSATION_OPEN, "zh-TW");
    emitEvent(port, 1, { type: "notice", code: "sandbox-permissions-declined", text: "" });
    const notice = screen.getByRole("log").querySelector("[data-notice-code='sandbox-permissions-declined']");
    expect(notice?.textContent).toBe(lookup("conversation.notice.sandbox-permissions-declined", "zh-TW"));
    expect(notice?.textContent).not.toBe(lookup("conversation.notice.sandbox-permissions-declined", "en-US"));
  });

  it("shows a notice the panel has no words for as the broker's own text", async () => {
    await open();
    emitEvent(port, 1, { type: "notice", code: "reconnecting", text: "Continuing the conversation" });
    expect(log().textContent).toContain("Continuing the conversation");
  });

  it("sends the owner's message for this conversation, without a tab id the shell does not know", async () => {
    await open();
    const box = screen.getByRole("textbox", { name: ui("conversation.composer.label").replace("{agent}", "Claude Code") });
    const send = screen.getByRole("button", { name: ui("conversation.composer.send") });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: "summarise this table" } });
    fireEvent.click(send);

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: CONVERSATION_ID, text: "summarise this table" } },
    ]);
    expectValidCommands(port);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("reads in zh-TW", async () => {
    await open(CONVERSATION_OPEN, "zh-TW");
    const zh = (key: string) => lookup(key, "zh-TW");
    expect(screen.getByRole("region", { name: "對話資訊" }).textContent).toContain("暫存資料夾");
    expect(screen.getByRole("button", { name: "查看對話清單" })).toBeTruthy();
    expect(screen.getByRole("button", { name: zh("conversation.chip.mode").replace("{mode}", "變更前先問") })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "給 Claude Code 的訊息" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "傳送" })).toBeTruthy();
    emitEvent(port, 1, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "execute", title: "npm test", detail: "npm test" });
    expect(screen.getByRole("button", { name: zh("conversation.permission.allow-once") }).textContent).toBe("允許一次");
    fireEvent.click(screen.getByRole("button", { name: zh("conversation.chip.mode").replace("{mode}", zh("conversation.mode.strict")) }));
    expect(screen.getByRole("radiogroup", { name: zh("conversation.mode.label") })).toBeTruthy();
  });
});

/**
 * 019/T547 - the panel's half of the worker forwarding: each `ui.conversation.*` command leaves with
 * a commandId, the broker's refusal of one this document sent is shown until its next success, and
 * a (re)connecting document names the seq it needs next so the worker asks the broker for that page.
 */
describe("T547 the panel's side of the forwarding", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    uninstallAgentPort();
  });

  const result = (payload: Record<string, unknown>) =>
    act(() => {
      port.emit({ type: "conversation-result", payload });
    });
  const resyncs = () => port.sent.filter((message) => (message as { type: string }).type === "ui.conversation.resync");

  it("gives every conversation command a commandId, and shows a refusal of its own command until the next success", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await act(async () => undefined);
    composeAndSend();
    const first = lastCommandId(port);
    expect(first).toMatch(/.+/u);
    expect(agentPanelCommandSchema.safeParse(port.sent.at(-1)).success).toBe(true);

    // Another document's command: not this panel's to show.
    result({ commandId: "someone-else", ok: false, error: { code: "busy", detail: "elsewhere" } });
    expect(screen.queryByText(ui("conversation.error.busy"))).toBeNull();

    result({ commandId: first, ok: false, error: { code: "too-many-running", detail: "Three are running." } });
    expect(screen.getByText(ui("conversation.error.too-many-running"))).toBeTruthy();
    expect(screen.getByText("Three are running.")).toBeTruthy();

    // The refused start gave the words back; sending them again is a new command.
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
    const second = lastCommandId(port);
    expect(second).not.toBe(first);
    result({ commandId: second, ok: true, value: { conversationId: CONVERSATION_ID } });
    expect(screen.queryByText(ui("conversation.error.too-many-running"))).toBeNull();
  });

  it("asks for the open conversation's log from 0 when it connects knowing nothing", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    project(port, withConversation(CONVERSATION_OPEN));

    expect(resyncs()).toEqual([{ type: "ui.conversation.resync", payload: { conversationId: CONVERSATION_ID, fromSeq: 0 } }]);
  });

  it("after a reconnect, asks only for what follows the last event it kept", () => {
    vi.useFakeTimers();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    emitEvent(port, 0, { type: "text", role: "agent", text: "one" });
    emitEvent(port, 1, { type: "text", role: "agent", text: "two" });
    port.sent.length = 0;

    port.drop();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    project(port, withConversation(CONVERSATION_OPEN));

    expect(resyncs()).toEqual([{ type: "ui.conversation.resync", payload: { conversationId: CONVERSATION_ID, fromSeq: 2 } }]);
  });

  it("asks nothing while the conversation part is unavailable, and asks once it is back", async () => {
    renderShell();
    project(port, withConversation({ ...CONVERSATION_OPEN, available: false, reason: "broker-unavailable" }));
    expect(resyncs()).toEqual([]);

    project(port, withConversation(CONVERSATION_OPEN));
    expect(resyncs()).toHaveLength(1);
  });

  it("puts a page's earlier events before the later ones it already holds, and drops repeats", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await act(async () => undefined);
    emitEvent(port, 5, { type: "text", role: "owner", text: "later" });
    emitEvent(port, 3, { type: "text", role: "agent", text: "earlier" });
    emitEvent(port, 3, { type: "text", role: "agent", text: "earlier" });

    const text = log().textContent ?? "";
    expect(text.indexOf("earlier")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("earlier")).toBeLessThan(text.indexOf("later"));
    expect(text.split("earlier")).toHaveLength(2);
  });

  it("T572: when the broker epoch changes, drops what it kept and pages the open conversation again from 0", async () => {
    renderShell();
    project(port, withConversation({ ...CONVERSATION_OPEN, epoch: "broker-a" }));
    await act(async () => undefined);
    emitEvent(port, 0, { type: "text", role: "owner", text: "old question" });
    emitEvent(port, 1, { type: "state", state: "running" });
    expect(screen.getByRole("button", { name: ui("conversation.stop") })).toBeTruthy();
    port.sent.length = 0;

    // A replacement broker: its seqs start at 0 again, and its projection names it.
    project(port, withConversation({ ...CONVERSATION_OPEN, epoch: "broker-b" }));

    expect(resyncs()).toEqual([{ type: "ui.conversation.resync", payload: { conversationId: CONVERSATION_ID, fromSeq: 0 } }]);
    expect(log().textContent).not.toContain("old question");
    // The old broker's "running" no longer holds the composer: the overview's state stands.
    expect(screen.queryByRole("button", { name: ui("conversation.stop") })).toBeNull();

    emitEvent(port, 0, { type: "text", role: "owner", text: "new question" });
    expect(log().textContent).toContain("new question");

    // The same epoch again is no change.
    port.sent.length = 0;
    project(port, withConversation({ ...CONVERSATION_OPEN, epoch: "broker-b" }));
    expect(resyncs()).toEqual([]);
    expect(log().textContent).toContain("new question");
  });
});
