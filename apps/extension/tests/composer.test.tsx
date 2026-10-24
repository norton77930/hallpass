import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationPanelState, type ConversationView } from "@hallpass/contracts";
import {
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, CONVERSATION_READY, VIEW, commandsSent, emitEvent, withConversation } from "./helpers/conversation-fixtures.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 020/T587, T589, T590 - the composer comes first (US1, D-020-1, FR-312 - FR-315, R-335).
 *
 * With no conversation open the tab is an empty conversation: the message box, focused, and under it
 * the agent, folder and mode chips. Nothing has to be picked before typing. Sending starts the
 * conversation and sends the typed words once it is open; an agent that still needs the one-time
 * consent or its connector gets the first-use card above the box, holding the message.
 */

/** The key 020 remembered the last-used agent under; 024 R-380 stopped reading and writing it. */
const LAST_AGENT_KEY = "conversationLastAgent";
const ALL_ON = { "claude-code": true, codex: true, hermes: true, deepseek: true } as const;

type FakeStorage = { items: Record<string, unknown>; writes: Record<string, unknown>[]; failGet: boolean; failSet: boolean };

/** `chrome.storage.local` with one value per key (the shell reads its own tab key from it too). */
function installStorage(items: Record<string, unknown> = {}): FakeStorage {
  const storage: FakeStorage = { items: { ...items }, writes: [], failGet: false, failSet: false };
  const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};
  chromeGlobal.storage = {
    local: {
      get: (key: string) => {
        if (storage.failGet) throw new Error("storage unavailable");
        return Promise.resolve(key in storage.items ? { [key]: storage.items[key] } : {});
      },
      set: (next: Record<string, unknown>) => {
        if (storage.failSet) throw new Error("storage unavailable");
        storage.writes.push(next);
        Object.assign(storage.items, next);
        return Promise.resolve();
      },
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chromeGlobal;
  return storage;
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const sendButton = () => screen.getByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement;
const agentChip = () => screen.getByRole("button", { name: new RegExp(`^${ui("conversation.chip.agent").replace("{agent}", "")}`) });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const firstUse = (agent = "Claude Code") =>
  screen.getByRole("region", { name: ui("conversation.firstUse.title").replace("{agent}", agent) });
const isAbove = (upper: Element, lower: Element) => !!(upper.compareDocumentPosition(lower) & Node.DOCUMENT_POSITION_FOLLOWING);
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};

const NEW_ID = "conv-fedcba9876543210";
/** What the worker projects once the started conversation is open. */
const opened = (base: ConversationPanelState, agent: "claude-code" | "codex" = "claude-code"): ConversationPanelState => ({
  ...base,
  consent: "granted",
  agents: base.agents.map((entry) => ({ ...entry, availability: "ready" as const })),
  conversations: [...base.conversations, { ...VIEW, conversationId: NEW_ID, agent, title: "New" }],
  active: NEW_ID,
});

describe("T587 the composer comes first", () => {
  let port: FakeAgentPort;
  let storage: FakeStorage;

  beforeEach(() => {
    port = installAgentPort();
    storage = installStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState = CONVERSATION_READY, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("opens with the message box focused and the owner's default agent on the chip (scenario 1)", async () => {
    // 024 R-380: the default is the owner's choice on the settings page, not the agent used last.
    await open({ ...CONVERSATION_READY, choices: { enabled: ALL_ON, default: "codex" } });

    expect(document.activeElement).toBe(box());
    expect(agentChip().textContent).toContain("Codex");
    expect(screen.getByRole("button", { name: ui("conversation.chip.folder").replace("{folder}", ui("conversation.folder.scratch")) })).toBeTruthy();
    expect(screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) })).toBeTruthy();
    // No picker step: nothing to choose before typing.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(commandsSent(port)).toEqual([]);
  });

  it("starts the box at two lines and puts Send on the chips' row (T602: a compact composer)", async () => {
    await open();

    expect(box().rows).toBe(2);
    const chips = screen.getByRole("group", { name: ui("conversation.chips.label") });
    const row = sendButton().closest(".agent-conversation-composer-row");
    expect(row).not.toBeNull();
    expect(row?.contains(chips)).toBe(true);
    expect(isAbove(box(), row!)).toBe(true);
  });

  it("falls back to the only ready agent when the owner chose no default (scenario 2)", async () => {
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "needs-install" }, { agent: "codex", availability: "ready" }] });
    expect(agentChip().textContent).toContain("Codex");
  });

  it("falls back to the first supported agent when none is ready", async () => {
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "needs-install" }, { agent: "codex", availability: "missing" }] });
    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("does not remember the agent last used: a stored value changes nothing (024 R-380)", async () => {
    storage.items[LAST_AGENT_KEY] = "codex";
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "ready" }, { agent: "codex", availability: "ready" }] });
    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("starts in the scratch folder on Enter, and sends the typed words once it is open", async () => {
    await open();
    type("summarise this page");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
    ]);
    expect(storage.writes.some((write) => LAST_AGENT_KEY in write)).toBe(false);
    // Held while the conversation starts: the words are still there, and not sent twice.
    expect(box().value).toBe("summarise this page");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(commandsSent(port)).toHaveLength(1);

    project(port, withConversation(opened(CONVERSATION_READY)));
    project(port, withConversation(opened(CONVERSATION_READY)));
    expect(commandsSent(port).slice(1)).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "summarise this page" } },
    ]);
    expectValidCommands(port);
  });

  it("keeps working when storage cannot be written", async () => {
    storage.failSet = true;
    await open();
    type("hello");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } }]);
  });

  // 021 FR-361: the chosen mode goes with the start; a switch sent beside the first message raced it.
  it("starts in the folder chosen on the folder chip and in the mode chosen on the mode chip", async () => {
    await open({ ...CONVERSATION_READY, folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.folder").replace("{folder}", ui("conversation.folder.scratch")) }));
    fireEvent.click(screen.getByRole("radio", { name: "D:\\work\\shop" }));
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) }));
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));
    expect(commandsSent(port)).toEqual([]);

    type("fix the tests");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "project", path: "D:\\work\\shop" }, mode: "agent-review" } },
    ]);

    project(port, withConversation(opened({ ...CONVERSATION_READY, folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] })));
    expect(commandsSent(port).slice(1)).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "fix the tests" } },
    ]);
    expectValidCommands(port);
  });

  it("gives the text back and sends nothing more when the start is refused", async () => {
    await open();
    type("hello");
    fireEvent.click(sendButton());
    const commandId = (port.sent.at(-1) as { commandId: string }).commandId;
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId, ok: false, error: { code: "too-many-running", detail: "Three are running." } } });
    });

    expect(screen.getByText(ui("conversation.error.too-many-running"))).toBeTruthy();
    expect(box().value).toBe("hello");
    expect(box().readOnly).toBe(false);
    project(port, withConversation(opened(CONVERSATION_READY)));
    expect(commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.send")).toEqual([]);
  });

  it("reads in zh-TW", async () => {
    await open(CONVERSATION_READY, "zh-TW");
    expect(screen.getByRole("textbox", { name: "給 Claude Code 的訊息" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Agent：Claude Code/ })).toBeTruthy();
  });
});

