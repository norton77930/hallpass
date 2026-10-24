import type {
  AgentLinkFrame,
  AgentPanelMessage,
  ConversationAgent,
  ConversationError,
  ConversationEvent,
  ConversationFolder,
  ConversationLinkCommand,
  ConversationPanelCommand,
  ConversationPanelState,
  SettingsCommand,
  SettingsMessage,
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
  /** 023 R-367: the reply to the panel's diagnostics request, passed to every panel document as it came. */
  "conversation-diagnostics",
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
 * 023 R-365, R-368: the worker's word that a conversation's `hallpass` server greeted with its panel
 * token. Like every frame to the broker it names the broker's session.
 */
export type ConversationBrowserAttachedFrame = {
  type: "conversation-browser-attached";
  sessionId: string;
  conversationId: string;
};

/** A frame the worker sends the broker. */
export type ConversationOutFrame = ConversationCommandFrame | ConversationBrowserAttachedFrame;

/**
 * 024 contracts/frames.md: the settings page's commands the broker answers (check-agents, install,
 * install-cancel, test, diagnostics by agent, and the side-panel-agent consent). Validated at the
 * settings port against the page's closed union; each carries the page's commandId.
 */
export type SettingsBrokerCommand = Extract<SettingsCommand, { type: `ui.conversation.${string}` }>;

/**
 * 024 R-373, R-387: where a settings page's forwarded command is answered - that page, and never the
 * panels. `result` is the broker's answer to the command (or the worker's own refusal when no broker
 * can answer); `diagnostics` the broker's reply to the page's `ui.conversation.diagnostics { agent }`.
 */
export type SettingsReplyTarget = {
  result: (
    payload: { commandId: string; ok: true } | { commandId: string; ok: false; error: { code: ConversationError["code"]; detail?: string } },
  ) => void;
  diagnostics: (payload: Extract<SettingsMessage, { type: "worker.settings.diagnostics" }>["payload"]) => void;
  /** Whether the page is still connected; a page that went no longer waits for a diagnostics reply. */
  isOpen?: () => boolean;
};

/**
 * 024 R-387: how long a page's `ui.conversation.diagnostics { agent }` waits for the broker's reply.
 * The reply names the agent and no command, so a wait whose reply never came would otherwise sit at
 * the head of that agent's queue and take the next asker's reply. The broker reads the lines from
 * its own ring and answers at once; 10 s is far past that, and a page that asks again is waiting anew.
 */
export const DIAGNOSTICS_REPLY_WINDOW_MS = 10_000;

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
  /**
   * 023 T717 (R-365): a conversation's `hallpass` server greeted with this live `token`. The broker
   * is told once per token - the broker mints one per agent run, so once per run - and only when it
   * is attached; a redial under the same token is the same run and says nothing.
   */
  browserAttached: (conversationId: string, token: string) => void;
  /**
   * T547: one `ui.conversation.*` command from a panel document, already validated at the port.
   * 024 R-373: or from a settings page (`page` given), whose answers go to that page alone.
   */
  command: (command: ConversationPanelCommand | SettingsBrokerCommand, page?: SettingsReplyTarget) => void;
  /** T547: the projection's `conversation` part; `linkUp` is whether the native link is connected. */
  panelState: (linkUp: boolean) => ConversationPanelState;
};

type Pending = {
  type: ConversationLinkCommand["type"];
  conversationId?: string;
  /** The consent command's answer, so the projection can show it before the next overview. */
  granted?: boolean;
  /**
   * T610: an open that switched the panel at once - the conversation that was open before it (none:
   * `to` undefined), which the panel goes back to if the broker refuses the open. T692: a start the
   * panel switched to (`conversationId` its listed entry) goes back the same way.
   */
  back?: { to: string | undefined };
  /**
   * T692 (021 R-354): a start's agent and folder, and the conversations listed when it left (unknown
   * without an overview: then it is never matched, and only its result opens the conversation).
   */
  start?: { agent: ConversationAgent; folder: ConversationFolder; before: ReadonlySet<string> | undefined };
  /** 024 R-373: the settings page that sent it, which alone hears its result. */
  page?: SettingsReplyTarget;
};

