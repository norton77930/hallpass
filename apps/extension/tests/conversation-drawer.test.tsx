import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  commandsSent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 020/T598 - the header's list and new-conversation buttons, and the drawer of conversations
 * (US5, FR-321). The drawer opens over the conversation as a modal dialog, groups the owner's
 * conversations by last use (Today, Last 7 days, Earlier), filters them by title, and gives the
 * focus back where the owner expects it: the list button on Escape, the message box after a choice.
 */

const NOW = new Date(2026, 9, 20, 9, 30);
const local = (day: number, hour = 8) => new Date(2026, 9, day, hour).toISOString();
const view = (patch: Partial<ConversationView>): ConversationView => ({ ...VIEW, ...patch });
const FOUR: ConversationPanelState = {
  ...CONVERSATION_OPEN,
  conversations: [
    view({ title: "Summarise this table", lastUsedAt: local(20, 9) }),
    view({ conversationId: "conv-aaaaaaaaaaaaaaaa", title: "Fix the Checkout page", agent: "codex", lastUsedAt: local(20, 8) }),
    view({ conversationId: "conv-bbbbbbbbbbbbbbbb", title: "Morning notes", lastUsedAt: local(20, 1) }),
    view({
      conversationId: "conv-cccccccccccccccc",
      title: "Last week's checkout bug",
      folder: { kind: "project", path: "D:\\work\\shop" },
      lastUsedAt: local(15),
    }),
  ],
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const listButton = () => screen.getByRole("button", { name: ui("conversation.header.list") });
const drawer = () => screen.getByRole("dialog", { name: ui("conversation.list.label") });
const search = () => within(drawer()).getByRole("searchbox", { name: ui("conversation.drawer.search") });
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const rowIds = () =>
  [...drawer().querySelectorAll(".agent-conversation-entries li")].map((row) => row.getAttribute("data-conversation-id"));

describe("T598 the header and the conversation drawer", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
    vi.useRealTimers();
  });

  async function open(conversation: ConversationPanelState = FOUR, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("holds a list button and a new-conversation button, and no longer repeats the mode as text", async () => {
    await open();
    const header = screen.getByRole("region", { name: ui("conversation.header.label") });
    expect(within(header).getByRole("button", { name: ui("conversation.header.list") })).toBe(listButton());
    expect(within(header).getByRole("button", { name: ui("conversation.new") })).toBeTruthy();
    expect(header.textContent).not.toContain(ui("conversation.mode.strict"));
    expect(listButton().getAttribute("aria-haspopup")).toBe("dialog");
    expect(listButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a labelled modal dialog with the focus on its search", async () => {
    await open();
    fireEvent.click(listButton());

    expect(drawer().getAttribute("aria-modal")).toBe("true");
    expect(listButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search());
  });

  it("groups by last use: three from today and one from last week make two groups", async () => {
    await open();
    fireEvent.click(listButton());

    const groups = within(drawer()).getAllByRole("list");
    expect(groups.map((group) => group.getAttribute("aria-label") ?? group.getAttribute("aria-labelledby"))).toHaveLength(2);
    expect(within(drawer()).getByRole("list", { name: ui("conversation.group.today") })).toBeTruthy();
    expect(within(drawer()).getByRole("list", { name: ui("conversation.group.week") })).toBeTruthy();
    expect(within(drawer()).queryByRole("list", { name: ui("conversation.group.earlier") })).toBeNull();
    expect(rowIds()).toEqual([CONVERSATION_ID, "conv-aaaaaaaaaaaaaaaa", "conv-bbbbbbbbbbbbbbbb", "conv-cccccccccccccccc"]);

    const lastWeek = drawer().querySelector("li[data-conversation-id='conv-cccccccccccccccc']")!;
    expect(lastWeek.textContent).toContain("Claude Code");
    expect(lastWeek.textContent).toContain("Last week's checkout bug");
    // T607 (G2): the folder's name; the whole path is its title.
    expect(lastWeek.querySelector(".agent-conversation-folder")?.textContent).toBe("shop");
    expect(lastWeek.querySelector(".agent-conversation-folder")?.getAttribute("title")).toBe("D:\\work\\shop");
    expect(lastWeek.querySelector("time")?.getAttribute("dateTime")).toBe(local(15));
  });

  it("filters by part of the title, case ignored, and says when nothing matches", async () => {
    await open();
    fireEvent.click(listButton());

    fireEvent.change(search(), { target: { value: "CHECKOUT" } });
    expect(rowIds()).toEqual(["conv-aaaaaaaaaaaaaaaa", "conv-cccccccccccccccc"]);

    fireEvent.change(search(), { target: { value: "nothing like this" } });
    expect(rowIds()).toEqual([]);
    expect(within(drawer()).getByRole("status").textContent).toBe(
      ui("conversation.drawer.noMatch").replace("{query}", "nothing like this"),
    );
  });

  it("closes on Escape and gives the focus back to the list button", async () => {
    await open();
    fireEvent.click(listButton());
    fireEvent.keyDown(search(), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(listButton());
    expect(listButton().getAttribute("aria-expanded")).toBe("false");
    expect(commandsSent(port)).toEqual([]);
  });

  it("closes from its Close button too, with the focus on the list button", async () => {
    await open();
    fireEvent.click(listButton());
    fireEvent.click(within(drawer()).getByRole("button", { name: ui("conversation.drawer.close") }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(listButton());
  });

  it("opens a chosen row, closes, and puts the focus in the message box", async () => {
    await open();
    fireEvent.click(listButton());
    fireEvent.click(within(drawer()).getByRole("button", { name: /^Fix the Checkout page/ }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.open", payload: { conversationId: "conv-aaaaaaaaaaaaaaaa" } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it("goes back to the open conversation without a command when its own row is chosen", async () => {
    await open();
    fireEvent.click(listButton());
    fireEvent.click(within(drawer()).getByRole("button", { name: /^Summarise this table/ }));

    expect(commandsSent(port)).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: ui("conversation.header.label") })).toBeTruthy();
    expect(document.activeElement).toBe(box());
  });

  it("keeps Tab inside the drawer and leaves the conversation behind it inert", async () => {
    await open();
    fireEvent.click(listButton());
    const inside = [...drawer().querySelectorAll<HTMLElement>("button, input")];
    const first = inside[0]!;
    const last = inside.at(-1)!;

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    expect(document.querySelector("[data-conversation-id]:not(li)")?.hasAttribute("inert")).toBe(true);
  });

  it("is in the empty conversation's header too, and says when there is nothing to list", async () => {
    await open(CONVERSATION_READY);
    // T606 (A1): the new-conversation button is there too (it puts the focus in the box).
    expect(screen.getByRole("button", { name: ui("conversation.new") })).toBeTruthy();
    fireEvent.click(listButton());

    expect(within(drawer()).getByText(ui("conversation.drawer.empty"))).toBeTruthy();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(document.activeElement).toBe(listButton());
  });

  it("reads in zh-TW", async () => {
    await open(FOUR, "zh-TW");
    const zh = (key: string) => lookup(key, "zh-TW");
    fireEvent.click(screen.getByRole("button", { name: zh("conversation.header.list") }));

    expect(screen.getByRole("dialog", { name: zh("conversation.list.label") })).toBeTruthy();
    expect(screen.getByRole("list", { name: zh("conversation.group.today") })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: zh("conversation.drawer.search") })).toBeTruthy();
    expect(zh("conversation.group.today")).not.toBe(ui("conversation.group.today"));
  });
});
