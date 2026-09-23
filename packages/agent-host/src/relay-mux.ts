import { AGENT_LINK_PROTOCOL, agentLinkFrameSchema } from "@hallpass/contracts";
import type { UploadRootsListing } from "./upload-config-store.js";

/**
 * The relay's multiplexer (004 R-111, T090).
 *
 * 003 had one MCP server listening and the relay dialling it, which made `bridge.json` a file with
 * many writers: a second agent session overwrote the record while the relay stayed attached to the
 * first server, and every session was told `bridge-unavailable`. R-111 inverts the link - the relay
 * listens, every server dials in - and this is the part that keeps N servers apart on one native
 * port.
 *
 * It is deliberately pure. A connection is an opaque handle with a `send` and a `close`; there is no
 * socket, no file and no timer in here, because the property that matters (one session never sees
 * another session's answer) is exactly the kind of thing that is unprovable through two live
 * sockets and trivial to state as a unit test.
 *
 * The routing keys come from the frames themselves, which already carry them: a server frame names
 * its `callId`, a worker answer names the same one back, and control frames name their `sessionId`.
 * The relay forwards everything unchanged - it reads two fields to decide where a frame goes and
 * rewrites none - but a server frame's `sessionId` is a *claim*, and this is the only component
 * that can check it: it knows both the socket and the session that greeted on it (T099e). A frame
 * naming any other session is refused rather than forwarded, and one session id is held by one
 * connection at a time.
 *
 * What this is not: a defence against another process on this machine. The threat model accepts
 * same-user processes (research.md R-111), and the token only keeps a *stranger* off the port. What
 * it does provide is that the isolation between attached sessions is enforced where it is claimed,
 * so a caller holding another session's id - which S2 discloses through `holder` and
 * `held-by-session` - cannot act as that session.
 */

/** One dialled-in server, as far as the multiplexer is concerned: something frames can be sent to. */
export type MuxConnection = {
  send: (frame: unknown) => void;
  /**
   * Ends this link.
   *
   * The verdict below is how the multiplexer asks for the socket the *current* frame arrived on to
   * be closed. It cannot express the one other case - a repeat `hello` taking a session id from a
   * connection that is still attached - so that connection is closed through its own handle. It
   * stays optional because the transport, not this file, decides what closing costs.
   */
  close?: () => void | Promise<void>;
};

export type RelayMuxOptions = {
  /** The token from this relay's own record; a greeting that does not match it is refused. */
  token: string;
  /** This relay's pid, the whole content of `hello-ack` (the worker's restart check turns on it). */
  relayPid: number;
  /** Towards Chrome, i.e. the worker. */
  toWorker: (frame: unknown) => void;
  log?: (code: string, detail?: string) => void;
  /**
   * The owner's upload directories, for the two frames addressed to the relay itself (014 R-187 §4).
   *
   * Injected rather than imported, for the same reason everything else here is: this file is the
   * routing and holds no file, no socket and no timer. It is also what keeps the claim of FR-195
   * checkable - the store has exactly two callers, this one and the server's consent flow, and
   * neither is reachable from an MCP request.
   *
   * Absent is a relay that cannot answer: the frames are dropped as any unaddressed frame is, and
   * the panel shows no directory rows, which is precisely what an old relay looks like.
   */
  uploadRoots?: {
    list: () => Promise<UploadRootsListing>;
    remove: (root: string) => Promise<{ listing: UploadRootsListing }>;
  };
};

/**
 * What a frame from a server did.
 *
 * `rejected` is a request to the caller to close that socket: an ungreeted or badly greeted peer is
 * not a peer at all. The multiplexer does not close it itself because it holds no sockets - the
 * transport that owns the socket owns its lifetime.
 */
export type MuxVerdict = "accepted" | "rejected";

export type RelayMux = {
  /** A frame that arrived from one dialled-in server. */
  fromServer: (connection: MuxConnection, frame: unknown) => MuxVerdict;
  /** A frame that arrived from the worker, through Chrome. */
  fromWorker: (frame: unknown) => void;
  /** That server's socket closed. */
  closed: (connection: MuxConnection) => void;
  /** The sessions currently attached, in the order they greeted. */
  sessionIds: () => string[];
  /**
   * How many calls have been forwarded to the worker with no answer back yet (004/T162).
   *
   * What a superseded relay drains against before it closes a socket: closing one out from under a
   * call still counted here is exactly the defect the drain exists to stop, because the answer may
   * already be on its way back through this same connection.
   */
  pendingCallCount: () => number;
};

