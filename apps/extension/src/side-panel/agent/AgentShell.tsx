import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import {
  AGENT_PANEL_PORT_NAME,
  agentPanelMessageSchema,
  type AgentPanelCommand,
  type AgentPanelState,
  type ConversationError,
  type ConversationPanelCommand,
  type ConversationPanelResult,
  type ConversationPanelState,
  type TabCaptureResult,
} from "@hallpass/contracts";
import { reportTestDiagnostic } from "../../diagnostics.js";
import { lookup } from "../../locales/catalog.js";
import { appendLogEntry, type ConversationLogs } from "./conversation/conversation-log.js";
import { ConversationTab } from "./conversation/ConversationTab.js";
import { useComposerMemory } from "./conversation/attachments/drafts.js";
import { panelWindowMessage } from "../../panel-window.js";
import { BrowserRow } from "./BrowserRow.js";
import { NotConnected } from "./NotConnected.js";
import { PanelConsentSwitch } from "./PanelConsentSwitch.js";
import { NoticeCard, PromptCard } from "./PromptCard.js";
import { SessionCard } from "./SessionCard.js";
import { SiteList } from "./SiteList.js";
import { StatusRow } from "./StatusRow.js";
import "./tokens.css";
import "./agent.css";

/**
 * The agent build's side panel (006 S1): a status, consent and control surface over the panel
 * port (D-006-1).
 *
 * It owns the port the way the 003 panel did - its own, beside the archived control port - and it
 * keeps nothing else (R-125): which of the compositions is on screen is computed from the last
 * projection that parsed, so the panel can never show a page the worker did not send. Everything
 * the owner presses leaves as one closed command.
 */

const EMPTY_STATE: AgentPanelState = { paired: [], sessions: [], tabs: [], sites: [], bridge: "disconnected" };

/**
 * How many times the panel silently reconnects to a worker that keeps going away - the archived
 * control port's number. An MV3 worker idling out is ordinary and reconnects transparently; one
 * that cannot be reached this many times is not a transient idle, and retrying forever leaves the
 * owner looking at a panel that quietly does nothing.
 */
const MAX_RECONNECT_ATTEMPTS = 6;

/** The three compositions the projection can land on; a pending prompt sits over any of them. */
export type AgentComposition = "not-connected" | "idle" | "sessions";

/**
 * The agent-id namespace of the side panel's own agent (`service-worker/panel-sessions.ts`, R-321).
 * Kept as a literal here because the panel bundle imports nothing from the worker.
 */
const PANEL_AGENT_PREFIX = "panel:";

/**
 * R-125 in one place. Not connected wins over everything: a paired browser whose link is down has
 * nothing the owner can do about a session, and an unpaired one has no session to show.
 *
 * 019 T563 follow-up: the side panel's own agent needs no pairing (FR-305), so "something is
 * connected to this browser" is also true for an owner who granted the panel consent, and for any
 * panel session already in the projection. Without it their session cards and the site list - where
 * the sites the panel agent touches are switched - stayed hidden behind the not-paired page. An
 * owner with neither a pairing nor a panel consent sees what they always saw.
 */
export function deriveComposition(state: AgentPanelState): AgentComposition {
  if (state.bridge !== "connected") return "not-connected";
  const panelAgent =
    state.conversation?.consent === "granted" ||
    state.sessions.some((session) => session.agentId.startsWith(PANEL_AGENT_PREFIX));
  if (state.paired.length === 0 && !panelAgent) return "not-connected";
  return state.sessions.length === 0 ? "idle" : "sessions";
}

export type SendCommand = (command: AgentPanelCommand) => void;

/** 022 R-337: a `ui.conversation.*` command whose own result the caller waits for. */
export type ConversationRequest = Exclude<ConversationPanelCommand, { type: "ui.conversation.resync" }>;
/**
 * 022 R-337: send one conversation command and wait for the broker's answer to it - matched by the
 * commandId minted here (T547). It does not touch the shell's last-error line: the caller says what
 * the answer means. A connection that drops first answers `broker-unavailable` (nothing more will
 * come for it); the caller bounds the wait (30 s, transfer.ts).
 */