describe("T589 the first-use card holds the message (scenario 3, FR-314)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  // 024: the card is the one-time consent of an agent that is ready - no download is offered from here.
  const NEEDS: ConversationPanelState = {
    ...CONVERSATION_READY,
    consent: "unknown",
    agents: [
      { agent: "claude-code", availability: "ready" },
      { agent: "codex", availability: "missing" },
    ],
  };

  async function open(conversation: ConversationPanelState = NEEDS) {
    renderShell();
    project(port, withConversation(conversation));
    await settle();
  }

  it("shows the card above the message box on Send, holding the words, and sends nothing", async () => {
    await open();
    type("what is on this page?");
    fireEvent.click(sendButton());

    expect(isAbove(firstUse(), box())).toBe(true);
    // T606 (A2): the words wait as a faded bubble over the card; the box is empty until they go or come back.
    expect(box().value).toBe("");
    expect(document.querySelector(".agent-conversation-held")?.textContent).toContain("what is on this page?");
    expect(commandsSent(port)).toEqual([]);
  });

  it("Cancel closes the card, keeps the text, and starts nothing", async () => {
    await open();
    type("what is on this page?");
    fireEvent.click(sendButton());
    fireEvent.click(within(firstUse()).getByRole("button", { name: ui("conversation.firstUse.cancel") }));

    expect(screen.queryByRole("region", { name: /Claude Code/ })).toBeNull();
    expect(box().value).toBe("what is on this page?");
    expect(box().readOnly).toBe(false);
    project(port, withConversation({ ...NEEDS, consent: "granted", agents: [{ agent: "claude-code", availability: "ready" }] }));
    expect(commandsSent(port)).toEqual([]);
  });

  it("offers no card and no download for an agent that is not ready: Send stays off (024 D-024-2)", async () => {
    await open({ ...NEEDS, agents: [{ agent: "claude-code", availability: "needs-install" }, NEEDS.agents[1]!] });
    type("what is on this page?");

    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector("[data-setup=first-use]")).toBeNull();
    // What is there instead: one line saying why, and the way to the agent's card.
    expect(document.querySelector("[data-setup=not-ready]")?.textContent).toContain(
      ui("conversation.agentMenu.notReady.download").replace("{agent}", "Claude Code"),
    );
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(commandsSent(port)).toEqual([]);
  });

  it("one Allow gives the consent, then starts and sends once the worker reports it given", async () => {
    const consentOnly: ConversationPanelState = { ...NEEDS, agents: [{ agent: "claude-code", availability: "ready" }] };
    await open(consentOnly);
    type("hello");
    fireEvent.click(sendButton());
    fireEvent.click(within(firstUse()).getByRole("button", { name: ui("conversation.firstUse.allow") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);

    project(port, withConversation({ ...consentOnly, consent: "granted" }));
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
    project(port, withConversation(opened(consentOnly)));
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "hello" } });
  });
});