function frameField(frame: unknown, field: "callId" | "sessionId" | "type"): string | undefined {
  if (!frame || typeof frame !== "object") {
    return undefined;
  }
  const value = (frame as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createRelayMux(options: RelayMuxOptions): RelayMux {
  const log = options.log ?? ((): void => undefined);
  /** The current connection of each attached session. */
  const sessions = new Map<string, MuxConnection>();
  /**
   * Which session made each call in flight.
   *
   * Indirect through the session rather than straight to a connection, so the two awkward cases
   * fall out instead of being special-cased: a server that reconnects gets its own pending answers
   * on its new socket, and a session that ended stops routing entirely (its calls resolve to a
   * session that is no longer there and are dropped, not delivered to whoever attaches next).
   */
  const calls = new Map<string, string>();

  function connectionSessionId(connection: MuxConnection): string | undefined {
    for (const [sessionId, attached] of sessions) {
      if (attached === connection) {
        return sessionId;
      }
    }
    return undefined;
  }

  function deliver(frame: unknown, sessionId: string | undefined, key: string): void {
    const connection = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (!connection) {
      // Never broadcast. An answer nobody is waiting for reaching every session is how one agent
      // ends up reading another agent's page.
      log("relay.mux.dropped", key);
      return;
    }
    connection.send(frame);
  }

  return {
    fromServer(connection, frame) {
      const greeting = agentLinkFrameSchema.safeParse(frame);
      if (greeting.success && greeting.data.type === "hello") {
        if (greeting.data.token !== options.token) {
          log("relay.mux.hello-refused", "bad-token");
          return "rejected";
        }
        if (greeting.data.protocol !== AGENT_LINK_PROTOCOL) {
          // A server from another build (T099j). It read the record - it has the token - but the
          // frames past this one mean something else to it, so the refusal names the reason
          // instead of leaving both sides to retry in silence.
          log("relay.mux.hello-refused", `protocol found=${greeting.data.protocol ?? "none"}`);
          return "rejected";
        }
        const { sessionId } = greeting.data;
        // A session that greets again has reconnected after a link drop; its entry is replaced and
        // nothing is announced, because the session did not end - only its socket did.
        //
        // The connection it replaces is closed here (T099e). Usually that socket is already dead -
        // the drop is why the server dialled again - and closing it is a no-op. When it is not, the
        // id has been taken from a live connection, and leaving that one attached would orphan a
        // peer that still believes it holds the session. One id, one socket, either way.
        const previous = sessions.get(sessionId);
        sessions.set(sessionId, connection);
        connection.send({ type: "hello-ack", relayPid: options.relayPid });
        if (previous !== undefined && previous !== connection) {
          log("relay.mux.hello-replaced");
          void previous.close?.();
        }
        /**
         * The announcement, forwarded (004/T099i).
         *
         * The relay used to consume the greeting, which left the worker learning that a session
         * existed only from the `pair-request` a server happens to send on every attach - so
         * session liveness rode on pairing cadence, and S2 changes pairing. A greeting is what an
         * attach *is*, so it is what the worker registers on.
         *
         * The token does not go with it. It is this relay's own admission check between two local
         * processes; the extension has no use for it and every hop it survives is another place it
         * can be read from. Nor does the protocol stamp (T099j): it is a fact about the loopback
         * leg, already checked above, and the worker has no version question to ask.
         */
        const { token: _token, protocol: _protocol, ...announcement } = greeting.data;
        options.toWorker(announcement);
        log("relay.mux.attached", `sessions=${sessions.size} calls=${calls.size}`);
        return "accepted";
      }

      const sessionId = connectionSessionId(connection);
      if (sessionId === undefined) {
        // Either a peer that never greeted, or one whose greeting was refused. Nothing it says
        // reaches the worker: the token is the only thing standing between a local process and the
        // owner's browser.
        log("relay.mux.hello-refused", "not-greeted");
        return "rejected";
      }

      /**
       * The frame's `sessionId` is a claim; this connection's greeting is the fact (T099e).
       *
       * Everything past this hop keys on the frame: the worker's session registry, the pairing
       * label, the tab ownership check and this file's own `calls` map. So a frame naming another
       * session would let one greeted peer end that session, run tools in its context and be sent
       * its answers back. It is refused rather than rewritten - a frame this relay had to correct
       * is one it did not understand, and forwarding a corrected version would hide the defect.
       */
      const claimed = frameField(frame, "sessionId");
      if (claimed !== sessionId) {
        log("relay.mux.frame-refused", claimed === undefined ? "no-session" : "foreign-session");
        return "rejected";
      }

      const callId = frameField(frame, "callId");
      if (callId !== undefined) {
        calls.set(callId, sessionId);
      }
      options.toWorker(frame);
      return "accepted";
    },

    fromWorker(frame) {
      /**
       * The two frames whose addressee is this process (014 R-187 §4).
       *
       * They are answered before the routing below rather than inside it, because they name no call
       * and no session: the list is one per machine, and a frame that named a session would be a
       * list per agent. Everything about them is checked against the declared shape first - a
       * `root` that is not an absolute path never reaches the store.
       */
      const type = frameField(frame, "type");
      if (type === "upload-roots-list" || type === "upload-roots-remove") {
        const parsed = agentLinkFrameSchema.safeParse(frame);
        const store = options.uploadRoots;
        if (!parsed.success || store === undefined) {
          log("relay.mux.dropped", `upload-roots type=${type}`);
          return;
        }
        const answer =
          parsed.data.type === "upload-roots-remove"
            ? store.remove(parsed.data.root).then((change) => change.listing)
            : store.list();
        void answer
          .then((listing) => options.toWorker({ type: "upload-roots", ...listing }))
          .catch(() => {
            // A file this process could not read or write is not an answer; the panel keeps the row
            // it has, with its pending note, and asks again on the next `relay-ack`.
            log("relay.mux.dropped", `upload-roots failed type=${type}`);
          });
        return;
      }
      const callId = frameField(frame, "callId");
      if (callId !== undefined) {
        const sessionId = calls.get(callId);
        /**
         * A frame that names a call is usually its answer, and an answered call is over. The one
         * exception is 011's `prompt-waiting`: it names the call it is about precisely because it
         * is *not* the answer - the owner is still being asked - so forgetting the call here would
         * leave their eventual Allow with nowhere to go, dropped as unaddressed while the agent was
         * answered by a backstop. The keep-alive is named rather than inferred, so a frame type
         * nobody declared still spends the entry instead of pinning it open.
         */
        if (frameField(frame, "type") !== "prompt-waiting") {
          calls.delete(callId);
        }
        deliver(frame, sessionId, "call");
        return;
      }
      const sessionId = frameField(frame, "sessionId");
      if (sessionId !== undefined) {
        deliver(frame, sessionId, "session");
        return;
      }
      // A frame that names neither is addressed to nobody. 003 could send it to its one server;
      // with N attached there is no such thing as "the" server.
      //
      // The frame's `type` goes in the line: it is a protocol code from the link schema and nothing
      // page-derived, and without it this log says only that *something* went nowhere - which is
      // what turned the T096b pairing defect into a diagnosis instead of a report.
      log("relay.mux.dropped", `unaddressed type=${frameField(frame, "type") ?? "unknown"}`);
    },

    closed(connection) {
      const sessionId = connectionSessionId(connection);
      if (sessionId === undefined) {
        // Already gone, or a socket that was replaced by a reconnect. Either way this is not the end
        // of a session, and saying so twice would have the worker release a live session's tabs.
        return;
      }
      sessions.delete(sessionId);
      for (const [callId, owner] of calls) {
        if (owner === sessionId) {
          calls.delete(callId);
        }
      }
      log("relay.mux.detached", `sessions=${sessions.size} calls=${calls.size}`);
      options.toWorker({ type: "session-ended", sessionId });
    },

    sessionIds() {
      return [...sessions.keys()];
    },

    pendingCallCount() {
      return calls.size;
    },
  };
}
