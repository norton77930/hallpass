import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import { PermissionCard, permissionAnswers } from "../src/side-panel/agent/conversation/PermissionCard.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";
import { lookup } from "../src/locales/catalog.js";

/**
 * 021/T673 - a permission card for an action nobody described (US2 scenario 4, FR-353, D-021-10).
 *
 * DeepSeek's question names only an action id. When neither the request nor the action it announced
 * says what the action is, the broker marks the card `rejectOnly`: the card says the action is
 * unknown and offers Reject alone - no "Allow once", no "Allow for this conversation".
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const UNKNOWN = { type: "permission", requestId: "r-u", toolCallId: "t-u", kind: "other", title: "Unknown action", detail: "", rejectOnly: true } as const;
const ASKED = { type: "permission", requestId: "r-1", toolCallId: "t-1", kind: "execute", title: "Run npm test", detail: "npm test" } as const;
const t = (key: string) => lookup(key, "en-US");

describe("T673 a reject-only permission card", () => {
  afterEach(cleanup);

  it("offers Reject alone, in the answers the card offers", () => {
    expect(permissionAnswers("other", true)).toEqual(["reject"]);
    expect(permissionAnswers("execute", true)).toEqual(["reject"]);
    // Unchanged for a card the broker described.
    expect(permissionAnswers("execute")).toEqual(["allow-once", "allow-conversation", "reject"]);
    expect(permissionAnswers("read")).toEqual(["allow-once", "reject"]);
  });

  it("says the action is unknown and shows only Reject, which answers reject", () => {
    const answers: string[] = [];
    render(<PermissionCard permission={{ ...UNKNOWN }} agentName="DeepSeek" t={t} onAnswer={(answer) => answers.push(answer)} />);

    const card = screen.getByRole("group");
    expect(card.textContent).toContain("Hallpass cannot tell what this action is");
    expect(card.textContent).toContain("only reject it");
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Reject"]);
    expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();

    fireEvent.click(buttons[0]!);
    expect(answers).toEqual(["reject"]);
  });

  it("says it in zh-TW too", () => {
    render(<PermissionCard permission={{ ...UNKNOWN }} agentName="DeepSeek" t={(key) => lookup(key, "zh-TW")} onAnswer={() => undefined} />);

    const card = screen.getByRole("group");
    expect(card.textContent).not.toContain("Hallpass cannot tell");
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual([lookup("conversation.permission.reject", "zh-TW")]);
    cleanup();
  });
});

describe("T668 a card for an `other` action with no title (DeepSeek)", () => {
  afterEach(cleanup);
  /** DeepSeek announces every action as `other` with an empty title: the broker keeps no rule for it. */
  const UNNAMED = { type: "permission", requestId: "r-d", toolCallId: "t-d", kind: "other", title: "", detail: "npm test\nRun the tests" } as const;

  it("offers no allow for this conversation; a titled `other` still does", () => {
    expect(permissionAnswers("other", false, "")).toEqual(["allow-once", "reject"]);
    expect(permissionAnswers("other", false, "  ")).toEqual(["allow-once", "reject"]);
    expect(permissionAnswers("other", false, "hallpass - read_page (MCP)")).toEqual(["allow-once", "allow-conversation", "reject"]);
    expect(permissionAnswers("execute", false, "")).toEqual(["allow-once", "allow-conversation", "reject"]);
  });

  it("shows Allow once and Reject and says each action is asked about on its own", () => {
    const answers: string[] = [];
    render(<PermissionCard permission={{ ...UNNAMED }} agentName="DeepSeek" t={t} onAnswer={(answer) => answers.push(answer)} />);
    const card = screen.getByRole("group");
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["Allow once", "Reject"]);
    expect(card.textContent).toContain("npm test");
    expect(card.textContent).toContain("Hallpass cannot tell which tool this is");
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(answers).toEqual(["allow-once"]);
  });

  it("says it in zh-TW too", () => {
    render(<PermissionCard permission={{ ...UNNAMED }} agentName="DeepSeek" t={(key) => lookup(key, "zh-TW")} onAnswer={() => undefined} />);
    const card = screen.getByRole("group");
    expect(card.textContent).toContain(lookup("conversation.permission.onceOnly", "zh-TW"));
    expect(card.textContent).not.toContain("Hallpass cannot tell");
    expect(within(card).getAllByRole("button")).toHaveLength(2);
  });

  it("a titled card says nothing of it", () => {
    render(<PermissionCard permission={{ ...ASKED }} agentName="Claude Code" t={t} onAnswer={() => undefined} />);
    expect(screen.getByRole("group").textContent).not.toContain("Hallpass cannot tell which tool this is");
  });
});