describe("T588 the agent menu (scenario 4, FR-313)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("lists every enabled agent with its state, one reason line for each that cannot start, and no install guidance", async () => {
    renderShell();
    project(
      port,
      withConversation({
        ...CONVERSATION_READY,
        agents: [
          { agent: "claude-code", availability: "version-problem", version: "1.0.0", detail: "needs 2.x" },
          { agent: "codex", availability: "missing" },
        ],
      }),
    );
    await settle();
    fireEvent.click(agentChip());

    const menu = screen.getByRole("menu", { name: ui("conversation.agentMenu.label") });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(4); // 021: every contract agent is listed (no choices from the worker: all on); S3 (T669) pins the rows.
    expect(items[0]?.textContent).toContain("Claude Code");
    expect(items[0]?.hasAttribute("disabled")).toBe(true);
    const reasons = (agent: string) => document.querySelector(`li[data-agent=${agent}] .agent-conversation-reason`)?.textContent;
    expect(reasons("claude-code")).toBe(ui("conversation.agentMenu.notReady.version").replace("{agent}", "Claude Code"));
    expect(reasons("codex")).toBe(ui("conversation.agentMenu.notReady.missing").replace("{agent}", "Codex"));
    expect(screen.queryByText("Install Codex by following its official setup guide, then run codex once in a terminal to sign in.")).toBeNull();

    // Neither can be chosen: the chip stays where it was, and nothing can be sent.
    fireEvent.click(items[1]!);
    expect(agentChip().textContent).toContain("Claude Code");
    type("hello");
    expect(sendButton().disabled).toBe(true);
    expect(commandsSent(port)).toEqual([]);
  });

  it("names ready and needs-download, and the chosen agent is the one started", async () => {
    renderShell();
    project(port, withConversation({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "ready" }, { agent: "codex", availability: "needs-install" }] }));
    await settle();
    fireEvent.click(agentChip());
    const items = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    expect(items[0]?.textContent).toContain(ui("conversation.availability.ready"));
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    expect(items[1]?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("li[data-agent=codex] .agent-conversation-reason")?.textContent).toBe(
      ui("conversation.agentMenu.notReady.download").replace("{agent}", "Codex"),
    );

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(agentChip());
  });

  // 020 T600: a press anywhere else closes the menu and leaves the focus to whatever was pressed.
  it("closes on a press outside it, without pulling the focus back to the chip", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();
    fireEvent.click(agentChip());

    fireEvent.pointerDown(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[0]!);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.pointerDown(box());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(agentChip().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).not.toBe(agentChip());
  });

  it("closes once from its own chip rather than closing and opening again", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();
    fireEvent.click(agentChip());

    fireEvent.pointerDown(agentChip());
    fireEvent.click(agentChip());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("T590 agent and folder fixed once started (scenario 5, FR-315)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("shows agent and folder as fixed, keeps the mode switchable, and offers a new conversation", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();

    const chips = screen.getByRole("group", { name: ui("conversation.chips.label") });
    expect(within(chips).queryByRole("button", { name: /Claude Code/ })).toBeNull();
    expect(chips.textContent).toContain("Claude Code");
    expect(chips.textContent).toContain(ui("conversation.folder.scratch"));
    expect(chips.querySelectorAll("[data-fixed]")).toHaveLength(2);

    // 020 FR-320 (T597): the mode is a chip of its own here too; its menu holds the choice.
    fireEvent.click(within(chips).getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) }));
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.set-mode", payload: { conversationId: CONVERSATION_ID, mode: "agent-review" } },
    ]);

    // Another agent or folder is a new conversation (FR-303): the composer again, the open one stays.
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.new") }));
    expect(agentChip()).toBeTruthy();
    expect(document.activeElement).toBe(box());
    expect(commandsSent(port)).toHaveLength(1);
  });
});

