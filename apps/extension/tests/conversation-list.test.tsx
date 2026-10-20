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
 * 019/T563 - the list of conversations and the folder chooser (US5, US6, FR-303, FR-304).
 *
 * The panel holds neither list: both are the worker's `conversation` projection, and every press
 * leaves as one `ui.conversation.*` command (checked against the panel command schema). The removal
 * copy is part of the contract here: it must never say the agent's own record is deleted.
 *
 * 020/T598 (FR-321): the list lives in the header's drawer now; the drawer's own behaviour (groups,
 * search, focus) is in conversation-drawer.test.tsx.
 */

const OTHER_ID = "conv-aaaaaaaaaaaaaaaa";
const THIRD_ID = "conv-bbbbbbbbbbbbbbbb";

const view = (patch: Partial<ConversationView>): ConversationView => ({ ...VIEW, ...patch });
const LISTED: ConversationPanelState = {
  ...CONVERSATION_READY,
  conversations: [
    view({ title: "Oldest chat", lastUsedAt: "2026-10-17T00:00:00.000Z" }),
    view({
      conversationId: OTHER_ID,
      title: "Newest chat",
      agent: "codex",
      folder: { kind: "project", path: "D:\\work\\shop" },
      lastUsedAt: "2026-10-19T09:00:00.000Z",
    }),
    view({ conversationId: THIRD_ID, title: "Middle chat", lastUsedAt: "2026-10-18T00:00:00.000Z" }),
  ],
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const result = (port: FakeAgentPort, payload: Record<string, unknown>) =>
  act(() => {
    port.emit({ type: "conversation-result", payload });
  });
const expectValidCommands = (port: FakeAgentPort) => {
  for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
};
/** 020 FR-321: the list is the drawer the header's list button opens. */
const list = () => {
  if (screen.queryByRole("dialog") === null) fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
  return screen.getByRole("dialog", { name: ui("conversation.list.label") });
};
const folderPicker = () => screen.getByRole("region", { name: ui("conversation.folders.label") });
/** 020 FR-312: the folder chooser opens from the folder chip under the message box. */
const folderChip = () => screen.getByRole("button", { name: /^Folder: / });
const composeAndSend = (words = "hello") => {
  fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: words } });
  fireEvent.click(screen.getByRole("button", { name: ui("conversation.composer.send") }));
};