/** T610: states with no agent running, which an open under way shows as `starting` (it resumes the agent). */
const NOT_RUNNING = new Set<string>(["stopped", "crashed", "gone"]);

const sameFolder = (a: ConversationFolder, b: ConversationFolder): boolean =>
  a.kind === "project" ? b.kind === "project" && a.path === b.path : b.kind === a.kind;

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
  /** 023 T717: the word that a conversation's browser server greeted, for the broker. */
  sendAttached?: (frame: ConversationBrowserAttachedFrame) => void;
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
  /**
   * T610: conversations whose open the broker refused with `cannot-resume`, shown as not resumable
   * until the broker's overview says so itself (it marks the entry after the result has gone) - or
   * until the owner tries to open it again.
   */
  const refusedResume = new Set<string>();
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
  /**
   * 023 R-365: the token each conversation's browser server was last reported under (a marker of the
   * run, never sent or logged). A new relay or broker forgets it: the run's server redials and the
   * broker it then talks to has not heard.
   */
  const attachedUnder = new Map<string, string>();

  /**
   * 024 R-387: the settings pages waiting for a diagnostics reply by agent, in the order they asked.
   * The broker's reply names the agent and no command, so the first page waiting on that agent takes
   * it; a refused request leaves the list, and a reply nobody waits for goes nowhere. A wait also
   * leaves when its page went, and when no reply came within `DIAGNOSTICS_REPLY_WINDOW_MS`.
   */
  type DiagnosticsWait = { commandId: string; agent: ConversationAgent; page: SettingsReplyTarget };
  const diagnosticsWaiting: DiagnosticsWait[] = [];
  const stopWaiting = (commandId: string): void => {
    const at = diagnosticsWaiting.findIndex((entry) => entry.commandId === commandId);
    if (at !== -1) diagnosticsWaiting.splice(at, 1);
  };
  const waitForDiagnostics = (wait: DiagnosticsWait): void => {
    diagnosticsWaiting.push(wait);
    schedule(() => {
      const at = diagnosticsWaiting.indexOf(wait);
      if (at === -1) return;
      diagnosticsWaiting.splice(at, 1);
      report("agent.conversation.diagnostics-expired");
    }, DIAGNOSTICS_REPLY_WINDOW_MS);
  };
  /** Drops the waits whose page is no longer connected. */
  const pruneClosedWaits = (): void => {
    for (let at = diagnosticsWaiting.length - 1; at >= 0; at -= 1) {
      if (diagnosticsWaiting[at]!.page.isOpen?.() === false) diagnosticsWaiting.splice(at, 1);
    }
  };

  const failure = (commandId: string, detail: string): AgentPanelMessage => ({
    type: "conversation-result",
    payload: { commandId, ok: false, error: { code: "broker-unavailable", detail } },
  });

  /** A refusal no broker gave: to the settings page that sent the command, else to every panel. */
  const refuse = (commandId: string, detail: string, page: SettingsReplyTarget | undefined): void => {
    if (page === undefined) {
      toPanels(failure(commandId, detail));
      return;
    }
    stopWaiting(commandId);
    page.result({ commandId, ok: false, error: { code: "broker-unavailable", detail } });
  };

  /**
   * T610: a refused open that had switched the panel goes back to the conversation open before it -
   * and an open chosen after it, still under way, goes back there too rather than to the refused one.
   */
  const switchBack = (command: Pending): void => {
    const refused = command.conversationId;
    if (command.back === undefined || refused === undefined) return;
    if (active === refused) active = command.back.to;
    for (const other of pending.values()) {
      if (other.back !== undefined && other.back.to === refused) other.back = command.back;
    }
  };

  /**
   * T692 (021 R-354, FR-354): the broker lists a new conversation as `starting` as soon as its start
   * begins, but answers the start only once the agent is up - minutes for DeepSeek - and the panel can
   * stop a start only from the open conversation. So an entry listed `starting` that was not listed
   * when a start left, with that start's agent and folder, is opened at once, as an open is (T610).
   * The overview names no command, so two starts of one agent in one folder under way together cannot
   * be told apart: neither is matched, and each result opens its own conversation as before.
   */
  const claimStarts = (conversations: Overview["conversations"]): void => {
    const taken = new Set<string>();
    const waiting: Array<Pending & { start: NonNullable<Pending["start"]> }> = [];
    for (const command of pending.values()) {
      if (command.start === undefined) continue;
      if (command.conversationId !== undefined) taken.add(command.conversationId);
      else if (command.start.before !== undefined) waiting.push(command as Pending & { start: NonNullable<Pending["start"]> });
    }
    const newTo = (command: (typeof waiting)[number], entry: Overview["conversations"][number]): boolean =>
      command.conversationId === undefined &&
      entry.state === "starting" &&
      !taken.has(entry.conversationId) &&
      !command.start.before!.has(entry.conversationId) &&
      entry.agent === command.start.agent &&
      sameFolder(entry.folder, command.start.folder);
    for (const command of waiting) {
      const found = conversations.filter((entry) => newTo(command, entry));
      if (found.length !== 1) continue;
      const entry = found[0]!;
      if (waiting.some((other) => other !== command && newTo(other, entry))) continue;
      command.conversationId = entry.conversationId;
      command.back = { to: active };
      taken.add(entry.conversationId);
      active = entry.conversationId;
    }
  };

  /** The commands no broker will answer now: said to the panels, so none waits in vain. */
  const failPending = (): void => {
    for (const [commandId, command] of pending) {
      if (command.type === "worker.conversation.page") continue;
      switchBack(command);
      refuse(commandId, "Hallpass's helper on this computer stopped before it answered.", command.page);
    }
    pending.clear();
    paging.clear();
    // 024 R-387: a reply the broker that left still owed will not come.
    diagnosticsWaiting.length = 0;
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
    if (command.type === "ui.conversation.open") {
      // T610: the panel switched when the open left; an answer only ends its `starting` - or, refused,
      // shows the chosen conversation's end (cannot-resume) or goes back to the one open before.
      if (!frame.ok && frame.error.code === "cannot-resume") refusedResume.add(command.conversationId!);
      else if (!frame.ok) switchBack(command);
      changed();
    } else if (!frame.ok && command.type === "ui.conversation.start") {
      // T692: a refused or cancelled start the panel had switched to goes back to the one before.
      if (command.back !== undefined) {
        switchBack(command);
        changed();
      }
    } else if (frame.ok) {
      let moved = true;
      if (command.type === "ui.conversation.start" && frame.value?.conversationId !== undefined) {
        const started = frame.value.conversationId;
        // T692: already open since it was listed - unless the owner went elsewhere meanwhile.
        if (command.conversationId === undefined || active === command.conversationId) active = started;
        else moved = false;
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
    if (command.page !== undefined) {
      // 024 R-373: a settings page's command is answered to that page alone; no value rides along
      // (none of the page's commands has one).
      if (frame.ok) {
        command.page.result({ commandId: frame.commandId, ok: true });
      } else {
        stopWaiting(frame.commandId);
        command.page.result({ commandId: frame.commandId, ok: false, error: frame.error });
      }
      return;
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
      refusedResume.clear();
      attachedUnder.clear();
      failPending();
      changed();
      return true;
    },
    relayStarted() {
      broker = undefined;
      overview = undefined;
      refusedResume.clear();
      greetedThisRun = false;
      attachedUnder.clear();
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
      // T558: a browser token reaches `onBrowserToken` alone, never the injectable hook; 023 R-367: nor
      // do the agent's own output lines, which reach the panels alone.
      if (frame.type !== "conversation-browser-token" && frame.type !== "conversation-diagnostics") options.deliver?.(frame);
      switch (frame.type) {
        case "conversation-overview": {
          const { conversations, agents, folders, consent, notice } = frame;
          // T610: a refusal the broker now shows itself (or an entry no longer listed) needs no stand-in.
          for (const conversationId of refusedResume) {
            const listed = conversations.find((entry) => entry.conversationId === conversationId);
            if (listed === undefined || !listed.resumable) refusedResume.delete(conversationId);
          }
          overview = {
            conversations,
            agents,
            folders,
            ...(consent === undefined ? {} : { consent }),
            ...(notice === undefined ? {} : { notice }),
          };
          claimStarts(conversations);
          changed();
          break;
        }
        case "conversation-result":
          settle(frame);
          break;
        case "conversation-event":
          forward(frame.conversationId, frame.seq, frame.event, true);
          break;
        case "conversation-diagnostics": {
          // 023 R-367: the broker's reply to a diagnostics request, already scrubbed there. Never
          // logged or kept here.
          const { agent, readAt, conversationId, lines } = frame;
          if (agent !== undefined && readAt !== undefined) {
            // 024 R-387: a reply by agent is the settings page's, to the first page waiting on that
            // agent and to no panel. A page that went waits no more.
            pruneClosedWaits();
            const at = diagnosticsWaiting.findIndex((entry) => entry.agent === agent);
            if (at === -1) {
              report("agent.conversation.diagnostics-unclaimed");
              break;
            }
            const [waiting] = diagnosticsWaiting.splice(at, 1);
            waiting!.page.diagnostics({ agent, readAt, ...(conversationId === undefined ? {} : { conversationId }), lines });
            break;
          }
          // A reply by conversation, as in 023: passed on to every panel document.
          if (conversationId !== undefined) toPanels({ type: "conversation-diagnostics", payload: { conversationId, lines } });
          break;
        }
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
    browserAttached(conversationId, token) {
      if (broker === undefined || options.sendAttached === undefined) return;
      if (attachedUnder.get(conversationId) === token) return;
      attachedUnder.set(conversationId, token);
      options.sendAttached({ type: "conversation-browser-attached", sessionId: broker, conversationId });
    },
    command(command, page) {
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
        refuse(commandId, "Hallpass's helper on this computer is not connected.", page);
        return;
      }
      const payload = forwarded.payload as { conversationId?: string; granted?: boolean; agent?: ConversationAgent; folder?: ConversationFolder };
      // 024 R-387: a page asking for an agent's last output waits for the reply that names that agent.
      if (page !== undefined && forwarded.type === "ui.conversation.diagnostics" && payload.agent !== undefined) {
        pruneClosedWaits();
        waitForDiagnostics({ commandId, agent: payload.agent, page });
      }
      // T610: the chosen conversation is shown at once; the broker answers only once its replay ends.
      const switching = forwarded.type === "ui.conversation.open" && payload.conversationId !== active;
      pending.set(commandId, {
        type: forwarded.type,
        ...(payload.conversationId === undefined ? {} : { conversationId: payload.conversationId }),
        ...(payload.granted === undefined ? {} : { granted: payload.granted }),
        ...(switching ? { back: { to: active } } : {}),
        ...(page === undefined ? {} : { page }),
        ...(forwarded.type === "ui.conversation.start"
          ? {
              start: {
                agent: payload.agent!,
                folder: payload.folder!,
                before: overview === undefined ? undefined : new Set(overview.conversations.map((entry) => entry.conversationId)),
              },
            }
          : {}),
      });
      options.sendFrame({ type: "conversation-command", sessionId: broker, commandId, command: forwarded });
      if (forwarded.type === "ui.conversation.open") {
        // Opening it again is trying again: the broker's answer decides anew.
        refusedResume.delete(payload.conversationId!);
        if (switching) active = payload.conversationId;
        changed();
      }
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
      // T610: an open under way shows its conversation starting; a refused resume shows its end.
      const opening = new Set<string>();
      for (const command of pending.values()) {
        if (command.type === "ui.conversation.open" && command.conversationId !== undefined) opening.add(command.conversationId);
      }
      const conversations = (overview?.conversations ?? []).map((entry) => {
        const starting = opening.has(entry.conversationId) && NOT_RUNNING.has(entry.state);
        const ended = refusedResume.has(entry.conversationId);
        if (!starting && !ended) return entry;
        return { ...entry, ...(starting ? { state: "starting" as const } : {}), ...(ended ? { resumable: false } : {}) };
      });
      return {
        available: true,
        epoch: broker!,
        consent,
        conversations,
        ...(active === undefined ? {} : { active }),
        agents: overview?.agents ?? [],
        folders: overview?.folders ?? [],
        ...(overview?.notice === undefined ? {} : { notice: overview.notice }),
      };
    },
  };
}