/**
 * T605 - the owner-approved planned layout: one compact header row (icon list button, title with
 * "agent · folder" under it, icon new-conversation button), the log or a welcome in the middle, and
 * the message box pinned at the bottom - in the empty conversation too. The welcome's suggestions
 * only fill the box; nothing is sent until the owner sends.
 */
describe("T605 the planned layout", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState = CONVERSATION_READY, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("puts the welcome before the message box in the empty conversation, the box last", async () => {
    await open();

    const welcome = screen.getByRole("region", { name: ui("conversation.welcome.title") });
    const composer = box().closest(".agent-conversation-composer-area")!;
    expect(isAbove(welcome, composer)).toBe(true);
    const section = document.querySelector("[data-conversation=new]")!;
    expect(section.lastElementChild?.contains(composer)).toBe(true);
  });

  it.each(["en-US", "zh-TW"] as const)("in %s a suggestion fills the box and sends nothing", async (locale) => {
    await open(CONVERSATION_READY, locale);
    const t = (key: string) => lookup(key, locale);

    fireEvent.click(screen.getByRole("button", { name: t("conversation.suggest.summarise") }));
    expect(box().value).toBe(t("conversation.suggest.summarise"));
    expect(document.activeElement).toBe(box());
    fireEvent.click(screen.getByRole("button", { name: t("conversation.suggest.csv") }));
    expect(box().value).toBe(t("conversation.suggest.csv"));
    expect(commandsSent(port)).toEqual([]);
  });

  it("keeps the log before the message box in an open conversation", async () => {
    await open(CONVERSATION_OPEN);

    const log = screen.getByRole("log", { name: ui("conversation.messages.label") });
    expect(isAbove(log, box().closest(".agent-conversation-composer-area")!)).toBe(true);
  });

  it("has one header row of named icon buttons, the title and 'agent · folder', and no details list", async () => {
    await open(CONVERSATION_OPEN);

    const header = screen.getByRole("region", { name: ui("conversation.header.label") });
    expect(header.querySelector("dl")).toBeNull();
    const list = within(header).getByRole("button", { name: ui("conversation.header.list") });
    const fresh = within(header).getByRole("button", { name: ui("conversation.new") });
    for (const button of [list, fresh]) expect(button.querySelector("svg")).not.toBeNull();
    expect(header.querySelector(".agent-conversation-title")?.textContent).toBe(VIEW.title);
    expect(header.querySelector(".agent-conversation-subtitle")?.textContent).toContain(
      `Claude Code · ${ui("conversation.folder.scratch")}`,
    );
  });

  it("offers Stop alone while a turn runs, and Send (a submit) once it is idle", async () => {
    await open(CONVERSATION_OPEN);
    const submit = () => document.querySelector(".agent-conversation-composer button[type=submit]");
    expect(submit()).not.toBeNull();

    emitEvent(port, 1, { type: "state", state: "running" });
    expect(screen.getByRole("button", { name: ui("conversation.stop") })).toBeTruthy();
    expect(submit()).toBeNull();
    expect(screen.queryByRole("button", { name: ui("conversation.composer.send") })).toBeNull();

    emitEvent(port, 2, { type: "state", state: "idle" });
    expect(submit()).not.toBeNull();
    expect(screen.queryByRole("button", { name: ui("conversation.stop") })).toBeNull();
  });

  it.each(["running", "waiting-for-owner"] as const)("keeps the %s state line for screen readers only", async (state) => {
    await open(CONVERSATION_OPEN);
    emitEvent(port, 1, { type: "state", state });

    const line = document.querySelector(".agent-conversation-state")!;
    expect(line.textContent).toBe(ui(`conversation.state.${state}`));
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(line.classList.contains("agent-sr-only")).toBe(true);
  });

  it("keeps a stopped turn's line on screen", async () => {
    await open(CONVERSATION_OPEN);
    emitEvent(port, 1, { type: "state", state: "stopped" });
    expect(document.querySelector(".agent-conversation-state")?.classList.contains("agent-sr-only")).toBe(false);
  });

  it("gives each agent in the menu its own badge", async () => {
    await open();
    fireEvent.click(agentChip());
    const badges = [...document.querySelectorAll(".agent-conversation-agent-badge")];
    expect(badges.map((badge) => badge.textContent)).toEqual(["C", "X", "H", "D"]);
    for (const badge of badges) expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a drawer row's Remove as a named icon button", async () => {
    await open(CONVERSATION_OPEN);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
    const remove = screen.getByRole("button", { name: ui("conversation.list.remove").replace("{title}", VIEW.title) });
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove.getAttribute("title")).toBe(ui("conversation.list.removeShort"));
    expect(remove.querySelector(".agent-sr-only")).not.toBeNull();
  });

  it.each([
    ["en-US", "strict"],
    ["zh-TW", "strict"],
    ["en-US", "agent-review"],
    ["zh-TW", "agent-review"],
  ] as const)("in %s the %s mode chip shows its short label and keeps the full name", async (locale, mode) => {
    await open(CONVERSATION_READY, locale);
    const t = (key: string) => lookup(key, locale);
    const name = (m: string) => t("conversation.chip.mode").replace("{mode}", t(`conversation.mode.${m}`));
    if (mode !== "strict") {
      fireEvent.click(screen.getByRole("button", { name: name("strict") }));
      fireEvent.click(screen.getByRole("radio", { name: t(`conversation.mode.${mode}`) }));
    }

    const chip = screen.getByRole("button", { name: name(mode) });
    expect(chip.getAttribute("title")).toBe(name(mode));
    const short = chip.querySelector(".agent-conversation-chip-short")!;
    expect(short.textContent).toBe(t(`conversation.mode.short.${mode}`));
    expect(short.getAttribute("aria-hidden")).toBe("true");
    const full = chip.querySelector(".agent-conversation-chip-text")!;
    expect(full.textContent).toBe(t(`conversation.mode.${mode}`));
    expect(full.classList.contains("agent-sr-only")).toBe(true);
  });

  it("names the empty conversation in its header", async () => {
    await open();
    const header = screen.getByRole("region", { name: ui("conversation.header.label") });
    expect(header.querySelector(".agent-conversation-title")?.textContent).toBe(ui("conversation.new"));
    expect(within(header).getByRole("button", { name: ui("conversation.header.list") })).toBeTruthy();
  });
});

