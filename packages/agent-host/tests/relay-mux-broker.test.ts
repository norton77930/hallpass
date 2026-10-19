import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { createRelayMux, type MuxConnection } from "../src/relay-mux.js";

/**
 * 019/T523 — the broker's greeting is admitted by the secret its relay gave it (R-312).
 *
 * The link token proves only that a peer could read a file in this user's profile, and the run id
 * is readable in the browser's record, so a greeting cannot *say* it is the broker. The relay that
 * spawned the broker passed it a secret on stdin and keeps only its SHA-256 (or reads that hash from
 * the sidecar, for an adopted broker); `role: "broker"` is admitted only with the secret behind that
 * hash, the secret stops at the relay as the token does, and `role` anywhere else is refused. This is
 * admission, not routing: every other frame is routed exactly as before.
 */

const TOKEN = "t".repeat(64);
const RELAY_PID = 4242;
const SECRET = "s".repeat(43);
const SECRET_SHA256 = createHash("sha256").update(SECRET).digest("hex");

type FakeConnection = MuxConnection & { sent: unknown[]; closes: number };

function fakeConnection(): FakeConnection {
  const connection: FakeConnection = {
    sent: [],
    closes: 0,
    send(value: unknown): void {
      connection.sent.push(value);
    },
    close(): void {
      connection.closes += 1;
    },
  };
  return connection;
}

function createHarness(expected: string | null = SECRET_SHA256) {
  const toWorker: unknown[] = [];
  const logs: string[] = [];
  const mux = createRelayMux({
    token: TOKEN,
    relayPid: RELAY_PID,
    toWorker: (frame) => toWorker.push(frame),
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
  });
  mux.expectBroker(expected ?? undefined);
  return { mux, toWorker, logs };
}

function hello(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello",
    sessionId,
    agentId: "hallpass-broker",
    displayName: "Hallpass conversations",
    token: TOKEN,
    protocol: AGENT_LINK_PROTOCOL,
    ...extra,
  };
}

const refusals = (logs: string[]) => logs.filter((line) => line.includes("broker-role-refused"));

