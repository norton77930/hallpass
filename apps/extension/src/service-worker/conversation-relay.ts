import type {
  AgentLinkFrame,
  AgentPanelMessage,
  ConversationEvent,
  ConversationLinkCommand,
  ConversationPanelCommand,
  ConversationPanelState,
} from "@hallpass/contracts";

/**
 * 019 R-312, T527: the worker's one broker session per relay run.
 *
 * The relay admitted the broker's greeting by the secret it gave its own broker, so a `hello` with
 * `role: "broker"` reaching the worker is that broker. It is not an agent: the runtime creates no
 * session card, no record, no tab group and no pairing for it. This holds which session it is, and
 * lets `conversation-*` frames through from that session alone - any other session that names the
 * frame type is dropped and the drop reported (a code only, never the frame).
 *
 * One per relay run: a second broker greeting while the first is attached is refused, and replaces
 * it only after the first's `session-ended`. A new relay run starts with none, because the broker
 * greets every new relay (adopted, with the same session id; or newly spawned, with a new one).
 * Memory only: a worker restart is also a new native port and so a new relay run.
 *
 * T547 (R-318, R-323): it is also the worker's whole part in a conversation. A panel's
 * `ui.conversation.*` command goes to the broker as a `conversation-command` under the panel's
 * commandId (or one minted here); the broker's result, events and pages go to every panel document;
 * the projection's `conversation` part is assembled here. What it holds is the broker's last
 * overview (index fields, no content), which conversation is open, the commands in flight (type and
 * conversation id only, never a message's text) and the last seq forwarded per conversation - a
 * number, so a gap or a new relay can be followed by a page request. Nothing of it is stored.
 */

/** The frames a broker sends the worker (contracts/conversation-frames.md, "Worker <-> broker"). */
export const CONVERSATION_FRAME_TYPES = [
  "conversation-result",
  "conversation-event",
  "conversation-overview",
  "conversation-page",
  "conversation-browser-token",
] as const;

export type ConversationLinkFrame = Extract<AgentLinkFrame, { type: (typeof CONVERSATION_FRAME_TYPES)[number] }>;

export function isConversationLinkFrame(frame: AgentLinkFrame): frame is ConversationLinkFrame {
  return (CONVERSATION_FRAME_TYPES as readonly string[]).includes(frame.type);
}

/** A `conversation-command` frame, as the worker sends it to the broker. */
export type ConversationCommandFrame = {
  type: "conversation-command";
  sessionId: string;
  commandId: string;
  command: ConversationLinkCommand;
};

/**
 * T547: how long after a relay announced itself the worker waits for that relay's broker before it
 * says the host is too old to have one. A 0.12 relay never starts a broker (R-323), and the broker a
 * current relay spawns greets within a second or two; 15 s is the broker's own redial window
 * (R-312), so a broker still on its way is not called outdated while it may yet arrive.
 */
export const BROKER_GREETING_WINDOW_MS = 15_000;

export type ConversationRelay = {
  /** A broker greeting; `true` when that session is (now, or still) this run's broker. */
  announce: (sessionId: string) => boolean;
  /** Whether a session is this run's broker. */
  isBroker: (sessionId: string) => boolean;
  /** A session ended; `true` when it was the broker, which is then forgotten. */
  ended: (sessionId: string) => boolean;
  /** A new relay announced itself: no broker until one greets it. */
  relayStarted: () => void;
  /** A conversation frame from the link; delivered only from the broker. */
  receive: (frame: ConversationLinkFrame) => boolean;
  current: () => string | undefined;
  /** T547: one `ui.conversation.*` command from a panel document, already validated at the port. */
  command: (command: ConversationPanelCommand) => void;
  /** T547: the projection's `conversation` part; `linkUp` is whether the native link is connected. */
  panelState: (linkUp: boolean) => ConversationPanelState;
};

type Pending = {
  type: ConversationLinkCommand["type"];
  conversationId?: string;
  /** The consent command's answer, so the projection can show it before the next overview. */
  granted?: boolean;
};

type Overview = Pick<ConversationPanelState, "conversations" | "agents" | "folders"> & {
  consent?: ConversationPanelState["consent"];
  /** T563: a code only; the panel words it (the broker's text never reaches it). */
  notice?: ConversationPanelState["notice"];
};

