import { describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { createRelayMux, type MuxConnection } from "../src/relay-mux.js";

/**
 * 004/T089 — the relay's multiplexer, the piece that makes several agent sessions share one browser.
 *
 * 003 had one server listening and the relay dialling it, so a second session overwrote the first
 * one's record and every session ended up `bridge-unavailable` (the owner's E1). R-111 turns the
 * link around: the relay listens, every server dials in, and this object is what keeps their traffic
 * apart. It is pure on purpose - connections are opaque handles with a `send` - so the isolation
 * property is a plain assertion instead of an inference from two live sockets.
 */

const TOKEN = "t".repeat(64);
const RELAY_PID = 4242;

type FakeConnection = MuxConnection & { sent: unknown[]; closes: number };

function fakeConnection(): FakeConnection {
  const sent: unknown[] = [];
  const connection: FakeConnection = {
    sent,
    closes: 0,
    send(value: unknown): void {
      sent.push(value);
    },
    close(): void {
      connection.closes += 1;
    },
  };
  return connection;
}

function createHarness(): {
  mux: ReturnType<typeof createRelayMux>;
  toWorker: unknown[];
  logs: string[];
} {
  const toWorker: unknown[] = [];
  const logs: string[] = [];
  const mux = createRelayMux({
    token: TOKEN,
    relayPid: RELAY_PID,
    toWorker: (frame) => toWorker.push(frame),
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
  });
  return { mux, toWorker, logs };
}

function hello(sessionId: string, token: string = TOKEN): Record<string, unknown> {
  return {
    type: "hello",
    sessionId,
    agentId: "claude-code",
    displayName: "Claude Code",
    token,
    protocol: AGENT_LINK_PROTOCOL,
  };
}

describe("relay multiplexer", () => {
  it("registers a connection that greets with the relay's own token", () => {
    const { mux } = createHarness();
    const connection = fakeConnection();

    expect(mux.fromServer(connection, hello("s-1"))).toBe("accepted");

    expect(connection.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(mux.sessionIds()).toEqual(["s-1"]);
  });

  it("rejects a greeting whose token is wrong or missing, and registers nothing", () => {
    const { mux, logs } = createHarness();
    const wrong = fakeConnection();
    const missing = fakeConnection();
    const { token: _dropped, ...tokenless } = hello("s-2");

    expect(mux.fromServer(wrong, hello("s-1", "n".repeat(64)))).toBe("rejected");
    expect(mux.fromServer(missing, tokenless)).toBe("rejected");

    // Nothing acknowledged and nothing registered: the caller closes a rejected socket, and a
    // session that was never registered must not be reachable from the worker side either.
    expect(wrong.sent).toEqual([]);
    expect(missing.sent).toEqual([]);
    expect(mux.sessionIds()).toEqual([]);
    expect(logs.filter((line) => line.startsWith("relay.mux.hello-refused"))).toHaveLength(2);
  });

  /**
   * 004/T099j - Chrome keeps the relay it spawned for the life of the browser, so a host upgrade
   * puts an old server and a new relay on the same record. Refusing with a code that names the
   * protocol is what turns that from an endless retry into one line.
   */
  it("refuses a greeting stamped with another protocol", () => {
    const { mux, logs, toWorker } = createHarness();
    const connection = fakeConnection();

    expect(
      mux.fromServer(connection, { ...hello("s-1"), protocol: AGENT_LINK_PROTOCOL + 1 }),
    ).toBe("rejected");

    expect(mux.sessionIds()).toEqual([]);
    expect(toWorker).toEqual([]);
    expect(logs.some((line) => line.startsWith("relay.mux.hello-refused protocol"))).toBe(true);
  });

  it("rejects any frame from a connection that has not greeted", () => {
    const { mux, toWorker } = createHarness();
    const stranger = fakeConnection();

    expect(
      mux.fromServer(stranger, { callId: "c-1", sessionId: "s-1", tool: "tabs_context", args: {} }),
    ).toBe("rejected");

    expect(toWorker).toEqual([]);
  });

  it("forwards a greeted server's frames to the worker unchanged", () => {
    const { mux, toWorker } = createHarness();
    const connection = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    // The greeting's own announcement (T099i) is not what this test is about.
    toWorker.length = 0;
    const call = {
      callId: "c-1",
      sessionId: "s-1",
      tool: "navigate",
      args: { url: "https://example.test/" },
      somethingTheRelayNeverHeardOf: 7,
    };

    expect(mux.fromServer(connection, call)).toBe("accepted");

    // The relay is a pump: it re-encodes but never rewrites, so a field only the worker understands
    // still survives the hop (contracts README section 1).
    expect(toWorker).toEqual([call]);
  });

  /**
   * 004/T099i - `hello` is the announcement, and the token is not part of it.
   *
   * Session liveness used to ride on `pair-request`: the relay consumed `hello` and the worker
   * learned a session existed only because a server sent a pairing request on every attach. S2
   * revisits pairing, so any change to when a pair-request is sent would silently unregister live
   * sessions (FR-058). The greeting is what a server sends on every attach by definition, so it is
   * what the worker registers on - stripped of the token, which is this relay's own business and
   * has no reason to reach the extension.
   */
  it("forwards the greeting to the worker as the session's announcement, without the token", () => {
    const { mux, toWorker } = createHarness();
    const connection = fakeConnection();

    expect(mux.fromServer(connection, hello("s-1"))).toBe("accepted");

    expect(toWorker).toEqual([
      { type: "hello", sessionId: "s-1", agentId: "claude-code", displayName: "Claude Code" },
    ]);
    expect(JSON.stringify(toWorker)).not.toContain(TOKEN);
  });

  it("routes a worker answer back by callId and a control frame by sessionId", () => {
    const { mux } = createHarness();
    const connection = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    mux.fromServer(connection, { callId: "c-1", sessionId: "s-1", tool: "tabs_context", args: {} });

    mux.fromWorker({ callId: "c-1", outcome: "ok", result: [] });
    mux.fromWorker({ type: "pairing-result", sessionId: "s-1", decision: "accepted" });

    expect(connection.sent).toEqual([
      { type: "hello-ack", relayPid: RELAY_PID },
      { callId: "c-1", outcome: "ok", result: [] },
      { type: "pairing-result", sessionId: "s-1", decision: "accepted" },
    ]);
  });

  /**
   * 011/T289 — a "still waiting" tick is about a call without being its answer.
   *
   * The mux routes a worker frame by the `callId` it names and forgets the call once it has, which
   * is right for an answer and wrong for a tick: the tick names the call it concerns, the answer is
   * still to come, and forgetting the call here would leave the owner's eventual Allow with nowhere
   * to go - dropped as unaddressed, the agent answered by a backstop instead. So the entry survives
   * a tick and is spent by the answer, and the frame itself is forwarded unchanged like every other.
   */
  it("forwards a prompt-waiting tick without spending the call it names", () => {
    const { mux, logs } = createHarness();
    const connection = fakeConnection();
    const other = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    mux.fromServer(other, hello("s-2"));
    mux.fromServer(connection, { callId: "c-1", sessionId: "s-1", tool: "click", args: {} });

    const tick = {
      type: "prompt-waiting",
      sessionId: "s-1",
      callId: "c-1",
      kind: "ask",
      panelConnected: false,
      waitedMs: 5_000,
      boundMs: 120_000,
    };
    mux.fromWorker(tick);
    // Two minutes later the owner opened the panel and pressed Allow.
    mux.fromWorker({ callId: "c-1", outcome: "ok", result: { verdict: "acted" } });

    expect(connection.sent).toEqual([
      { type: "hello-ack", relayPid: RELAY_PID },
      tick,
      { callId: "c-1", outcome: "ok", result: { verdict: "acted" } },
    ]);
    // Never to the other session, and nothing was dropped on the way.
    expect(other.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(logs.filter((line) => line.startsWith("relay.mux.dropped"))).toEqual([]);
    // And the call is finished once its answer has gone: the drain has nothing left to wait for.
    expect(mux.pendingCallCount()).toBe(0);
  });

  /**
   * 011 review H1 — a question raised inside a batch has to name the batch to be routed at all.
   *
   * The relay knows the call ids it handed out and nothing else. A batch step runs under an id the
   * worker derives (`<batch>#<i>`) and never sends here, so a tick carrying that id is addressed to
   * nobody: it is dropped, the server never hears it, and the batch is given up on by the backstop
   * while the owner is still looking at the card. The worker says the batch's own id instead.
   */
  it("routes a batch step's tick by the batch call the server made", () => {
    const { mux, logs } = createHarness();
    const connection = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    mux.fromServer(connection, { callId: "c-1", sessionId: "s-1", tool: "browser_batch", args: {} });

    const step = {
      type: "prompt-waiting",
      sessionId: "s-1",
      callId: "c-1#0",
      kind: "ask",
      panelConnected: false,
      waitedMs: 5_000,
      boundMs: 120_000,
    };
    mux.fromWorker(step);
    // The id the worker's dispatch invented reaches nobody, which is why it must not be sent.
    expect(connection.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(logs.filter((line) => line.startsWith("relay.mux.dropped"))).toEqual(["relay.mux.dropped call"]);

    const batch = { ...step, callId: "c-1" };
    mux.fromWorker(batch);

    expect(connection.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }, batch]);
    // And the batch is still in flight: its answer has not been sent yet.
    expect(mux.pendingCallCount()).toBe(1);
  });

  it("drops a frame for an unknown callId or sessionId instead of broadcasting it", () => {
    const { mux, logs } = createHarness();
    const first = fakeConnection();
    const second = fakeConnection();
    mux.fromServer(first, hello("s-1"));
    mux.fromServer(second, hello("s-2"));

    mux.fromWorker({ callId: "c-nobody", outcome: "ok", result: [] });
    mux.fromWorker({ type: "pairing-result", sessionId: "s-nobody", decision: "accepted" });
    mux.fromWorker({ type: "bridge-unavailable" });

    // Isolation is the whole point of the multiplexer: an answer nobody is waiting for must reach
    // nobody. Broadcasting an unrouted frame would hand one session another session's answer.
    expect(first.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(second.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(logs.filter((line) => line.startsWith("relay.mux.dropped"))).toHaveLength(3);
    // A drop names the frame's own `type` - a protocol code, never anything page-derived - because
    // an anonymous "unaddressed" is what made the T096b pairing defect need a diagnosis instead of
    // reporting itself from the relay log.
    expect(logs).toContain("relay.mux.dropped unaddressed type=bridge-unavailable");
  });

  it("announces one session-ended when a connection closes, and stops routing its calls", () => {
    const { mux, toWorker, logs } = createHarness();
    const connection = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    mux.fromServer(connection, { callId: "c-1", sessionId: "s-1", tool: "wait", args: {} });
    toWorker.length = 0;

    mux.closed(connection);
    mux.closed(connection);

    expect(toWorker).toEqual([{ type: "session-ended", sessionId: "s-1" }]);
    expect(mux.sessionIds()).toEqual([]);

    // The answer to the call that was in flight arrives at a socket that is gone; it is dropped, not
    // handed to whoever connects next.
    mux.fromWorker({ callId: "c-1", outcome: "ok", result: [] });
    expect(connection.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(logs.filter((line) => line.startsWith("relay.mux.dropped"))).toHaveLength(1);
  });

  /**
   * The owner's E1, in one test: two sessions calling at the same time.
   *
   * Under 003 the second session's server overwrote `bridge.json` and the relay stayed attached to
   * the first, so both sessions saw `bridge-unavailable`. Here both are attached at once, their
   * calls interleave, and each answer goes to exactly the session that asked - never to both, never
   * to the other one.
   */
  it("keeps two sessions' interleaved calls apart", () => {
    const { mux, toWorker } = createHarness();
    const alice = fakeConnection();
    const bob = fakeConnection();
    mux.fromServer(alice, hello("s-alice"));
    mux.fromServer(bob, hello("s-bob"));

    mux.fromServer(alice, { callId: "c-a1", sessionId: "s-alice", tool: "get_page_text", args: {} });
    mux.fromServer(bob, { callId: "c-b1", sessionId: "s-bob", tool: "get_page_text", args: {} });
    mux.fromServer(alice, { callId: "c-a2", sessionId: "s-alice", tool: "screenshot", args: {} });

    // The worker answers out of order, as it will whenever one page is slower than another.
    mux.fromWorker({ callId: "c-b1", outcome: "ok", result: { text: "bob page" } });
    mux.fromWorker({ callId: "c-a2", outcome: "ok", result: { data: "png", mimeType: "image/png" } });
    mux.fromWorker({ callId: "c-a1", outcome: "ok", result: { text: "alice page" } });

    expect(alice.sent).toEqual([
      { type: "hello-ack", relayPid: RELAY_PID },
      { callId: "c-a2", outcome: "ok", result: { data: "png", mimeType: "image/png" } },
      { callId: "c-a1", outcome: "ok", result: { text: "alice page" } },
    ]);
    expect(bob.sent).toEqual([
      { type: "hello-ack", relayPid: RELAY_PID },
      { callId: "c-b1", outcome: "ok", result: { text: "bob page" } },
    ]);
    // Both sessions' calls reached the worker, in the order they were made. The two announcements
    // the greetings forwarded carry no `callId` and are not part of that order (T099i).
    expect(
      toWorker
        .map((frame) => (frame as { callId?: string }).callId)
        .filter((callId) => callId !== undefined),
    ).toEqual(["c-a1", "c-b1", "c-a2"]);
  });

  it("replaces the connection when a session greets again, without ending the session", () => {
    const { mux, toWorker } = createHarness();
    const first = fakeConnection();
    mux.fromServer(first, hello("s-1"));
    mux.fromServer(first, { callId: "c-1", sessionId: "s-1", tool: "wait", args: {} });
    toWorker.length = 0;

    // The same server after a link drop: it dialled again and greeted with the same session id.
    const second = fakeConnection();
    expect(mux.fromServer(second, hello("s-1"))).toBe("accepted");
    mux.closed(first);

    // No `session-ended`: the session did not end, its socket did. Telling the worker otherwise
    // would release the tabs of a session that is still running. What the worker does hear is the
    // announcement (T099i), which is how a reconnect keeps the group it already owns.
    expect(toWorker).toEqual([
      { type: "hello", sessionId: "s-1", agentId: "claude-code", displayName: "Claude Code" },
    ]);
    expect(mux.sessionIds()).toEqual(["s-1"]);
    mux.fromWorker({ callId: "c-1", outcome: "ok", result: null });
    expect(second.sent).toEqual([
      { type: "hello-ack", relayPid: RELAY_PID },
      { callId: "c-1", outcome: "ok", result: null },
    ]);
  });

  /**
   * 004/T099e - the frame's own `sessionId` is a claim, not an identity.
   *
   * The relay knows which session greeted on this socket; the worker keys sessions, pairing and tab
   * ownership on the id inside the frame. If the relay forwards a frame that names a *different*
   * session, one greeted connection can end another session, run tools in its context and take its
   * answers. S2 hands other sessions' ids to callers (`holder`, `held-by-session`), so the claim
   * has to be checked where both halves are known - here.
   */
  it("refuses a greeted connection's frame that names another session", () => {
    const { mux, toWorker, logs } = createHarness();
    const alice = fakeConnection();
    const bob = fakeConnection();
    mux.fromServer(alice, hello("s-alice"));
    mux.fromServer(bob, hello("s-bob"));
    toWorker.length = 0;

    expect(
      mux.fromServer(alice, { callId: "c-steal", sessionId: "s-bob", tool: "get_page_text", args: {} }),
    ).not.toBe("accepted");
    expect(mux.fromServer(alice, { type: "stop", sessionId: "s-bob" })).not.toBe("accepted");
    expect(
      mux.fromServer(alice, { type: "pair-request", sessionId: "s-bob", agentId: "other" }),
    ).not.toBe("accepted");
    // A frame that names nobody is a claim too - the relay would have keyed nothing and the worker
    // would have read `undefined` as "the" session.
    expect(mux.fromServer(alice, { callId: "c-anon", tool: "get_page_text", args: {} })).not.toBe(
      "accepted",
    );

    expect(toWorker).toEqual([]);
    expect(logs.filter((line) => line.startsWith("relay.mux.frame-refused"))).toHaveLength(4);
    // Nothing was keyed either: an answer for the refused call must not route to the sender.
    mux.fromWorker({ callId: "c-steal", outcome: "ok", result: { text: "bob page" } });
    expect(alice.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(bob.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
  });

  it("closes the connection a repeat hello takes a session id from, and never logs the id", () => {
    const { mux, toWorker, logs } = createHarness();
    const holder = fakeConnection();
    const taker = fakeConnection();
    mux.fromServer(holder, hello("s-1"));

    expect(mux.fromServer(taker, hello("s-1"))).toBe("accepted");

    // One id, one socket: the connection that lost the id is closed rather than left attached and
    // silently orphaned, so it cannot go on sending under a session it no longer holds.
    expect(holder.closes).toBe(1);
    expect(taker.closes).toBe(0);
    expect(mux.sessionIds()).toEqual(["s-1"]);
    expect(mux.fromServer(holder, { callId: "c-1", sessionId: "s-1", tool: "wait", args: {} })).toBe(
      "rejected",
    );
    // Nothing of the displaced connection's reached the worker; the two announcements are the
    // greetings' own (T099i).
    expect(toWorker.filter((frame) => (frame as { type?: string }).type !== "hello")).toEqual([]);

    // Session ids are the routing keys of every other session too; `relay.log` is a plain file in
    // the host data directory, so a code and a count say what diagnosis needs without naming them.
    expect(logs.filter((line) => line.includes("s-1"))).toEqual([]);
  });

  /**
   * 004/T162 - the count a superseded relay drains against.
   *
   * `native-host.ts` needs to know, from outside, whether it is safe to close a socket: closing one
   * with a call still in flight is the defect a superseded relay must not repeat, and this is the
   * one number that says whether that is true right now. It falls the same two ways a call in
   * flight can end - the worker answers it, or the session's connection closes before it does.
   */
  it("counts calls waiting on an answer, and stops counting one once it is settled", () => {
    const { mux } = createHarness();
    const connection = fakeConnection();
    mux.fromServer(connection, hello("s-1"));
    expect(mux.pendingCallCount()).toBe(0);

    mux.fromServer(connection, { callId: "c-1", sessionId: "s-1", tool: "wait", args: {} });
    mux.fromServer(connection, { callId: "c-2", sessionId: "s-1", tool: "wait", args: {} });
    expect(mux.pendingCallCount()).toBe(2);

    mux.fromWorker({ callId: "c-1", outcome: "ok", result: null });
    expect(mux.pendingCallCount()).toBe(1);

    mux.closed(connection);
    expect(mux.pendingCallCount()).toBe(0);
  });
});
