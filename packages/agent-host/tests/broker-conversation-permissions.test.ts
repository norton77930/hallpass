import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import { isCodexSandboxPermissionsRequest, permissionRuleKey } from "../src/broker/conversation.js";
import { isAlive, poolHarness, sleep, turnEnded, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 019/T536 - permission answers (R-317, FR-290, FR-291, FR-294). The agent's request becomes a
 * `permission` event and the agent waits; the owner's three answers map to the adapter's *once*
 * options; "for this conversation" is a broker-side rule keyed by tool kind (`other` by tool name)
 * that answers later requests itself; "always" options are never sent; an unanswered card waits
 * forever; an agent that exits while a card is open closes it as `agent-exited`.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const answers = (log: FakeLogLine[]) => log.filter((line) => line.event === "permission-answer");

async function cardFor(harness: Harness, id: string, from = 0) {
  let requestId = "";
  await waitFor(() => {
    const card = harness.rec.of(id).slice(from).find((entry) => entry.event.type === "permission");
    if (card?.event.type === "permission") requestId = card.event.requestId;
    return requestId !== "";
  }, "a permission card");
  return requestId;
}

/** Sends without waiting for the end of the turn. */
async function sendOnly(harness: Harness, id: string, text: string): Promise<number> {
  const from = harness.rec.of(id).length;
  const sent = await harness.pool.send(id, text);
  expect(sent.ok).toBe(true);
  return from;
}

async function untilTurnEnds(harness: Harness, id: string, from: number) {
  await waitFor(() => turnEnded(harness.rec.of(id).slice(from), id), "the end of the turn");
}

describe("T536 a request becomes a card and the agent waits", () => {
  it("raises a permission event with the tool's kind and title, state waiting-for-owner, no answer sent", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, from);

    const card = h.rec.of(id).find((entry) => entry.event.type === "permission")!.event;
    expect(card).toMatchObject({ type: "permission", requestId, kind: "edit", title: "Edit src/app.ts" });
    expect(card.type === "permission" && card.detail).toMatch(/src\/app\.ts/u);
    expect(h.pool.state(id)).toBe("waiting-for-owner");
    await sleep(200);
    expect(answers(await h.log())).toEqual([]);
  });
});

