import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import {
  AGENT_LINK_PROTOCOL,
  agentBridgeRecordSchema,
  agentLinkFrameSchema,
  type AgentBridgeRecord,
} from "@hallpass/contracts";
import { bridgeFilePath, hostDataDirectory, type HostEnvironment } from "./host-paths.js";
import { encodeFrame, FrameDecoder } from "./native-frame.js";

/**
 * The loopback link between the relay (which Chrome spawns) and the MCP servers (which agents
 * spawn). Neither process can spawn the other - that is the whole reason there are two of them
 * (R-102) - so they find each other through one file at a known path.
 *
 * 004/R-111 inverts who is which: the relay listens and is the single writer of the record, and
 * every server dials it and keeps dialling. 003 had it the other way round, which made the record a
 * file with N writers - a second agent session overwrote the first one's record while the relay
 * stayed attached to the first server, and both sessions were told `bridge-unavailable` (the
 * owner's E1). One writer, N diallers, and that failure has nowhere to happen.
 */

/** The record's shape lives in the contracts package (`agentBridgeRecordSchema`), with the frames. */
export type BridgeRecord = AgentBridgeRecord;

/**
 * Publishes the record as one indivisible step: a temp file beside it, then a rename (004/T099f).
 *
 * `writeFile` on the record's own path truncates first, so a server reading in that window saw an
 * empty or half-written file and answered `bridge-unavailable` for a relay that was serving
 * perfectly. A rename inside one directory is atomic for readers - they see the old record or the
 * new one, never a prefix of either.
 *
 * The rename is retried a few times because Windows refuses one over a destination another process
 * has open, and every server on this machine reads this path on its dial cadence. Ten milliseconds
 * is longer than any of those reads, and a rename that still cannot land leaves the previous record
 * in place rather than a truncated one.
 */
