import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import type { ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import { CONVERSATION_PAGE_MAX_BYTES, conversationEventSchema, conversationPageFrameSchema, type ConversationEvent } from "@hallpass/contracts";
import type { AdapterLaunchSpec } from "../src/broker/agents.js";
import { spawnAgentProcess } from "../src/broker/conversation.js";
import { CONVERSATION_LOG_CAP_BYTES, ConversationEventLog } from "../src/broker/event-log.js";
import { poolHarness, turnEnded, waitFor, type Recorded } from "./conversation-harness.js";

/**
 * 019/T537 - the live stream and the log behind it (R-318, FR-285, FR-287, FR-295). Text is
 * coalesced to at most one frame per 50 ms; tool events carry their status transitions; stop sends
 * `session/cancel` and nothing more of that turn's tools is shown; the per-conversation log is capped
 * at 256 KB by coalescing the oldest text first; pages are at most 256 KB with `more`; `seq` only
 * ever increases.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const texts = (events: Recorded[]) => events.filter((entry) => entry.event.type === "text");
const joined = (events: Recorded[]) =>
  texts(events)
    .map((entry) => (entry.event.type === "text" ? entry.event.text : ""))
    .join("");

describe("T537 text coalescing", () => {
  it("emits at most one text frame per 50 ms and loses nothing", { retry: 2 }, async () => { // wall-clock: a loaded machine can space every chunk past 50 ms
    h = await poolHarness({ env: { FAKE_ACP_CHUNK_DELAY_MS: "5" } });
    const id = await h.start();
    const from = h.rec.of(id).length;
    await h.turn(id, "chunks:60");

    const turn = h.rec.of(id).slice(from);
    const agentText = turn.filter((entry) => entry.event.type === "text" && entry.event.role === "agent");
    expect(joined(agentText)).toBe(Array.from({ length: 60 }, (_, index) => `part-${index + 1};`).join(""));
    expect(agentText.length).toBeLessThan(60);
    for (let index = 1; index < agentText.length; index++) {
      expect(agentText[index]!.at - agentText[index - 1]!.at).toBeGreaterThanOrEqual(48); // 50 ms, less the clock granularity of the two timestamps
    }
  });

  it("echoes the owner's message as owner text, before the agent's answer", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    await h.turn(id, "hello there");
    const turn = texts(h.rec.of(id).slice(from)).map((entry) => entry.event);
    expect(turn[0]).toEqual({ type: "text", role: "owner", text: "hello there" });
    expect(turn.slice(1).map((event) => (event.type === "text" ? event.text : "")).join("")).toBe("echo:hello there");
  });
});

describe("T537 tool events", () => {
  it("carry the status transitions pending -> running -> done", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    expect((await h.pool.send(id, "tool:edit")).ok).toBe(true);
    let requestId = "";
    await waitFor(() => {
      const card = h!.rec.of(id).slice(from).find((entry) => entry.event.type === "permission");
      if (card?.event.type === "permission") requestId = card.event.requestId;
      return requestId !== "";
    }, "the card");
    await h.pool.answer(id, requestId, "allow-once");
    await waitFor(() => turnEnded(h!.rec.of(id).slice(from), id), "the end of the turn");

    const tools = h.rec.of(id).slice(from).flatMap((entry) => (entry.event.type === "tool" ? [entry.event] : []));
    const statuses = tools.map((tool) => tool.status).filter((status, index, all) => status !== all[index - 1]);
    expect(statuses).toEqual(["pending", "running", "done"]);
    expect(tools[0]).toMatchObject({ kind: "edit", title: "Edit src/app.ts", inputSummary: expect.stringMatching(/src\/app\.ts/u) });
    expect(new Set(tools.map((tool) => tool.toolCallId)).size).toBe(1);
  });

  it("stop sends session/cancel, closes the card as cancelled and shows no further tool event of that turn", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    expect((await h.pool.send(id, "tool:edit")).ok).toBe(true);
    let requestId = "";
    await waitFor(() => {
      const card = h!.rec.of(id).slice(from).find((entry) => entry.event.type === "permission");
      if (card?.event.type === "permission") requestId = card.event.requestId;
      return requestId !== "";
    }, "the card");

    const stoppedAt = h.rec.of(id).length;
    expect((await h.pool.stop(id)).ok).toBe(true);
    await waitFor(() => turnEnded(h!.rec.of(id).slice(stoppedAt), id), "the end of the stopped turn");

    expect((await h.log()).some((line) => line.method === "session/cancel")).toBe(true);
    const after = h.rec.of(id).slice(stoppedAt).map((entry) => entry.event);
    expect(after).toContainEqual({ type: "permission-closed", requestId, answer: "cancelled" });
    expect(after.some((event) => event.type === "tool")).toBe(false);
    expect(h.pool.state(id)).toBe("idle");
  });

  it("stop ends a turn that would never end on its own", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    expect((await h.pool.send(id, "chunks:2 hang")).ok).toBe(true);
    await waitFor(() => joined(h!.rec.of(id).slice(from)).includes("part-2;"), "the chunks before the hang");
    expect((await h.pool.stop(id)).ok).toBe(true);
    await waitFor(() => turnEnded(h!.rec.of(id).slice(from), id), "the end of the stopped turn");
    expect(h.pool.state(id)).toBe("idle");
    // US1.4: the conversation says it was stopped.
    expect(h.rec.of(id).slice(from).map((entry) => entry.event)).toContainEqual({
      type: "notice",
      code: "turn-stopped",
      text: expect.stringMatching(/stopped/iu),
    });
  });
});

/**
 * T572: an agent that ends its turn for another reason than `end_turn` / `cancelled` gets a notice
 * whose code is one of a fixed few - never built from the agent's text, which can outgrow the
 * contract's 64-character code and have the worker drop the notice.
 */
describe("T572 the code of a turn that ended for another reason", () => {
  /** The fake agent, with every turn's `end_turn` rewritten to `stopReason` on its way to the broker. */
  const endingWith =
    (stopReason: string) =>
    (spec: AdapterLaunchSpec, cwd: string): ChildProcess => {
      const child = spawnAgentProcess(spec, cwd);
      const rewritten = child.stdout!.pipe(
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            done(null, chunk.toString("utf8").replaceAll('"stopReason":"end_turn"', `"stopReason":${JSON.stringify(stopReason)}`));
          },
        }),
      );
      return new Proxy(child, {
        get(target, key) {
          if (key === "stdout") return rewritten;
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };

  const noticeOf = async (stopReason: string) => {
    h = await poolHarness({ spawnAgent: endingWith(stopReason) });
    const id = await h.start();
    const from = h.rec.of(id).length;
    await h.turn(id, "hello");
    const notices = h.rec.of(id).slice(from).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));
    expect(notices).toHaveLength(1);
    expect(conversationEventSchema.safeParse(notices[0]).success).toBe(true);
    return notices[0]!;
  };

  it("a known ACP stop reason has its own fixed code", async () => {
    expect((await noticeOf("max_turn_requests")).code).toBe("stop-max_turn_requests");
  });

  it("any other reason, however long, is the one fixed code stop-other", async () => {
    expect((await noticeOf(`a-reason-no-adapter-documents-${"x".repeat(80)}`)).code).toBe("stop-other");
  });
});

