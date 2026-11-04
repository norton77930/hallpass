import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent, ConversationEvent } from "@hallpass/contracts";
import { poolHarness, sleep, turnEnded, waitFor } from "./conversation-harness.js";

// Every test here starts real fake-agent processes.
vi.setConfig({ testTimeout: 60_000 });

/**
 * 029 - agent questions as side-panel cards, over the fake agent's `ask:form:*` keywords (T864):
 * the broker advertises forms (R-429), shows a form question of a live turn as a `question` event
 * (R-431), checks the owner's reply against it (R-434), and ends every card in one of R-435's ways.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

type QuestionEvent = Extract<ConversationEvent, { type: "question" }>;

const events = (harness: Harness, id: string, from = 0) => harness.rec.of(id).slice(from).map((entry) => entry.event);
const agentText = (harness: Harness, id: string, from = 0) =>
  events(harness, id, from)
    .flatMap((event) => (event.type === "text" && event.role === "agent" ? [event.text] : []))
    .join("");

async function sendOnly(harness: Harness, id: string, text: string): Promise<number> {
  const from = harness.rec.of(id).length;
  expect((await harness.pool.send(id, text)).ok).toBe(true);
  return from;
}

async function questionFor(harness: Harness, id: string, from: number): Promise<QuestionEvent> {
  let found: QuestionEvent | undefined;
  await waitFor(() => {
    const event = events(harness, id, from).find((entry): entry is QuestionEvent => entry.type === "question");
    found = event;
    return found !== undefined;
  }, "a question card");
  return found!;
}

const untilTurnEnds = (harness: Harness, id: string, from: number) =>
  waitFor(() => turnEnded(harness.rec.of(id).slice(from), id), "the end of the turn");

const closedOf = (harness: Harness, id: string, requestId: string) =>
  events(harness, id).find((event) => event.type === "question-closed" && event.requestId === requestId);

describe("029 T868 Hallpass advertises form questions (R-429)", () => {
  it("the agent sends its form question instead of saying unsupported", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:elicit");
    const question = await questionFor(h, id, from);
    expect(question).toMatchObject({ message: "Which colour do you prefer?", fields: [{ key: "colour", kind: "choice", required: true }] });
    expect(agentText(h, id, from)).not.toContain("elicit:unsupported");
  });

  it("a fieldless MCP approval still arrives as a permission card", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:empty");
    await waitFor(() => events(h!, id, from).some((event) => event.type === "permission"), "a permission card");
    expect(events(h, id, from).some((event) => event.type === "question")).toBe(false);
  });
});

describe("029 T869 a form question of a live turn becomes a card (R-431)", () => {
  it("raises a question event with every field and the state waiting-for-owner", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const question = await questionFor(h, id, from);
    expect(question.requestId).toMatch(/^q-\d+$/u);
    expect(question.message).toBe("Pick your order");
    expect(question.fields.map((field) => field.kind)).toEqual(["choice", "choice", "choices", "text", "text", "integer", "number", "yes-no"]);
    expect(question.toolCallId).toBeUndefined();
    expect(h.pool.state(id)).toBe("waiting-for-owner");
  });

  it("a question over the bounds is shown skip-only", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:big");
    expect(await questionFor(h, id, from)).toMatchObject({ skipOnly: true, fields: [] });
  });

  it("a question after the turn ended is answered cancel with no card", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    await h.turn(id, "ask:form:outside");
    await waitFor(async () => (await h!.log()).some((line) => line.event === "outside-elicit"), "the outside question's answer");
    expect((await h.log()).find((line) => line.event === "outside-elicit")).toMatchObject({ action: "cancel" });
    expect(events(h, id, from).some((event) => event.type === "question")).toBe(false);
  });
});

describe("029 T870 the owner's Send (R-434)", () => {
  it("sends exactly the values, closes the card answered with its summary, and the turn goes on", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    const values = { colour: "blue", toppings: ["ham", "olive"], count: 3, ok: false, note: "" };
    expect(await h.pool.questionReply(id, requestId, { action: "accept", values })).toEqual({ ok: true });
    await untilTurnEnds(h, id, from);
    expect(agentText(h, id, from)).toContain(`elicit:accept`);
    expect(agentText(h, id, from)).toContain(`content:${JSON.stringify({ colour: "blue", toppings: ["ham", "olive"], count: 3, ok: false })}`);
    expect(closedOf(h, id, requestId)).toEqual({
      type: "question-closed",
      requestId,
      ending: "answered",
      summary: "Colour: Blue; Toppings: Ham, Olive; Count: 3; Deliver: ✗",
    });
  });

  it("refuses values that do not fit with question-invalid, and the card stays", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    const refused = await h.pool.questionReply(id, requestId, { action: "accept", values: { colour: "green" } });
    expect(refused).toMatchObject({ ok: false, error: { code: "question-invalid" } });
    expect(closedOf(h, id, requestId)).toBeUndefined();
    expect(h.pool.state(id)).toBe("waiting-for-owner");
  });

  it("a second reply (another panel document) is not-found, and only the first reached the agent", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    expect((await h.pool.questionReply(id, requestId, { action: "accept", values: { colour: "red" } })).ok).toBe(true);
    expect(await h.pool.questionReply(id, requestId, { action: "decline" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    await untilTurnEnds(h, id, from);
    expect(agentText(h, id, from)).toContain("elicit:accept");
    expect(agentText(h, id, from)).not.toContain("elicit:decline");
  });

  it("an unknown conversation is not-found", async () => {
    h = await poolHarness();
    expect(await h.pool.questionReply("conv-0123456789abcdef", "q-1", { action: "decline" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("029 T874 every ending (R-435)", () => {
  it("Skip replies decline and closes skipped", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    expect((await h.pool.questionReply(id, requestId, { action: "decline" })).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(agentText(h, id, from)).toContain("elicit:decline");
    expect(closedOf(h, id, requestId)).toEqual({ type: "question-closed", requestId, ending: "skipped" });
  });

  it("Stop replies cancel and closes cancelled", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    expect((await h.pool.stop(id)).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(closedOf(h, id, requestId)).toEqual({ type: "question-closed", requestId, ending: "cancelled" });
    expect(agentText(h, id, from)).not.toContain("elicit:accept");
  });

  it("the agent withdrawing its request closes the card withdrawn", async () => {
    h = await poolHarness({ env: { FAKE_ACP_WITHDRAW_MS: "300" } });
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:withdraw");
    const { requestId } = await questionFor(h, id, from);
    await waitFor(() => closedOf(h!, id, requestId) !== undefined, "the withdrawn card");
    expect(closedOf(h, id, requestId)).toEqual({ type: "question-closed", requestId, ending: "withdrawn" });
    await untilTurnEnds(h, id, from);
    expect(agentText(h, id, from)).toContain("elicit:withdrawn");
    expect(await h.pool.questionReply(id, requestId, { action: "decline" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("the agent exiting closes the card agent-exited, and a late reply is refused", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    process.kill(h.pool.agentPid(id)!);
    await waitFor(() => h!.pool.state(id) === "crashed", "the crashed state");
    expect(closedOf(h, id, requestId)).toEqual({ type: "question-closed", requestId, ending: "agent-exited" });
    expect((await h.pool.questionReply(id, requestId, { action: "decline" })).ok).toBe(false);
  });
});

describe("029 T875 a waiting question holds the conversation like a card (R-437)", () => {
  it("a mode change is refused busy while it waits, and the state returns to running once answered", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:kinds");
    const { requestId } = await questionFor(h, id, from);
    expect(await h.pool.setMode(id, "agent-review")).toMatchObject({ ok: false, error: { code: "busy" } });
    await sleep(200);
    expect(h.pool.state(id)).toBe("waiting-for-owner");
    expect((await h.pool.questionReply(id, requestId, { action: "decline" })).ok).toBe(true);
    await untilTurnEnds(h, id, from);
  });
});

describe("029 T877 who asks (R-430)", () => {
  it("a question tied to a tool call this turn announced carries its id and title", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:tool");
    const question = await questionFor(h, id, from);
    expect(question.toolCallId).toMatch(/^call-\d+$/u);
    expect(question.toolTitle).toBe("mcp__github__create_issue");
  });
});

describe("029 T879, T881 a secret answer stays out of everything but the reply (FR-449, SC-199)", () => {
  it("reaches the agent, is hidden in the summary, and is in no event, log line, diagnostics line or data file", async () => {
    const logs: string[] = [];
    h = await poolHarness({ log: (code: string, detail?: string) => logs.push(`${code} ${detail ?? ""}`) });
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:secret");
    const question = await questionFor(h, id, from);
    expect(question.fields[0]).toMatchObject({ key: "token", secret: true });
    const secret = "s3cret-029-value";
    expect((await h.pool.questionReply(id, question.requestId, { action: "accept", values: { token: secret } })).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    // The fake agent says the content back, so its own text holds it; nothing of Hallpass's own does.
    expect(closedOf(h, id, question.requestId)).toEqual({ type: "question-closed", requestId: question.requestId, ending: "answered", summary: "API token: ••••••" });
    const hallpassEvents = events(h, id).filter((event) => !(event.type === "text" && event.role === "agent"));
    expect(JSON.stringify(hallpassEvents)).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expect(h.pool.diagnostics(id).join("\n")).not.toContain(secret);
    const files = await readdir(h.dataDir, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      expect(await readFile(join(file.parentPath, file.name), "utf8"), file.name).not.toContain(secret);
    }
  });
});

describe("029 T880 Hermes and DeepSeek are unchanged (FR-448)", () => {
  for (const agent of ["hermes", "deepseek"] as ConversationAgent[]) {
    it(`${agent}: a turn without a question runs as before`, async () => {
      h = await poolHarness();
      const id = await h.start(agent);
      const from = h.rec.of(id).length;
      await h.turn(id, "hello");
      expect(agentText(h, id, from)).toBe("echo:hello");
      expect(events(h, id, from).some((event) => event.type === "question")).toBe(false);
    });
  }
});

describe("029 R-438 the adapters' display hints reach the card", () => {
  it("Claude Code's question tool: tags as chips, words as labels, the preview, each Other box joined to its question", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "ask:form:claude");
    const question = await questionFor(h, id, from);
    expect(question.fields.map((field) => [field.key, field.chip, field.otherFor])).toEqual([
      ["question_0", "Auth", undefined],
      ["question_0_custom", undefined, "question_0"],
      ["question_1", "Features", undefined],
      ["question_1_custom", undefined, "question_1"],
    ]);
    expect(question.fields[0]?.label).toBe("Which sign-in should the app use?");
    expect(question.fields[0]?.options?.[0]?.preview).toBe("await signIn({ provider })");
    const values = { question_0: "OAuth", question_0_custom: "with SSO", question_1: ["Export"] };
    expect((await h.pool.questionReply(id, question.requestId, { action: "accept", values })).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(agentText(h, id, from)).toContain(`content:${JSON.stringify(values)}`);
  });

  it("Codex's user-input request: the words as the label, the tag as the chip, the note joined to its question", async () => {
    h = await poolHarness();
    const id = await h.start("codex");
    const from = await sendOnly(h, id, "ask:form:codex");
    const question = await questionFor(h, id, from);
    expect(question.fields[0]).toMatchObject({ key: "scope", label: "Which scope should the new token have?", chip: "Token scope", required: true });
    expect(question.fields[1]).toMatchObject({ key: "scope_note", otherFor: "scope" });
  });
});
