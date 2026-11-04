import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationEvent, type QuestionField } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 029 T871, T872, T876, T878, T879 - an agent's form question as a card above the box (FR-440 -
 * FR-449): one control per field, Send with exactly the entered values, Skip, Skip only, the line an
 * ending leaves, who asks, a secret field that never shows again.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const COLOUR: QuestionField = {
  key: "colour",
  kind: "choice",
  label: "Colour",
  required: true,
  options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue", description: "The calm one" }],
};
const KINDS: QuestionField[] = [
  COLOUR,
  { key: "toppings", kind: "choices", label: "Toppings", required: false, options: [{ value: "ham", label: "Ham" }, { value: "olive", label: "Olive" }], maxItems: 1 },
  { key: "note", kind: "text", label: "Note", required: false, maxLength: 50 },
  { key: "email", kind: "text", label: "Email", required: false, format: "email" },
  { key: "count", kind: "integer", label: "Count", required: false, minimum: 1, maximum: 9, default: 2 },
  { key: "ok", kind: "yes-no", label: "Deliver", required: false, default: true },
];
const question = (extra: Partial<Extract<ConversationEvent, { type: "question" }>> = {}): ConversationEvent => ({
  type: "question",
  requestId: "q-1",
  message: "Pick your order",
  fields: KINDS,
  ...extra,
});