export type RequestCommand = (command: ConversationRequest) => Promise<ConversationPanelResult>;
/** 022 R-342: ask the worker for the tab the owner is looking at (the composer's tab entries). */
export type CaptureTab = (tabId: number, what: "screenshot" | "page") => Promise<TabCaptureResult>;

/** What a pending request is answered with when the connection it left on is gone. */
const CONNECTION_LOST = "The side panel lost its connection to Hallpass before the answer came.";

/**
 * T633: how long the composer waits for the worker's capture before saying it failed. A page's text
 * (every frame) or a PDF's fetch can take longer than a picture of what the window shows.
 */
const CAPTURE_TIMEOUT_MS: Record<"screenshot" | "page", number> = { screenshot: 30_000, page: 90_000 };
const CAPTURE_TIMED_OUT = "The tab was not captured in time.";

/** 019 T547: how many of this document's own commandIds are remembered while their results are due. */
const OWN_COMMANDS_KEPT = 64;

const mintCommandId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * 019 T547, R-318: which conversation a (re)connected document asks the worker to page from, and
 * from which seq. The one on screen - or, when a worker that restarted has forgotten which was open,
 * the one this document last showed - from the seq after the last event it kept (0 if none).
 */
function resyncTarget(
  conversation: ConversationPanelState,
  lastShown: string | undefined,
  lastSeqs: ReadonlyMap<string, number>,
): { conversationId: string; fromSeq: number } | undefined {
  const conversationId = conversation.active ?? lastShown;
  if (conversationId === undefined) return undefined;
  const last = lastSeqs.get(conversationId);
  return { conversationId, fromSeq: last === undefined ? 0 : last + 1 };
}

