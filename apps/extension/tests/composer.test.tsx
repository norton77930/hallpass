import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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

const LAST_AGENT_KEY = "conversationLastAgent";

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

  it("opens with the message box focused and the agent used last on the chip (scenario 1)", async () => {
    storage.items[LAST_AGENT_KEY] = "codex";
    await open();

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

  it("falls back to the only ready agent when none was used before (scenario 2)", async () => {
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "needs-install" }, { agent: "codex", availability: "ready" }] });
    expect(agentChip().textContent).toContain("Codex");
  });

  it("falls back to the first supported agent when none is ready, and when storage fails", async () => {
    storage.failGet = true;
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "needs-install" }, { agent: "codex", availability: "missing" }] });
    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("does not keep a last-used agent that is no longer ready", async () => {
    storage.items[LAST_AGENT_KEY] = "codex";
    await open({ ...CONVERSATION_READY, agents: [{ agent: "claude-code", availability: "ready" }, { agent: "codex", availability: "missing" }] });
    expect(agentChip().textContent).toContain("Claude Code");
  });

  it("starts in the scratch folder on Enter, remembers the agent, and sends the typed words once it is open", async () => {
    await open();
    type("summarise this page");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
    ]);
    expect(storage.writes).toContainEqual({ [LAST_AGENT_KEY]: "claude-code" });
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

  it("starts in the folder chosen on the folder chip, and applies the mode chosen on the mode chip once open", async () => {
    await open({ ...CONVERSATION_READY, folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.folder").replace("{folder}", ui("conversation.folder.scratch")) }));
    fireEvent.click(screen.getByRole("radio", { name: "D:\\work\\shop" }));
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.chip.mode").replace("{mode}", ui("conversation.mode.strict")) }));
    fireEvent.click(screen.getByRole("radio", { name: ui("conversation.mode.agent-review") }));
    expect(commandsSent(port)).toEqual([]);

    type("fix the tests");
    fireEvent.click(sendButton());
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "project", path: "D:\\work\\shop" } } },
    ]);

    project(port, withConversation(opened({ ...CONVERSATION_READY, folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] })));
    expect(commandsSent(port).slice(1)).toEqual([
      { type: "ui.conversation.set-mode", payload: { conversationId: NEW_ID, mode: "agent-review" } },
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

  const NEEDS: ConversationPanelState = {
    ...CONVERSATION_READY,
    consent: "unknown",
    agents: [
      { agent: "claude-code", availability: "needs-install" },
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

  it("one Download fetches the connector, starts, and sends the held message", async () => {
    await open();
    type("what is on this page?");
    fireEvent.click(sendButton());
    fireEvent.click(within(firstUse()).getByRole("button", { name: ui("conversation.firstUse.download") }));
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.consent", payload: { granted: true } },
      { type: "ui.conversation.install", payload: { agent: "claude-code" } },
    ]);

    const ready: ConversationPanelState = { ...NEEDS, consent: "granted", agents: [{ agent: "claude-code", availability: "ready" }, NEEDS.agents[1]!] };
    project(port, withConversation(ready));
    expect(commandsSent(port).slice(2)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } },
    ]);
    project(port, withConversation(opened(ready)));
    expect(commandsSent(port).slice(3)).toEqual([
      { type: "ui.conversation.send", payload: { conversationId: NEW_ID, text: "what is on this page?" } },
    ]);
    expectValidCommands(port);
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

  it("lists every supported agent with its state, and install guidance for one not installed", async () => {
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
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Claude Code");
    expect(items[0]?.textContent).toContain(ui("conversation.availability.version-problem"));
    expect(items[0]?.textContent).toContain(ui("conversation.version.installed").replace("{version}", "1.0.0"));
    expect(items[0]?.textContent).toContain("needs 2.x");
    expect(items[1]?.textContent).toContain(ui("conversation.availability.missing"));
    expect(items[1]?.textContent).toContain(ui("conversation.missing.codex"));

    fireEvent.click(items[1]!);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(agentChip().textContent).toContain("Codex");
    // A not-installed agent cannot be sent to; its guidance stays on screen.
    type("hello");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(ui("conversation.missing.codex"))).toBeTruthy();
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
    expect(items[1]?.textContent).toContain(ui("conversation.availability.needs-install"));

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
    expect(badges.map((badge) => badge.textContent)).toEqual(["C", "X"]);
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