describe("T563 the list of conversations", () => {
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

  it("lists title, agent and folder, newest use first", async () => {
    await open(LISTED);

    const rows = within(list()).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-conversation-id"))).toEqual([OTHER_ID, THIRD_ID, CONVERSATION_ID]);
    expect(rows[0]?.textContent).toContain("Newest chat");
    expect(rows[0]?.textContent).toContain("Codex");
    // T607 (G2): the folder's name; the whole path is its title.
    expect(rows[0]?.querySelector(".agent-conversation-folder")?.textContent).toBe("shop");
    expect(rows[0]?.querySelector(".agent-conversation-folder")?.getAttribute("title")).toBe("D:\\work\\shop");
    expect(rows[1]?.textContent).toContain("Claude Code");
    expect(rows[1]?.textContent).toContain(ui("conversation.folder.scratch"));
  });

  it("shows no list while there is nothing to list", async () => {
    await open(CONVERSATION_READY);
    expect(screen.queryByRole("list")).toBeNull();
    expect(within(list()).queryByRole("listitem")).toBeNull();
    expect(within(list()).getByText(ui("conversation.drawer.empty"))).toBeTruthy();
  });

  it("opens an entry on a click", async () => {
    await open(LISTED);

    fireEvent.click(within(list()).getByRole("button", { name: /^Middle chat/ }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.open", payload: { conversationId: THIRD_ID } }]);
    expectValidCommands(port);
  });

  it("removes only the entry, and says the agent's own record stays", async () => {
    await open(LISTED);
    expect(within(list()).getByText(ui("conversation.list.removeNote"))).toBeTruthy();
    expect(ui("conversation.list.removeNote").toLowerCase()).not.toMatch(/delet/);

    fireEvent.click(within(list()).getByRole("button", { name: ui("conversation.list.remove").replace("{title}", "Newest chat") }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.remove", payload: { conversationId: OTHER_ID } }]);
    expectValidCommands(port);
  });

  it("labels an entry the agent can no longer continue, and one running in another browser", async () => {
    await open({
      ...LISTED,
      conversations: [
        view({ title: "Gone chat", resumable: false }),
        view({ conversationId: OTHER_ID, title: "Busy chat", inUseElsewhere: true }),
        view({ conversationId: THIRD_ID, title: "Plain chat" }),
      ],
    });

    const row = (title: string) => within(list()).getByText(title).closest("li")!;
    expect(row("Gone chat").textContent).toContain(ui("conversation.list.cannotContinue"));
    expect(row("Gone chat").textContent).not.toContain(ui("conversation.list.inUseElsewhere"));
    expect(row("Busy chat").textContent).toContain(ui("conversation.list.inUseElsewhere"));
    expect(row("Plain chat").textContent).not.toContain(ui("conversation.list.cannotContinue"));
    expect(row("Plain chat").textContent).not.toContain(ui("conversation.list.inUseElsewhere"));
  });

  it("says in the owner's words that the list could not be read, without blocking the message box", async () => {
    await open({ ...CONVERSATION_READY, notice: "index-unreadable" });

    expect(screen.getByRole("status", { name: ui("conversation.list.label") }).textContent).toContain(
      ui("conversation.list.notice.index-unreadable"),
    );
    expect(screen.getByRole("textbox", { name: ui("conversation.composer.label").replace("{agent}", "Claude Code") })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Agent: Claude Code/ })).toBeTruthy();
  });

  it("reads in zh-TW", async () => {
    await open({ ...LISTED, conversations: [view({ title: "舊對話", resumable: false })], notice: "index-unreadable" }, "zh-TW");

    fireEvent.click(screen.getByRole("button", { name: "查看對話清單" }));
    expect(screen.getByRole("dialog", { name: "對話清單" })).toBeTruthy();
    expect(screen.getByText("這個對話已無法繼續")).toBeTruthy();
    expect(screen.getByRole("button", { name: "從清單移除「舊對話」" })).toBeTruthy();
  });

  it("is reachable from an open conversation, which keeps its folder", async () => {
    await open({ ...LISTED, active: CONVERSATION_ID });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);

    // 020 FR-321: the drawer closes over the conversation, which stayed open behind it.
    fireEvent.click(within(list()).getByRole("button", { name: ui("conversation.drawer.close") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: ui("conversation.header.label") })).toBeTruthy();
    expect(commandsSent(port)).toEqual([]);
  });

  it("offers a new conversation in another folder from an open conversation", async () => {
    await open({ ...CONVERSATION_OPEN, folders: [{ path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" }] });

    // 020 FR-315: a new conversation, then its folder chip.
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.new") }));
    fireEvent.click(folderChip());

    expect(folderPicker()).toBeTruthy();
    expect(screen.getByRole("radio", { name: "D:\\work\\shop" })).toBeTruthy();
  });
});

describe("T563 the folder chooser", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  const FOLDERS = [
    { path: "D:\\work\\shop", addedAt: "2026-10-18T00:00:00.000Z" },
    { path: "D:\\work\\blog", addedAt: "2026-10-18T01:00:00.000Z" },
  ];

  async function openChooser(conversation: ConversationPanelState = { ...LISTED, folders: FOLDERS }) {
    renderShell();
    project(port, withConversation(conversation));
    await settle();
    fireEvent.click(folderChip());
  }

  it("offers the scratch folder, chosen by default, and the owner's folders", async () => {
    await openChooser();

    const radios = within(folderPicker()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.getAttribute("aria-label") ?? radio.labels?.[0]?.textContent)).toEqual([
      ui("conversation.folders.scratch"),
      "D:\\work\\shop",
      "D:\\work\\blog",
    ]);
    expect(radios[0]?.checked).toBe(true);
  });

  it("starts a conversation in the scratch folder by default", async () => {
    await openChooser();
    composeAndSend();
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } }]);
  });

  it("starts a conversation in a listed folder once chosen, and the chip says which", async () => {
    await openChooser();
    fireEvent.click(screen.getByRole("radio", { name: "D:\\work\\blog" }));
    expect(screen.getByRole("button", { name: ui("conversation.chip.folder").replace("{folder}", "blog") })).toBeTruthy();

    composeAndSend();
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "project", path: "D:\\work\\blog" } } },
    ]);
    expectValidCommands(port);
  });

  it("falls back to the scratch folder when the chosen folder is removed", async () => {
    await openChooser();
    fireEvent.click(screen.getByRole("radio", { name: "D:\\work\\blog" }));

    fireEvent.click(screen.getByRole("button", { name: ui("conversation.folders.remove").replace("{path}", "D:\\work\\blog") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.remove-folder", payload: { path: "D:\\work\\blog" } }]);
    expectValidCommands(port);

    // The worker drops it from the list; the choice goes with it.
    project(port, withConversation({ ...LISTED, folders: [FOLDERS[0]!] }));
    composeAndSend();
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
  });

  it("asks the broker to open its folder dialog for Add folder", async () => {
    await openChooser();

    fireEvent.click(within(folderPicker()).getByRole("button", { name: ui("conversation.folders.add") }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.add-folder", payload: {} }]);
    expectValidCommands(port);
    expect(screen.queryByRole("textbox", { name: ui("conversation.folders.pathLabel") })).toBeNull();
  });

  it("offers a typed path when the dialog cannot open, and sends it as the owner's answer", async () => {
    await openChooser();
    fireEvent.click(within(folderPicker()).getByRole("button", { name: ui("conversation.folders.add") }));
    result(port, { commandId: lastCommandId(port), ok: false, error: { code: "path-entry", detail: "No desktop here." } });

    expect(screen.getByText(ui("conversation.error.path-entry"))).toBeTruthy();
    const field = screen.getByRole("textbox", { name: ui("conversation.folders.pathLabel") });
    fireEvent.change(field, { target: { value: "  D:\\work\\typed  " } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.folders.addTyped") }));

    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.add-folder", payload: { path: "D:\\work\\typed" } });
    expectValidCommands(port);
  });

  it("keeps the typed field for a refused path, shows why, and drops it once a folder is added", async () => {
    await openChooser();
    fireEvent.click(within(folderPicker()).getByRole("button", { name: ui("conversation.folders.add") }));
    result(port, { commandId: lastCommandId(port), ok: false, error: { code: "path-entry", detail: "No desktop here." } });
    fireEvent.change(screen.getByRole("textbox", { name: ui("conversation.folders.pathLabel") }), { target: { value: "D:\\nope" } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.folders.addTyped") }));

    result(port, { commandId: lastCommandId(port), ok: false, error: { code: "folder-missing", detail: "D:\\nope is not a folder." } });
    expect(screen.getByText("D:\\nope is not a folder.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: ui("conversation.folders.pathLabel") })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: ui("conversation.folders.pathLabel") }), { target: { value: "D:\\work\\typed" } });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.folders.addTyped") }));
    result(port, { commandId: lastCommandId(port), ok: true });
    expect(screen.queryByRole("textbox", { name: ui("conversation.folders.pathLabel") })).toBeNull();
  });

  it("shows the broker's reason for any other refusal of the dialog", async () => {
    await openChooser();
    fireEvent.click(within(folderPicker()).getByRole("button", { name: ui("conversation.folders.add") }));
    result(port, { commandId: lastCommandId(port), ok: false, error: { code: "broker-unavailable", detail: "Helper stopped." } });

    expect(screen.getByText("Helper stopped.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: ui("conversation.folders.pathLabel") })).toBeNull();
  });

  it("reads in zh-TW", async () => {
    renderShell("zh-TW");
    project(port, withConversation({ ...LISTED, folders: FOLDERS }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "資料夾：暫存資料夾" }));

    expect(screen.getByRole("region", { name: "新對話的資料夾" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "暫存資料夾（預設）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新增資料夾…" })).toBeTruthy();
  });
});
