import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LINK_PROTOCOL, agentBrowserNameSchema, type AgentBrowserRecord } from "@hallpass/contracts";
import {
  browserPeers,
  browserRecordPath,
  decideLegacyClaim,
  decideOwnRecordOnAck,
  decideOwnRecordTurn,
  identityFromAck,
  inspectBrowserRecord,
  listBrowserRecords,
  liveOtherRecords,
  ownRecordFacts,
  removeOwnBrowserRecord,
  sweepDeadBrowserRecords,
  writeBrowserRecord,
  type BrowserIdentity,
} from "./browser-record.js";
import {
  inspectBridgeRecord,
  listenAndPublish,
  removeBridgeRecord,
  type FrameChannel,
} from "./bridge-link.js";
import { browsersDirectory, hostDataDirectory } from "./host-paths.js";
import { createRelayMux, type RelayMux } from "./relay-mux.js";
import {
  decideRelayAck,
  readRelayAck,
  removeBridgeOwner,
  repairBridgeOwner,
  writeBridgeOwner,
  type RelayAck,
} from "./relay-ownership.js";
import { encodeFrame, FrameDecoder } from "./native-frame.js";
import { createUploadConfigStore } from "./upload-config-store.js";

/**
 * The native-messaging relay Chrome spawns (R-102, 004/R-111).
 *
 * It is the singular side of the link: Chrome spawns exactly one of it per browser, so it is the
 * one process that can own a listening port and be the single writer of that browser's record,
 * `browsers/<browserId>.json` (018 R-266). Every MCP server an agent starts dials in, greets with the
 * record's token, and is multiplexed onto this one native port by `createRelayMux`. 003 had it the
 * other way round - the server listened and this process dialled - which made the record a file
 * with N writers and told a second agent session that the bridge was unavailable. Every browser's
 * relay serves at once (018 R-267, R-274): none stands by or leaves because another browser is
 * running. The legacy `bridge.json` is kept for servers older than 018 by whichever relay claims it.
 *
 * It still has no policy in it. It reads two fields of a session's frame to decide which way it goes
 * and rewrites none of them; pairing, tab ownership and the per-site gate all live in the worker or
 * in the server, so this process can be read end to end and seen to add no authority. The frames it
 * consumes itself - `relay-ack`, `browser-name` - are about its own record, never a session's.
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
async function drainThenClose(mux: RelayMux, close: () => Promise<void>): Promise<void> {
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
  await close();
}

/**
 * How often a relay re-reads its records (004/R-111, T099c; 018 R-266).
 *
 * A poll rather than `fs.watch`: the records share a directory tree with the relay log this process
 * writes on every frame, so a directory watch would wake on the relay's own writes and have to
 * re-read anyway, and `fs.watch` is the one fs API Node documents as not available - or not
 * event-for-event - on every platform and filesystem. A few small reads per second cost nothing next
 * to the frames already crossing this process, and the poll bounds the detection time.
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
 * the relay's own process tests, nothing else reads it. An 018 worker reads its identity before it
 * answers, inside this same bound (R-279), so the identity always arrives on the ack itself and the
 * relay never has to publish a legacy record first and correct it later.
 */
