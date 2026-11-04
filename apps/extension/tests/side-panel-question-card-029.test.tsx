import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationEvent, type QuestionField } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_OPEN, commandsSent, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 029 T871, T872, T876, T878, T879, R-438, R-439 - an agent's form question as a card above the box,
 * drawn as the agent's own client draws its questions (the owner's screenshots, R-439): one question
 * at a time under a header with its words and "n of total", the options as rows with a radio or a box
 * and their description under them, "Other" as the last row, Skip and Next / Send with Ctrl+Enter.
 */

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const COLOUR: QuestionField = {
  key: "colour",
  kind: "choice",
  label: "Which colour?",
  required: true,
  options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue", description: "The calm one" }],
};
const KINDS: QuestionField[] = [
  COLOUR,
  { key: "toppings", kind: "choices", label: "Which toppings?", required: false, options: [{ value: "ham", label: "Ham" }, { value: "olive", label: "Olive" }], maxItems: 1 },
  { key: "note", kind: "text", label: "Note", required: false, maxLength: 50 },
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
  const button = (key: string) => within(card()).getByRole("button", { name: ui(key) }) as HTMLButtonElement;
  const heading = () => within(card()).getByRole("heading").textContent;
  const page = (n: number, total: number) => ui("conversation.question.page").replace("{n}", String(n)).replace("{total}", String(total));
  const replies = () => commandsSent(port).filter((command) => (command as { type: string }).type === "ui.conversation.question-reply");

  it("shows one question at a time: its words in the header with n of total, options as rows with their description", async () => {
    await open();
    emitEvent(port, 1, question());
    expect(heading()).toBe("Which colour?");
    expect(card().textContent).toContain(page(1, 5));
    const rows = within(card()).getAllByRole("radio");
    expect(rows.map((radio) => radio.getAttribute("value"))).toEqual(["red", "blue"]);
    expect(rows[1]!.closest("label")!.textContent).toContain("The calm one");
    // Nothing is picked for the owner; Next waits for the required pick.
    expect(rows.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(button("conversation.question.next").disabled).toBe(true);
    fireEvent.click(rows[0]!);
    expect(button("conversation.question.next").disabled).toBe(false);
    fireEvent.click(button("conversation.question.next"));
    expect(heading()).toBe("Which toppings?");
    expect(within(card()).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("goes back with the pager, keeping what was picked; Send is on the last page only", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("radio", { name: /Blue/ }));
    fireEvent.click(within(card()).getByRole("button", { name: ui("conversation.question.nextPage") }));
    fireEvent.click(within(card()).getByRole("button", { name: ui("conversation.question.previous") }));
    expect((within(card()).getByRole("radio", { name: /Blue/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(card()).queryByRole("button", { name: ui("conversation.question.send") })).toBeNull();
    for (let index = 0; index < 4; index++) fireEvent.click(button("conversation.question.next"));
    expect(card().textContent).toContain(page(5, 5));
    expect(button("conversation.question.send")).toBeTruthy();
  });

  it("Send posts accept with exactly the values entered on every page, typed", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("radio", { name: /Blue/ }));
    fireEvent.click(button("conversation.question.next"));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Olive" }));
    fireEvent.click(button("conversation.question.next"));
    fireEvent.change(within(card()).getByRole("textbox", { name: "Note" }), { target: { value: "no onions" } });
    fireEvent.click(button("conversation.question.next"));
    const count = within(card()).getByRole("spinbutton", { name: "Count" }) as HTMLInputElement;
    expect([count.value, count.min, count.max, count.step]).toEqual(["2", "1", "9", "1"]);
    fireEvent.change(count, { target: { value: "3" } });
    fireEvent.click(button("conversation.question.next"));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Deliver" }));
    fireEvent.click(button("conversation.question.send"));
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

  it("holds Next back for a value outside its limits, naming the field", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(within(card()).getByRole("radio", { name: /Red/ }));
    fireEvent.click(button("conversation.question.next"));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Ham" }));
    fireEvent.click(within(card()).getByRole("checkbox", { name: "Olive" }));
    expect(button("conversation.question.next").disabled).toBe(true);
    expect(card().textContent).toContain(ui("conversation.question.check").replace("{fields}", "Which toppings?"));
  });

  it("Ctrl+Enter presses Next, then Send", async () => {
    await open();
    emitEvent(port, 1, question({ fields: [COLOUR, { key: "ok", kind: "yes-no", label: "Deliver", required: false }] }));
    fireEvent.click(within(card()).getByRole("radio", { name: /Red/ }));
    fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    expect(heading()).toBe("Deliver");
    fireEvent.keyDown(card(), { key: "Enter", ctrlKey: true });
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { colour: "red", ok: false } } } }]);
  });

  it("Skip posts decline from any page", async () => {
    await open();
    emitEvent(port, 1, question());
    fireEvent.click(button("conversation.question.skip"));
    expect(replies()).toEqual([
      { type: "ui.conversation.question-reply", payload: { conversationId: CONVERSATION_ID, requestId: "q-1", reply: { action: "decline" } } },
    ]);
  });

  it("Other is the last row: picking it opens its box, and its words go back as the question's own answer", async () => {
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
    expect(heading()).toBe("Which sign-in should the app use?");
    expect(card().textContent).not.toContain(page(1, 1));
    // The question tool's generic message is not said; a plain form's message is (first test).
    expect(card().textContent).not.toContain("Please answer the following questions.");
    const oauth = within(card()).getByRole("radio", { name: /OAuth/ }).closest("label")!;
    expect(oauth.querySelector("pre")?.textContent).toBe("await signIn({ provider })");
    const radios = within(card()).getAllByRole("radio");
    expect(radios.at(-1)!.closest("label")!.textContent).toBe(ui("conversation.question.other"));
    expect(within(card()).queryByRole("textbox")).toBeNull();
    fireEvent.click(radios.at(-1)!);
    const box = within(card()).getByRole("textbox", { name: ui("conversation.question.other") }) as HTMLInputElement;
    expect(box.placeholder).toBe("Type your own answer (optional).");
    expect(button("conversation.question.send").disabled).toBe(true);
    fireEvent.change(box, { target: { value: "with SSO" } });
    fireEvent.click(button("conversation.question.send"));
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { question_0_custom: "with SSO" } } } }]);
    expect((replies()[0] as { payload: { reply: { values: Record<string, unknown> } } }).payload.reply.values).not.toHaveProperty("question_0");
  });

  it("a required choice keeps its note as a box under the options (Codex)", async () => {
    await open();
    emitEvent(port, 1, question({
      message: "Codex needs your input to continue.",
      fields: [
        { key: "scope", kind: "choice", label: "Which scope?", chip: "Token scope", required: true, options: [{ value: "repo", label: "repo" }, { value: "None of the above", label: "None of the above" }] },
        { key: "scope_note", kind: "text", label: "Additional answer or note", required: false, otherFor: "scope" },
      ],
    }));
    expect(within(card()).getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(within(card()).getByRole("radio", { name: "None of the above" }));
    fireEvent.change(within(card()).getByRole("textbox", { name: "Additional answer or note" }), { target: { value: "admin:org" } });
    fireEvent.click(button("conversation.question.send"));
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { scope: "None of the above", scope_note: "admin:org" } } } }]);
  });

  it("a skip-only question shows its message and Skip alone, and names a field it cannot show", async () => {
    await open();
    emitEvent(port, 1, question({ skipOnly: true, fields: [{ key: "when", kind: "unsupported", label: "When", required: true }] }));
    expect(within(card()).getAllByRole("button").map((entry) => entry.textContent)).toEqual([ui("conversation.question.skip")]);
    expect(card().textContent).toContain(ui("conversation.question.skipOnly"));
    expect(card().textContent).toContain("When");
  });

  it("says the agent asks, the tool call only when it carries one, where the answer goes, and the agent's own waiting time", async () => {
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
    fireEvent.click(button("conversation.question.send"));
    expect(replies()).toMatchObject([{ payload: { reply: { action: "accept", values: { token: "s3cret-029" } } } }]);
    emitEvent(port, 2, { type: "question-closed", requestId: "q-1", ending: "answered", summary: "API token: ••••••" });
    expect(document.body.innerHTML).not.toContain("s3cret-029");
  });

  it("speaks zh-TW", async () => {
    await open("zh-TW");
    emitEvent(port, 1, question());
    const title = lookup("conversation.question.title", "zh-TW").replace("{agent}", "Claude Code");
    const shown = screen.getByRole("group", { name: title });
    expect(shown.textContent).toContain(lookup("conversation.question.page", "zh-TW").replace("{n}", "1").replace("{total}", "5"));
    expect(within(shown).getByRole("button", { name: lookup("conversation.question.next", "zh-TW") })).toBeTruthy();
    expect(lookup("conversation.question.next", "zh-TW")).not.toBe(lookup("conversation.question.next", "en-US"));
  });
});
