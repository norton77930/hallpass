import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import type { ConversationEntry } from "@hallpass/contracts";
import { memoryConversationIndex, type ConversationIndex } from "../src/broker/conversation-index.js";
import { poolHarness, deadPid, isAlive, sleep, waitFor, requests } from "./conversation-harness.js";

/**
 * 019/T538 - a running conversation's life in the broker (R-318, R-319; FR-297, FR-298, FR-311).
 * Idle for 10 minutes (on an injected clock) closes the agent and the next message resumes it with
 * `session/load`; at most three agents run, a fourth evicts the one idle longest and never a running
 * or waiting one, and all three busy is `too-many-running`; an agent that dies is `crashed` with an
 * `agent-exited` notice and nothing is retried; a lease marks the conversation while its agent runs
 * and another browser's `open` is refused while the lease holder lives.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;
let other: Harness | undefined;

afterEach(async () => {
  await other?.cleanup();
  await h?.cleanup();
  h = undefined;
  other = undefined;
});

const IDLE_MS = 10 * 60_000;

describe("T538 idle limit", () => {
  it("closes the agent after 10 idle minutes and resumes it with session/load on the next message", async () => {
    h = await poolHarness();
    const id = await h.start();
    await h.turn(id, "first");
    const pid = h.pool.agentPid(id)!;

    h.clock.advance(IDLE_MS - 1_000);
    await sleep(100);
    expect(h.pool.state(id)).toBe("idle");

    h.clock.advance(1_000);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");
    await waitFor(() => !isAlive(pid), "the agent process to exit");
    expect(h.rec.of(id).map((entry) => entry.event)).toContainEqual({ type: "state", state: "stopped" });

    await h.turn(id, "second");
    const log = await h.log();
    expect(requests(log, "session/load")).toHaveLength(1);
    expect(requests(log, "session/new")).toHaveLength(1);
    expect(h.pool.agentPid(id)).not.toBe(pid);
    // The resume did not replay the history this broker already streamed.
    const echoes = h.rec.of(id).filter((entry) => entry.event.type === "text" && entry.event.text.includes("echo:first"));
    expect(echoes).toHaveLength(1);
  });

  it("a running turn is not idle, however long it runs", async () => {
    h = await poolHarness();
    const id = await h.start();
    expect((await h.pool.send(id, "hang")).ok).toBe(true);
    h.clock.advance(IDLE_MS * 3);
    await sleep(200);
    expect(h.pool.state(id)).toBe("running");
  });
});

/**
 * SC-137: the history a resume shows. The agent replays the conversation on `session/load`; a broker
 * whose log holds none of it (the next browser run) shows that replay, one that already shows it
 * (an idle stop, a second open) drops it - either way each message is in the log exactly once.
 */
describe("SC-137 history on resume", () => {
  const textsOf = (harness: Harness, id: string) => {
    const page = harness.pool.page(id, 0);
    if (!page.ok) throw new Error("no page");
    return page.value.events.flatMap((entry) => (entry.event.type === "text" ? [`${entry.event.role}:${entry.event.text}`] : []));
  };
  const idleStop = async (harness: Harness, id: string) => {
    harness.clock.advance(IDLE_MS);
    await waitFor(() => harness.pool.state(id) === "stopped", "the idle stop");
  };

  it("a new broker's open shows the agent's record once, and a later open in that broker adds nothing", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start();
    await h.turn(id, "first");
    await h.pool.shutdown();

    other = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await other.pool.open(id)).ok).toBe(true);
    const history = ["owner:first", "agent:echo:first"];
    await waitFor(() => textsOf(other!, id).length >= 2, "the replayed history");
    await sleep(200);
    expect(textsOf(other, id)).toEqual(history);

    // The 10-minute idle stop, then the next open of the same broker: the replay is not shown again.
    await idleStop(other, id);
    expect((await other.pool.open(id)).ok).toBe(true);
    await sleep(200);
    expect(requests(await other.log(), "session/load")).toHaveLength(2);
    expect(textsOf(other, id)).toEqual(history);
  });

  it("a new broker's open of a Codex conversation leaves out the broker's own /rename and its answer (R-322)", async () => {
    h = await poolHarness({ browserRunId: "run-a" });
    const id = await h.start("codex");
    await h.turn(id, "first");
    // The owner's own later message that happens to start with /rename is the owner's, and is shown.
    await h.turn(id, "/rename my title");
    await h.pool.shutdown();
    // The agent's record begins with the broker's title prompt, hidden while the conversation was live.
    expect(requests(await h.log(), "session/prompt").map((line) => line.params?.text)).toEqual([
      "/rename first",
      "first",
      "/rename my title",
    ]);

    other = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b" });
    expect((await other.pool.open(id)).ok).toBe(true);
    const history = ["owner:first", "agent:echo:first", "owner:/rename my title", "agent:renamed:my title"];
    await waitFor(() => textsOf(other!, id).length >= history.length, "the replayed history");
    await sleep(200);
    expect(textsOf(other, id)).toEqual(history);
  });

  it("the broker that streamed the conversation shows it once after an idle stop and an open", async () => {
    h = await poolHarness();
    const id = await h.start();
    await h.turn(id, "first");
    await idleStop(h, id);
    expect((await h.pool.open(id)).ok).toBe(true);
    await sleep(200);
    expect(requests(await h.log(), "session/load")).toHaveLength(1);
    expect(textsOf(h, id)).toEqual(["owner:first", "agent:echo:first"]);
  });
});