const FOUR_AGENTS = (
  accepts: { hermes?: { image: boolean; context: boolean }; deepseek?: { image: boolean; context: boolean } } = {},
): ConversationPanelState => ({
  ...CONVERSATION_READY,
  agents: [
    { agent: "claude-code", availability: "ready", version: "2.1.0" },
    { agent: "codex", availability: "ready", version: "0.50.0" },
    { agent: "hermes", availability: "ready", version: "0.22.2", ...(accepts.hermes === undefined ? {} : { accepts: accepts.hermes }) },
    { agent: "deepseek", availability: "ready", version: "0.2.1-rc.2", ...(accepts.deepseek === undefined ? {} : { accepts: accepts.deepseek }) },
  ],
});
const withHermesOrDeepSeek = (agent: "hermes" | "deepseek", mode: "strict" | "agent-review" = "strict", extra: Partial<ConversationView> = {}): ConversationPanelState => ({
  ...FOUR_AGENTS(),
  conversations: [{ ...VIEW, agent, mode, ...extra }],
  active: CONVERSATION_ID,
});

describe("T679 the mode menu for Hermes and DeepSeek (US3, D-021-5, D-021-8, FR-358)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
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
  const modeChipButton = () => document.querySelector<HTMLButtonElement>("button[data-chip=mode]")!;
  const menuText = () => document.querySelector(".agent-conversation-mode")?.textContent ?? "";

  it("tells a Hermes owner that automatic mode runs commands without a folder boundary", async () => {
    await open(withHermesOrDeepSeek("hermes"));
    fireEvent.click(modeChipButton());

    const reviewOption = document.querySelector('[data-mode="agent-review"]')!;
    expect(reviewOption.textContent).toContain("Hermes runs commands without a folder boundary");
    expect(document.querySelector('[data-mode="strict"]')?.textContent).not.toContain("folder boundary");
    // It is part of the radio's description, so a screen reader reads it with the choice.
    const radio = within(reviewOption as HTMLElement).getByRole("radio");
    const described = (radio.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.join(" ")).toContain("folder boundary");
  });

  // D-021-16: a started DeepSeek conversation offers no switch at all (below), so only Hermes restarts.
  it("tells a Hermes owner that switching the mode restarts the agent", async () => {
    await open(withHermesOrDeepSeek("hermes"));
    fireEvent.click(modeChipButton());
    expect(menuText()).toContain("Changing the mode restarts Hermes");
  });

  it("carries neither note for Claude Code or Codex", async () => {
    await open(CONVERSATION_OPEN);
    fireEvent.click(modeChipButton());
    expect(menuText()).not.toContain("restarts");
    expect(menuText()).not.toContain("folder boundary");
  });

  it("shows them on the empty conversation's chip for the agent chosen, in the panel's language", async () => {
    await open(FOUR_AGENTS(), "zh-TW");
    fireEvent.click(document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[2]!);
    fireEvent.click(modeChipButton());

    const text = menuText();
    expect(text).toContain(lookup("conversation.mode.hermesAutomaticNote", "zh-TW"));
    expect(text).toContain(lookup("conversation.mode.restartNote", "zh-TW").replace("{agent}", "Hermes"));
    expect(text).not.toContain("restarts");
    expect(text).not.toContain("folder boundary");
  });

  it("has no English left in zh-TW for any new key", () => {
    const keys = [
      "conversation.mode.hermesAutomaticNote",
      "conversation.mode.restartNote",
      "conversation.note.git-missing",
      "conversation.note.pre-release",
      "conversation.state.starting",
      "conversation.state.startingSlow",
      "conversation.state.cancelStart",
      "conversation.state.cancelStartLabel",
      "conversation.state.start-cancelled",
      "conversation.permission.rejectOnly",
      "conversation.noReplay",
      "conversation.firstUse.settings.hermes",
      "conversation.firstUse.settings.deepseek",
      "conversation.error.start-cancelled",
      "conversation.error.agent-model-unreachable",
      "conversation.hint.agent-model-unreachable.hermes",
      "conversation.hint.agent-model-unreachable.deepseek",
      "conversation.mode.fixedNote",
      "conversation.error.mode-fixed",
    ];
    for (const key of keys) {
      const en = lookup(key, "en-US");
      const zh = lookup(key, "zh-TW");
      expect(en, key).not.toBe(lookup("workspace.title", "en-US")); // the key exists
      expect(zh, key).not.toBe(en);
      expect(zh, key).toMatch(/[一-鿿]/u);
    }
  });
});