function useAgentPort(): {
  state: AgentPanelState;
  logs: ConversationLogs;
  send: SendCommand;
  request: RequestCommand;
  captureTab: CaptureTab;
  lastError: ConversationError | undefined;
} {
  const [state, setState] = useState<AgentPanelState>(EMPTY_STATE);
  /**
   * 019 D-019-6, T546: what the Conversation tab has been told, per conversation, in this document's
   * memory only. Nothing of it is written anywhere; a reopened panel is sent it again (T547).
   */
  const [logs, setLogs] = useState<ConversationLogs>({});
  /**
   * 019 T547: the broker's refusal of the last command *this document* sent, cleared by its next
   * success. Results reach every document; one whose commandId this document did not mint is
   * another panel's, and not shown here.
   */
  const [lastError, setLastError] = useState<ConversationError | undefined>(undefined);
  const ownCommands = useRef<string[]>([]);
  /** The last seq kept per conversation (a number per id, the events stay in `logs`). */
  const lastSeqs = useRef(new Map<string, number>());
  /** Set on every connection and whenever the conversation part is unavailable; cleared by a resync. */
  const needsResync = useRef(true);
  const lastShown = useRef<string | undefined>(undefined);
  /**
   * 019 T572: the broker whose events `logs` and `lastSeqs` hold (the projection's `epoch`). Kept
   * across reconnections, as the logs are: a worker that restarted may be attached to the same broker.
   */
  const epoch = useRef<string | undefined>(undefined);
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
  /** A fresh connection on the owner's word, for after the backoff has given up. */
  const reconnectRef = useRef<(() => void) | undefined>(undefined);
  /** 022 R-337: requests waiting for their own result, by the commandId minted for them. */
  const requests = useRef(new Map<string, (result: ConversationPanelResult) => void>());
  /** 022 R-342: tab captures waiting for the worker, by requestId. */
  const captures = useRef(new Map<string, (result: TabCaptureResult) => void>());
  /**
   * 022 (S1 architecture review): attachments whose first piece left and that were neither sent nor
   * cancelled, with their conversation - cancelled, best effort, when this document goes away.
   */
  const begun = useRef(new Map<string, string>());

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) {
      return;
    }
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const onMessage = (message: unknown): void => {
      const parsed = agentPanelMessageSchema.safeParse(message);
      if (!parsed.success) {
        // Keep showing the last projection that parsed. Rendering a state nobody sent is how a
        // panel ends up offering the owner a decision about something that is not there.
        reportTestDiagnostic("agent.panel.projection-rejected");
        return;
      }
      // A projection proves this connection is healthy, so the next drop backs off from scratch.
      attempt = 0;
      if (parsed.data.type === "conversation-event") {
        // 019 T546, FR-288: one broker event for the Conversation tab, kept with its conversation.
        const payload = parsed.data.payload;
        const last = lastSeqs.current.get(payload.conversationId);
        if (last === undefined || payload.seq > last) lastSeqs.current.set(payload.conversationId, payload.seq);
        setLogs((current) => appendLogEntry(current, payload));
        return;
      }
      if (parsed.data.type === "conversation-result") {
        const result = parsed.data.payload;
        // 022 R-337: a request's answer goes to the one waiting for it, and only there.
        const waiting = requests.current.get(result.commandId);
        if (waiting !== undefined) {
          requests.current.delete(result.commandId);
          waiting(result);
          return;
        }
        // 019 T547 (G1): only this document's own commands; the latest one decides.
        const index = ownCommands.current.indexOf(result.commandId);
        if (index < 0) return;
        ownCommands.current.splice(index, 1);
        setLastError(result.ok ? undefined : result.error);
        return;
      }
      // 022 R-342: the viewed tab's capture is answered to the composer that asked; not a projection.
      if (parsed.data.type === "tab-capture-result") {
        const waiting = captures.current.get(parsed.data.requestId);
        if (waiting !== undefined) {
          captures.current.delete(parsed.data.requestId);
          waiting(parsed.data.result);
        }
        return;
      }
      const projected = parsed.data.payload;
      setState(projected);
      const conversation = projected.conversation;
      if (conversation === undefined || !conversation.available) {
        // Events may be missed while the broker is away; ask again once it is back.
        needsResync.current = true;
        return;
      }
      if (conversation.epoch !== undefined) {
        if (epoch.current !== undefined && epoch.current !== conversation.epoch) {
          // 019 T572: a replacement broker restarts every conversation's seqs at 0, so what this
          // document kept would swallow its events as repeats (and an old "running" would hold the
          // composer). Drop all of it and page the conversation on screen again from 0.
          lastSeqs.current.clear();
          setLogs({});
          needsResync.current = true;
        }
        epoch.current = conversation.epoch;
      }
      if (!needsResync.current) {
        lastShown.current = conversation.active;
        return;
      }
      needsResync.current = false;
      const target = resyncTarget(conversation, lastShown.current, lastSeqs.current);
      lastShown.current = target?.conversationId;
      if (target !== undefined) {
        // 019 T547 (G4): the worker turns this into a page request from that seq; the overview
        // came with the projection just received.
        portRef.current?.postMessage({ type: "ui.conversation.resync", payload: target } satisfies AgentPanelCommand);
      }
    };
    const connect = (): void => {
      if (disposed) {
        return;
      }
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: AGENT_PANEL_PORT_NAME });
      } catch {
        // An extension page orphaned by a reload throws "Extension context invalidated": there is
        // no worker this page can ever reach again, so say so rather than retry.
        reportTestDiagnostic("agent.panel.connect-unavailable");
        setState((current) => ({ ...current, bridge: "disconnected" }));
        return;
      }
      portRef.current = port;
      // 019 T547: a new connection may follow a worker restart; the first available state asks again.
      needsResync.current = true;
      port.onMessage.addListener(onMessage);
      /**
       * Which window this panel is in, on every connection (fix 2026-09-23, panel in another
       * window). The worker counts a panel as in front of the owner only when it is in the window
       * they last focused - a panel open in another window left the badge off and a pairing card
       * on the 45 s bound while the owner saw nothing - and the port itself does not say where the
       * panel is. Every connection rather than the first: a worker that restarted remembers nothing.
       *
       * Until this arrives the worker counts the panel as not seen, which only means the badge may
       * be on for the moment `getCurrent` takes. A failure leaves it that way and is said.
       */
      void Promise.resolve()
        .then(() => chrome.windows?.getCurrent?.())
        .then((window) => {
          if (portRef.current !== port || typeof window?.id !== "number") return;
          port.postMessage(panelWindowMessage(window.id));
        })
        .catch(() => reportTestDiagnostic("agent.panel.window-unknown"));
      port.onDisconnect.addListener(() => {
        // An MV3 service worker idles out, and an extension reload or a worker restart does the
        // same: each takes the port with it. Without this the panel keeps a dead handle - every
        // button silently stops working with nothing on screen to say so, and the new worker has
        // no panel to publish its consent prompts to. Observed three times on 2026-09-16.
        if (portRef.current === port) {
          portRef.current = undefined;
        }
        // Chrome's own sentence about the drop, read so it is on the record (and so Chrome does
        // not log it as unchecked) - the one fact that tells a worker idling out from a worker
        // that cannot start.
        const reason = chrome.runtime.lastError?.message;
        reportTestDiagnostic(`agent.panel.disconnected${reason ? `: ${reason}` : ""}`);
        // 022: nothing that was waiting on this connection will be answered on the next one.
        failWaiting();
        if (disposed) {
          return;
        }
        // The last projection stays on screen while a retry is pending: the worker re-publishes
        // the whole projection the moment the new port is accepted, so the picture is a
        // fraction of a second stale, not wrong.
        attempt += 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setState((current) => ({ ...current, bridge: "disconnected" }));
          return;
        }
        retryTimer = setTimeout(connect, Math.min(250 * 2 ** (attempt - 1), 5000));
      });
    };

    connect();
    reconnectRef.current = () => {
      // The owner pressed something with no port to carry it: whether the backoff gave up or is
      // mid-wait, their press is the better signal - start over now, from the first delay.
      if (disposed || portRef.current) {
        return;
      }
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0;
      connect();
    };

    return () => {
      disposed = true;
      reconnectRef.current = undefined;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      const port = portRef.current;
      // 022: the panel closing gives up every transfer under way - its staged pieces are cancelled,
      // best effort (the broker also drops them after 120 s without a piece, R-340).
      if (port) {
        for (const [attachmentId, conversationId] of begun.current) {
          try {
            port.postMessage({
              type: "ui.conversation.attach-cancel",
              commandId: mintCommandId(),
              payload: { conversationId, attachmentId },
            } satisfies AgentPanelCommand);
          } catch {
            reportTestDiagnostic("agent.panel.send-failed");
          }
        }
      }
      begun.current.clear();
      failWaiting();
      portRef.current = undefined;
      if (port) {
        port.onMessage.removeListener(onMessage);
        port.disconnect();
      }
    };
  }, []);

  const send: SendCommand = (pressed) => {
    // 019 T547 (G1): a conversation command leaves with the id its result will come back under.
    let command = pressed;
    if (command.type.startsWith("ui.conversation.") && command.type !== "ui.conversation.resync" && !("commandId" in command)) {
      const commandId = mintCommandId();
      command = { ...command, commandId } as AgentPanelCommand;
      ownCommands.current.push(commandId);
      if (ownCommands.current.length > OWN_COMMANDS_KEPT) ownCommands.current.shift();
    }
    post(command);
  };

  /** 022: every request and capture still waiting is answered as failed (the connection is gone). */
  function failWaiting(): void {
    const waitingRequests = [...requests.current];
    requests.current.clear();
    for (const [commandId, resolve] of waitingRequests) {
      resolve({ commandId, ok: false, error: { code: "broker-unavailable", detail: CONNECTION_LOST } });
    }
    const waitingCaptures = [...captures.current.values()];
    captures.current.clear();
    for (const resolve of waitingCaptures) resolve({ ok: false, code: "failed", message: CONNECTION_LOST });
  }

  /** 022: which staged attachments a command begins or ends, for the cancel on close. */
  function track(command: AgentPanelCommand): void {
    if (command.type === "ui.conversation.attach" && command.payload.index === 0) {
      begun.current.set(command.payload.attachmentId, command.payload.conversationId);
    } else if (command.type === "ui.conversation.attach-cancel") {
      begun.current.delete(command.payload.attachmentId);
    } else if (command.type === "ui.conversation.send") {
      for (const attachmentId of command.payload.attachments ?? []) begun.current.delete(attachmentId);
    }
  }

  /** Posts one command on the current port; false when it could not leave. */
  function post(command: AgentPanelCommand): boolean {
    const port = portRef.current;
    if (!port) {
      // This press is lost - the projection it answered may not survive the reconnect anyway -
      // but it is the owner asking, so the next one has a port to leave on. Without this the
      // give-up page's Retry would be a button that can never work.
      reportTestDiagnostic("agent.panel.message-dropped");
      reconnectRef.current?.();
      return false;
    }
    try {
      port.postMessage(command);
      track(command);
      return true;
    } catch {
      // The worker can idle out between the last projection and this click.
      reportTestDiagnostic("agent.panel.send-failed");
      portRef.current = undefined;
      return false;
    }
  }

  const request: RequestCommand = (command) =>
    new Promise<ConversationPanelResult>((resolve) => {
      const commandId = mintCommandId();
      requests.current.set(commandId, resolve);
      if (!post({ ...command, commandId } as AgentPanelCommand)) {
        requests.current.delete(commandId);
        resolve({ commandId, ok: false, error: { code: "broker-unavailable", detail: CONNECTION_LOST } });
      }
    });

  const captureTab: CaptureTab = (tabId, what) =>
    new Promise<TabCaptureResult>((resolve) => {
      const requestId = mintCommandId();
      // T633: bounded, and a late answer finds nobody waiting (the resolver goes with the bound).
      const timer = setTimeout(() => {
        if (captures.current.delete(requestId)) resolve({ ok: false, code: "failed", message: CAPTURE_TIMED_OUT });
      }, CAPTURE_TIMEOUT_MS[what]);
      captures.current.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      if (!post({ type: "ui.tab.capture", requestId, payload: { tabId, what } })) {
        clearTimeout(timer);
        captures.current.delete(requestId);
        resolve({ ok: false, code: "failed", message: CONNECTION_LOST });
      }
    });

  return { state, logs, send, request, captureTab, lastError };
}