describe("T538 at most three agents", () => {
  it("a fourth start evicts the idle-longest, never a running or waiting one", async () => {
    h = await poolHarness({ store: false });
    const running = await h.start();
    const waiting = await h.start();
    const oldIdle = await h.start();
    await h.turn(oldIdle, "a");
    h.clock.advance(1_000);

    expect((await h.pool.send(running, "hang")).ok).toBe(true);
    expect((await h.pool.send(waiting, "tool:edit")).ok).toBe(true);
    await waitFor(() => h!.pool.state(waiting) === "waiting-for-owner", "the card");
    // The running and waiting ones were active more recently, but are idle-longest by no measure.
    h.clock.advance(1_000);

    const fourth = await h.start();
    expect(h.pool.state(oldIdle)).toBe("stopped");
    expect(h.pool.state(running)).toBe("running");
    expect(h.pool.state(waiting)).toBe("waiting-for-owner");
    expect(h.pool.state(fourth)).toBe("idle");
  });

  it("among idle ones, the one idle longest goes", async () => {
    h = await poolHarness({ store: false });
    const a = await h.start();
    h.clock.advance(1_000);
    const b = await h.start();
    h.clock.advance(1_000);
    const c = await h.start();
    h.clock.advance(1_000);
    await h.turn(a, "used again"); // a is now the most recent; b is idle longest
    h.clock.advance(1_000);

    await h.start();
    expect(h.pool.state(b)).toBe("stopped");
    expect(h.pool.state(a)).toBe("idle");
    expect(h.pool.state(c)).toBe("idle");
  });

  it("with all three busy a fourth is refused as too-many-running and nothing is spawned", async () => {
    h = await poolHarness({ store: false });
    const ids = [await h.start(), await h.start(), await h.start()];
    expect((await h.pool.send(ids[0]!, "hang")).ok).toBe(true);
    expect((await h.pool.send(ids[1]!, "hang")).ok).toBe(true);
    expect((await h.pool.send(ids[2]!, "tool:edit")).ok).toBe(true);
    await waitFor(() => h!.pool.state(ids[2]!) === "waiting-for-owner", "the card");
    const startsBefore = (await h.log()).filter((line) => line.event === "start").length;

    const refused = await h.pool.start("claude-code", { kind: "scratch" });
    expect(refused).toMatchObject({ ok: false, error: { code: "too-many-running" } });
    expect((await h.log()).filter((line) => line.event === "start").length).toBe(startsBefore);
    for (const id of ids) expect(h.pool.state(id)).not.toBe("stopped");
  });

  it("resuming a stopped conversation counts against the cap too", async () => {
    h = await poolHarness({ store: false });
    const stopped = await h.start();
    h.clock.advance(IDLE_MS);
    await waitFor(() => h!.pool.state(stopped) === "stopped", "the idle stop");
    const busy = [await h.start(), await h.start(), await h.start()];
    for (const id of busy) expect((await h.pool.send(id, "hang")).ok).toBe(true);

    const refused = await h.pool.send(stopped, "hello");
    expect(refused).toMatchObject({ ok: false, error: { code: "too-many-running" } });
  });
});