describe("D-021-16 DeepSeek's mode is fixed once its conversation has started (FR-360)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
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
  const modeChipButton = () => document.querySelector<HTMLButtonElement>("button[data-chip=mode]")!;
  const description = (chip: HTMLElement) =>
    (chip.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

  it("a started DeepSeek conversation's mode chip is unavailable, says why on screen, and opens nothing", async () => {
    await open(withHermesOrDeepSeek("deepseek", "agent-review"));
    const chip = modeChipButton();
    // Still reachable by keyboard, so a screen reader meets it and its reason.
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-label")).toBe(ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.agent-review")));
    const why = "DeepSeek keeps the mode it started with. To use another mode, start a new conversation.";
    expect(description(chip)).toBe(why);
    const line = [...document.querySelectorAll(".agent-conversation-note")].find((note) => note.textContent === why);
    expect(line).toBeDefined();
    expect(line?.classList.contains("agent-sr-only")).toBe(false);

    fireEvent.click(chip);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(commandsSent(port)).toEqual([]);
  });

  it("says why in zh-TW", async () => {
    await open(withHermesOrDeepSeek("deepseek"), "zh-TW");
    expect(description(modeChipButton())).toBe("DeepSeek 會沿用開始時的模式。要換模式，請開新對話。");
  });

  it("Claude Code and Hermes conversations keep a switchable chip", async () => {
    for (const conversation of [CONVERSATION_OPEN, withHermesOrDeepSeek("hermes")]) {
      await open(conversation);
      const chip = modeChipButton();
      expect(chip.hasAttribute("aria-disabled")).toBe(false);
      expect(document.body.textContent).not.toContain("keeps the mode it started with");
      fireEvent.click(chip);
      expect(screen.getByRole("radiogroup")).toBeTruthy();
      cleanup();
    }
  });

  it("before the start the DeepSeek chip offers the choice, with no restart note", async () => {
    await open(FOUR_AGENTS());
    fireEvent.click(document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[3]!);
    const chip = modeChipButton();
    expect(chip.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(chip);
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(document.querySelector(".agent-conversation-mode")?.textContent).not.toContain("restarts");
  });

  // FR-361: for every agent the mode chosen before the first message is the first start's, and the
  // open conversation shows it; nothing is switched beside the first message.
  it.each([
    [0, "claude-code"],
    [1, "codex"],
    [2, "hermes"],
    [3, "deepseek"],
  ] as const)("the empty conversation's mode goes with the start (%i: %s) and the opened conversation shows it", async (index, agent) => {
    await open(FOUR_AGENTS());
    fireEvent.click(document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[index]!);
    fireEvent.click(modeChipButton());
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));

    type("tidy the invoices");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent, folder: { kind: "scratch" }, mode: "agent-review" } }]);

    // What the broker reports for that start: listed in automatic, and its first mode event says so.
    project(
      port,
      withConversation({
        ...FOUR_AGENTS(),
        consent: "granted",
        conversations: [{ ...VIEW, conversationId: NEW_ID, agent, mode: "agent-review", title: "New" }],
        active: NEW_ID,
      }),
    );
    emitEvent(port, 1, { type: "mode", mode: "agent-review" }, NEW_ID);
    await settle();
    expect(commandsSent(port).slice(1)).toEqual([{ type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "tidy the invoices" } }]);
    expect(modeChipButton().getAttribute("aria-label")).toBe(ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.agent-review")));
    expectValidCommands(port);
  });

  // T701: the choice is that conversation's only - the next new conversation starts strict again.
  it("the next new conversation opened after an Agent review start is back on Ask first and starts strict", async () => {
    await open(FOUR_AGENTS());
    fireEvent.click(modeChipButton());
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));
    type("tidy the invoices");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" }, mode: "agent-review" } }]);
    project(
      port,
      withConversation({
        ...FOUR_AGENTS(),
        consent: "granted",
        conversations: [{ ...VIEW, conversationId: NEW_ID, mode: "agent-review", title: "New" }],
        active: NEW_ID,
      }),
    );
    await settle();
    expect(commandsSent(port)).toHaveLength(2);

    const header = screen.getByRole("region", { name: ui("conversation.header.label") });
    fireEvent.click(within(header).getByRole("button", { name: ui("conversation.new") }));
    expect(modeChipButton().getAttribute("aria-label")).toBe(ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")));
    fireEvent.click(document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[2]!);
    type("and the receipts");
    fireEvent.click(sendButton());
    expect(commandsSent(port).slice(2)).toEqual([{ type: "ui.conversation.start", payload: { agent: "hermes", folder: { kind: "scratch" } } }]);
  });

  it("keeps the choice while the owner changes agent and folder on the same unsent new conversation", async () => {
    await open({ ...FOUR_AGENTS(), folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] });
    fireEvent.click(modeChipButton());
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));
    fireEvent.click(document.querySelector<HTMLButtonElement>("button[data-chip=agent]")!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[3]!);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.folder").replace("{folder}", ui("conversation.folder.scratch")) }));
    fireEvent.click(screen.getByRole("radio", { name: "D:\\work\\shop" }));
    expect(modeChipButton().getAttribute("aria-label")).toBe(ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.agent-review")));
    type("go");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "deepseek", folder: { kind: "project", path: "D:\\work\\shop" }, mode: "agent-review" } },
    ]);
  });

  it("a strict start names no mode, as before", async () => {
    await open(FOUR_AGENTS());
    type("hello");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } }]);
  });
});