describe("T537 the log and its pages", () => {
  it("seq strictly increases, and the pages of a live conversation are exactly what was streamed", async () => {
    h = await poolHarness();
    const id = await h.start();
    await h.turn(id, "chunks:3");
    await h.turn(id, "again");

    const streamed = h.rec.of(id);
    for (let index = 1; index < streamed.length; index++) expect(streamed[index]!.seq).toBeGreaterThan(streamed[index - 1]!.seq);

    const page = h.pool.page(id, 0);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.more).toBe(false);
    expect(page.value.events).toEqual(streamed.map((entry) => ({ seq: entry.seq, event: entry.event })));
    expect(
      conversationPageFrameSchema.safeParse({ type: "conversation-page", sessionId: "broker-1", conversationId: id, ...page.value }).success,
    ).toBe(true);
  });

  it("is capped at 256 KB by coalescing the oldest text first, keeping the newest and the tools", () => {
    const log = new ConversationEventLog();
    const big = (n: number) => `${String(n).padStart(4, "0")}${"x".repeat(16 * 1024 - 8)}`;
    const tools: ConversationEvent[] = [];
    let lastSeq = -1;
    for (let n = 0; n < 40; n++) {
      const seq = log.append({ type: "text", role: "agent", text: big(n) });
      expect(seq).toBeGreaterThan(lastSeq);
      lastSeq = seq;
      if (n % 5 === 0) {
        const tool: ConversationEvent = {
          type: "tool",
          toolCallId: `call-${n}`,
          kind: "edit",
          title: `Edit ${n}`,
          inputSummary: "x",
          status: "done",
        };
        tools.push(tool);
        lastSeq = log.append(tool);
      }
    }
    expect(log.bytes).toBeLessThanOrEqual(CONVERSATION_LOG_CAP_BYTES);
    expect(JSON.stringify(log.entries).length).toBe(log.bytes);
    const kept = log.entries.map((entry) => entry.event);
    // The newest text is whole; every tool event survived; seq still increases.
    expect(kept.at(-1)).toEqual({ type: "text", role: "agent", text: big(39) });
    for (const tool of tools) expect(kept).toContainEqual(tool);
    for (let index = 1; index < log.entries.length; index++) {
      expect(log.entries[index]!.seq).toBeGreaterThan(log.entries[index - 1]!.seq);
    }
    // What gave way is the oldest text: the newest texts are whole, older runs were coalesced.
    for (let n = 35; n < 40; n++) expect(kept).toContainEqual({ type: "text", role: "agent", text: big(n) });
    const keptTexts = kept.flatMap((event) => (event.type === "text" ? [event.text] : []));
    expect(keptTexts.length).toBeLessThan(40);
    expect(keptTexts.some((text) => text.startsWith("…"))).toBe(true);
    expect(keptTexts.findIndex((text) => text.startsWith("…"))).toBeLessThan(keptTexts.indexOf(big(35)));
  });

  it("serves pages of at most 256 KB and 4096 entries, with `more` until the end", () => {
    const log = new ConversationEventLog();
    for (let n = 0; n < 5000; n++) log.append({ type: "state", state: n % 2 === 0 ? "running" : "idle" });
    const seen: number[] = [];
    let fromSeq = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = log.page(fromSeq);
      expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(CONVERSATION_PAGE_MAX_BYTES);
      expect(page.events.length).toBeLessThanOrEqual(4096);
      expect(
        conversationPageFrameSchema.safeParse({ type: "conversation-page", sessionId: "b", conversationId: "c".repeat(16), ...page })
          .success,
      ).toBe(true);
      seen.push(...page.events.map((entry) => entry.seq));
      if (!page.more) break;
      fromSeq = page.events.at(-1)!.seq + 1;
    }
    expect(seen).toEqual(log.entries.map((entry) => entry.seq));

    // A smaller byte bound splits the same log into more pages, each within it.
    const small = log.page(0, 10 * 1024);
    expect(small.more).toBe(true);
    expect(JSON.stringify(small.events).length).toBeLessThanOrEqual(10 * 1024);
  });

  it("never drops a card that is still open, even when it is the oldest thing in the log", () => {
    const log = new ConversationEventLog({ capBytes: 4 * 1024 });
    log.append({ type: "permission", requestId: "r-1", toolCallId: "t", kind: "edit", title: "Edit", detail: "d" });
    for (let n = 0; n < 50; n++) log.append({ type: "state", state: "running" });
    expect(log.entries[0]!.event).toMatchObject({ type: "permission", requestId: "r-1" });
    expect(log.bytes).toBeLessThanOrEqual(4 * 1024);
    log.append({ type: "permission-closed", requestId: "r-1", answer: "allow-once" });
    for (let n = 0; n < 50; n++) log.append({ type: "state", state: "running" });
    expect(log.entries.some((entry) => entry.event.type === "permission")).toBe(false);
  });
});

describe("023 R-371 thinking", () => {
  it("says once per turn that the agent is thinking, before its answer, without the thought", async () => {
    h = await poolHarness();
    const id = await h.start();
    const from = h.rec.of(id).length;
    await h.turn(id, "think:20 chunks:1");

    const turn = h.rec.of(id).slice(from).map((entry) => entry.event);
    const thinking = turn.filter((event) => event.type === "activity");
    expect(thinking).toEqual([{ type: "activity", activity: "thinking" }]);
    expect(conversationEventSchema.safeParse(thinking[0]).success).toBe(true);
    const at = turn.indexOf(thinking[0]!);
    expect(turn.findIndex((event) => event.type === "text" && event.role === "owner")).toBeLessThan(at);
    expect(turn.findIndex((event) => event.type === "text" && event.role === "agent")).toBeGreaterThan(at);
    expect(JSON.stringify(turn)).not.toContain("thought-");
  });
});