/** 019 D-019-3, FR-284: the two tabs, and the key the last one is remembered under. */
export type AgentPanelTabName = "conversation" | "connections";
const PANEL_TABS: readonly AgentPanelTabName[] = ["conversation", "connections"];
export const PANEL_TAB_STORAGE_KEY = "agentPanelTab";

const isPanelTab = (value: unknown): value is AgentPanelTabName => PANEL_TABS.includes(value as AgentPanelTabName);

/**
 * The tab on screen, opened on the one used last (FR-284, US7 scenario 3).
 *
 * Every storage access is wrapped: a panel whose storage throws or is missing still opens, on
 * Conversation, and still switches - remembering the tab is a convenience, never a reason the
 * owner cannot reach a control. A choice the owner makes before the read settles wins.
 */
function usePanelTab(): [AgentPanelTabName, (tab: AgentPanelTabName) => void] {
  const [tab, setTab] = useState<AgentPanelTabName>("conversation");
  const chosen = useRef(false);
  useEffect(() => {
    let disposed = false;
    try {
      const read = chrome.storage?.local?.get?.(PANEL_TAB_STORAGE_KEY) as Promise<Record<string, unknown>> | undefined;
      void Promise.resolve(read)
        .then((items) => {
          const stored = items?.[PANEL_TAB_STORAGE_KEY];
          if (!disposed && !chosen.current && isPanelTab(stored)) setTab(stored);
        })
        .catch(() => reportTestDiagnostic("agent.panel.tab-unread"));
    } catch {
      reportTestDiagnostic("agent.panel.tab-unread");
    }
    return () => {
      disposed = true;
    };
  }, []);
  const choose = (next: AgentPanelTabName): void => {
    chosen.current = true;
    setTab(next);
    try {
      const write = chrome.storage?.local?.set?.({ [PANEL_TAB_STORAGE_KEY]: next }) as Promise<void> | undefined;
      void Promise.resolve(write).catch(() => reportTestDiagnostic("agent.panel.tab-unsaved"));
    } catch {
      reportTestDiagnostic("agent.panel.tab-unsaved");
    }
  };
  return [tab, choose];
}

