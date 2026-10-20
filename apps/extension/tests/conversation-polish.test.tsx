import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import type { TurnActionGroup } from "../src/side-panel/agent/conversation/conversation-log.js";
import { TurnActions } from "../src/side-panel/agent/conversation/TurnActions.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_ID,
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  emitEvent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 020/T606 - the owner's review of the T605 shots: what the Conversation tab says and where, while
 * the first message is held, while a turn runs and while a card waits.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const header = () => document.querySelector<HTMLElement>(".agent-conversation-header")!;
const headerTitle = () => header().querySelector(".agent-conversation-title")?.textContent;
const log = () => document.querySelector<HTMLElement>(".agent-conversation-log")!;
const ask = (port: FakeAgentPort, seq: number, detail = "+3 lines") =>
  emitEvent(port, seq, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "edit", title: "Write table.csv", detail });

const NEEDS: ConversationPanelState = {
  ...CONVERSATION_READY,
  consent: "unknown",
  agents: [
    { agent: "claude-code", availability: "needs-install" },
    { agent: "codex", availability: "missing" },
  ],
};

describe("T606 the Conversation tab", () => {
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

  it("A1: offers the new-conversation button on the empty conversation too, where it puts the focus in the box", async () => {
    await open(CONVERSATION_READY);
    const fresh = within(header()).getByRole("button", { name: ui("conversation.new") });
    fresh.focus();
    fireEvent.click(fresh);
    expect(document.activeElement).toBe(box());
    expect(port.sent.filter((message) => (message as { type: string }).type !== "ui.conversation.resync")).toEqual([]);
  });

  it.each(["en-US", "zh-TW"] as const)("A2: in %s holds the first message as a faded bubble with an empty box, and Cancel gives it back", async (locale) => {
    await open(NEEDS, locale);
    const t = (key: string) => lookup(key, locale);
    fireEvent.change(box(), { target: { value: "what is on this page?" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);

    const held = document.querySelector(".agent-conversation-held")!;
    expect(held.querySelector("[data-message-role=owner]")?.textContent).toContain("what is on this page?");
    expect(held.textContent).toContain(t("conversation.held.hint"));
    expect(screen.queryByRole("region", { name: t("conversation.welcome.title") })).toBeNull();
    expect(box().value).toBe("");
    // The card still sits above the box.
    expect(screen.getByRole("region", { name: t("conversation.firstUse.title").replace("{agent}", "Claude Code") })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("conversation.firstUse.cancel") }));
    expect(document.querySelector(".agent-conversation-held")).toBeNull();
    expect(box().value).toBe("what is on this page?");
    expect(screen.getByRole("region", { name: t("conversation.welcome.title") })).toBeTruthy();
  });

  it("A2: gives the held words back when the install is cancelled", async () => {
    await open(NEEDS);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
    expect(document.querySelector(".agent-conversation-held")).not.toBeNull();
    expect(document.querySelector(".agent-conversation-held")?.textContent).not.toContain(ui("conversation.held.hint"));

    const commandId = (port.sent.at(-1) as { commandId: string }).commandId;
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId, ok: false, error: { code: "install-failed", detail: "npm said no" } } });
    });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.cancel") }));
    expect(box().value).toBe("hello");
  });

  it.each(["en-US", "zh-TW"] as const)("A3: in %s the box asks for the answer above while a card waits", async (locale) => {
    await open(CONVERSATION_OPEN, locale);
    const t = (key: string) => lookup(key, locale);
    const name = t("conversation.composer.label").replace("{agent}", "Claude Code");
    expect(box().placeholder).toBe(name);
    ask(port, 1);
    expect(box().placeholder).toBe(t("conversation.composer.waiting"));
    expect(box().getAttribute("aria-label")).toBe(name);
  });

  it.each(["en-US", "zh-TW"] as const)("C1: in %s titles the first turn with the owner's first message until the broker names it", async (locale) => {
    await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, title: "New conversation" }] }, locale);
    expect(headerTitle()).toBe(lookup("conversation.new", locale));

    emitEvent(port, 1, { type: "text", role: "owner", text: "  fix the\n  checkout tests  " });
    expect(headerTitle()).toBe("fix the checkout tests");

    project(port, withConversation({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, title: "Checkout tests" }] }));
    expect(headerTitle()).toBe("Checkout tests");
  });

  it("C2: keeps the live line last, below the reply that is still streaming", async () => {
    await open(CONVERSATION_OPEN);
    emitEvent(port, 1, { type: "state", state: "running" });
    emitEvent(port, 2, { type: "text", role: "owner", text: "walk me through it" });
    emitEvent(port, 3, { type: "tool", toolCallId: "a", kind: "read", title: "Read cart.ts", inputSummary: "", status: "running" });
    emitEvent(port, 4, { type: "text", role: "agent", text: "The cart is three layers" });

    const last = log().lastElementChild!;
    expect(last.querySelector(".agent-conversation-live") ?? (last.matches(".agent-conversation-live") ? last : null)).not.toBeNull();
    expect(last.textContent).toContain(ui("conversation.turn.live").replace("{title}", "Read cart.ts"));
    expect(log().querySelectorAll(".agent-conversation-live")).toHaveLength(1);
  });

  it.each(["en-US", "zh-TW"] as const)("C3: in %s the live line says what waits for the owner, with a warning mark", async (locale) => {
    await open(CONVERSATION_OPEN, locale);
    emitEvent(port, 1, { type: "state", state: "running" });
    emitEvent(port, 2, { type: "text", role: "owner", text: "tidy up" });
    emitEvent(port, 3, { type: "tool", toolCallId: "t-9", kind: "edit", title: "Edit app.ts", inputSummary: "", status: "pending" });
    emitEvent(port, 4, { type: "state", state: "waiting-for-owner" });
    ask(port, 5);

    const live = log().querySelector(".agent-conversation-live")!;
    expect(live.hasAttribute("data-waiting")).toBe(true);
    expect(live.textContent).toBe(lookup("conversation.turn.waiting", locale).replace("{title}", "Write table.csv"));
    expect(live.querySelector("svg")).not.toBeNull();
    expect(log().lastElementChild?.contains(live)).toBe(true);
  });

  it("C3: the live line has the spinner while an action runs and only the warning mark while a permission waits", async () => {
    await open(CONVERSATION_OPEN);
    emitEvent(port, 1, { type: "state", state: "running" });
    emitEvent(port, 2, { type: "text", role: "owner", text: "tidy up" });
    emitEvent(port, 3, { type: "tool", toolCallId: "t-9", kind: "edit", title: "Edit app.ts", inputSummary: "", status: "running" });
    const running = log().querySelector(".agent-conversation-live")!;
    expect(running.querySelector(".agent-conversation-spinner")).not.toBeNull();
    expect(running.querySelector("svg")).toBeNull();

    emitEvent(port, 4, { type: "state", state: "waiting-for-owner" });
    ask(port, 5);
    const waiting = log().querySelector(".agent-conversation-live")!;
    expect(waiting.hasAttribute("data-waiting")).toBe(true);
    expect(waiting.querySelector(".agent-conversation-spinner")).toBeNull();
    expect(waiting.querySelectorAll("svg")).toHaveLength(1);
  });

  it.each(["en-US", "zh-TW"] as const)("H3: in %s the broker's stopped and failed notices are said in the panel's own words", async (locale) => {
    await open(CONVERSATION_OPEN, locale);
    emitEvent(port, 1, { type: "notice", code: "turn-stopped", text: "Stopped. Nothing more from that turn will run." });
    emitEvent(port, 2, { type: "notice", code: "turn-failed", text: "The agent's turn failed: spawn EPERM" });
    emitEvent(port, 3, { type: "notice", code: "something-new", text: "The broker's own sentence" });

    const notices = [...log().querySelectorAll<HTMLElement>(".agent-conversation-notice")];
    expect(notices.map((notice) => notice.getAttribute("data-notice-code"))).toEqual(["turn-stopped", "turn-failed", "something-new"]);
    expect(notices[0]?.textContent).toBe(lookup("conversation.state.stopped", locale));
    expect(notices[1]?.querySelector("p:not(.agent-conversation-detail)")?.textContent).toBe(lookup("conversation.notice.turn-failed", locale));
    expect(notices[1]?.querySelector(".agent-conversation-detail")?.textContent).toBe("spawn EPERM");
    expect(notices[2]?.textContent).toBe("The broker's own sentence");
  });

  it("C5: shows no detail box that only repeats the title, and leads with allow once, then for this conversation, then reject", async () => {
    await open(CONVERSATION_OPEN);
    ask(port, 1, "table.csv");
    const card = screen.getByRole("group", { name: /Write table\.csv/ });
    expect(card.querySelector(".agent-conversation-permission-detail")).toBeNull();
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.allow-conversation"),
      ui("conversation.permission.reject"),
    ]);
  });

  it("C5: keeps a detail that adds something", async () => {
    await open(CONVERSATION_OPEN);
    ask(port, 1, "+ ## Install\n+ 1. npm install");
    expect(document.querySelector(".agent-conversation-permission-detail")?.textContent).toContain("npm install");
  });

  it("C7: Copy is a named icon button that says Copied to a screen reader", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
    try {
      await open(CONVERSATION_OPEN);
      emitEvent(port, 1, { type: "text", role: "agent", text: "done" });
      const copy = screen.getByRole("button", { name: ui("conversation.reply.copyLabel") });
      expect(copy.querySelector("svg")).not.toBeNull();
      await act(async () => {
        fireEvent.click(copy);
        await Promise.resolve();
      });
      const status = log().querySelector(".agent-reply-copied[role=status]")!;
      expect(status.textContent).toBe(ui("conversation.reply.copied"));
      expect(status.classList.contains("agent-sr-only")).toBe(true);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it.each(["en-US", "zh-TW"] as const)("C8: in %s says which ready agent was used last", async (locale) => {
    installTabStorage("codex");
    await open(CONVERSATION_READY, locale);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-chip=agent]")!);
    const items = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    expect(items[0]?.querySelector(".agent-conversation-availability")?.textContent).toBe(lookup("conversation.availability.ready", locale));
    expect(items[1]?.querySelector(".agent-conversation-availability")?.textContent).toBe(
      lookup("conversation.availability.readyLastUsed", locale),
    );
  });

  it("C9: marks each drawer row with its agent's badge and the open conversation as current", async () => {
    const other = { ...VIEW, conversationId: "conv-fedcba9876543210", agent: "codex" as const, title: "Other" };
    await open({ ...CONVERSATION_OPEN, conversations: [VIEW, other] });
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));

    const row = (id: string) => document.querySelector(`li[data-conversation-id="${id}"]`)!;
    expect(row(CONVERSATION_ID).querySelector(".agent-conversation-agent-badge")?.textContent).toBe("C");
    expect(row("conv-fedcba9876543210").querySelector(".agent-conversation-agent-badge")?.textContent).toBe("X");
    expect(row("conv-fedcba9876543210").querySelector(".agent-conversation-agent-badge")?.getAttribute("aria-hidden")).toBe("true");
    expect(row(CONVERSATION_ID).querySelector(".agent-conversation-entry")?.getAttribute("aria-current")).toBe("true");
    expect(row("conv-fedcba9876543210").querySelector(".agent-conversation-entry")?.hasAttribute("aria-current")).toBe(false);
  });

  it("C10: a press on the popup's own padding leaves the menu open", async () => {
    await open(CONVERSATION_READY);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-chip=agent]")!);
    fireEvent.pointerDown(document.querySelector(".agent-conversation-popup")!);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-chip=mode]")!);
    fireEvent.pointerDown(document.querySelector(".agent-conversation-popup")!);
    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });
});