export function createConversationRelay(options: {
  /** Every accepted broker frame except `conversation-browser-token` (that goes to `onBrowserToken` only). */
  deliver?: (frame: ConversationLinkFrame) => void;
  reportDiagnostic?: (code: string) => void;
  /** T547: a frame for the broker, on the native link. */
  sendFrame?: (frame: ConversationCommandFrame) => void;
  /** T547: a message for every panel document. */
  toPanels?: (message: AgentPanelMessage) => void;
  /** T547: the projection's conversation part may have changed. */
  changed?: () => void;
  /**
   * 019 T553 (R-321): a `conversation-browser-token` from this run's broker - a token for one
   * conversation's mcp-server, or `token: null` to revoke it. Revoking every token when the broker
   * leaves or a new relay starts is the runtime's, beside `ended` and `relayStarted`.
   */
  onBrowserToken?: (grant: { conversationId: string; token: string | null; startTabId?: number }) => void;
  greetingWindowMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
  mintId?: () => string;
}): ConversationRelay {
  const report = options.reportDiagnostic ?? ((): void => undefined);
  const changed = options.changed ?? ((): void => undefined);
  const toPanels = options.toPanels ?? ((): void => undefined);
  const now = options.now ?? (() => Date.now());
  const windowMs = options.greetingWindowMs ?? BROKER_GREETING_WINDOW_MS;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): void => {
      const timer = setTimeout(callback, delayMs) as unknown as { unref?: () => void };
      timer.unref?.();
    });
  const mintId = options.mintId ?? (() => crypto.randomUUID());

  let broker: string | undefined;
  /** When the current relay run began; undefined before the first `relay-started`. */
  let relayStartedAt: number | undefined;
  /** Whether a broker greeted this relay run at all (one that greeted and left is not "outdated"). */
  let greetedThisRun = false;
  let overview: Overview | undefined;
  let consentAnswer: ConversationPanelState["consent"] | undefined;
  let active: string | undefined;
  const pending = new Map<string, Pending>();
  /** The last seq forwarded per conversation: a number, never the event (R-318). */
  const lastSeq = new Map<string, number>();
  /**
   * T572: the broker whose seqs `lastSeq` holds. A replacement broker (a new session id) restarts
   * every conversation at seq 0, so its greeting clears them; the same broker greeting a new relay
   * (adopted) still counts where it left off, and is asked for what it may have missed.
   */
  let seqsOf: string | undefined;
  /** Conversations a gap-filling page request is out for, so a burst of late events asks once. */
  const paging = new Set<string>();

  const failure = (commandId: string, detail: string): AgentPanelMessage => ({
    type: "conversation-result",
    payload: { commandId, ok: false, error: { code: "broker-unavailable", detail } },
  });

  /** The commands no broker will answer now: said to the panels, so none waits in vain. */
  const failPending = (): void => {
    for (const [commandId, command] of pending) {
      if (command.type === "worker.conversation.page") continue;
      toPanels(failure(commandId, "Hallpass's helper on this computer stopped before it answered."));
    }
    pending.clear();
    paging.clear();
  };

  const requestPages = (conversationId: string, fromSeq: number): void => {
    if (broker === undefined || options.sendFrame === undefined) return;
    const commandId = mintId();
    pending.set(commandId, { type: "worker.conversation.page", conversationId });
    options.sendFrame({
      type: "conversation-command",
      sessionId: broker,
      commandId,
      command: { type: "worker.conversation.page", payload: { conversationId, fromSeq } },
    });
  };

  /** One event to every panel document; a jump in its conversation's seqs asks for the missing part. */
  const forward = (conversationId: string, seq: number, event: ConversationEvent, live: boolean): void => {
    const last = lastSeq.get(conversationId);
    if (live && last !== undefined && seq > last + 1 && !paging.has(conversationId)) {
      paging.add(conversationId);
      requestPages(conversationId, last + 1);
    }
    if (last === undefined || seq > last) lastSeq.set(conversationId, seq);
    toPanels({ type: "conversation-event", payload: { conversationId, seq, event } });
  };

  const settle = (frame: Extract<ConversationLinkFrame, { type: "conversation-result" }>): void => {
    const command = pending.get(frame.commandId);
    if (command === undefined) {
      report("agent.conversation.result-unknown");
      return;
    }
    pending.delete(frame.commandId);
    if (command.type === "worker.conversation.page") {
      if (frame.ok) return;
      paging.delete(command.conversationId!);
      // A conversation the broker does not know is not left open (a panel's resync of a removed one).
      if (frame.error.code === "not-found" && active === command.conversationId) {
        active = undefined;
        changed();
      }
      return;
    }
    if (frame.ok) {
      let moved = true;
      if (command.type === "ui.conversation.start" && frame.value?.conversationId !== undefined) {
        active = frame.value.conversationId;
      } else if (command.type === "ui.conversation.open") {
        active = command.conversationId;
      } else if (command.type === "ui.conversation.remove" && active === command.conversationId) {
        active = undefined;
      } else if (command.type === "ui.conversation.consent") {
        consentAnswer = command.granted ? "granted" : "withdrawn";
        // Until the broker's next overview says so itself.
        if (overview !== undefined) overview = { ...overview, consent: consentAnswer };
      } else {
        moved = false;
      }
      if (moved) changed();
    }
    const { type: _type, sessionId: _sessionId, ...payload } = frame;
    toPanels({ type: "conversation-result", payload } as AgentPanelMessage);
  };

  return {
    announce(sessionId) {
      if (broker !== undefined && broker !== sessionId) {
        report("agent.conversation.broker-refused");
        return false;
      }
      broker = sessionId;
      greetedThisRun = true;
      if (seqsOf !== sessionId) {
        lastSeq.clear();
        paging.clear();
        seqsOf = sessionId;
      }
      changed();
      // Whatever a panel was shown may have gone on without this worker hearing it (a new relay,
      // a dropped link): ask for each conversation from the seq after the last one forwarded.
      for (const [conversationId, seq] of lastSeq) {
        paging.add(conversationId);
        requestPages(conversationId, seq + 1);
      }
      return true;
    },
    isBroker(sessionId) {
      return broker !== undefined && broker === sessionId;
    },
    ended(sessionId) {
      if (broker === undefined || broker !== sessionId) return false;
      broker = undefined;
      overview = undefined;
      failPending();
      changed();
      return true;
    },
    relayStarted() {
      broker = undefined;
      overview = undefined;
      greetedThisRun = false;
      relayStartedAt = now();
      failPending();
      changed();
      // So the projection is re-read when the window closes and "host-outdated" can be said.
      schedule(changed, windowMs);
    },
    receive(frame) {
      if (broker === undefined || frame.sessionId !== broker) {
        report("agent.conversation.frame-foreign");
        return false;
      }
      // T558: a browser token reaches `onBrowserToken` alone, never the injectable hook.
      if (frame.type !== "conversation-browser-token") options.deliver?.(frame);
      switch (frame.type) {
        case "conversation-overview": {
          const { conversations, agents, folders, consent, notice } = frame;
          overview = {
            conversations,
            agents,
            folders,
            ...(consent === undefined ? {} : { consent }),
            ...(notice === undefined ? {} : { notice }),
          };
          changed();
          break;
        }
        case "conversation-result":
          settle(frame);
          break;
        case "conversation-event":
          forward(frame.conversationId, frame.seq, frame.event, true);
          break;
        case "conversation-page":
          for (const entry of frame.events) forward(frame.conversationId, entry.seq, entry.event, false);
          if (!frame.more) paging.delete(frame.conversationId);
          break;
        case "conversation-browser-token":
          // 019 R-321, T553: the panel conversation's browser connection, from the broker alone
          // (checked above). Handed on as it came; the token is never kept or logged here.
          options.onBrowserToken?.({
            conversationId: frame.conversationId,
            token: frame.token,
            ...(frame.startTabId === undefined ? {} : { startTabId: frame.startTabId }),
          });
          break;
      }
      return true;
    },
    current() {
      return broker;
    },
    command(command) {
      if (command.type === "ui.conversation.resync") {
        const { conversationId, fromSeq } = command.payload;
        // The panel is showing it: a worker that restarted has forgotten which one was open.
        if (active === undefined) {
          active = conversationId;
          changed();
        }
        requestPages(conversationId, fromSeq);
        return;
      }
      const { commandId: given, ...forwarded } = command;
      const commandId = given ?? mintId();
      if (broker === undefined || options.sendFrame === undefined) {
        toPanels(failure(commandId, "Hallpass's helper on this computer is not connected."));
        return;
      }
      const payload = forwarded.payload as { conversationId?: string; granted?: boolean };
      pending.set(commandId, {
        type: forwarded.type,
        ...(payload.conversationId === undefined ? {} : { conversationId: payload.conversationId }),
        ...(payload.granted === undefined ? {} : { granted: payload.granted }),
      });
      options.sendFrame({ type: "conversation-command", sessionId: broker, commandId, command: forwarded });
    },
    /**
     * T572: `epoch` is the attached broker's session id, so a panel that sees it change knows the
     * events it kept are another broker's seqs, drops them and pages again from 0.
     */
    panelState(linkUp) {
      const available = linkUp && broker !== undefined;
      const outdated =
        !available &&
        linkUp &&
        broker === undefined &&
        !greetedThisRun &&
        relayStartedAt !== undefined &&
        now() - relayStartedAt >= windowMs;
      const consent = overview?.consent ?? consentAnswer ?? "unknown";
      if (!available) {
        return {
          available: false,
          reason: outdated ? "host-outdated" : "broker-unavailable",
          consent,
          conversations: [],
          agents: [],
          folders: [],
        };
      }
      return {
        available: true,
        epoch: broker!,
        consent,
        conversations: overview?.conversations ?? [],
        ...(active === undefined ? {} : { active }),
        agents: overview?.agents ?? [],
        folders: overview?.folders ?? [],
        ...(overview?.notice === undefined ? {} : { notice: overview.notice }),
      };
    },
  };
}