describe("019 relay admission of the broker's greeting", () => {
  it("refuses role broker without a secret, with a wrong one, and when the relay expects no broker", () => {
    const cases: Array<{ expected: string | null; extra: Record<string, unknown> }> = [
      { expected: SECRET_SHA256, extra: { role: "broker" } },
      { expected: SECRET_SHA256, extra: { role: "broker", brokerSecret: "w".repeat(43) } },
      { expected: null, extra: { role: "broker", brokerSecret: SECRET } },
      // A secret with no role is no greeting this relay hands out either.
      { expected: SECRET_SHA256, extra: { brokerSecret: SECRET } },
    ];
    for (const { expected, extra } of cases) {
      const { mux, toWorker, logs } = createHarness(expected);
      const connection = fakeConnection();

      expect(mux.fromServer(connection, hello("broker-1", extra))).toBe("rejected");

      expect(connection.sent).toEqual([]);
      expect(toWorker).toEqual([]);
      expect(mux.sessionIds()).toEqual([]);
      expect(mux.brokerSessionId()).toBeUndefined();
      expect(refusals(logs)).toHaveLength(1);
    }
  });

  it("admits the right secret and strips it before forwarding, as it strips the token", () => {
    const { mux, toWorker } = createHarness();
    const connection = fakeConnection();

    expect(mux.fromServer(connection, hello("broker-1", { role: "broker", brokerSecret: SECRET }))).toBe("accepted");

    expect(connection.sent).toEqual([{ type: "hello-ack", relayPid: RELAY_PID }]);
    expect(toWorker).toEqual([
      {
        type: "hello",
        sessionId: "broker-1",
        agentId: "hallpass-broker",
        displayName: "Hallpass conversations",
        role: "broker",
      },
    ]);
    expect(JSON.stringify(toWorker)).not.toContain(SECRET);
    expect(mux.brokerSessionId()).toBe("broker-1");
  });

  it("checks against the hash set last (a new spawn or an adopted sidecar)", () => {
    const { mux } = createHarness();
    const other = "o".repeat(43);
    mux.expectBroker(createHash("sha256").update(other).digest("hex"));

    expect(mux.fromServer(fakeConnection(), hello("broker-1", { role: "broker", brokerSecret: SECRET }))).toBe(
      "rejected",
    );
    expect(mux.fromServer(fakeConnection(), hello("broker-1", { role: "broker", brokerSecret: other }))).toBe(
      "accepted",
    );
  });

  it("refuses role or brokerSecret on any frame after the greeting", () => {
    const { mux, toWorker, logs } = createHarness();
    const broker = fakeConnection();
    const server = fakeConnection();
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));
    mux.fromServer(server, hello("s-1", { agentId: "claude-code", displayName: "Claude Code" }));
    toWorker.length = 0;

    expect(
      mux.fromServer(server, { type: "conversation-overview", sessionId: "s-1", role: "broker" }),
    ).toBe("rejected");
    expect(mux.fromServer(broker, { callId: "c-1", sessionId: "broker-1", brokerSecret: SECRET })).toBe("rejected");

    expect(toWorker).toEqual([]);
    expect(refusals(logs)).toHaveLength(2);
  });

  it("refuses an ordinary greeting that names the broker's session", () => {
    const { mux, toWorker, logs } = createHarness();
    const broker = fakeConnection();
    const impostor = fakeConnection();
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));
    toWorker.length = 0;

    expect(mux.fromServer(impostor, hello("broker-1"))).toBe("rejected");

    // The broker keeps its link; nothing reached the worker.
    expect(broker.closes).toBe(0);
    expect(toWorker).toEqual([]);
    expect(refusals(logs)).toHaveLength(1);
    expect(mux.brokerSessionId()).toBe("broker-1");
  });

  it("routes every other frame as before, and conversation frames by the broker's session", () => {
    const { mux, toWorker } = createHarness();
    const broker = fakeConnection();
    const server = fakeConnection();
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));
    mux.fromServer(server, hello("s-1", { agentId: "claude-code", displayName: "Claude Code" }));
    toWorker.length = 0;

    const call = { callId: "c-1", sessionId: "s-1", tool: "tabs_context", args: {} };
    const overview = { type: "conversation-overview", sessionId: "broker-1", conversations: [], agents: [], folders: [] };
    expect(mux.fromServer(server, call)).toBe("accepted");
    expect(mux.fromServer(broker, overview)).toBe("accepted");
    expect(toWorker).toEqual([call, overview]);

    const answer = { callId: "c-1", outcome: "ok", result: [] };
    const command = { type: "conversation-command", sessionId: "broker-1", commandId: "k-1", command: { kind: "list" } };
    mux.fromWorker(answer);
    mux.fromWorker(command);
    expect(server.sent.slice(1)).toEqual([answer]);
    expect(broker.sent.slice(1)).toEqual([command]);
  });

  it("tells the broker the relay is going, and nobody else", () => {
    const { mux } = createHarness();
    const broker = fakeConnection();
    const server = fakeConnection();
    expect(mux.tellBrokerRelayGone()).toBe(false);
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));
    mux.fromServer(server, hello("s-1"));

    expect(mux.tellBrokerRelayGone()).toBe(true);

    expect(broker.sent.slice(1)).toEqual([{ type: "relay-gone", sessionId: "broker-1" }]);
    expect(server.sent.slice(1)).toEqual([]);
  });

  it("T572: a superseded relay's relay-gone also lets the broker's link go, and no server's", () => {
    const { mux } = createHarness();
    const broker = fakeConnection();
    const server = fakeConnection();
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));
    mux.fromServer(server, hello("s-1"));

    expect(mux.tellBrokerRelayGone({ release: true })).toBe(true);

    expect(broker.sent.slice(1)).toEqual([{ type: "relay-gone", sessionId: "broker-1" }]);
    expect(broker.closes).toBe(1);
    expect(server.closes).toBe(0);
  });

  it("forgets the broker session when its link closes", () => {
    const { mux, toWorker } = createHarness();
    const broker = fakeConnection();
    mux.fromServer(broker, hello("broker-1", { role: "broker", brokerSecret: SECRET }));

    mux.closed(broker);

    expect(mux.brokerSessionId()).toBeUndefined();
    expect(toWorker.at(-1)).toEqual({ type: "session-ended", sessionId: "broker-1" });
  });
});