describe("T673 in the conversation", () => {
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("sits above the message box with Reject first in the keyboard order, then the box's own Stop", () => {
    emitEvent(port, 1, { ...UNKNOWN });
    const card = screen.getByRole("group", { name: /Unknown action/ });
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    expect(card.nextElementSibling?.classList.contains("agent-conversation-composer")).toBe(true);

    const order = [...document.querySelectorAll<HTMLElement>(".agent-conversation-composer-area button, .agent-conversation-composer-area textarea")];
    expect(order[0]?.textContent).toBe("Reject");
    fireEvent.click(order[0]!);
    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.answer", payload: { conversationId: CONVERSATION_ID, requestId: "r-u", answer: "reject" } },
    ]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("leaves an ordinary card with its three answers", () => {
    emitEvent(port, 1, { ...ASKED });
    const card = screen.getByRole("group", { name: /Run npm test/ });
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.allow-conversation"),
      ui("conversation.permission.reject"),
    ]);
    expect(card.textContent).not.toContain("cannot tell what this action is");
  });
});

/**
 * A card whose title is blank (DeepSeek often sends none; a reject-only card has no detail either)
 * must not leave "asks to:" / "Waiting for you:" / "You rejected:" dangling: the heading, the
 * waiting line and the answer line fall back to the detail's first line, then to "an action it did
 * not describe".
 */
describe("a permission with a blank title", () => {
  const NAMELESS = { type: "permission", requestId: "r-n", toolCallId: "t-n", kind: "other", title: "  ", detail: "", rejectOnly: true } as const;
  const DETAILED = { type: "permission", requestId: "r-d", toolCallId: "t-d", kind: "other", title: "", detail: "\n  npm test\nRun the tests" } as const;
  const FALLBACK_EN = "an action it did not describe";
  const FALLBACK_ZH = "一個沒說明的動作";
  let port: FakeAgentPort;

  beforeEach(async () => {
    port = installAgentPort();
    installTabStorage();
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("names the fallback in the heading, the waiting line and the answer line", () => {
    emitEvent(port, 1, { type: "state", state: "waiting-for-owner" });
    emitEvent(port, 2, { ...NAMELESS });
    expect(document.querySelector(".agent-conversation-permission h3")?.textContent).toMatch(new RegExp(`asks to: ${FALLBACK_EN}$`));
    expect(document.querySelector(".agent-conversation-live[data-waiting]")?.textContent).toBe(`Waiting for you: ${FALLBACK_EN}`);

    emitEvent(port, 3, { type: "permission-closed", requestId: "r-n", answer: "reject" });
    expect(document.querySelector(".agent-conversation-answer")?.textContent).toBe(`You rejected: ${FALLBACK_EN}`);
  });

  it("uses the first non-blank line of the detail where the card has it, without repeating a line it already shows", () => {
    emitEvent(port, 1, { type: "state", state: "waiting-for-owner" });
    emitEvent(port, 2, { ...DETAILED });
    const card = document.querySelector(".agent-conversation-permission")!;
    expect(card.querySelector("h3")?.textContent).toMatch(/asks to: npm test$/);
    expect(document.querySelector(".agent-conversation-live[data-waiting]")?.textContent).toBe("Waiting for you: npm test");
    // The detail still adds its second line, so it stays; a one-line detail would be suppressed.
    expect(card.querySelector(".agent-conversation-permission-detail")?.textContent).toContain("Run the tests");
    cleanup();
    render(<PermissionCard permission={{ ...DETAILED, detail: "npm test" }} agentName="DeepSeek" t={t} onAnswer={() => undefined} />);
    expect(screen.getByRole("group").querySelector(".agent-conversation-permission-detail")).toBeNull();
  });

  it("says the fallback in zh-TW", () => {
    cleanup();
    render(<PermissionCard permission={{ ...NAMELESS }} agentName="DeepSeek" t={(key) => lookup(key, "zh-TW")} onAnswer={() => undefined} />);
    expect(document.querySelector(".agent-conversation-permission h3")?.textContent).toBe(`DeepSeek 要求：${FALLBACK_ZH}`);
  });
});