export async function writeBridgeRecord(record: BridgeRecord, env?: HostEnvironment): Promise<void> {
  await mkdir(hostDataDirectory(env), { recursive: true });
  const target = bridgeFilePath(env);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(record)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 10;

/**
 * What the record's path holds right now, with the three answers kept apart (004/T099f).
 *
 * A dialling server may collapse them - none of the three is a relay it can dial - but the relay
 * that owns the record cannot: `absent` is an invitation to republish, because something deleted
 * the record out from under a live relay and only that relay can put it back, while `unparseable`
 * is a file whose owner is unknown and must be left alone.
 */
export type BridgeRecordReading =
  | { status: "ok"; record: BridgeRecord }
  | { status: "absent" }
  /** A record written by a build that speaks another protocol (T099j); `protocol` is its stamp. */
  | { status: "protocol-mismatch"; protocol: number | undefined }
  | { status: "unparseable" };

export async function inspectBridgeRecord(env?: HostEnvironment): Promise<BridgeRecordReading> {
  let raw: string;
  try {
    raw = await readFile(bridgeFilePath(env), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { status: "absent" };
    }
    // Unreadable for any other reason - a sharing violation, a permission - is not "nobody is
    // listening": something is there, and this process does not know whose it is.
    return { status: "unparseable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "unparseable" };
  }
  /**
   * The stamp is read before the shape (T099j): a record from another build fails this repository's
   * schema in some arbitrary way, and "unparseable" would send both sides back into the silent
   * retry the stamp exists to end. A record with no stamp at all is one from before it existed,
   * which is the same fact.
   */
  const stamp = value && typeof value === "object" ? (value as { protocol?: unknown }).protocol : undefined;
  if (typeof stamp !== "number" || stamp !== AGENT_LINK_PROTOCOL) {
    return { status: "protocol-mismatch", protocol: typeof stamp === "number" ? stamp : undefined };
  }
  const parsed = agentBridgeRecordSchema.safeParse(value);
  return parsed.success ? { status: "ok", record: parsed.data } : { status: "unparseable" };
}

/**
 * Reads the record, or `undefined` when there is no usable one.
 *
 * A missing file, a half-written file and 003's own record (which named a *server's* `pid`) are the
 * same fact to a dialling server - there is no relay to connect to - and each of them must produce
 * another turn of the dial loop rather than a crash.
 */
export async function readBridgeRecord(env?: HostEnvironment): Promise<BridgeRecord | undefined> {
  const reading = await inspectBridgeRecord(env);
  return reading.status === "ok" ? reading.record : undefined;
}

/**
 * Retracts the record, but only when it is this process's own.
 *
 * The file is one machine-wide rendezvous point, so deleting it is a claim about who is listening.
 * A dying relay that removed a record naming another live relay would silently strand every server
 * dialling that one, and a stale file left behind is the far cheaper failure: the servers that dial
 * it get no answer and come round again five seconds later. A file that does not parse as a record
 * is left alone for the same reason - nothing here knows whose it is.
 */
export async function removeBridgeRecord(env?: HostEnvironment): Promise<void> {
  const record = await readBridgeRecord(env);
  if (record?.relayPid !== process.pid) {
    return;
  }
  await rm(bridgeFilePath(env), { force: true });
}

/**
 * Whether a pid still names a running process this user may signal.
 *
 * Signal 0 performs no delivery - it is the standard existence check - and `EPERM` counts as alive:
 * a process this user cannot signal is still a process. A record naming a dead relay is a record of
 * a browser that is gone, so the dial loop treats it as no record at all (R-111) rather than
 * connecting to whatever now holds that port.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export type FrameChannel = {
  send: (value: unknown) => void;
  /**
   * Ends the link, resolving once the socket has actually gone.
   *
   * It is a promise because the last frame matters: a server on its way out announces that its
   * session ended (M4 Part A), and a caller that exited the moment `end()` returned would drop that
   * frame in the kernel buffer. Waiting for the close is how the announcement is delivered.
   */
  close: () => Promise<void>;
};

/**
 * Wraps a socket in the same length-prefixed framing Chrome uses on the native-messaging pipe.
 *
 * The relay is a pump between two streams, and using one framing on both sides means it never
 * re-encodes a message: it decodes a frame from one side and encodes the same value to the other,
 * so a field this repository has not thought about still survives the trip.
 */
export function createFrameChannel(
  socket: Socket,
  handlers: { onFrame: (value: unknown) => void; onClose: () => void; onError?: (error: Error) => void },
): FrameChannel {
  const decoder = new FrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch (error) {
      // A stream that has lost framing cannot be resynchronised: every byte after the bad prefix is
      // at an unknown offset, so the link is ended rather than guessed at.
      handlers.onError?.(error instanceof Error ? error : new Error("frame-invalid"));
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      handlers.onFrame(frame);
    }
  });
  socket.on("close", handlers.onClose);
  socket.on("error", (error) => {
    handlers.onError?.(error);
  });
  return {
    send(value: unknown): void {
      if (socket.destroyed) {
        return;
      }
      socket.write(encodeFrame(value));
    },
    close(): Promise<void> {
      if (socket.destroyed) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      });
    },
  };
}

/** The relay's listening side, once it is published (004/T092). */
export type PublishedRelay = {
  port: number;
  token: string;
  /**
   * Writes this relay's record again, unchanged (004/T099f).
   *
   * The same values including `startedAt`: this is the repair of a record that went missing, not a
   * new relay start, and a fresh timestamp would tell the worker's reconciliation that something
   * restarted when nothing did.
   */
  republish: () => Promise<void>;
  /** Closes the listener, drops every attached server, and retracts this relay's own record. */
  close: () => Promise<void>;
};

export type RelayConnectionHandlers = {
  onFrame: (connection: FrameChannel, frame: unknown) => void;
  onClose: (connection: FrameChannel) => void;
};

/**
 * The relay opens the port and publishes the record (R-111).
 *
 * The token is minted per relay start rather than kept anywhere: it proves only that the peer could
 * read a file in this user's own profile, which is all a loopback link can prove, and a token that
 * did not change on restart would still be honoured by a server left over from before.
 */