const RELAY_ACK_BOUND_MS = (() => {
  const raw = Number(process.env.HALLPASS_RELAY_ACK_BOUND_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

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

async function main(): Promise<void> {
  startLog();
  // The run marker between relay runs (B106). The browser id is not known yet - it arrives on the
  // ack - so it rides on `relay.owned`, the line that says which browser this run serves.
  log("relay.started", process.pid.toString());

  /**
   * Minted here rather than inside `listenAndPublish` so the multiplexer can exist before the port
   * does: a server that connects in the same tick the listener opens would otherwise arrive at a
   * relay that has nothing to hand it to.
   */
  const token = randomBytes(32).toString("hex");
  /** Set once this browser's next relay took its record: from then on this process's socket closes say nothing. */
  let superseded = false;
  /**
   * The owner's upload directories, as this process may read and write them (014 FR-194).
   *
   * The relay is the one process that both speaks to the worker and can touch the file, which is
   * why the panel's list and its revoke are answered here and nowhere else. It never *adds*: the
   * list grows only where a file is already in hand, in the server's consent flow (FR-195).
   */
  const uploadRoots = createUploadConfigStore();
  const mux = createRelayMux({
    token,
    relayPid: process.pid,
    uploadRoots,
    toWorker(frame) {
      // Whole values, forwarded unchanged: the relay re-encodes but never rewrites, so a field it
      // has never heard of still reaches the worker that understands it.
      log("relay.to-chrome");
      writeToChrome(frame);
    },
    log,
  });

  const listening = await listenAndPublish(
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
  log("relay.listening", String(listening.port));
  // The worker's 15 s reconciliation starts here: the sessions that greet again inside the window
  // survive a browser restart, and the ones that do not are released. Where the record goes rides
  // along (006 FR-082): the worker cannot see this directory, and the not-connected page shows it.
  // Since 018 that is the per-browser directory - the file inside it is named after the browser's
  // id, which arrives only on the ack this frame asks for.
  writeToChrome({ type: "relay-started", relayPid: process.pid, recordPath: browsersDirectory() });

  /**
   * The record this relay publishes for its browser (018 R-266), set once the ack is adopted and
   * cleared again only by an identity collision found on the poll. While it is set, this relay is
   * that browser's relay: it repairs the record, answers `browser-name`, and counts peers.
   */
  let ownRecord: AgentBrowserRecord | undefined;
  /**
   * The identity refused because another live browser of another run holds it (R-276). Until the
   * worker answers again with a different id, this relay publishes nothing at all - no record and
   * no claim on `bridge.json` - so no server can reach a browser whose identity is ambiguous.
   */
  let conflictedId: string | undefined;
  /** A rename that arrived while the ack was still being adopted; applied with it. */
  let pendingName: string | undefined;
  /** The last `browser-peers` sent, so the frame goes on change only. */
  let lastPeers: string | undefined;
  /**
   * Whether the last sidecar write failed. The poll retries the write every turn, so a write that
   * keeps failing is logged once per failure streak rather than once a second (review m5).
   */
  let ownerWriteFailing = false;
  const noteOwnerWrite = (ok: boolean): void => {
    if (!ok && !ownerWriteFailing) log("relay.owner-write-failed");
    ownerWriteFailing = !ok;
  };

  /**
   * Claims the legacy `bridge.json` for servers older than 018 (R-277), with its owner sidecar. A
   * sidecar that cannot be written is not fatal: it only informs another relay's ack-time choice.
   */
  const claimLegacy = async (record: AgentBrowserRecord): Promise<void> => {
    await listening.republish();
    await writeBridgeOwner({
      relayPid: process.pid,
      ...(record.browserRunId === undefined ? {} : { browserRunId: record.browserRunId }),
    }).then(
      () => noteOwnerWrite(true),
      () => noteOwnerWrite(false),
    );
  };

  /** Retracts everything this relay published, each file only when it is still this process's own. */
  const close = async (): Promise<void> => {
    const mine = ownRecord;
    if (mine !== undefined) await removeOwnBrowserRecord(mine.browserId, process.pid).catch(() => undefined);
    await removeBridgeOwner().catch(() => undefined);
    await listening.close();
  };

  /**
   * Owned, or not (004/T169). Nothing is published - and the poll is not armed - until the worker
   * has answered; until then this process can be dialled by nobody. A relay whose owner never
   * answers leaves on the bound without ever having written a record.
   */
  let acknowledged = false;
  /**
   * Set on every path that starts `close()`: an ack that lands while the sockets are still closing
   * (the bound fired, framing broke, Chrome closed) must not publish a record for a process that is
   * leaving - nothing would retract it (review B121 #1).
   */
  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    leaving = true;
    void close().finally(exitAfterFlush);
  };
  const ackBound = setTimeout(() => {
    if (acknowledged) return;
    log("relay.unowned", `no relay-ack within ${RELAY_ACK_BOUND_MS} ms`);
    leave();
  }, RELAY_ACK_BOUND_MS);
  ackBound.unref?.();

  /**
   * One task at a time: adopting an ack, a rename and a poll turn all read and then write the same
   * record, and two of them interleaved could write a stale copy over a fresh one.
   */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch(() => log("relay.task-failed"));
  };

  /**
   * `browser-peers` (R-269), on change only, and only to a worker that sent an identity: a worker
   * older than 018 does not read the frame (contracts "Link frames": each is sent only to a peer
   * known to read it).
   */
  const sendPeers = async (record: AgentBrowserRecord): Promise<void> => {
    if (record.legacy) return;
    const others = await liveOtherRecords(await listBrowserRecords(), record.browserId);
    if (leaving || ownRecord !== record) return;
    const peers = browserPeers(record, others);
    const key = JSON.stringify(peers);
    if (key === lastPeers) return;
    lastPeers = key;
    writeToChrome({ type: "browser-peers", ...peers });
  };

  const refuseIdentity = (browserId: string, holderPid: number | undefined): void => {
    conflictedId = browserId;
    log("relay.identity-conflict", `browser=${browserId} holder=${holderPid ?? "unknown"} speaker=${process.pid}`);
    writeToChrome({ type: "browser-identity-conflict" });
  };

  /** The record for an identity this relay has just been given, or a refusal (R-276). */
  const adopt = async (identity: BrowserIdentity): Promise<void> => {
    const reading = await inspectBrowserRecord(browserRecordPath(identity.browserId));
    const facts = await ownRecordFacts({ selfPid: process.pid, mineRunId: identity.browserRunId, reading });
    if (leaving) return;
    if (decideOwnRecordOnAck(facts) === "conflict") {
      refuseIdentity(identity.browserId, reading.status === "ok" ? reading.record.relayPid : undefined);
      return;
    }
    conflictedId = undefined;
    const name = pendingName ?? identity.name;
    pendingName = undefined;
    const { name: _ackName, ...rest } = identity;
    const record: AgentBrowserRecord = {
      ...rest,
      ...(name === undefined ? {} : { name }),
      relayPid: process.pid,
      port: listening.port,
      token: listening.token,
      startedAt: listening.startedAt,
      protocol: AGENT_LINK_PROTOCOL,
    };
    try {
      await writeBrowserRecord(record);
    } catch {
      log("relay.record-publish-failed");
      leave();
      return;
    }
    ownRecord = record;
    if (leaving) {
      // `close()` may have read `ownRecord` before it was set; retract it here instead.
      await removeOwnBrowserRecord(record.browserId, process.pid).catch(() => undefined);
      return;
    }
    /**
     * The legacy record, by today's ownership rule (`decideOnAck` + sidecar): this browser's own
     * previous relay is replaced there too (004/T169), and a live relay of another browser run
     * keeps it - this relay serves through its own record either way (R-267, R-274).
     * A decision that cannot be made claims it, as it always has.
     */
    const { decision } = await decideRelayAck({ mineRunId: record.browserRunId }).catch(() => ({
      decision: "claim-legacy" as const,
    }));
    if (leaving) return;
    if (decision === "claim-legacy") {
      await claimLegacy(record).catch(() => log("relay.legacy-claim-failed"));
    }
    log("relay.owned", `${process.pid} browser=${record.browserId}${record.legacy ? " legacy" : ""}`);
    await sendPeers(record);
    armPoll();
  };

  /** One turn of the 1 s poll: the own record, then the legacy record, then the directory. */
  const turn = async (): Promise<void> => {
    const record = ownRecord;
    if (leaving || superseded || record === undefined) return;

    const reading = await inspectBrowserRecord(browserRecordPath(record.browserId));
    const facts = await ownRecordFacts({ selfPid: process.pid, mineRunId: record.browserRunId, reading });
    if (leaving || ownRecord !== record) return;
    switch (decideOwnRecordTurn(facts)) {
      case "keep":
      case "wait":
        break;
      case "republish":
        // 004/T099f, per browser: something deleted (or a dead relay holds) this browser's record
        // while this relay serves it, and only this relay can put it back.
        log("relay.browser-record-republished", record.browserId);
        await writeBrowserRecord(record).catch(() => log("relay.record-republish-failed"));
        break;
      case "superseded": {
        // This browser's next relay - the same run - took the record (004/T169), or another build
        // of this browser did (T099j). Both pids, not just the winner's (004/T162, B107).
        const winner = reading.status === "ok" ? reading.record.relayPid : reading.status === "protocol-mismatch" ? reading.relayPid : undefined;
        if (reading.status === "protocol-mismatch") log("relay.protocol-mismatch", "browser record");
        log("relay.superseded", `winner=${winner ?? "unknown"} speaker=${process.pid} browser=${record.browserId}`);
        superseded = true;
        void drainThenClose(mux, close).finally(exitAfterFlush);
        return;
      }
      case "conflict":
        // The late half of a collision: two acks raced past each other's check, and the other
        // browser's write landed. It keeps the id; this relay stops publishing anything, and
        // retracts its claim on the legacy record, until its worker names a new identity.
        ownRecord = undefined;
        lastPeers = undefined;
        await removeBridgeRecord().catch(() => undefined);
        await removeBridgeOwner().catch(() => undefined);
        refuseIdentity(record.browserId, reading.status === "ok" ? reading.record.relayPid : undefined);
        return;
    }

    const legacy = await inspectBridgeRecord();
    if (leaving || ownRecord !== record) return;
    switch (decideLegacyClaim(legacy, process.pid)) {
      case "claim":
        log("relay.legacy-claimed", String(process.pid));
        await claimLegacy(record).catch(() => log("relay.legacy-claim-failed"));
        break;
      case "own": {
        // `removeBridgeOwner` reads then deletes, so a relay on its way out can delete the sidecar
        // this one wrote; it is rewritten when missing or naming another relay or run.
        let repaired: boolean;
        try {
          repaired = await repairBridgeOwner({
            browserRunId: record.browserRunId,
            shouldWrite: () => !leaving && ownRecord === record,
          });
        } catch {
          noteOwnerWrite(false);
          break;
        }
        noteOwnerWrite(true);
        if (repaired) log("relay.owner-repaired", String(process.pid));
        break;
      }
      case "leave":
        break;
    }

    const swept = await sweepDeadBrowserRecords({ ownBrowserId: record.browserId }).catch(() => []);
    if (swept.length > 0) log("relay.browser-records-swept", String(swept.length));
    await sendPeers(record);
  };

  let pollArmed = false;
  let turnQueued = false;
  /**
   * The poll starts with the first adopted record and runs until the relay leaves. A relay that is
   * leaving stops (review m4): its `close()` retracts its records on purpose, and a turn that then
   * read `absent` would republish them for a process about to exit, with nobody left to retract
   * them. `leaving` is asked at the top of a turn and again after every read.
   */
  const armPoll = (): void => {
    if (pollArmed) return;
    pollArmed = true;
    const timer = setInterval(() => {
      if (leaving || superseded) {
        clearInterval(timer);
        return;
      }
      if (turnQueued) return;
      turnQueued = true;
      enqueue(async () => {
        turnQueued = false;
        await turn();
      });
    }, RECORD_CHECK_MS);
    timer.unref?.();
  };

  /**
   * The worker's ack (004/T169) and, after a refused identity, its answer with a new one (R-276).
   * Any other repeat is ignored: an ack is a one-time fact about this port.
   */
  const onAck = (ack: RelayAck): void => {
    if (leaving) return;
    if (acknowledged && conflictedId === undefined) return;
    const identity = identityFromAck(ack, process.pid);
    if (conflictedId !== undefined && identity.browserId === conflictedId) {
      log("relay.identity-conflict.repeated", identity.browserId);
      return;
    }
    acknowledged = true;
    clearTimeout(ackBound);
    enqueue(() => adopt(identity));
  };

  /** The owner renamed this browser in its panel (FR-268): this relay rewrites its own record. */
  const onBrowserName = (name: string): void => {
    enqueue(async () => {
      const record = ownRecord;
      if (record === undefined) {
        pendingName = name;
        return;
      }
      // A superseded relay is only draining: the record belongs to the winner now (T515 m1).
      if (leaving || superseded || record.name === name) return;
      const renamed = { ...record, name };
      ownRecord = renamed;
      await writeBrowserRecord(renamed).catch(() => log("relay.record-rename-failed"));
      log("relay.browser-renamed", record.browserId);
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
      const ack = readRelayAck(frame, process.pid);
      if (ack !== undefined) {
        onAck(ack);
        continue;
      }
      if (isFrameOfType(frame, "browser-name")) {
        // A frame for the relay itself, like the ack: it is about this browser's record, never a
        // session's traffic, so it is not forwarded - not even when its name is refused.
        const name = agentBrowserNameSchema.safeParse((frame as { name?: unknown }).name);
        if (name.success) onBrowserName(name.data);
        else log("relay.browser-name-refused");
        continue;
      }
      log("relay.to-server");
      mux.fromWorker(frame);
    }
  });
  process.stdin.on("end", () => {
    // Chrome closed the native port, so there is no browser behind this relay any more. Every
    // dialled-in server is dropped and the records retracted before the exit, so the servers stop
    // sending into a link nobody is reading and dial the *next* relay instead of this one's port.
    log("relay.chrome.closed");
    leave();
  });
}

function isFrameOfType(frame: unknown, type: string): boolean {
  return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === type;
}

await main();