describe("T606 C4 backticks in step titles", () => {
  const t = (key: string): string => lookup(key, "en-US");
  type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;
  const tool = (title: string, status: ToolEvent["status"]): ToolEvent => ({ type: "tool", toolCallId: title, kind: "execute", title, inputSummary: "", status });
  const group = (parts: Partial<TurnActionGroup>): TurnActionGroup => ({ kind: "turn-actions", key: "k", running: false, steps: [], problems: [], ...parts });

  afterEach(cleanup);

  it("shows a backtick span as inline code, in a failed step and in the steps list", () => {
    const run = tool("Run `npm test -- checkout`", "failed");
    const read = tool("Read `src/a.ts` and `src/b.ts`", "done");
    render(<TurnActions group={group({ steps: [read], problems: [run] })} t={t} />);

    const problem = screen.getByRole("list", { name: t("conversation.turn.problems") }).querySelector(".agent-conversation-action-title")!;
    expect(problem.textContent).toBe("Run npm test -- checkout");
    expect(problem.querySelector("code")?.textContent).toBe("npm test -- checkout");

    fireEvent.click(screen.getByRole("button", { name: t("conversation.turn.step") }));
    const title = screen.getByRole("list", { name: t("conversation.actions.label") }).querySelector(".agent-conversation-action-title")!;
    expect([...title.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("leaves an unpaired backtick as written and never reads markup", () => {
    render(<TurnActions group={group({ problems: [tool("Run `rm <b>x</b>", "failed")] })} t={t} />);
    const title = document.querySelector(".agent-conversation-action-title")!;
    expect(title.textContent).toBe("Run `rm <b>x</b>");
    expect(title.querySelector("code, b")).toBeNull();
  });

  it("shows inline code in the live line too", () => {
    const live = tool("Run `npm test`", "running");
    render(<TurnActions group={group({ running: true, steps: [live], live })} t={t} />);
    expect(document.querySelector(".agent-conversation-live code")?.textContent).toBe("npm test");
  });
});

describe("T606 C6 the radios' colour", () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8");

  it("draws every radio in the accent and the agent's own review in the warning colour", () => {
    expect(css).toMatch(/\.agent-shell input\[type="radio"\][^{]*\{[^}]*accent-color:\s*var\(--accent\)/);
    expect(css).toMatch(/\.agent-conversation-mode-option\[data-mode="agent-review"\][^{]*\{[^}]*color:\s*var\(--warn\)/);
  });
});