describe("T572 one agent per conversation", () => {
  const stoppedConversation = async (): Promise<{ id: string; starts: () => Promise<number>; from: number }> => {
    h = await poolHarness();
    const id = await h.start();
    await h.turn(id, "first");
    h.clock.advance(IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");
    const starts = async () => (await h!.log()).filter((line) => line.event === "start").length;
    return { id, starts, from: h.rec.events.length };
  };

  it("two opens of a stopped conversation at once start one agent, and its log gets one run's events", async () => {
    const { id, starts, from } = await stoppedConversation();
    const before = await starts();

    const [first, second] = await Promise.all([h!.pool.open(id), h!.pool.open(id)]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    await sleep(300);

    expect((await starts()) - before).toBe(1);
    expect(requests(await h!.log(), "session/load")).toHaveLength(1);
    expect(h!.pool.state(id)).toBe("idle");
    const modes = h!.rec.events.slice(from).filter((entry) => entry.conversationId === id && entry.event.type === "mode");
    expect(modes).toHaveLength(1);
  });

  it("an open and a message at once start one agent; the message is sent or refused busy", async () => {
    const { id, starts } = await stoppedConversation();
    const before = await starts();

    const [opened, sent] = await Promise.all([h!.pool.open(id), h!.pool.send(id, "hello")]);
    expect(opened).toEqual({ ok: true });
    if (!sent.ok) expect(sent.error.code).toBe("busy");
    await sleep(300);

    expect((await starts()) - before).toBe(1);
  });
});

describe("T538 crash", () => {
  it("an agent that dies mid-turn leaves the conversation crashed with an agent-exited notice, and nothing is retried", async () => {
    h = await poolHarness();
    const id = await h.start();
    expect((await h.pool.send(id, "crash")).ok).toBe(true);
    await waitFor(() => h!.pool.state(id) === "crashed", "the crashed state");
    await sleep(300);

    const events = h.rec.of(id).map((entry) => entry.event);
    expect(events.filter((event) => event.type === "notice" && event.code === "agent-exited")).toHaveLength(1);
    expect(events).toContainEqual({ type: "state", state: "crashed" });
    const log = await h.log();
    expect(log.filter((line) => line.event === "start")).toHaveLength(1);
    expect(requests(log, "session/prompt")).toHaveLength(1);

    // "Continue" is the owner's: the next message resumes it.
    await h.turn(id, "again");
    expect(requests(await h.log(), "session/load")).toHaveLength(1);
  });
});

describe("T538 lease across browsers", () => {
  it("is set while the agent runs and cleared when it stops", async () => {
    h = await poolHarness({ browserRunId: "run-a", brokerPid: process.pid });
    const id = await h.start();
    expect((await h.index.get(id))?.lease).toMatchObject({ browserRunId: "run-a", pid: process.pid });

    h.clock.advance(IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");
    await waitFor(async () => (await h!.index.get(id))?.lease === undefined, "the lease to clear");
  });

  it("another browser's open is refused while the holder lives, and goes ahead when it is dead", async () => {
    h = await poolHarness({ browserRunId: "run-a", brokerPid: process.pid });
    const id = await h.start();
    await h.turn(id, "first");

    other = await poolHarness({ dir: h.dir, index: h.index, browserRunId: "run-b", brokerPid: 4_000_001 });
    const refused = await other.pool.open(id);
    expect(refused).toMatchObject({ ok: false, error: { code: "in-use-elsewhere" } });
    expect((await other.pool.send(id, "hi")).ok).toBe(false);
    const view = (await other.pool.views()).find((entry) => entry.conversationId === id);
    expect(view?.inUseElsewhere).toBe(true);

    // The first broker is gone without clearing its lease: a dead pid's lease is ignored.
    await h.pool.shutdown();
    const entry = (await h.index.get(id))!;
    await h.index.put({ ...entry, lease: { browserRunId: "run-a", pid: await deadPid(), at: new Date().toISOString() } });
    const opened = await other.pool.open(id);
    expect(opened.ok).toBe(true);
    expect((await h.index.get(id))?.lease).toMatchObject({ browserRunId: "run-b", pid: 4_000_001 });
  });
});

/**
 * T577 (D-019-14): after an extension reload the new broker lists conversations whose lease the old
 * broker still holds while it shuts down. When that lease goes - released, or its holder dead - the
 * list is sent again, so the panel does not keep "in use in another browser" until the next change.
 */
describe("T577 a lease released after the list was sent", () => {
  const ID = "conv-0000000000000577";
  const leased = (pid: number): ConversationEntry => ({
    conversationId: ID,
    agent: "claude-code",
    agentSessionId: "session-577",
    title: "Held by the old broker",
    folder: { kind: "scratch" },
    mode: "strict",
    createdAt: "2026-10-20T00:00:00.000Z",
    lastUsedAt: "2026-10-20T00:00:00.000Z",
    resumable: true,
    lease: { browserRunId: "run-a", pid, at: "2026-10-20T00:00:00.000Z" },
  });

  async function listedHeld(index: ConversationIndex) {
    let changes = 0;
    h = await poolHarness({ index, browserRunId: "run-b", brokerPid: 4_000_002, onChange: () => (changes += 1) });
    expect((await h.pool.views())[0]?.inUseElsewhere).toBe(true);
    return { changes: () => changes };
  }

  it("re-sends the list once the old broker releases the lease, and not while it holds it", async () => {
    const index = memoryConversationIndex([leased(process.pid)]);
    const seen = await listedHeld(index);

    h!.clock.advance(5_000);
    await sleep(100);
    expect(seen.changes()).toBe(0);

    const { lease: _released, ...free } = (await index.get(ID))!;
    await index.put(free);
    h!.clock.advance(5_000);
    await waitFor(() => seen.changes() === 1, "the list to be sent again");
    expect((await h!.pool.views())[0]?.inUseElsewhere).toBeUndefined();
  });

  it("re-sends the list once the lease's holder is dead", async () => {
    let holderAlive = true;
    const index = memoryConversationIndex([leased(4_000_001)]);
    let changes = 0;
    h = await poolHarness({
      index,
      browserRunId: "run-b",
      brokerPid: 4_000_002,
      isAlive: () => holderAlive,
      onChange: () => (changes += 1),
    });
    expect((await h.pool.views())[0]?.inUseElsewhere).toBe(true);

    holderAlive = false;
    h.clock.advance(5_000);
    await waitFor(() => changes === 1, "the list to be sent again");
    expect((await h.pool.views())[0]?.inUseElsewhere).toBeUndefined();
  });
});