describe("T536 the owner's answers", () => {
  it("allow-once selects the adapter's allow_once option and the tool runs", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, from);
    expect((await h.pool.answer(id, requestId, "allow-once")).ok).toBe(true);
    await untilTurnEnds(h, id, from);

    expect(answers(await h.log())).toMatchObject([{ outcome: "selected", optionId: "allow-once", optionKind: "allow_once" }]);
    expect(h.rec.of(id).map((entry) => entry.event)).toContainEqual({ type: "permission-closed", requestId, answer: "allow-once" });
  });

  it("reject selects reject_once and the tool shows as refused", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:execute");
    const requestId = await cardFor(h, id, from);
    expect((await h.pool.answer(id, requestId, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, from);

    expect(answers(await h.log())).toMatchObject([{ outcome: "selected", optionId: "reject-once", optionKind: "reject_once" }]);
    const statuses = h.rec.of(id).flatMap((entry) => (entry.event.type === "tool" ? [entry.event.status] : []));
    expect(statuses.at(-1)).toBe("refused");
  });

  it("allow-conversation sends allow-once and answers the next request of that kind by rule", async () => {
    h = await poolHarness();
    const id = await h.start();
    const first = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, first);
    expect((await h.pool.answer(id, requestId, "allow-conversation")).ok).toBe(true);
    await untilTurnEnds(h, id, first);

    // Same kind: no card, allowed once by the broker, listed as by rule.
    const second = h.rec.of(id).length;
    await h.turn(id, "tool:edit");
    const later = h.rec.of(id).slice(second).map((entry) => entry.event);
    expect(later.some((event) => event.type === "permission")).toBe(false);
    expect(later.some((event) => event.type === "tool" && event.byRule === true)).toBe(true);

    // Another kind still asks.
    const third = await sendOnly(h, id, "tool:execute");
    await cardFor(h, id, third);

    const sent = answers(await h.log());
    expect(sent.map((answer) => answer.optionId)).toEqual(["allow-once", "allow-once"]);
  });

  it("an `other` rule is keyed by the tool's name, not by the kind", async () => {
    h = await poolHarness();
    const id = await h.start();
    const first = await sendOnly(h, id, "tool:mcp");
    const requestId = await cardFor(h, id, first);
    expect((await h.pool.answer(id, requestId, "allow-conversation")).ok).toBe(true);
    await untilTurnEnds(h, id, first);
    const second = h.rec.of(id).length;
    await h.turn(id, "tool:mcp");
    expect(h.rec.of(id).slice(second).some((entry) => entry.event.type === "permission")).toBe(false);

    const read = { toolCallId: "a", kind: "other" as const, title: "hallpass - read_page (MCP)" };
    const click = { toolCallId: "b", kind: "other" as const, title: "hallpass - computer (MCP)" };
    expect(permissionRuleKey(read)).not.toBe(permissionRuleKey(click));
    expect(permissionRuleKey({ toolCallId: "c", kind: "edit", title: "Edit a" })).toBe(
      permissionRuleKey({ toolCallId: "d", kind: "edit", title: "Edit b" }),
    );
    // The adapter's own tool name wins over the title when it gives one.
    const named = (title: string) => ({ toolCallId: "e", kind: "other" as const, title, _meta: { claudeCode: { toolName: "mcp__x__y" } } });
    expect(permissionRuleKey(named("one"))).toBe(permissionRuleKey(named("two")));
    // Kinds that never ask get no rule.
    expect(permissionRuleKey({ toolCallId: "f", kind: "read", title: "Read" })).toBeUndefined();
  });

  it("never sends an always option, whatever the owner answers", async () => {
    h = await poolHarness();
    const id = await h.start();
    for (const answer of ["allow-once", "reject", "allow-conversation"] as const) {
      const from = await sendOnly(h, id, "tool:execute");
      const requestId = await cardFor(h, id, from);
      expect((await h.pool.answer(id, requestId, answer)).ok).toBe(true);
      await untilTurnEnds(h, id, from);
    }
    const kinds = answers(await h.log()).map((answer) => answer.optionKind);
    expect(kinds).toEqual(["allow_once", "reject_once", "allow_once"]);
  });

  it("never sends an always option for Codex either, by the owner's answer or by rule (R-317)", async () => {
    // Codex offers `accept_execpolicy_amendment` (allow_always), which would write a prefix rule into
    // the owner's own Codex configuration; the fake offers allow_always and reject_always the same way.
    h = await poolHarness();
    const id = await h.start("codex");
    for (const answer of ["allow-once", "reject", "allow-conversation"] as const) {
      const from = await sendOnly(h, id, "tool:execute");
      const requestId = await cardFor(h, id, from);
      expect((await h.pool.answer(id, requestId, answer)).ok).toBe(true);
      await untilTurnEnds(h, id, from);
    }
    await h.turn(id, "tool:execute");
    const kinds = answers(await h.log()).map((answer) => answer.optionKind);
    expect(kinds).toEqual(["allow_once", "reject_once", "allow_once", "allow_once"]);
  });

  it("a second answer to a closed card changes nothing (another panel already answered)", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, from);
    expect((await h.pool.answer(id, requestId, "reject")).ok).toBe(true);
    expect((await h.pool.answer(id, requestId, "allow-once")).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(answers(await h.log()).map((answer) => answer.optionKind)).toEqual(["reject_once"]);
  });
});

/**
 * R-317 / SC-135: Codex's request for wider sandbox permissions (codex-acp's "Grant permissions?",
 * tool `request_permissions`) is granted for the rest of the turn or the session, never for one
 * action - so in strict mode the broker declines it itself and says so; Codex then has to ask for
 * each change. In the agent's own review mode it is a card as before, with no conversation rule.
 */