/**
 * 019 FR-284, US7 scenario 2: how many questions wait in the question slot - pairing, consent,
 * plan, site plan, browser choice. The slot shows one at a time above both tabs; the count on the
 * Connections tab is how the owner learns while in a conversation that more are waiting there.
 */
export function connectionsAttentionCount(state: AgentPanelState): number {
  return [state.pending, state.prompt, state.plan, state.sitePlan, state.browserChoice].filter(
    (question) => question !== undefined,
  ).length;
}

/**
 * 019 FR-306, T554: the tab the owner is viewing in this panel's window, so a message can name it
 * and the agent starts there. Read when the panel opens and again whenever the active tab changes;
 * `currentWindow` is the window the side panel belongs to. Without the tabs API, or with no tab to
 * name, a message names none - the worker then places nothing and the agent claims a tab itself.
 * The worker decides what the id is worth: a tab another session holds, or a browser page, is not
 * placed (the claim path refuses it).
 */
function useActiveTab(): { id?: number; url?: string } {
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string }>({});
  useEffect(() => {
    let disposed = false;
    const read = (): void => {
      try {
        const query = chrome.tabs?.query?.({ active: true, currentWindow: true }) as Promise<chrome.tabs.Tab[]> | undefined;
        void Promise.resolve(query)
          .then((tabs) => {
            // 022 FR-334: the address too, so "Attach this tab" can tell a PDF tab.
            const tab = tabs?.[0];
            if (!disposed) {
              setActiveTab({ ...(tab?.id === undefined ? {} : { id: tab.id }), ...(tab?.url === undefined ? {} : { url: tab.url }) });
            }
          })
          .catch(() => reportTestDiagnostic("agent.panel.active-tab-unread"));
      } catch {
        reportTestDiagnostic("agent.panel.active-tab-unread");
      }
    };
    read();
    const activated = chrome.tabs?.onActivated;
    activated?.addListener(read);
    // T633: the viewed tab going to another address (a PDF, a restricted page) is read again too.
    const updated = chrome.tabs?.onUpdated;
    const onUpdated = (_tabId: number, change: { url?: string }, tab: chrome.tabs.Tab): void => {
      if (change.url !== undefined && tab.active) read();
    };
    updated?.addListener(onUpdated);
    return () => {
      disposed = true;
      activated?.removeListener(read);
      updated?.removeListener(onUpdated);
    };
  }, []);
  return activeTab;
}

