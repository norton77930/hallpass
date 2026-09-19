import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  inspectBridgeRecord,
  listenAndPublish,
  type FrameChannel,
  type PublishedRelay,
} from "./bridge-link.js";
import { bridgeFilePath, hostDataDirectory } from "./host-paths.js";
import { createRelayMux, type RelayMux } from "./relay-mux.js";
import { encodeFrame, FrameDecoder } from "./native-frame.js";

/**
 * The native-messaging relay Chrome spawns (R-102, 004/R-111).
 *
 * It is the singular side of the link: Chrome spawns exactly one of it, so it is the one process
 * that can own a listening port and be the single writer of `bridge.json`. Every MCP server an
 * agent starts dials in, greets with the record's token, and is multiplexed onto this one native
 * port by `createRelayMux`. 003 had it the other way round - the server listened and this process
 * dialled - which made the record a file with N writers and told a second agent session that the
 * bridge was unavailable.
 *
 * It still has no policy in it. It reads two fields of a frame to decide which way it goes and
 * rewrites none of them; pairing, tab ownership and the per-site gate all live in the worker or in
 * the server, so this process can be read end to end and seen to add no authority.
 */

/**
 * Chrome gives a native host no console and no environment to log through, so the trace of one
 * connection goes to a file beside the other host files. It carries stable codes only, never page
 * content or frame bodies (the redaction rule from contracts/README §2).
 *
 * It used to be truncated on every start, on the theory that one relay process is one Chrome
 * connection. That theory is exactly backwards for the one situation this log exists to explain: a
 * relay that behaves badly and dies is routinely followed, seconds later, by Chrome respawning a new
 * one - and the new relay's start wiped the failing run's trail before anyone could read it (004,
 * B106). Every start now appends instead, with `relay.started <pid>` as the marker between runs, so
 * a failure survives whatever short-lived relay comes after it. `startLog` still bounds the file's
 * size, by rotating (not discarding) once it crosses `LOG_SIZE_CAP_BYTES`, so "never truncate" does
 * not become "grow forever."
 */
const logPath = join(hostDataDirectory(), "relay.log");

/** One rotated generation is kept beside the live file, so a rotation never simply discards history. */
const ROTATED_LOG_PATH = `${logPath}.1`;

/**
 * How large `relay.log` is allowed to get before `startLog` rotates it (004, B107).
 *
 * 5 MB is generous next to one line per frame crossing a single relay's lifetime, and it is checked
 * only at start - not on every write - so a run already in progress is never cut off mid-trail.
 */
const LOG_SIZE_CAP_BYTES = 5 * 1024 * 1024;