describe("R-317 Codex's request for wider sandbox permissions", () => {
  const notices = (harness: Harness, id: string, from = 0) =>
    harness.rec.of(id).slice(from).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));

  it("strict mode declines it without a card, every time, and says so in the conversation", async () => {
    h = await poolHarness();
    const id = await h.start("codex");
    const from = h.rec.of(id).length;
    await h.turn(id, "grant:permissions");
    await h.turn(id, "grant:permissions");

    const events = h.rec.of(id).slice(from).map((entry) => entry.event);
    expect(events.some((event) => event.type === "permission")).toBe(false);
    expect(answers(await h.log()).map((answer) => [answer.optionId, answer.optionKind])).toEqual([
      ["reject_permissions", "reject_once"],
      ["reject_permissions", "reject_once"],
    ]);
    const said = notices(h, id, from);
    expect(said.map((notice) => notice.code)).toEqual(["sandbox-permissions-declined", "sandbox-permissions-declined"]);
    // The detail is what Codex asked for, summarised and redacted like any card's detail.
    expect(said[0]!.text).toMatch(/"fileSystem".*work.*out/u);
  });

  it("the agent's review mode shows it as a card; for this conversation is once and records no rule", async () => {
    h = await poolHarness();
    const id = await h.start("codex");
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    const first = await sendOnly(h, id, "grant:permissions");
    const requestId = await cardFor(h, id, first);
    expect((await h.pool.answer(id, requestId, "allow-conversation")).ok).toBe(true);
    await untilTurnEnds(h, id, first);

    // No rule: the next request is a card again.
    const second = await sendOnly(h, id, "grant:permissions");
    const again = await cardFor(h, id, second);
    expect((await h.pool.answer(id, again, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, second);

    // And back in strict mode it is declined, whatever was answered before.
    expect((await h.pool.setMode(id, "strict")).ok).toBe(true);
    await h.turn(id, "grant:permissions");

    expect(answers(await h.log()).map((answer) => [answer.optionId, answer.optionKind])).toEqual([
      ["allow_permissions_turn", "allow_once"],
      ["reject_permissions", "reject_once"],
      ["reject_permissions", "reject_once"],
    ]);
  });

  it("is recognised by the adapter's tool name or its request title, and nothing else", () => {
    const toolCall = { toolCallId: "x", kind: "other", title: "Additional sandbox permissions" };
    expect(isCodexSandboxPermissionsRequest({ toolCall: { ...toolCall, name: "request_permissions" } })).toBe(true);
    expect(isCodexSandboxPermissionsRequest({ toolCall, _meta: { permission: { version: 1, title: "Grant permissions?" } } })).toBe(true);
    expect(isCodexSandboxPermissionsRequest({ toolCall })).toBe(false);
    expect(isCodexSandboxPermissionsRequest({ toolCall: { ...toolCall, name: "shell" }, _meta: { permission: { title: "Run command?" } } })).toBe(
      false,
    );
  });

  it("is only Codex's: the same tool name from Claude Code is an ordinary card", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "grant:permissions");
    const requestId = await cardFor(h, id, from);
    expect((await h.pool.answer(id, requestId, "reject")).ok).toBe(true);
    await untilTurnEnds(h, id, from);
    expect(notices(h, id, from).some((notice) => notice.code === "sandbox-permissions-declined")).toBe(false);
  });
});

describe("T536 no answer, and an agent that leaves", () => {
  it("an unanswered card keeps the agent waiting indefinitely: no timeout, no idle stop", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, from);
    const pid = h.pool.agentPid(id)!;

    h.clock.advance(24 * 60 * 60_000);
    await sleep(300);
    expect(answers(await h.log())).toEqual([]);
    expect(h.pool.state(id)).toBe("waiting-for-owner");
    expect(isAlive(pid)).toBe(true);

    expect((await h.pool.answer(id, requestId, "allow-once")).ok).toBe(true);
    await untilTurnEnds(h, id, from);
  });

  it("the agent exiting while a card is open closes it as agent-exited", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = await sendOnly(h, id, "tool:edit");
    const requestId = await cardFor(h, id, from);

    process.kill(h.pool.agentPid(id)!);
    await waitFor(() => h!.pool.state(id) === "crashed", "the crashed state");

    const events = h.rec.of(id).map((entry) => entry.event);
    expect(events).toContainEqual({ type: "permission-closed", requestId, answer: "agent-exited" });
    expect(events.some((event) => event.type === "notice" && event.code === "agent-exited")).toBe(true);
    // A late answer is refused: there is no agent to give it to.
    const late = await h.pool.answer(id, requestId, "allow-once");
    expect(late.ok).toBe(false);
  });
});