export async function listenAndPublish(
  handlers: RelayConnectionHandlers,
  options: {
    env?: HostEnvironment;
    token?: string;
    /**
     * `false` listens without writing the record; the caller publishes with `republish()` once it
     * knows the relay has a live owner (004/T169). Default `true`, the pre-T169 behaviour.
     */
    publishOnListen?: boolean;
  } = {},
): Promise<PublishedRelay> {
  const token = options.token ?? randomBytes(32).toString("hex");
  const channels = new Set<FrameChannel>();
  const listener: NetServer = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const channel = createFrameChannel(socket, {
      onFrame: (value) => handlers.onFrame(channel, value),
      onClose: () => {
        channels.delete(channel);
        handlers.onClose(channel);
      },
    });
    channels.add(channel);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const record: BridgeRecord = {
    port,
    token,
    relayPid: process.pid,
    startedAt: new Date().toISOString(),
    protocol: AGENT_LINK_PROTOCOL,
  };
  let published = false;
  if (options.publishOnListen !== false) {
    await writeBridgeRecord(record, options.env);
    published = true;
  }

  return {
    port,
    token,
    async republish(): Promise<void> {
      await writeBridgeRecord(record, options.env);
      published = true;
    },
    async close(): Promise<void> {
      // A relay that never published (004/T169: nobody acknowledged it) has no record to retract,
      // and the one on disk belongs to the relay that is serving.
      if (published) await removeBridgeRecord(options.env);
      await Promise.all([...channels].map((channel) => channel.close()));
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

/** How long a server waits before looking for the relay again (R-111, the reference's cadence). */
export const DIAL_RETRY_MS = 5_000;

/**
 * How soon a server looks again after a link it had went away (004/T099k).
 *
 * The steady cadence is right for a browser that is not running: five seconds of nothing is a
 * cheap poll. It is wrong for the seconds after a relay died, which is the one moment a new record
 * is about to appear - Chrome respawns the worker and its relay publishes within about a second.
 * On the flat cadence the first look after the drop still read the *dead* relay's record and the
 * attach waited out a second cadence, landing at ~10 s: FR-057's bound exactly, so a call issued
 * in that first second could time out just as the link it was waiting for arrived. The retry after
 * a drop therefore starts short and doubles back up to the cadence, which puts the attach seconds
 * inside the bound and still leaves a server with no browser polling once every five seconds.
 */
export const DETACH_RETRY_MS = 500;

/** One dialled link, from the dialler's point of view. */
export type LinkConnection = {
  send: (value: unknown) => void;
  close: () => Promise<void>;
};

/**
 * How a dial is actually made. Injected so the loop is testable without a socket - and so B6 can
 * hand it the loopback connector below without the loop knowing what a socket is.
 */
export type LinkConnector = (
  record: BridgeRecord,
  handlers: { onFrame: (value: unknown) => void; onClose: () => void },
) => Promise<LinkConnection>;

export type DialRelayOptions = {
  /** Who is dialling. The relay registers the session under this id and the worker labels it.  */
  hello: { sessionId: string; agentId: string; displayName: string };
  /** Every frame from the relay except the acknowledgement, which the loop consumes itself. */
  onFrame: (value: unknown) => void;
  onAttached?: (relayPid: number) => void;
  onDetached?: () => void;
  connect?: LinkConnector;
  /** Injected clock: `wait(DIAL_RETRY_MS)` between attempts. */
  wait?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  env?: HostEnvironment;
  retryMs?: number;
  /** The first wait after a drop, before the ramp back to `retryMs` (T099k); injected by tests. */
  detachRetryMs?: number;
  log?: (code: string, detail?: string) => void;
};

export type RelayDial = {
  /** Resolves with the relay's pid the first time one acknowledges. */
  attached: Promise<number>;
  /** Sends on the current link; `false` when there is none, which is not an error but a state. */
  send: (value: unknown) => boolean;
  /**
   * Greets the relay again on the current link (006 FR-087): the worker forgot this session on the
   * owner's Stop, and a fresh greeting under the same id is what makes it a session again. The
   * relay answers with another `hello-ack`, so `onAttached` fires as it did the first time.
   * `false` when there is no link to greet on.
   */
  greet: () => boolean;
  stop: () => Promise<void>;
};

/**
 * A server's side of the link: dial the relay, greet it, and never give up (R-111, FR-057).
 *
 * Retrying from this side is what makes a browser restart cheap. Chrome respawns the relay whenever
 * the worker wakes, the new relay publishes a new record, and every server that was already running
 * finds it within one cadence - no server has to be restarted alongside the browser, and a server
 * that starts before Chrome does simply waits instead of failing.
 */
export function dialRelay(options: DialRelayOptions): RelayDial {
  const log = options.log ?? ((): void => undefined);
  const connector = options.connect ?? loopbackConnector;
  const retryMs = options.retryMs ?? DIAL_RETRY_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.isAlive ?? isProcessAlive;

  let stopped = false;
  /**
   * How long the loop waits before its next look (T099k). The ordinary cadence until a link this
   * server had drops; from then the short retry, doubling back up to the cadence, so the recovery
   * that FR-057 bounds is quick and an unattended server still polls slowly.
   */
  let nextWaitMs = retryMs;
  /** Never longer than the cadence itself: a test that asked for 100 ms means 100 ms. */
  const detachRetryMs = Math.min(options.detachRetryMs ?? DETACH_RETRY_MS, retryMs);
  /** So a mismatch is one line rather than one every five seconds for the life of the server. */
  let mismatchLogged = false;
  let current: LinkConnection | undefined;
  /** The record the current link was dialled from; its token is what every greeting carries. */
  let currentRecord: BridgeRecord | undefined;
  let announceAttached: ((relayPid: number) => void) | undefined;
  const attached = new Promise<number>((resolve) => {
    announceAttached = resolve;
  });

  async function attempt(): Promise<void> {
    const reading = await inspectBridgeRecord(options.env);
    if (reading.status === "protocol-mismatch") {
      /**
       * A relay from another build owns the record (T099j).
       *
       * Dialling it would either be refused or would greet in a language it does not speak, and
       * before the stamp that was an endless retry with nothing in any log naming the cause. The
       * loop keeps its cadence - the browser restarting replaces the record with one this server
       * can use - but it says once, clearly, why it is not dialling.
       */
      if (!mismatchLogged) {
        mismatchLogged = true;
        log("agent.dial.protocol-mismatch", `found=${reading.protocol ?? "none"} own=${AGENT_LINK_PROTOCOL}`);
      }
      return;
    }
    mismatchLogged = false;
    if (reading.status !== "ok") {
      log("agent.dial.no-record");
      return;
    }
    const record = reading.record;
    if (!alive(record.relayPid)) {
      // A record naming a relay that has exited is a record of a browser that is gone. Dialling its
      // port would either fail or reach whatever took the port over.
      log("agent.dial.relay-gone", String(record.relayPid));
      return;
    }

    let closed: () => void = () => undefined;
    const untilClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let connection: LinkConnection;
    try {
      connection = await connector(record, {
        onFrame(value) {
          const frame = agentLinkFrameSchema.safeParse(value);
          if (frame.success && frame.data.type === "hello-ack") {
            log("agent.dial.attached", String(frame.data.relayPid));
            announceAttached?.(frame.data.relayPid);
            options.onAttached?.(frame.data.relayPid);
            return;
          }
          options.onFrame(value);
        },
        onClose: () => closed(),
      });
    } catch {
      // A recorded port nothing answers on: the relay is starting, or died without retracting.
      log("agent.dial.refused", String(record.port));
      return;
    }

    current = connection;
    currentRecord = record;
    greet(connection, record);
    await untilClosed;
    current = undefined;
    currentRecord = undefined;
    // The link this server was on has gone; the replacement is seconds away, so the loop looks
    // again quickly rather than on the unattended cadence (T099k).
    nextWaitMs = detachRetryMs;
    log("agent.dial.detached");
    options.onDetached?.();
  }

  function greet(connection: LinkConnection, record: BridgeRecord): void {
    connection.send({
      type: "hello",
      ...options.hello,
      token: record.token,
      protocol: AGENT_LINK_PROTOCOL,
    });
  }

  void (async () => {
    while (!stopped) {
      await attempt();
      if (stopped) {
        return;
      }
      await wait(nextWaitMs);
      nextWaitMs = Math.min(nextWaitMs * 2, retryMs);
    }
  })();

  return {
    attached,
    send(value: unknown): boolean {
      if (!current) {
        return false;
      }
      current.send(value);
      return true;
    },
    greet(): boolean {
      if (!current || !currentRecord) {
        return false;
      }
      greet(current, currentRecord);
      return true;
    },
    async stop(): Promise<void> {
      stopped = true;
      const connection = current;
      current = undefined;
      currentRecord = undefined;
      await connection?.close();
    },
  };
}

/** The real connector: a loopback socket carrying the same framing as Chrome's native pipe. */
const loopbackConnector: LinkConnector = (record, handlers) =>
  new Promise<LinkConnection>((resolve, reject) => {
    const socket = connect({ port: record.port, host: "127.0.0.1" });
    socket.setNoDelay(true);
    let settled = false;
    socket.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.once("connect", () => {
      settled = true;
      resolve(
        createFrameChannel(socket, {
          onFrame: handlers.onFrame,
          onClose: handlers.onClose,
        }),
      );
    });
  });