describe("T680 the + menu follows what Hermes and DeepSeek say they accept (US5, FR-356, D-022-6)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installStorage();
    const chromeGlobal = (globalThis as { chrome?: Record<string, unknown> }).chrome ?? {};
    chromeGlobal.tabs = {
      query: () => Promise.resolve([{ id: 7, url: "https://example.test/" }]),
      onActivated: { addListener: () => undefined, removeListener: () => undefined },
    };
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState) {
    renderShell();
    project(port, withConversation(conversation));
    await settle();
  }
  const plus = () => screen.getByRole("button", { name: ui("conversation.attach.button") });
  const entry = (key: string) => screen.getByRole("menuitem", { name: new RegExp(ui(key)) });
  const off = (key: string) => entry(key).getAttribute("aria-disabled") === "true";

  it("before the start, follows the descriptor's expectation for the agent on the chip", async () => {
    await open(FOUR_AGENTS({ hermes: { image: true, context: true }, deepseek: { image: false, context: false } }));

    fireEvent.click(agentChip());
    fireEvent.click(screen.getAllByRole("menuitemradio")[3]!);
    fireEvent.click(plus());
    expect(off("conversation.attach.screenshot")).toBe(true);
    expect(entry("conversation.attach.screenshot").textContent).toContain("DeepSeek does not take images. Files still work.");
    // 023 FR-365: no page context no longer greys the tab - the broker hands it over as a text file.
    expect(off("conversation.attach.tab")).toBe(false);
    expect(entry("conversation.attach.tab").textContent).not.toContain("does not take page text");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(agentChip());
    fireEvent.click(screen.getAllByRole("menuitemradio")[2]!);
    fireEvent.click(plus());
    expect(off("conversation.attach.screenshot")).toBe(false);
    expect(off("conversation.attach.tab")).toBe(false);
  });

  it("after the start, the value the running agent reported wins over the expectation", async () => {
    const conversation = (agent: "hermes" | "deepseek", accepts: { image: boolean; context: boolean }): ConversationPanelState => ({
      ...FOUR_AGENTS({ hermes: { image: true, context: true }, deepseek: { image: false, context: false } }),
      conversations: [{ ...VIEW, agent, accepts }],
      active: CONVERSATION_ID,
    });

    await open(conversation("hermes", { image: false, context: true }));
    fireEvent.click(plus());
    expect(off("conversation.attach.screenshot")).toBe(true);
    expect(entry("conversation.attach.screenshot").textContent).toContain("Hermes does not take images.");
    expect(off("conversation.attach.tab")).toBe(false);
    cleanup();

    await open(conversation("deepseek", { image: true, context: true }));
    fireEvent.click(plus());
    expect(off("conversation.attach.screenshot")).toBe(false);
    expect(off("conversation.attach.tab")).toBe(false);
  });
});