describe("029 the question card", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
  }
  const card = () => screen.getByRole("group", { name: ui("conversation.question.title").replace("{agent}", "Claude Code") });
  const send = () => within(card()).getByRole("button", { name: ui("conversation.question.send") }) as HTMLButtonElement;
  const replies = () => commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.question-reply");

  it("shows one control per field, with defaults, and Send waits for the required field", async () => {
    await open();
    emitEvent(port, 1, question());
    const shown = card();
    expect(shown.textContent).toContain("Pick your order");
    expect(within(shown).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["red", "blue"]);
    expect(shown.textContent).toContain("The calm one");
    expect(within(shown).getAllByRole("checkbox")).toHaveLength(3); // two toppings + Deliver
    expect((within(shown).getByRole("textbox", { name: "Note" }) as HTMLInputElement).maxLength).toBe(50);
    expect((within(shown).getByRole("textbox", { name: "Email" }) as HTMLInputElement).type).toBe("email");
    const count = within(shown).getByRole("spinbutton", { name: "Count" }) as HTMLInputElement;
    expect([count.value, count.min, count.max, count.step]).toEqual(["2", "1", "9", "1"]);
    expect((within(shown).getByRole("checkbox", { name: "Deliver" }) as HTMLInputElement).checked).toBe(true);
    expect(send().disabled).toBe(true);
    expect(shown.textContent).toContain(ui("conversation.question.check").replace("{fields}", "Colour"));
  });

  it("Send posts accept with exactly the values entered, typed", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("radio", { name: /Blue/ }));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Olive" }));
    fireEvent.change(within(card()).getByRole("textbox", { name: "Note" }), { target: { value: "no onions" } });
    fireEvent.change(within(card()).getByRole("spinbutton", { name: "Count" }), { target: { value: "3" } });
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Deliver" }));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(replies()).toEqual([
      {
        type: "ui.conversation.question-reply",
        payload: {
          conversationId: CONVERSATION_ID,
          requestId: "q-1",
          reply: { action: "accept", values: { colour: "blue", toppings: ["olive"], note: "no onions", count: 3, ok: false } },
        },
      },
    ]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("holds Send back for a value outside its limits, naming the field", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("radio", { name: /Red/ }));
    fireEvent.change(within(card()).getByRole("spinbutton", { name: "Count" }), { target: { value: "12" } });
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Ham" }));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Olive" }));
    expect(send().disabled).toBe(true);
    expect(card().textContent).toContain(ui("conversation.question.check").replace("{fields}", "Toppings, Count"));
  });

  it("Skip posts decline", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("button", { name: ui("conversation.question.skip") }));
    expect(replies()).toEqual([
      { type: "ui.conversation.question-reply", payload: { conversationId: CONVERSATION_ID, requestId: "q-1", reply: { action: "decline" } } },
    ]);
  });

  it("a skip-only question shows its message and Skip alone, and lists a field it cannot show", async () => {
    await open();
    emitEvent(port, 1, question({ skipOnly: true, fields: [{ key: "when", kind: "unsupported", label: "When", required: true }] }));
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual([ui("conversation.question.skip")]);
    expect(card().textContent).toContain(ui("conversation.question.skipOnly"));
    expect(card().textContent).toContain("When");
    expect(card().textContent).toContain(ui("conversation.question.unsupported"));
  });

  it("names the agent, the tool call only when it carries one, where the answer goes, and the agent's own waiting time", async () => {
    await open();
    emitEvent(port, 1, question());
    expect(card().textContent).toContain(ui("conversation.question.goesTo").replace("{agent}", "Claude Code"));
    expect(card().textContent).not.toContain(ui("conversation.question.during").replace("{tool}", ""));
    emitEvent(port, 2, { type: "question-closed", requestId: "q-1", ending: "cancelled" });
    emitEvent(port, 3, question({ requestId: "q-2", toolCallId: "call-1", toolTitle: "mcp__github__create_issue", waitsMs: 60_000 }));
    expect(card().textContent).toContain(ui("conversation.question.during").replace("{tool}", "mcp__github__create_issue"));
    expect(card().textContent).toContain(ui("conversation.question.waitsFor").replace("{agent}", "Claude Code").replace("{seconds}", "60"));
  });

  it("while a question waits the box sends nothing", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: "hello" } });
    const boxSend = screen.queryByRole("button", { name: ui("conversation.composer.send") }) as HTMLButtonElement | null;
    expect(boxSend === null || boxSend.disabled).toBe(true);
  });

  it("leaves when closed, and each ending leaves its line", async () => {
    await open();
    const endings = [
      ["answered", "conversation.questionEnded.answered"],
      ["skipped", "conversation.questionEnded.skipped"],
      ["cancelled", "conversation.questionEnded.cancelled"],
      ["withdrawn", "conversation.questionEnded.withdrawn"],
      ["agent-exited", "conversation.questionEnded.agent-exited"],
    ] as const;
    let seq = 0;
    for (const [ending, key] of endings) {
      const requestId = `q-${ending}`;
      emitEvent(port, ++seq, question({ requestId, message: `Asked ${ending}` }));
      emitEvent(port, ++seq, { type: "question-closed", requestId, ending, ...(ending === "answered" ? { summary: "Colour: Red" } : {}) });
      expect(screen.queryByRole("group", { name: ui("conversation.question.title").replace("{agent}", "Claude Code") })).toBeNull();
      const line = ui(key).replace("{summary}", "Colour: Red").replace("{message}", `Asked ${ending}`);
      expect(screen.getByRole("log").textContent).toContain(line);
    }
  });

  it("a secret field hides what is typed, and its value is nowhere in the panel once sent", async () => {
    await open();
    emitEvent(port, 1, question({ fields: [{ key: "token", kind: "text", label: "API token", required: true, secret: true }] }));
    const input = card().querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "s3cret-029" } });
    fireEvent.click(send());
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { token: "s3cret-029" } } } }]);
    emitEvent(port, 2, { type: "question-closed", requestId: "q-1", ending: "answered", summary: "API token: ••••••" });
    expect(document.body.innerHTML).not.toContain("s3cret-029");
  });

  it("speaks zh-TW", async () => {
    await open("zh-TW");
    emitEvent(port, 1, question());
    const title = lookup("conversation.question.title", "zh-TW").replace("{agent}", "Claude Code");
    expect(screen.getByRole("group", { name: title })).toBeTruthy();
    expect(screen.getByRole("button", { name: lookup("conversation.question.send", "zh-TW") })).toBeTruthy();
    expect(lookup("conversation.question.send", "zh-TW")).not.toBe(lookup("conversation.question.send", "en-US"));
  });

  it("R-438 Claude Code: the tag is a chip over the question's words, options are rows with their description and preview, and Other sits in its question", async () => {
    await open();
    emitEvent(port, 1, question({
      message: "Please answer the following questions.",
      fields: [
        {
          key: "question_0",
          kind: "choice",
          label: "Which sign-in should the app use?",
          chip: "Auth",
          required: false,
          options: [
            { value: "OAuth", label: "OAuth", description: "Sign in through the browser", preview: "await signIn({ provider })" },
            { value: "API key", label: "API key" },
          ],
        },
        { key: "question_0_custom", kind: "text", label: "Other", description: "Type your own answer (optional).", required: false, otherFor: "question_0" },
      ],
    }));
    const group = within(card()).getByRole("group", { name: /Which sign-in should the app use\?/ });
    expect(group.querySelector(".agent-question-chip")?.textContent).toBe("Auth");
    const row = within(group).getByRole("radio", { name: /OAuth/ }).closest("label")!;
    expect(row.textContent).toContain("Sign in through the browser");
    expect(row.querySelector("pre")?.textContent).toBe("await signIn({ provider })");
    const other = within(group).getByRole("textbox", { name: /^Other/ }) as HTMLInputElement;
    // The agent's hint is said with the box, in full, not as a placeholder cut off inside it.
    expect(other.closest("label")?.textContent).toContain("Type your own answer (optional).");
    expect(other.placeholder).toBe("");
    // The Other box is not a field of its own after the question.
    expect(card().querySelectorAll(".agent-question-field")).toHaveLength(1);
    fireEvent.change(other, { target: { value: "with SSO" } });
    fireEvent.click(send());
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { question_0_custom: "with SSO" } } } }]);
  });

  it("R-438 Codex: the note sits in its question, under None of the above", async () => {
    await open();
    emitEvent(port, 1, question({
      message: "Codex needs your input to continue.",
      fields: [
        {
          key: "scope",
          kind: "choice",
          label: "Which scope should the new token have?",
          chip: "Token scope",
          required: true,
          options: [{ value: "repo", label: "repo" }, { value: "None of the above", label: "None of the above" }],
        },
        { key: "scope_note", kind: "text", label: "Additional answer or note", required: false, otherFor: "scope" },
      ],
    }));
    const group = within(card()).getByRole("group", { name: /Which scope should the new token have\?/ });
    expect(within(group).getByRole("textbox", { name: "Additional answer or note" })).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "None of the above" }));
    fireEvent.change(within(group).getByRole("textbox", { name: "Additional answer or note" }), { target: { value: "admin:org" } });
    fireEvent.click(send());
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { scope: "None of the above", scope_note: "admin:org" } } } }]);
  });
});