/** How often the cards' "last action" words are measured again (016 FR-230). */
export const LAST_ACTION_TICK_MS = 60_000;

/**
 * The panel's own minute clock (016 FR-230, R-206).
 *
 * "Idle · last action 12 min ago" goes stale while the worker has nothing new to say, and asking
 * it for a projection once a minute would be traffic for the sake of a word. So the shell ticks
 * once a minute and the cards measure against the tick; nothing leaves the panel.
 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LAST_ACTION_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function AgentShell(props: { locale: string }): ReactElement {
  const { state, logs, send, request, captureTab, lastError } = useAgentPort();
  /**
   * T633 (FR-335): the composer's drafts and transfers live here, above the tab switch, so showing
   * Connections & sites gives up nothing; only this document going away does (with the cancel of
   * every begun attachment in `useAgentPort`).
   */
  const composer = useComposerMemory();
  useEffect(() => {
    const running = composer.transfers;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);
  const now = useMinuteClock();
  const t = (key: string): string => lookup(key, props.locale);
  const [tab, chooseTab] = usePanelTab();
  const activeTab = useActiveTab();
  const activeTabId = activeTab.id;
  const tabRefs = useRef<Partial<Record<AgentPanelTabName, HTMLButtonElement | null>>>({});
  const composition = deriveComposition(state);

  /**
   * The name the owner knows an agent by (FR-035's stated name), never the session id. The fallback
   * to the id covers the moment mid-unpair when a session is projected for an agent no longer listed.
   */
  const agentName = (agentId: string): string =>
    state.paired.find((agent) => agent.agentId === agentId)?.displayName ?? agentId;

  // Newest activity first (US3 scenario 1); a session without a timestamp sorts last.
  const sessions = [...state.sessions].sort((a, b) =>
    (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""),
  );

  /**
   * Whose question the consent card is about: the session the worker marked `waiting` (R-127), or
   * the paired agent when the projection names none - which is the one-agent case, where the two
   * are the same agent.
   */
  const waiting = state.sessions.find((session) => session.state === "waiting");
  const promptAgent = waiting ? agentName(waiting.agentId) : (state.agentName ?? "");
  /** The newest non-blocking notice any session is carrying (008 FR-114); at most one is shown. */
  const notice = state.sessions
    .map((session) => session.notice)
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort((left, right) => right.at - left.at)[0];

  /**
   * 018 FR-268, FR-279: "This browser" with its rename, whenever the link is up and the worker
   * named the browser - before any agent pairs too, so the owner can name it first.
   */
  const browserRow =
    state.browser !== undefined && state.bridge === "connected" ? (
      <BrowserRow
        browser={state.browser}
        locale={props.locale}
        onRename={(name) => {
          send({ type: "ui.agent.browser-rename", payload: { name } });
        }}
      />
    ) : null;

  /**
   * 019 FR-282: Connections & sites is everything the panel showed before this feature, unchanged
   * (the 006 compositions, the 016 status row, the 018 browser row).
   */
  /**
   * 019 FR-309, T555: the panel consent, beside the browser it is about. Present whenever the
   * projection offers conversations - also before any external agent has paired, since the side
   * panel's own agent needs no pairing.
   */
  const consentSwitch =
    state.conversation === undefined ? null : (
      <PanelConsentSwitch consent={state.conversation.consent} locale={props.locale} send={send} />
    );
  /** T607 (Q1): the conversation part says the helper cannot be reached (the Conversation tab's own page for it). */
  const helperDown = state.conversation?.available === false && state.conversation.reason === "broker-unavailable";
  const connections =
    composition === "not-connected" ? (
      <>
        <NotConnected
          variant={state.paired.length > 0 ? "bridge-lost" : helperDown ? "helper-down" : "not-paired"}
          diagnostics={state.diagnostics ?? {}}
          locale={props.locale}
          onRetry={() => {
            send({ type: "ui.agent.retry-bridge", payload: {} });
          }}
        />
        {browserRow}
        {consentSwitch}
      </>
    ) : (
      <>
        <StatusRow
          sessionCount={state.sessions.length}
          paired={state.paired}
          locale={props.locale}
          uploadListPath={state.uploadRoots?.path}
          onUnpair={(agentId) => {
            // 016 FR-223: the agent the owner chose, and no other - the menu names each one.
            send({ type: "ui.agent.unpair", payload: { agentId } });
          }}
        />
        {browserRow}
        {consentSwitch}
        {/* T605: the session cards under a small heading of their own, as the sites have one. */}
        {sessions.length === 0 ? null : (
          <h2 className="agent-section-heading" data-sessions-heading="">
            {t("agent.sessionsTitle")}
          </h2>
        )}
        {sessions.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            agentName={agentName(session.agentId)}
            locale={props.locale}
            now={now}
            onStop={() => {
              send({ type: "ui.agent.session-stop", payload: { sessionId: session.sessionId } });
            }}
            onRelease={() => {
              send({ type: "ui.agent.session-release", payload: { sessionId: session.sessionId } });
            }}
            onInterrupt={() => {
              send({ type: "ui.agent.session-interrupt", payload: { sessionId: session.sessionId } });
            }}
            onWithdrawSitePlan={() => {
              send({ type: "ui.agent.site-plan-withdraw", payload: { sessionId: session.sessionId } });
            }}
          />
        ))}
        <SiteList
          sites={state.sites}
          transitions={state.transitions}
          uploadRoots={state.uploadRoots}
          locale={props.locale}
          send={send}
        />
      </>
    );

  /** 019 FR-284: the count shows on the Connections tab only while the other tab is shown. */
  const attention = connectionsAttentionCount(state);
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The ARIA tabs pattern: arrows move and wrap, Home/End jump; selection follows focus.
    const index = PANEL_TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? PANEL_TABS[(index + 1) % PANEL_TABS.length]
        : event.key === "ArrowLeft"
          ? PANEL_TABS[(index - 1 + PANEL_TABS.length) % PANEL_TABS.length]
          : event.key === "Home"
            ? PANEL_TABS[0]
            : event.key === "End"
              ? PANEL_TABS[PANEL_TABS.length - 1]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    chooseTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="agent-shell" data-agent-state={composition}>
      {/* 016 FR-224: no in-panel heading - the browser's side-panel header already names the product. */}
      {/* 019 FR-283: the question slot sits above the tab bar, so it is on screen on both tabs. */}
      <PromptCard state={state} locale={props.locale} promptAgent={promptAgent} send={send} />
      {/*
        008 FR-114: under the question area, never in it. A notice is not an answerable question,
        so it sits below whatever is being asked and takes no focus from it; the newest session's
        is the one on screen, because the notice is about what just happened.
      */}
      {notice === undefined ? null : <NoticeCard notice={notice} locale={props.locale} />}
      {state.conversation === undefined ? (
        // A projection with no conversation part (a worker without 019): today's panel, no tabs.
        connections
      ) : (
        <>
          <div role="tablist" aria-label={t("agent.tabs.label")} className="agent-tabs" onKeyDown={onTabKeyDown}>
            {PANEL_TABS.map((name) => {
              const selected = tab === name;
              const count = name === "connections" && !selected ? attention : 0;
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  id={`agent-tab-${name}`}
                  aria-selected={selected}
                  aria-controls={`agent-tabpanel-${name}`}
                  tabIndex={selected ? 0 : -1}
                  className="agent-tab"
                  ref={(element) => {
                    tabRefs.current[name] = element;
                  }}
                  onClick={() => chooseTab(name)}
                >
                  {t(name === "conversation" ? "agent.tabs.conversation" : "agent.tabs.connections")}
                  {count > 0 ? (
                    <>
                      <span className="agent-tab-count" data-tab-count aria-hidden="true">
                        {count}
                      </span>
                      <span className="agent-sr-only">{t("agent.tabs.waiting").replace("{count}", String(count))}</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={`agent-tabpanel-${tab}`} aria-labelledby={`agent-tab-${tab}`} className="agent-tabpanel">
            {tab === "conversation" ? (
              <ConversationTab
                conversation={state.conversation}
                logs={logs}
                locale={props.locale}
                send={send}
                request={request}
                captureTab={captureTab}
                composer={composer}
                {...(activeTabId === undefined ? {} : { activeTabId })}
                {...(activeTab.url === undefined ? {} : { activeTabUrl: activeTab.url })}
                {...(lastError === undefined ? {} : { lastError })}
                onGoConnections={() => chooseTab("connections")}
              />
            ) : (
              connections
            )}
          </div>
        </>
      )}
    </div>
  );
}