function log(code: string, detail?: string): void {
  const line = `${new Date().toISOString()} ${code}${detail === undefined ? "" : ` ${detail}`}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(logPath, line);
  } catch {
    // A log that cannot be written must not take the relay down with it.
  }
}

/** Writes one frame to Chrome. Chrome reads the same 4-byte length prefix the socket side uses. */
function writeToChrome(value: unknown): void {
  process.stdout.write(encodeFrame(value));
}

/**
 * Ends the relay, but only once stdout has actually drained.
 *
 * `process.stdout` towards a pipe is asynchronous on Windows, so `write` returning does not mean the
 * bytes reached Chrome; `process.exit` on the next line discards whatever is still buffered. The
 * frames that must not be lost are the last answers of the sessions that were live when Chrome went
 * away, and `session-ended` for each of them. A zero-length write still runs its callback behind
 * everything already queued, which is the flush signal, and a stream that never drains ends the
 * process on the bound rather than leaving an orphan.
 */
function exitAfterFlush(): void {
  let exited = false;
  const done = (): void => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };
  const guard = setTimeout(done, FLUSH_BOUND_MS);
  guard.unref?.();
  process.stdout.write("", () => {
    clearTimeout(guard);
    done();
  });
}

const FLUSH_BOUND_MS = 2_000;

/**
 * How long a superseded relay keeps its sockets open for calls it already forwarded, before it
 * gives up on them and exits anyway (004/T162, the design decision above).
 *
 * A superseded relay used to close every socket the moment it noticed - discarding an answer that
 * may already be on its way back from the worker, on the very connection being closed. This bound
 * is generous next to one call's own round trip: it only has to cover the moment a relay is
 * replaced, which happens once per browser restart or record repair, not the ordinary case of a
 * call finishing inside the router's own timeout. A call the worker never gets to inside this bound
 * is answered `call-unconfirmed` by the server's own detach handling (`mcp-server.ts`), never a
 * silent drop.
 */
const DRAIN_BOUND_MS = 5_000;

/** How often the drain checks whether every call it forwarded has been answered. */
const DRAIN_POLL_MS = 50;

/**
 * Waits for every call this relay forwarded to be answered - `mux.pendingCallCount() === 0` - or
 * for the bound to pass, then closes (004/T162). This is the "finishes what it started" half of the
 * design decision; `mcp-server.ts` is the "answered honestly" half, for whatever the bound could not
 * cover.
 */
async function drainThenClose(mux: RelayMux, published: PublishedRelay): Promise<void> {
  const deadline = Date.now() + DRAIN_BOUND_MS;
  while (mux.pendingCallCount() > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
  const abandoned = mux.pendingCallCount();
  if (abandoned > 0) {
    // Named so a diagnosis does not have to infer it from `mcp-server.ts` answering
    // `call-unconfirmed` a moment later on a socket this process can no longer see.
    log("relay.drain.abandoned", String(abandoned));
  }
  await published.close();
}

/**
 * How often a relay re-reads the record to check it still owns it (004/R-111, T099c).
 *
 * A poll rather than `fs.watch`: the record shares its directory with the relay log this process
 * writes on every frame, so a directory watch would wake on the relay's own writes and have to
 * re-read anyway, and `fs.watch` is the one fs API Node documents as not available - or not
 * event-for-event - on every platform and filesystem. One read of a ~150-byte file per second costs
 * nothing next to the frames already crossing this process, and it bounds the detection time.
 */
const RECORD_CHECK_MS = 1_000;

/**
 * How long a freshly spawned relay waits for its owner to answer `relay-started` before it
 * concludes it has none and leaves (004/T169, protocol 2).
 *
 * Chrome spawns a host for every `connectNative`, including one issued by a worker instance that
 * is on its way out and will never read a frame. Such a host used to publish its record the moment
 * it listened, take the bridge over from the relay that was serving, and leave that relay draining
 * a call it could no longer answer. So the record is written only after `relay-ack`, and a relay
 * nobody acknowledges never touches it. The bound is generous next to a worker's turnaround (the
 * answer is sent from the frame handler) and short next to a test; the environment override is for
 * the relay's own process tests, nothing else reads it.
 */
const RELAY_ACK_BOUND_MS = (() => {
  const raw = Number(process.env.HALLPASS_RELAY_ACK_BOUND_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

/**
 * Keeps the record and this relay in agreement, in both directions (004/T099c, T099f).
 *
 * Servers only ever dial the record, so the record is the whole of this relay's reachability, and
 * the poll is the one place that sees it. Two things can go wrong with it and each has its own
 * repair:
 *
 * - The record names *another* relay. This one can be reached by nobody: it is an orphan holding a
 *   second native port open, which is exactly the split bridge B13 measured. It exits, and the
 *   worker's reconnect re-establishes a single link.
 * - The record is *gone* while this relay is still serving. A dying relay reads the record and
 *   deletes it, so one that loses the race with the winner's write deletes the winner's record;
 *   every server then reads no record and answers `bridge-unavailable` for a relay that is up -
 *   the owner's E1 through the mechanism built to remove it. So an absent record is republished
 *   rather than ignored. Two relays racing to republish still converge: whichever pid ends up on
 *   disk owns it, and the other sees the first case on its next turn and exits.
 *
 * A record that does not *parse* is neither. It is a file this process cannot attribute - a torn
 * read of someone's write, or a shape from another version - and republishing on top of it would
 * take the link away from a relay that may well be live. It is left alone, and the next turn reads
 * whatever the writer finished writing.
 */
function exitWhenSuperseded(mux: RelayMux, published: PublishedRelay, onSuperseded: () => void): void {
  const timer = setInterval(() => {
    void (async () => {
      const reading = await inspectBridgeRecord();
      if (reading.status === "unparseable") {
        return;
      }
      if (reading.status === "protocol-mismatch") {
        /**
         * A relay from another build owns the record (004/T099j). Chrome keeps the relay it spawned
         * for the life of the browser, so a host upgrade leaves this process running against
         * servers that no longer speak to it - and the stamp it finds is not its own is exactly
         * that fact. It leaves, the same way it leaves when another relay of its own build takes
         * the record over, and Chrome's reconnect spawns the current one.
         */
        clearInterval(timer);
        log("relay.protocol-mismatch", `found=${reading.protocol ?? "none"}`);
        onSuperseded();
        void drainThenClose(mux, published).finally(exitAfterFlush);
        return;
      }
      if (reading.status === "absent") {
        log("relay.record-republished");
        await published.republish().catch(() => {
          // A record that cannot be written is retried on the next turn; there is nothing else
          // this process can do about it, and taking the relay down would strand its servers.
          log("relay.record-republish-failed");
        });
        return;
      }
      if (reading.record.relayPid === process.pid) {
        return;
      }
      clearInterval(timer);
      // Both pids, not just the winner's (004/T162, B107): the winner is who the record now names,
      // and the speaker is whoever writes this line, which the reader cannot otherwise tell apart -
      // that gap is what misled the previous investigation into reporting a guard bypass that never
      // happened.
      log("relay.superseded", `winner=${reading.record.relayPid} speaker=${process.pid}`);
      onSuperseded();
      void drainThenClose(mux, published).finally(exitAfterFlush);
    })();
  }, RECORD_CHECK_MS);
  timer.unref?.();
}

function startLog(): void {
  try {
    mkdirSync(hostDataDirectory(), { recursive: true });
    if (statSync(logPath).size > LOG_SIZE_CAP_BYTES) {
      // Rotate rather than truncate: the previous generation is still readable at `.1` (one before
      // it is dropped, which is the bound), and the live file starts empty only because it just
      // rotated, not because a relay merely started.
      renameSync(logPath, ROTATED_LOG_PATH);
    }
  } catch {
    // No file yet, or it cannot be stat'd/rotated - either way there is nothing to preserve, and
    // appendFileSync below creates the file on its first write.
  }
}

/** The worker's answer to `relay-started`, addressed to this relay (004/T169). */
function isRelayAck(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const { type, relayPid } = frame as { type?: unknown; relayPid?: unknown };
  return type === "relay-ack" && relayPid === process.pid;
}

async function main(): Promise<void> {
  startLog();
  log("relay.started", process.pid.toString());

  /**
   * Minted here rather than inside `listenAndPublish` so the multiplexer can exist before the port
   * does: a server that connects in the same tick the listener opens would otherwise arrive at a
   * relay that has nothing to hand it to.
   */
  const token = randomBytes(32).toString("hex");
  /** Set once the record names another relay: from then on this process's socket closes say nothing. */
  let superseded = false;
  const mux = createRelayMux({
    token,
    relayPid: process.pid,
    toWorker(frame) {
      // Whole values, forwarded unchanged: the relay re-encodes but never rewrites, so a field it
      // has never heard of still reaches the worker that understands it.
      log("relay.to-chrome");
      writeToChrome(frame);
    },
    log,
  });

  const published = await listenAndPublish(
    {
      onFrame(connection: FrameChannel, frame: unknown) {
        if (mux.fromServer(connection, frame) === "rejected") {
          // An ungreeted or badly greeted peer is not a peer: the token is the only thing between a
          // local process and the owner's browser, so the socket goes rather than the frame.
          void connection.close();
        }
      },
      onClose(connection: FrameChannel) {
        if (superseded) {
          // 004/T099g: this relay is going, its servers are not. `close()` ends every socket on the
          // way out, and announcing each one as `session-ended` would have the *one* worker behind
          // both relays release the tabs and the debugger of sessions whose servers are at that
          // moment dialling the winner. A relay losing the record is not a session ending.
          return;
        }
        mux.closed(connection);
      },
    },
    { token, publishOnListen: false },
  );
  log("relay.listening", String(published.port));
  // The worker's 15 s reconciliation starts here: the sessions that greet again inside the window
  // survive a browser restart, and the ones that do not are released. The record's path rides
  // along (006 FR-082): the worker cannot see this directory, and the not-connected page shows it.
  writeToChrome({ type: "relay-started", relayPid: process.pid, recordPath: bridgeFilePath() });

  /**
   * Owned, or not (004/T169). The record is published - and the supersession watch armed - only
   * once the worker has answered; until then this process can be dialled by nobody and takes
   * nothing from the relay that is serving. A relay whose owner never answers leaves on the bound
   * without ever having written the record.
   */
  let owned = false;
  /**
   * Set on every path that starts `published.close()`: a `relay-ack` that lands while the sockets
   * are still closing (the bound fired, framing broke, Chrome closed) must not publish a record
   * for a process that is leaving - nothing would retract it (review B121 #1).
   */
  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    leaving = true;
    void published.close().finally(exitAfterFlush);
  };
  const ackBound = setTimeout(() => {
    if (owned) return;
    log("relay.unowned", `no relay-ack within ${RELAY_ACK_BOUND_MS} ms`);
    leave();
  }, RELAY_ACK_BOUND_MS);
  ackBound.unref?.();
  const onAck = (): void => {
    if (owned || leaving) return;
    owned = true;
    clearTimeout(ackBound);
    void published
      .republish()
      .then(() => {
        log("relay.owned", String(process.pid));
        exitWhenSuperseded(mux, published, () => {
          superseded = true;
        });
      })
      .catch(() => {
        log("relay.record-publish-failed");
        leave();
      });
  };

  const decoder = new FrameDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch {
      // A stream that has lost framing cannot be resynchronised.
      log("relay.chrome.frame-invalid");
      leave();
      return;
    }
    for (const frame of frames) {
      if (isRelayAck(frame)) {
        onAck();
        continue;
      }
      log("relay.to-server");
      mux.fromWorker(frame);
    }
  });
  process.stdin.on("end", () => {
    // Chrome closed the native port, so there is no browser behind this relay any more. Every
    // dialled-in server is dropped and the record retracted before the exit, so the servers stop
    // sending into a link nobody is reading and dial the *next* relay instead of this one's port.
    log("relay.chrome.closed");
    leave();
  });
}

await main();
