import {
  AGENT_ACTIVITY_KEPT,
  AGENT_EFFECT_TOOL_NAMES,
  type AgentActivityItem,
  type AgentBridgeDiagnostics,
  type AgentNotice,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentPanelState,
  type AgentPanelTab,
  type AgentToolName,
  type SiteMode,
} from "@hallpass/contracts";
import { setAttention } from "../chrome-adapters/action-badge.js";
import { downloadFile, watchDownloadChanged, watchDownloadCreated } from "../chrome-adapters/downloads.js";
import { createOffscreenAdapter } from "../chrome-adapters/offscreen.js";
import { getTabSnapshot, queryTabSnapshots } from "../chrome-adapters/tabs.js";
import { getWindowFacts, setWindowState } from "../chrome-adapters/windows.js";
import { reportTestDiagnostic } from "../diagnostics.js";
import {
  connectAgentNativeHost,
  createAgentBridge,
  type AgentBridge,
  type AgentBridgeStatus,
  type AgentPortLike,
} from "./agent-bridge.js";
import { createAgentTabManager, type AgentTab, type AgentTabManager } from "./agent-tab-manager.js";
import { createDownloadObserver } from "./download-observer.js";
import {
  createPairingController,
  readPairingState,
  watchPairingState,
  writePairingState,
  type PairingController,
  type PairingState,
  type PairingWaitingTick,
} from "./pairing-controller.js";
import { createSiteModeStore, siteOfUrl, type SiteModeStore } from "./site-mode-store.js";
import { createAgentBatch } from "./agent-tools/batch.js";
import {
  createAgentSessionContext,
  type AgentSessionContext,
  type AgentSessionContexts,
} from "./agent-tools/context.js";
import { createAgentDiagnostics } from "./agent-tools/diagnostics.js";
import { createAgentDialogs } from "./agent-tools/dialogs.js";
import { createAgentDownloadTools } from "./agent-tools/downloads.js";
import { createInputAttachments } from "./agent-tools/input.js";
import {
  createAgentIndicator,
  isAgentAnnounceMessage,
  type IndicatorMessage,
} from "./agent-tools/indicator.js";
import { createAgentEffects } from "./agent-tools/effects.js";
import { createAgentPageBindings } from "./agent-tools/page-binding.js";
import { createStatedPlans } from "./agent-tools/plans.js";
import {
  createAgentPromptController,
  type AgentPromptController,
  type PromptEnding,
  type PromptWaitingTick,
} from "./agent-tools/prompts.js";
import { createAgentReads } from "./agent-tools/reads.js";
import { createAgentRecordingTools } from "./agent-tools/recording.js";
import { createActionContext } from "./recording/action-context.js";
import { describeAction } from "./recording/action-label.js";
import { captureFrame } from "./recording/frame-capture.js";
import { createRecorder, sessionRecordingStore, type AgentRecorder } from "./recording/recorder.js";
import { createWindowRestorer, sessionWindowRestoreStore } from "./window-restore.js";
import { createViewportEmulation, sessionViewportStore } from "./viewport-emulation.js";
import { sessionBrowserRun } from "./browser-run.js";
import { createAgentStopSignals, type AgentToolRequest } from "./agent-tools/stop.js";
import { createAgentTabTools } from "./agent-tools/tabs.js";
import { createAgentUpload } from "./agent-tools/upload.js";
import { createAgentWait } from "./agent-tools/wait.js";

/**
 * The agent path's composition root (003/T013, T018).
 *
 * It exists so `index.ts` can start the bridge without knowing what the bridge is made of, and so
 * the agent path is reachable from exactly one place: the `agent` build. The remote path of 001/002
 * is untouched by anything here.
 *
 * The order of authority is the point of this file: the transport decides nothing, the pairing
 * controller decides who may call, and the tab manager decides which tabs a call may name. A tool
 * request passes all three before it is answered.
 */

/**
 * The alarm that retries a connection the worker could not make (FR-033).
 *
 * An MV3 worker is torn down between events, so a `setTimeout` retry dies with it and the bridge
 * would stay down until something else happened to wake the worker. An alarm both survives the
 * teardown and wakes the worker to run the retry, which is the whole reason the `alarms` permission
 * is in the agent profile.
 *
 * It is the *backstop* and nothing more (004/T096a, evidence G2). An alarm cannot fire inside
 * FR-057's ten seconds - a minute is Chrome's floor - so the awake worker's fast re-open in
 * `agent-bridge.ts` is what restores a link, and this is what covers the stretch in which there is
 * no worker to run that timer.
 */
export const AGENT_RETRY_ALARM = "hallpass-bridge-retry";

/** The retry's cadence; the bridge's own fast re-open in an awake worker is what meets FR-057. */
export const AGENT_RETRY_PERIOD_MINUTES = 1;

/**
 * The alarm that keeps the worker alive while the link is up (004/T169).
 *
 * A worker holding an open native port but exchanging nothing on it is idle as far as MV3 is
 * concerned, and thirty quiet seconds evict it - which is exactly the shape of an owner reading a
 * pairing prompt, or of a call held for their answer. Chrome then closes the native port, the host
 * exits with it, the pending prompt is dropped (`onStatusChange` below, by design), and the agent's
 * server re-dials a fresh relay and asks all over again. Measured in the attach-mode family: the
 * relay pid changing in the middle of a twenty-second wait, in the server's own log.
 *
 * A repeating alarm is the one event a worker can give itself: each firing resets the idle clock.
 * Both reference extensions keep their worker alive this way, at Chrome's half-minute floor (the
 * minimum since Chrome 120); so does this one, for as long as the link is up. When it is not, the
 * retry alarm above takes over, so the two never run together.
 */
export const AGENT_HEARTBEAT_ALARM = "hallpass-bridge-heartbeat";

/** Chrome's floor for a repeating alarm, and the cadence both references use. */
export const AGENT_HEARTBEAT_PERIOD_MINUTES = 0.5;

/**
 * The alarm that closes the 15 s reconciliation window after a relay started (004 US2).
 *
 * An alarm rather than a `setTimeout` for the same reason the retry is one: the window is fifteen
 * seconds of an agent doing nothing, which is exactly when MV3 evicts the worker, and a timer would
 * go with it - leaving every session of the *previous* relay marked on the owner's tab strip for
 * ever. The alarm wakes a fresh worker instead, and the fresh worker reads `chrome.storage.session`
 * rather than its own memory, so it can finish a window it did not start.
 */
export const AGENT_RECONCILE_ALARM = "hallpass-reconcile";

/** R-111's bound. Chrome may fire an alarm late, which delays the release and never skips it. */
export const AGENT_RECONCILE_SECONDS = 15;

/**
 * What a *trusted* click on the in-page indicator's control produces (004/T108, FR-062, R-117).
 *
 * The page half is in `content-runtime/indicator.ts`; this is the only shape the worker answers.
 * `tabId` is never how the worker learns which tab sent it - Chrome's own `sender.tab` says that -
 * and a body that names a different tab is refused rather than corrected (see `focusMainTab`).
 */
type FocusMainMessage = { type: "ui.agent.focus-main"; tabId?: number };

function isFocusMainMessage(message: unknown): message is FocusMainMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<FocusMainMessage>;
  if (candidate.type !== "ui.agent.focus-main") return false;
  return candidate.tabId === undefined || typeof candidate.tabId === "number";
}

/** What the worker is told about the sender of a content-script message; Chrome fills it in. */
type ContentMessageSender = { id?: string | undefined; tab?: { id?: number | undefined } | undefined };

/**
 * Where the last few native-port drops are kept, with Chrome's reason for each (004/T169).
 *
 * `chrome.storage.session`, for the two readers that need it: the attach-mode gate, which reads
 * the worker's storage over its socket when a journey fails, and a fresh worker after an eviction,
 * which still finds what its predecessor saw. The agent build prints no diagnostics, so without
 * this a port that closes while its host is alive - measured, 1 in 3 family runs - has no witness.
 */
export const AGENT_BRIDGE_DISCONNECTS_KEY = "agentBridgeDisconnects";

/** How many drops are kept; a link that flaps for an hour must not fill the session area. */
export const AGENT_BRIDGE_DISCONNECTS_KEPT = 5;

/**
 * One drop as the ring keeps it. `worker` names the worker *instance* that saw it and `relay` the
 * host pid that instance had last been greeted by: two instances alive at once - each opening its
 * own host, each host superseding the other's - is the shape the family's reds have (T169), and only
 * an instance id in the record can tell it from one instance dropping and re-opening.
 */
export type AgentBridgeDisconnect = { at: string; reason?: string; worker?: string; relay?: number };

/** This worker instance's name for the ring above; a fresh worker gets a fresh one. */
const WORKER_INSTANCE_ID = `w-${Math.random().toString(36).slice(2, 8)}`;

/** The pid of the relay that last greeted this instance, for the ring. */
let lastRelayPid: number | undefined;

/** Where that relay said its record is (006 FR-082), when it said; kept exactly as `lastRelayPid` is. */
let lastRecordPath: string | undefined;

/**
 * The greetings ring (T169): `{ at, worker, relay, record? }` for the last few `relay-started`
 * frames - `record` being the path the relay named, present only when the greeting carried one.
 */
export const AGENT_BRIDGE_GREETINGS_KEY = "agentBridgeGreetings";

/** One writer at a time: two drops in quick succession must not read the same ring and lose one. */
let bridgeDisconnectWrites: Promise<void> = Promise.resolve();

/**
 * Queues one ring write behind the previous. The stored chain is the *settled* one (review B121
 * #2): a write that rejects still rejects for its own caller, but the next write starts from a
 * resolved link rather than inheriting the rejection and never running.
 */
function queueRingWrite(work: () => Promise<void>): Promise<void> {
  const next = bridgeDisconnectWrites.then(work);
  bridgeDisconnectWrites = next.catch(() => undefined);
  return next;
}

function recordBridgeGreeting(relayPid: number, recordPath: string | undefined): Promise<void> {
  const at = new Date().toISOString();
  return queueRingWrite(async () => {
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    if (!area) return;
    const raw = (await area.get([AGENT_BRIDGE_GREETINGS_KEY])) as Record<string, unknown>;
    const kept = Array.isArray(raw[AGENT_BRIDGE_GREETINGS_KEY]) ? (raw[AGENT_BRIDGE_GREETINGS_KEY] as unknown[]) : [];
    const entry = { at, worker: WORKER_INSTANCE_ID, relay: relayPid, ...(recordPath === undefined ? {} : { record: recordPath }) };
    await area.set({ [AGENT_BRIDGE_GREETINGS_KEY]: [...kept, entry].slice(-AGENT_BRIDGE_DISCONNECTS_KEPT) });
  });
}

function recordBridgeDisconnect(reason: string | undefined): Promise<void> {
  const at = new Date().toISOString();
  return queueRingWrite(async () => {
    const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
    if (!area) return;
    const raw = (await area.get([AGENT_BRIDGE_DISCONNECTS_KEY])) as Record<string, unknown>;
    const kept = Array.isArray(raw[AGENT_BRIDGE_DISCONNECTS_KEY])
      ? (raw[AGENT_BRIDGE_DISCONNECTS_KEY] as AgentBridgeDisconnect[])
      : [];
    const entry: AgentBridgeDisconnect = {
      at,
      ...(reason === undefined ? {} : { reason }),
      worker: WORKER_INSTANCE_ID,
      ...(lastRelayPid === undefined ? {} : { relay: lastRelayPid }),
    };
    await area.set({ [AGENT_BRIDGE_DISCONNECTS_KEY]: [...kept, entry].slice(-AGENT_BRIDGE_DISCONNECTS_KEPT) });
  });
}

/**
 * The bridge facts the not-connected page folds away (006 FR-082), read from the rings above rather
 * than from this instance's memory alone: a fresh worker after an eviction has no `lastRelayPid`,
 * but the greeting its predecessor recorded is still in the session area. The record path comes
 * the same way: the relay writes it in the host data directory the worker cannot see, and names it
 * in its greeting, so it is absent only while no greeting has carried one.
 */
async function readBridgeDiagnostics(): Promise<AgentBridgeDiagnostics> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  const raw = area ? ((await area.get([AGENT_BRIDGE_GREETINGS_KEY, AGENT_BRIDGE_DISCONNECTS_KEY])) as Record<string, unknown>) : {};
  const greetings = Array.isArray(raw[AGENT_BRIDGE_GREETINGS_KEY])
    ? (raw[AGENT_BRIDGE_GREETINGS_KEY] as Array<{ relay?: number; record?: string }>)
    : [];
  const drops = Array.isArray(raw[AGENT_BRIDGE_DISCONNECTS_KEY]) ? (raw[AGENT_BRIDGE_DISCONNECTS_KEY] as AgentBridgeDisconnect[]) : [];
  const relayPid = lastRelayPid ?? greetings.at(-1)?.relay;
  const recordPath = lastRecordPath ?? greetings.at(-1)?.record;
  const last = drops.at(-1);
  return {
    ...(relayPid === undefined ? {} : { relayPid }),
    ...(recordPath === undefined ? {} : { recordPath }),
    ...(last === undefined ? {} : { lastDisconnect: { at: last.at, ...(last.reason === undefined ? {} : { reason: last.reason }) } }),
  };
}

/**
 * The host of a held tab's url, for the session card; `undefined` for a url with none (a blank tab)
 * or one that is not a web page at all - `chrome://extensions` parses to a hostname, and it is not
 * a site the agent is on.
 */
function hostOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.hostname === "" ? undefined : parsed.hostname;
  } catch {
    return undefined;
  }
}

export type AgentRuntimeOptions = {
  /** Injected by tests; the real one opens the native port. */
  connectNative?: () => AgentPortLike | undefined;
  /** Injected by tests; the real one records to the offscreen document (008/T219). */
  recorder?: AgentRecorder;
  /** Injected by tests; the real one reads `chrome.runtime.lastError` inside the listener (T169). */
  disconnectReason?: () => string | undefined;
  onStatusChange?: (status: AgentBridgeStatus) => void;
  onPairingChange?: (state: PairingState) => void;
  /**
   * Injected by tests; the real one marks the toolbar icon (011 FR-152). Only the derivation below
   * decides when it is called, and it is called only when the answer changes.
   */
  setAttention?: (on: boolean) => void;
};

/**
 * Whether the toolbar icon should be marked (011 data-model "Attention state", FR-152).
 *
 * Derived, never stored: the badge is a picture of two facts the worker already holds, and a
 * remembered badge is how a worker that was evicted mid-question comes back with a mark on an icon
 * nothing is waiting behind. Both kinds of question count - a pairing card and a consent card are
 * the same situation to the person - and a panel that is open needs no badge, because the card is
 * already in front of them.
 */
export function deriveAttention(input: {
  pairingPending: boolean;
  promptPending: boolean;
  panelConnected: boolean;
}): boolean {
  return (input.pairingPending || input.promptPending) && !input.panelConnected;
}

/** What the runtime needs of the panel port: is anybody looking, and tell me when that changes. */
export type AgentPanelPresence = {
  isConnected: () => boolean;
  onPresenceChange: (listener: (connected: boolean) => void) => void;
};

export type AgentRuntime = {
  bridge: AgentBridge;
  pairing: PairingController;
  tabs: AgentTabManager;
  /** The owner's per-site decisions; the panel reads and writes them through this runtime. */
  siteModes: SiteModeStore;
  /** The live `ask` prompt, which the panel shows and answers (FR-042). */
  prompts: AgentPromptController;
  status: () => AgentBridgeStatus;
  /** Everything the side panel is told, assembled in one place so the panel reads one picture. */
  projection: () => Promise<AgentPanelState>;
  /** Opens the port and arms the retry alarm listener. */
  start: () => void;
  /** The panel's Connect: try again now rather than at the next alarm. */
  connect: () => void;
  /** The panel's Unpair: forget the agent and tell any open session at once (FR-032). */
  unpair: (agentId: string) => Promise<void>;
  /** The panel's per-site list: set one site's mode. Never the diagnostics grant, which has its own. */
  setSiteMode: (site: string, mode: SiteMode) => Promise<void>;
  /** The site list's revoke (006 FR-086): forget the site's record, so the default applies again. */
  clearSiteMode: (site: string) => Promise<void>;
  /**
   * The session card's Stop (006 FR-087): the session ends the way a relay-named stop ends it, and
   * its in-flight `wait` or batch answers `owner-stopped` through the stops registry it is watching.
   */
  stopSessionFromOwner: (sessionId: string) => Promise<void>;
  /**
   * The session card's Release tabs (006 FR-087): every tab the session holds goes back to the owner
   * the way `tabs_release` hands one back, and the session stays live and paired.
   */
  releaseSessionTabs: (sessionId: string) => Promise<void>;
  /**
   * The panel's diagnostics control (US6, FR-049).
   *
   * Revoking is more than a stored `false`: every tab attached under that grant is detached, so
   * Chrome stops telling the owner this extension is debugging their browser the moment they say
   * so, rather than at the next call that happens to notice.
   */
  setDiagnostics: (site: string, granted: boolean) => Promise<void>;
  /** Fires whenever anything in `projection()` may have changed, so the panel can re-read it. */
  subscribe: (listener: () => void) => void;
  /**
   * Hands the runtime the panel port's presence (011 R-163).
   *
   * It arrives afterwards rather than as an option because the panel port is built *from* the
   * runtime: the composition root makes both and introduces them. Until it is called the worker
   * assumes no panel, which is the truth for a worker Chrome has just woken.
   */
  bindPanelPresence: (presence: AgentPanelPresence) => void;
};

function scheduleRetryAlarm(): void {
  chrome.alarms?.create(AGENT_RETRY_ALARM, { periodInMinutes: AGENT_RETRY_PERIOD_MINUTES });
}

function clearRetryAlarm(): void {
  void chrome.alarms?.clear(AGENT_RETRY_ALARM);
}

function scheduleHeartbeatAlarm(): void {
  chrome.alarms?.create(AGENT_HEARTBEAT_ALARM, { periodInMinutes: AGENT_HEARTBEAT_PERIOD_MINUTES });
}

function clearHeartbeatAlarm(): void {
  void chrome.alarms?.clear(AGENT_HEARTBEAT_ALARM);
}

function scheduleReconcileAlarm(): void {
  chrome.alarms?.create(AGENT_RECONCILE_ALARM, { delayInMinutes: AGENT_RECONCILE_SECONDS / 60 });
}

/**
 * The extension owns every alarm in its profile; one with a name we no longer register is left
 * over from an earlier version (0.2.0 used other names). Cleared once on start.
 */
async function clearLegacyAlarms(): Promise<void> {
  const known = new Set([AGENT_RETRY_ALARM, AGENT_HEARTBEAT_ALARM, AGENT_RECONCILE_ALARM]);
  const all = (await chrome.alarms?.getAll?.()) ?? [];
  for (const alarm of all) {
    if (!known.has(alarm.name)) await chrome.alarms?.clear(alarm.name);
  }
}

export function composeAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  void clearLegacyAlarms();
  const listeners: Array<() => void> = [];
  function notify(): void {
    for (const listener of listeners) listener();
  }

  /**
   * When each agent's pairing request reached this worker (006 FR-085), keyed by agent because the
   * prompt is (one prompt per agent, every session of it joins). The panel orders the questions it
   * holds by this and by the prompt controller's own stamp. Kept here rather than in the pairing
   * state because it is a fact about the projection, not about the owner's durable decision.
   */
  const pairingRequestedAt = new Map<string, string>();

  /**
   * The three inputs of the attention derivation (011 data-model), each read where it is known.
   *
   * `panelPresence` is undefined until the composition root introduces the panel port, which in
   * production is before `start()` (`agent-entry.ts`) - so the default governs test compositions
   * alone, and there it says "somebody is looking": a suite that says nothing about panels means
   * the bounds it was written under, which are the open-panel ones (011 review). It is the same
   * assumption `prompts.ts` and `pairing-controller.ts` make when they are handed no presence at
   * all. The pairing half is mirrored here rather than awaited from `pairing.state()` because the
   * derivation runs inside a panel connect and a prompt raise, where an await would leave the badge
   * trailing the thing it describes.
   */
  let panelPresence: AgentPanelPresence | undefined;
  let pairingPending = false;
  /** What the icon was last told. `undefined` until the first derivation, which always speaks. */
  let attention: boolean | undefined;
  const markAttention = options.setAttention ?? setAttention;
  const panelConnected = (): boolean => panelPresence?.isConnected() ?? true;

  function refreshAttention(): void {
    const next = deriveAttention({
      pairingPending,
      promptPending: prompts.currentSession() !== undefined,
      panelConnected: panelConnected(),
    });
    // Only on a change: the derivation runs on every prompt, every pairing event and every panel
    // connect, and four `chrome.action` calls for a picture that did not move are noise in the
    // browser the owner is working in.
    if (attention === next) return;
    attention = next;
    markAttention(next);
  }

  /** One "still waiting", addressed and put on the wire (011 FR-148). */
  function sendWaiting(tick: PromptWaitingTick | PairingWaitingTick): void {
    bridge.sendWaiting({
      type: "prompt-waiting",
      sessionId: tick.sessionId,
      ...("callId" in tick ? { callId: tick.callId } : {}),
      kind: tick.kind,
      panelConnected: tick.panelConnected,
      waitedMs: tick.waitedMs,
      boundMs: tick.boundMs,
    });
  }

  const pairing = createPairingController({
    read: readPairingState,
    write: writePairingState,
    watch: watchPairingState,
    now: () => new Date().toISOString(),
    panelPresence: panelConnected,
    onWaiting: sendWaiting,
    onChange(state) {
      // Whatever is not the prompt on screen is over: answered, ignored, abandoned or unpaired.
      for (const agentId of [...pairingRequestedAt.keys()]) {
        if (agentId !== state.pending?.agentId) pairingRequestedAt.delete(agentId);
      }
      pairingPending = state.pending !== undefined;
      refreshAttention();
      options.onPairingChange?.(state);
      notify();
    },
  });
  /**
   * The in-page indicator, sent (004/T107b, FR-062).
   *
   * Addressed to the top frame of the tab: the declared content script runs in every frame, and an
   * indicator per iframe would be several badges on one page. The answer is never read - a content
   * script that does not answer resolves `sendMessage` with `undefined` (004/T107a) and a tab with
   * no runtime rejects it - because nothing here depends on the page having heard: the page asks
   * again on its next load, which is the whole shape of the announcement.
   */
  const indicator = createAgentIndicator({
    send: (tabId, message: IndicatorMessage) => {
      void chrome.tabs?.sendMessage?.(tabId, message, { frameId: 0 })?.catch?.(() => undefined);
    },
    holderOf: async (tabId) => (await tabs.leases()).find((lease) => lease.tabId === tabId)?.sessionId,
    // The owner's browser decides the language; the worker has no other opinion about it.
    locale: () => chrome.i18n?.getUILanguage?.() ?? "en-US",
  });
  const tabs = createAgentTabManager({
    onTabJoined: (_sessionId, tabId) => indicator.raise(tabId),
    onTabLeft: (sessionId, tabId) => {
      indicator.lower(tabId);
      // The window that tab was in may now hold none of this session's (008/FR-119). Not awaited:
      // the manager is inside its own queue here, and the restorer asks it questions of its own.
      void windowRestorer.onTabLeft(sessionId).catch(() => reportTestDiagnostic("agent.window.restore-failed"));
    },
    // The session's download records go with its tabs (005/FR-080): the ring is kept per session
    // and there is no session left for it to be about.
    onSessionEnded: (sessionId) =>
      void downloads.discard(sessionId).catch(() => reportTestDiagnostic("agent.downloads.discard-failed")),
  });
  /**
   * The browser's downloads, attributed by who holds a tab when each begins (005/R-123). Composed
   * beside the tab manager because that is the only question it asks - and it asks it of the
   * leases, at the moment of creation, never later.
   */
  const downloads = createDownloadObserver({
    onCreated: watchDownloadCreated,
    onChanged: watchDownloadChanged,
    holders: () => tabs.sessionsHoldingAnyTab(),
    reportDiagnostic: reportTestDiagnostic,
  });
  const siteModes = createSiteModeStore();
  const prompts = createAgentPromptController({
    onChange() {
      // A question raised or ended is half of what the icon shows (011 FR-152); the other half is
      // whether anybody has a panel open to see it.
      refreshAttention();
      notify();
    },
    reportDiagnostic: reportTestDiagnostic,
    panelPresence: panelConnected,
    onWaiting: sendWaiting,
  });
  const bindings = createAgentPageBindings();
  /**
   * The two pieces of state a call can outlive a round trip with (US5): the batch the owner
   * approved for a site, and the calls that are watching for the owner's Stop.
   */
  const plans = createStatedPlans();
  const stops = createAgentStopSignals();

  /**
   * One live agent session as this worker knows it (data-model AgentSession).
   *
   * `context` is per session on purpose: the channel nonce and the runtime epoch are the binding
   * between this worker and the pages one session is driving, so a second session that reused them
   * would be able to speak into the first's conversation, and a rebuild would invalidate every ref
   * the first session holds for an event it never saw.
   */
  type LiveSession = { agentId: string; agentName: string; lastHelloAt: string; lastActivityAt: string };
  const sessions = new Map<string, LiveSession>();

  /**
   * One fabricated binding per session (D-M3-2), kept by session id rather than in a variable the
   * last caller re-points (004/T103a).
   *
   * A runner reaches a binding only through the id its own call carries, so a call that resumes
   * after an await cannot pick up whichever session spoke while it was gone. The entry is minted on
   * the session's greeting and dropped when the session ends, which is what keeps a new session
   * from inheriting a previous one's channel nonce.
   */
  const contexts = new Map<string, AgentSessionContext>();
  function contextFor(session: string): AgentSessionContext {
    const known = contexts.get(session);
    if (known) return known;
    const minted = createAgentSessionContext(session);
    contexts.set(session, minted);
    return minted;
  }
  const toolContexts: AgentSessionContexts = {
    forCall: (session, callId) => contextFor(session).forCall(callId),
  };

  /**
   * The windows this worker owes the owner a state back (008/US4, FR-118): written by the one tool
   * that un-maximises one, read at every release. `chrome.storage.session`, because the worker that
   * resized is usually not the worker that restores.
   */
  const windowRestores = sessionWindowRestoreStore();
  const tabTools = createAgentTabTools({
    context: toolContexts,
    tabs,
    bindings,
    // What `resize_window` had to un-maximise, so the release can give it back (008/FR-118).
    windowRestores,
    /**
     * The emulated viewport `viewport` puts on a tab (012/US1, FR-156).
     *
     * Delegated rather than passed, as the dialogs are below: the module needs the attachment,
     * which is made further down this same function, and a tool call cannot happen before both
     * exist. Nothing else on the release paths changes - the module's own `onBeforeRelease` hook
     * is what clears the emulation, wherever the release came from.
     */
    viewport: {
      set: (sessionId, tabId, size) => viewportEmulation.set(sessionId, tabId, size),
      reset: (sessionId, tabId) => viewportEmulation.reset(sessionId, tabId),
    },
    onTabsChanged: notify,
    // A tab that moved may be on a site the diagnostics grant does not cover, and a tab that is
    // gone cannot be debugged at all. Both are announced here rather than discovered at the next
    // call, because what they end is an attachment the owner can see in their own browser.
    onTabNavigated: (tabId) => void diagnostics.refresh(tabId).catch(() => undefined),
    onTabReleased: (tabId) => {
      // The lease is over, so every holder is: the diagnostics buffers go with their grant, and the
      // attachment an effect made for this tab goes with the tab (004/T121, R-113).
      void diagnostics.release(tabId).catch(() => undefined);
      void attachments
        .release(tabId)
        // And the size this session laid the page out at (012/S2c F5) - *after* the release, never
        // beside it: the release hook reads that very record to know what to clear, so a record
        // forgotten first would leave the page emulated on a tab the owner has back. What this
        // catches is the tab that was closed rather than handed back, where there is nothing to
        // clear and the record would otherwise outlive the tab id Chrome will hand out again.
        .then(() => viewportEmulation.forget(tabId))
        .catch(() => undefined);
      // And what a read said about that tab's refs (008/T221): a handle means nothing without the
      // document that minted it, and this worker has no business remembering either.
      actions.forget(tabId);
      // Nor what the page had open on it (008/T226): a dialog on a tab nobody holds is the owner's
      // own browsing, and a `force` policy that outlived the lease would be worse than stale.
      dialogs.forget(tabId);
    },
    // A navigation to a url the browser downloads ends on the record that appears for it (005/US2).
    downloads: { list: (session) => downloads.list(session) },
    // 008/FR-115: a page with unsaved work is not left unless the owner said so. The policy is
    // armed per call by the dialogs module, and `force` is decided by the site's own mode.
    dialogs: { beginUnload: (tabId, policy) => dialogs.beginUnload(tabId, policy) },
    siteModes,
    prompts,
    statedPlan: (site) => plans.get(site),
    onAdmitted: (site, step) => plans.admit(site, step),
    reportDiagnostic: reportTestDiagnostic,
  });

  const reads = createAgentReads({
    context: toolContexts,
    bindings,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    // What a read said about each ref, kept for the label a later recorded action carries (FR-106):
    // the page decides what is redacted, and this is the only moment the worker is told.
    onNodesRead: (tabId, nodes) => actions.noteNodes(tabId, nodes),
    /**
     * What a screenshot is a picture of, when a session emulated the tab (012/T311, FR-158).
     *
     * Reading the record is all this is: no attachment is made for it, because a read attaches no
     * debugger - and on a tab that *is* emulated the attachment the emulation holds is already
     * there, which is what `sendOverAttachment` photographs through (R-166: `captureVisibleTab`
     * would hand back a picture of the window instead of the viewport that was asked about).
     */
    currentViewport: (tabId) => viewportEmulation.current(tabId),
    sendOverAttachment: (tabId, method, params) => attachments.send(tabId, method, params),
    // And the attachment itself when an eviction took this worker's record of it (012/S2c F2): the
    // holder claimed is the emulation's own, which is the one that is already owed to this tab.
    ensureAttached: (tabId) => attachments.acquire(tabId, "viewport"),
    reportDiagnostic: reportTestDiagnostic,
  });

  /**
   * The one debugger attachment per held tab, made here rather than inside a runner (004/T121).
   *
   * Both uses share it - input delivers through it, diagnostics listen through it - and it is
   * created where the *lease* lives, because that is what its lifetime follows: a tab released, a
   * tab closed, a session ended or an agent unpaired takes it down, whichever of the two asked for
   * it. Owned by a runner it would only ever be let go of by that runner's own rules.
   */
  const attachments = createInputAttachments({ reportDiagnostic: reportTestDiagnostic });

  /**
   * What each session's card remembers having happened, and the one thing it is being told
   * (008/FR-113, FR-114). Worker memory, newest first and bounded: a card is a card, not a log.
   */
  const activity = new Map<string, AgentActivityItem[]>();
  const notices = new Map<string, AgentNotice>();
  function noteActivity(sessionId: string, item: AgentActivityItem): void {
    activity.set(sessionId, [item, ...(activity.get(sessionId) ?? [])].slice(0, AGENT_ACTIVITY_KEPT));
    notify();
  }

  /**
   * The windows `resize_window` un-maximised, and giving them back (008/US4, FR-118..FR-120).
   *
   * Composed here because the question it asks at a release - "does this session still have a tab
   * in that window" - is one only the leases can answer, and because the card's line about it is
   * this file's `noteActivity`. The records themselves live in `chrome.storage.session`, so a
   * worker evicted between the resize and the release still finds what it owes.
   */
  const windowRestorer = createWindowRestorer({
    store: windowRestores,
    getWindow: getWindowFacts,
    setWindowState,
    windowsHeldBy: async (sessionId) => {
      const held = (await tabs.leases()).filter((lease) => lease.sessionId === sessionId);
      const windows = await Promise.all(held.map(async (lease) => (await getTabSnapshot(lease.tabId))?.windowId));
      return windows.filter((windowId): windowId is number => windowId !== undefined);
    },
    // The worker sends the state word, never a sentence: the panel writes what the owner reads.
    onRestored: (sessionId, state) =>
      noteActivity(sessionId, { at: Date.now(), kind: "restore", outcome: "restored", message: state }),
    reportDiagnostic: reportTestDiagnostic,
  });

  /**
   * The size a session laid a page out at, and giving it back (012/US1, FR-156, FR-159, R-166).
   *
   * Composed beside the window restorer because it is the same kind of debt - something this
   * worker did to the owner's browser for the agent's convenience, owed back the moment the
   * session lets the tab go - and because the card's line about it is this file's `noteActivity`.
   * The difference is where the giving back happens: a window is restored by the runtime at each
   * release site, while an emulation has to be cleared *over the attachment* before it is detached
   * (R-166 measured that a detach leaves the page emulated), so the two hooks below are registered
   * once here and the five release paths stay exactly as they were.
   */
  const viewportEmulation = createViewportEmulation({
    store: sessionViewportStore(),
    attachments,
    // The worker sends the pieces - an outcome and a size - and the panel writes the sentence.
    onActivity: (sessionId, outcome, size) =>
      noteActivity(sessionId, {
        at: Date.now(),
        kind: "viewport",
        outcome,
        ...(size === undefined ? {} : { message: `${size.width}x${size.height}` }),
      }),
    reportDiagnostic: reportTestDiagnostic,
  });
  // R-167: Chrome keeps both the emulation and the attachment across an MV3 eviction, and what the
  // worker loses is its own map. The next acquire re-applies what the record says; the release
  // clears it while there is still an attachment to send the clear over.
  attachments.onAttached((tabId) => viewportEmulation.onAttached(tabId));
  attachments.onBeforeRelease((tabId) => viewportEmulation.onBeforeRelease(tabId));

  /**
   * The dialogs the page opens (008/US3, R-138..R-140).
   *
   * Composed here because it needs two things no runner holds: the shared attachment - it answers
   * dialogs over the same debugger every effect is delivered through - and the tab leases, which
   * are what say whose card a dialog the agent never asked for is logged on.
   */
  const dialogs = createAgentDialogs({
    send: (tabId, method, params) => attachments.send(tabId, method, params),
    siteModes,
    prompts,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    // The browser's own record of the tab, never a page binding: a tab with a dialog open answers
    // no content message at all, so binding it would wait for the page this call is unblocking.
    siteOfTab: async (tabId) => {
      const tab = await getTabSnapshot(tabId);
      return tab === undefined ? undefined : siteOfUrl(tab.url);
    },
    holderOf: async (tabId) => (await tabs.leases()).find((lease) => lease.tabId === tabId)?.sessionId,
    onActivity: noteActivity,
    onNotice: (sessionId, notice) => {
      notices.set(sessionId, notice);
      notify();
    },
    statedPlan: (site) => plans.get(site),
    onAdmitted: (site, step) => plans.admit(site, step),
    reportDiagnostic: reportTestDiagnostic,
  });
  /**
   * The debugger fan-out, in one line (R-138, D-008-5): the page-events domain has exactly one
   * consumer in this worker, and its own switch keeps exactly two events. Nothing else in this file
   * subscribes to it; the only other subscriber in the worker is 003's diagnostics, which keeps
   * `Runtime`, `Log` and `Network` traffic under the owner's per-site grant and no `Page` event at
   * all. `dialog-wiring.test.ts` counts both on a composed runtime, so a third cannot appear quietly.
   */
  attachments.onEvent((tabId, method, params) => dialogs.onDebuggerEvent(tabId, method, params));
  /**
   * And the other end of that wire: what was heard on an attachment does not outlive it (T230, S4
   * review). Chrome detaches on its own when the tab closes or the owner dismisses the debugging
   * bar, and the `javascriptDialogClosed` that would have cleared the record never arrives - so the
   * next session to adopt that tab would meet a dialog nobody can answer and every tool blocked.
   */
  attachments.onDetach((tabId) => dialogs.forget(tabId));

  /**
   * The recording side of the worker (008/US1, R-132..R-134, R-137).
   *
   * `actions` is the scratch pad the label needs and the dispatch point does not have - where an
   * effect landed, and what the last read said about the element it landed on. The recorder itself
   * holds no frame: each one goes straight to the offscreen document, which is why a worker eviction
   * mid-recording loses nothing (D-008-2).
   */
  const actions = createActionContext();
  const recorder: AgentRecorder =
    options.recorder ??
    createRecorder({
      offscreen: createOffscreenAdapter(),
      capture: (tabId, lastViewport) =>
        captureFrame(tabId, { attachments, ...(lastViewport === undefined ? {} : { lastViewport }) }),
      downloads: { download: downloadFile, onChanged: watchDownloadChanged },
      store: sessionRecordingStore(),
      clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      // The manifest's own name and version, read at run time (FR-105): a watermark that named a
      // version this build is not would be a picture that lies about what produced it.
      watermark: () => {
        const manifest = chrome.runtime?.getManifest?.();
        return manifest ? `${manifest.name} ${manifest.version}` : "Hallpass";
      },
      reportDiagnostic: reportTestDiagnostic,
    });

  const effects = createAgentEffects({
    // Read through, never captured: the host names the session at `pair-request`, which is after
    // this runtime is composed, and a snapshot taken here would be the placeholder for ever.
    context: toolContexts,
    siteModes,
    bindings,
    prompts,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    // The session's `mainTabId` follows what it is actually driving (004/T103a): a session that
    // claimed a tab rather than creating one would otherwise leave the indicator's control pointing
    // at whichever tab it happened to open first.
    onEffect: (session, tabId) => {
      // The card's "newest activity first" (006 R-127) reads this; a greeting sets it too.
      const live = sessions.get(session);
      if (live) live.lastActivityAt = new Date().toISOString();
      void tabs.touch(session, tabId).catch(() => undefined);
    },
    // `follow-a-plan` in one line: what the owner approved for this site, and the count that keeps
    // each approved step from being admitted twice. A batch is the only thing that states one.
    statedPlan: (site) => plans.get(site),
    onAdmitted: (site, step) => plans.admit(site, step),
    // The two halves of 008/US3 an effect owns: what the owner just consented to on this tab, and
    // what the page put on the screen because of it (R-139, FR-111).
    onApproved: (tabId, tool) => dialogs.noteApprovedEffect(tabId, tool),
    currentDialog: (tabId) => dialogs.current(tabId),
    attachments,
    // The same record the `screenshot` tool reads (012/T311): `computer`'s own picture and the crop
    // the owner is shown are of the emulated viewport when there is one, not of the window.
    currentViewport: (tabId) => viewportEmulation.current(tabId),
    // Where the gesture actually landed, for the ring a recorded frame draws (008/R-136). The
    // coordinate is the runner's own measurement of the target's box; the decorator that builds the
    // label has no way to compute it and must not guess one.
    onDelivered: (callId, delivery) => actions.noteDelivery(callId, delivery),
    reportDiagnostic: reportTestDiagnostic,
  });

  const diagnostics = createAgentDiagnostics({
    context: toolContexts,
    siteModes,
    prompts,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    // `evaluate` is gated exactly as an effect is, so it reads the same approved plan a batch states.
    statedPlan: (site) => plans.get(site),
    onAdmitted: (site, step) => plans.admit(site, step),
    attachments,
    reportDiagnostic: reportTestDiagnostic,
  });

  const upload = createAgentUpload({
    context: toolContexts,
    siteModes,
    bindings,
    prompts,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    statedPlan: (site) => plans.get(site),
    onAdmitted: (site, step) => plans.admit(site, step),
    reportDiagnostic: reportTestDiagnostic,
  });

  const waiting = createAgentWait({
    context: toolContexts,
    bindings,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    stops,
    downloads,
    // Why a page-condition wait can end early (008/FR-111): a dialog is holding the page still.
    currentDialog: (tabId) => dialogs.current(tabId),
    reportDiagnostic: reportTestDiagnostic,
  });

  const downloadTools = createAgentDownloadTools({ list: (session) => downloads.list(session) });

  /**
   * One call to the runner that owns it. A batch's steps come back through this same function, so a
   * step is answered by exactly the code path it would have taken had the agent sent it alone -
   * which is what makes the per-step gate of FR-047 a fact about the wiring rather than a promise.
   */
  /**
   * The tools a dialog does not block (FR-111, as the S4 review amended it).
   *
   * `dialog` is the way out of it; `tabs_context`, `downloads_context` and `wait` read the *browser*
   * - which tabs there are, which downloads happened, how long to wait - and never the page a
   * dialog is holding still. `tabs_release` is the other way out: the agent may decline to answer a
   * dialog at all and hand the tab back, with the dialog on it, to the owner whose browser it is.
   * And `tabs_create` and `gif_recorder` name no tab: a call that carries its session's tab only
   * because every call does is not a call about the blocked page. Everything else, read or effect,
   * would be asking a renderer that will not answer until a button is pressed.
   */
  const DIALOG_PASS_THROUGH = new Set<AgentToolName>([
    "dialog",
    "tabs_context",
    "downloads_context",
    "wait",
    "tabs_release",
    "tabs_create",
    "gif_recorder",
  ]);

  /**
   * The block, answered before the call is routed anywhere (FR-111, R-139).
   *
   * Both references let the command run into a generic timeout and then tell the agent the renderer
   * "may be frozen" (design-notes §3) - true of a dialog, of a crash and of a slow page alike.
   * This is the whole of the difference: the answer is immediate, it names the dialog, and it
   * carries the page's own words, so the agent's next call is `dialog` rather than the same call
   * again. `busy` is the outcome because that is this contract's word for a tab that is occupied
   * right now and will not be in a moment - the same word a second effect gets while a prompt is up.
   */
  function blockedByDialog(request: AgentNativeRequest): AgentNativeResponse | undefined {
    if (DIALOG_PASS_THROUGH.has(request.tool)) return undefined;
    const named = (request.args as { tabId?: unknown }).tabId;
    const tabId = typeof named === "number" ? named : request.tabId;
    if (tabId === undefined) return undefined;
    const dialog = dialogs.current(tabId);
    if (!dialog) return undefined;
    return {
      callId: request.callId,
      outcome: "busy",
      reason: "blocked-by-dialog",
      refusal: { reason: "blocked-by-dialog", dialog },
    };
  }

  async function dispatchTool(request: AgentToolRequest): Promise<AgentNativeResponse> {
    // Before routing, deliberately: a runner reached at all is a runner that has already begun
    // asking the page something, and this is the one state in which nothing on that tab can answer.
    const blocked = blockedByDialog(request);
    if (blocked) return blocked;
    return recordAfter(request, await runTool(request));
  }

  /**
   * The tools whose answer a recording adds a frame for (FR-101, R-132).
   *
   * The effect list plus the four that change what the page shows without being effects and the one
   * that takes a picture on purpose. Reads are deliberately absent: a recording of a session's work
   * should show what it *did*, and a frame per read would be a film of a page nobody touched.
   */
  const RECORDED_TOOLS = new Set<string>([
    ...AGENT_EFFECT_TOOL_NAMES,
    "navigate",
    "screenshot",
    "file_upload",
    "upload_image",
    "resize_window",
    "dialog",
  ] satisfies AgentToolName[]);

  /** The tab a recorded call was about; the session's own main tab when the call names none. */
  async function recordedTabOf(request: AgentNativeRequest): Promise<number | undefined> {
    const named = (request.args as { tabId?: unknown }).tabId;
    if (typeof named === "number") return named;
    if (request.tabId !== undefined) return request.tabId;
    return tabs.mainTabId(request.sessionId);
  }

  /**
   * One line on the card for a picture the session put into one of the owner's pages (013/FR-174).
   *
   * Here rather than inside the upload runner for the same reason the restore's line is here: the
   * activity list is this file's, and a runner that wrote to it would need the map passed in. Only
   * an `ok` answer earns a line - a refused or stale call changed nothing on the page, and a card
   * entry for it would be a fact about nothing - and only `upload_image`: whether `file_upload`
   * gets one too is the owner's parity decision to make, not a side effect of this slice.
   *
   * The pieces, never a sentence: the site the tab is on and the delivery the *page* reported. A
   * tab whose site cannot be named still gets the line, with the site left out, because what
   * happened to the page happened either way.
   */
  async function noteUploadedImage(
    request: AgentToolRequest,
    response: AgentNativeResponse,
  ): Promise<void> {
    if (request.tool !== "upload_image" || response.outcome !== "ok") return;
    const delivery = (response.result as { delivery?: unknown } | undefined)?.delivery;
    if (delivery !== "input" && delivery !== "drop") return;
    const tabId = await recordedTabOf(request);
    const tab = tabId === undefined ? undefined : await getTabSnapshot(tabId);
    const site = tab === undefined ? undefined : siteOfUrl(tab.url);
    noteActivity(request.sessionId, {
      at: Date.now(),
      kind: "upload",
      outcome: "delivered",
      ...(site === undefined ? {} : { site }),
      message: delivery,
    });
  }

  /** The ref a call names, whichever of the two spellings it uses. */
  function refOf(args: Record<string, unknown>): string | undefined {
    const target = args["target"] as { ref?: unknown } | undefined;
    if (target && typeof target.ref === "string") return target.ref;
    return typeof args["ref"] === "string" ? (args["ref"] as string) : undefined;
  }

  /**
   * One frame per recorded action, taken after the action's own answer is in hand (R-132).
   *
   * Everything about this is deliberately downstream of the answer. A refused call changed nothing,
   * so it gets no frame; a failed capture changes no answer, because FR-101 says the recording is
   * never the reason a tool call reports differently. The state rides back on the answer either way
   * once a recording exists, which is how an agent learns it has hit the 200-frame cap without
   * asking - `full` is on every later answer of that session (FR-102).
   */
  async function recordAfter(
    request: AgentNativeRequest,
    response: AgentNativeResponse,
  ): Promise<AgentNativeResponse> {
    if (!RECORDED_TOOLS.has(request.tool)) return response;
    let state = await recorder.stateOf(request.sessionId);
    if (state.state === "none") return response;
    if (state.state === "recording" && response.outcome === "ok") {
      const tabId = await recordedTabOf(request);
      if (tabId !== undefined) {
        const args = request.args as Record<string, unknown>;
        const facts = actions.factsFor(tabId, refOf(args));
        const delivery = actions.takeDelivery(request.callId);
        state = await recorder.noteAction(
          request.sessionId,
          tabId,
          describeAction({
            tool: request.tool,
            args,
            ...(facts === undefined ? {} : { target: facts }),
            ...(delivery ?? {}),
          }),
        );
        // The card's recording line follows the count (FR-109); the panel re-reads the picture.
        notify();
      }
    }
    // Spread into the result the contract already makes room for; an answer with no result object
    // of its own is left exactly as its runner wrote it.
    if (response.outcome !== "ok" || typeof response.result !== "object" || response.result === null) {
      return response;
    }
    return { ...response, result: { ...(response.result as Record<string, unknown>), recording: state } };
  }

  async function runTool(request: AgentToolRequest): Promise<AgentNativeResponse> {
    if (tabTools.handles(request.tool)) {
      return tabTools.run(request);
    }
    if (reads.handles(request.tool)) {
      return reads.run(request);
    }
    if (waiting.handles(request.tool)) {
      return waiting.run(request);
    }
    if (dialogs.handles(request.tool)) {
      return dialogs.run(request);
    }
    if (effects.handles(request.tool)) {
      return effects.run(request);
    }
    if (batch.handles(request.tool)) {
      return batch.run(request);
    }
    if (diagnostics.handles(request.tool)) {
      return diagnostics.run(request);
    }
    if (upload.handles(request.tool)) {
      const answered = await upload.run(request);
      await noteUploadedImage(request, answered);
      return answered;
    }
    if (downloadTools.handles(request.tool)) {
      return downloadTools.run(request);
    }
    if (recordingTools.handles(request.tool)) {
      const answered = await recordingTools.run(request);
      // start/stop/export/clear all move the card's recording line (FR-109); the panel re-reads it.
      notify();
      return answered;
    }
    // Every other name in the closed tool list belongs to a later slice. Saying so is the only
    // honest answer: an `ok` here would be a result claiming an effect nothing carried out.
    return { callId: request.callId, outcome: "failed", reason: "tool-not-implemented" };
  }

  const recordingTools = createAgentRecordingTools({
    recorder,
    // `start` photographs the page the session is working on; the tool names no tab of its own.
    mainTabId: (sessionId) => tabs.mainTabId(sessionId),
  });

  const batch = createAgentBatch({
    siteModes,
    plans,
    prompts,
    stops,
    tabOwnership: (session, tabId) => tabs.ownership(session, tabId),
    async siteOfTab(session, tabId, callId) {
      // The same binding every step will use, so the site the owner is asked about is the site the
      // gate will decide on. A tab that cannot be bound - a blank one a `navigate` step is about to
      // fix - has no site, and the batch states no plan for it.
      const bound = await bindings.bind(tabId, toolContexts.forCall(session, callId));
      return bound.ok ? bound.binding.site : undefined;
    },
    dispatch: dispatchTool,
    reportDiagnostic: reportTestDiagnostic,
  });

  async function handleToolCall(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    /**
     * The call names its session, and that is the session it is answered as (004 US2).
     *
     * 003 read "the" connected agent because there was only one. With several live, a call
     * attributed to whichever session paired most recently would answer one agent out of another
     * agent's tab group - which is the ownership check reading the wrong side of the question.
     */
    const session = sessions.get(request.sessionId);
    if (!session) {
      /**
       * A session this worker does not have (006 FR-087, S1 review). The owner's Stop forgets the
       * session while the host behind it is still attached and still paired, so its next call
       * lands here - and `not-paired` would tell that host the owner refused it, which is a word it
       * keeps for the rest of its life. `session-ended` is the fact, and the host's cue to greet
       * again as a new session rather than restart.
       */
      return { callId, outcome: "denied", reason: "session-ended" };
    }
    if (!(await pairing.isPaired(session.agentId))) {
      // Checked per call rather than remembered from the pairing: unpairing has to bite the very
      // next call of a session that is already open (SC-026), and a cached "yes" would let it not.
      return { callId, outcome: "denied", reason: "not-paired" };
    }
    // The card's "newest activity first" (006 R-127) reads this: any call of the session is its
    // activity, not only the effects that also move its main tab.
    session.lastActivityAt = new Date().toISOString();
    // Nothing is re-pointed here: the call names its session, and every runner reads that id off
    // the request it was handed. A batch's steps carry it too, so a step that resumes after an
    // await is still answered as the session that sent it (004/T103a).
    return dispatchTool(request);
  }

  /**
   * One session is over: forget it, withdraw its group's marking, and let go of everything it was
   * holding - and nothing anybody else is (004 US2).
   *
   * The debugger attachments are released by tab rather than wholesale, because `releaseAll` would
   * detach the tabs of every other live session too. The tabs themselves stay open: the owner may
   * still be reading them, and closing a window because an agent exited is not a thing the owner
   * asked for.
   */
  async function releaseSession(ending: string, questions: PromptEnding = "timed-out"): Promise<void> {
    // Its own questions, and nobody else's: another session's owner may be sitting in front of a
    // prompt that is perfectly alive (004/T103a). Settled first, so a call parked on a question
    // is answered in the word the ending deserves before the session it belongs to is gone.
    prompts.cancelSession(ending, questions);
    // And its half of a pairing card, if it was waiting on one (011 review M2): the card stays up
    // for the sessions that are still there, and this one stops being told about it.
    pairing.sessionEnded(ending);
    /**
     * The recording goes to disk *before* the tabs do (FR-108, R-137).
     *
     * `download-observer.ts` attributes a download to whoever held a tab when the browser created
     * it, so an export run after `endSession` below would belong to nobody and the session's own
     * `downloads_context` would never list the file it just wrote. A recording of no frames is
     * dropped inside `exportIfFrames`, and a failed export never stops a session from ending.
     */
    await recorder.exportIfFrames(ending).catch(() => reportTestDiagnostic("agent.recording.export-failed"));
    // And the owner's windows go back before the tabs do (FR-119), for the ordinary reason: after
    // `endSession` this session holds nothing, and the hook that watches tabs leave would be asking
    // about a session that no longer exists. Awaited, so the record is gone before that hook runs.
    await windowRestorer.restoreFor(ending).catch(() => reportTestDiagnostic("agent.window.restore-failed"));
    const held = await tabs.context(ending);
    for (const tab of held.tabs) {
      await diagnostics.release(tab.tabId).catch(() => undefined);
      await attachments.release(tab.tabId).catch(() => undefined);
      // Exactly what a `tabs_release` does for one tab (008/T230): the dialog this session heard is
      // a fact about an attachment that is now gone, and the tab stays open for whoever takes it.
      dialogs.forget(tab.tabId);
    }
    await tabs.endSession(ending);
    sessions.delete(ending);
    // The binding goes with the session: a later session reusing the id would otherwise inherit its
    // channel nonce and speak into a conversation it never had.
    contexts.delete(ending);
    // And so does its card's own memory (008 FR-113): there is no card left for it to be about.
    activity.delete(ending);
    notices.delete(ending);
    notify();
  }

  /**
   * The indicator's control, answered (004/T108, FR-062): the session working in *this* tab brings
   * its main tab forward, at once, without the owner going looking for it.
   *
   * Two facts decide it, and the message is not either of them. The sender is the extension's own
   * content script - `sender.id` is Chrome's attribution and a page cannot forge it - and the tab
   * it came from, which is `sender.tab`, has a live lease. The lease *is* the session: nothing here
   * reads the tab group, because the group is the visible marking and the owner can drag a tab into
   * or out of it.
   *
   * A `tabId` in the body is therefore never the tab that is acted on. A body naming another tab is
   * refused whole rather than quietly ignored, so that one session's page cannot use the control to
   * steer the owner anywhere at all - not to another session's tab, and not to its own either.
   */
  async function focusMainTab(message: unknown, sender: ContentMessageSender): Promise<void> {
    if (!isFocusMainMessage(message)) return;
    if (!sender.id || sender.id !== chrome.runtime?.id) return;
    const from = sender.tab?.id;
    if (from === undefined) return;
    // The body may only ever agree with Chrome. Anything else is a message about a tab this page
    // is not in, which is not a question this control is allowed to ask.
    if (message.tabId !== undefined && message.tabId !== from) return;
    const lease = (await tabs.leases()).find((held) => held.tabId === from);
    // Nobody holds the sending tab: there is no session behind this click, so there is no main tab
    // it could be about. The indicator should not be on that page in the first place.
    if (!lease) return;
    const main = await tabs.mainTabId(lease.sessionId);
    if (main === undefined) return;
    const tab = await chrome.tabs.update(main, { active: true });
    const windowId = tab?.windowId;
    // The tab is only forward if its window is: a session working in a background window would
    // otherwise activate a tab the owner cannot see (FR-062).
    if (windowId !== undefined) await chrome.windows?.update(windowId, { focused: true });
  }

  /**
   * A content script announced itself (004/T107b): a page loaded, and it wants to know whether the
   * tab it is in is held.
   *
   * The answer goes back as an ordinary `indicator` message rather than as a reply on this port,
   * which is what keeps the listener above free to return `false`. Every announcement is answered,
   * including from a tab nobody holds - that answer is "no indicator", and it is what makes a page
   * that kept an indicator across a release (or across a worker eviction) drop it.
   */
  async function announced(message: unknown, sender: ContentMessageSender): Promise<void> {
    if (!isAgentAnnounceMessage(message)) return;
    // Chrome's own attribution of the sender, exactly as the focus-main path reads it: a page
    // cannot forge `sender.id`, and a message from anywhere else is not this extension's.
    if (!sender.id || sender.id !== chrome.runtime?.id) return;
    const from = sender.tab?.id;
    if (from === undefined) return;
    await indicator.answerAnnouncement(from);
  }

  /** This worker's view of which browser run it belongs to (013/R-184); read once, on first ask. */
  const browserRun = sessionBrowserRun();

  const bridge = createAgentBridge({
    connectNative: options.connectNative ?? connectAgentNativeHost,
    ...(options.disconnectReason === undefined ? {} : { disconnectReason: options.disconnectReason }),
    onDisconnected(reason) {
      void recordBridgeDisconnect(reason).catch(() => reportTestDiagnostic("agent.bridge.disconnect-record-failed"));
    },
    /**
     * A session announced itself (004/T099i): the relay forwarded its greeting.
     *
     * This is the whole of session liveness. It used to happen inside `decidePairing`, which only
     * ran because a server sends a `pair-request` on every attach - so the registry and the 15 s
     * reconciliation depended on pairing cadence, and S2 is the slice that changes pairing.
     *
     * The host's id is adopted as-is. A relay that reconnected during one agent session repeats the
     * same id, so an id this worker already knows is a *reconnect*: keep its group, its tabs and
     * its binding, and only note that it is alive. An id it has not seen is a new session beside
     * the ones already running, never in place of them (D-M3-3).
     */
    onSessionAnnounced(announcement) {
      const known = sessions.get(announcement.sessionId);
      const helloAt = new Date().toISOString();
      if (known) {
        known.lastHelloAt = helloAt;
        known.lastActivityAt = helloAt;
        known.agentId = announcement.agentId;
        known.agentName = announcement.displayName;
      } else {
        contextFor(announcement.sessionId);
        sessions.set(announcement.sessionId, {
          agentId: announcement.agentId,
          agentName: announcement.displayName,
          lastHelloAt: helloAt,
          lastActivityAt: helloAt,
        });
      }
      // Written where an evicted worker will find it: the reconciliation's alarm may fire in a
      // worker that never saw this greeting.
      void tabs.announce(announcement.sessionId, helloAt).catch(() => undefined);
      notify();
    },
    async decidePairing(request) {
      // Pairing, and only pairing (004/T099i). The session behind this request announced itself on
      // its greeting; what is left here is the owner's question about the agent.
      if (!pairingRequestedAt.has(request.agentId)) pairingRequestedAt.set(request.agentId, new Date().toISOString());
      return pairing.decidePairing({
        agentId: request.agentId,
        displayName: request.displayName,
        origin: request.origin,
        // Who is waiting, for the ticks alone (011): the card is about an agent, but the frame the
        // relay routes is addressed to a session, and this is the session that raised the card.
        sessionId: request.sessionId,
      });
    },
    /**
     * Which run of the browser is answering (013/R-184, FR-168).
     *
     * One instance for this worker, so the id is read or minted once and the same one travels on
     * every pairing answer; it lives in `chrome.storage.session`, which is what makes it survive a
     * recycling of this worker and end when the browser does. The host compares it to decide
     * whether the screenshots it is holding for this session are still this browser's.
     */
    browserRunId: () => browserRun.id(),
    callTool: handleToolCall,
    onStop(frame) {
      if (frame.callId !== undefined) {
        // The host's per-call backstop (D-M3-1). The session is still running; only this one call
        // is over - and if it was a batch or a wait, it is still walking steps or watching a page,
        // so it is told to stop as well as being abandoned (FR-046, FR-048). A question the owner
        // is looking at goes down with it, and a question raised by a *different* call does not
        // (B5): that call has not been given up on and its answer still has somewhere to go.
        prompts.cancel(frame.callId);
        stops.stop(frame.callId);
        return;
      }
      // No call named: the MCP session itself has ended (M4 Part A). This is the only event that
      // releases the session's tabs - a relay dropping is not it, because one agent session
      // outlives any number of relay connections (D-M3-3). A `stop` for some *other* session is
      // ignored rather than applied to this one.
      if (frame.sessionId === undefined) {
        // The owner stopped everything, which is the widest reading of Stop and the safe one when
        // they have just asked for it (003). Every live session goes, not the one that happens to
        // have called most recently - and so does every question and every call in flight.
        prompts.cancel();
        stops.stop();
        void diagnostics.releaseAll().catch(() => undefined);
        void attachments.releaseAll().catch(() => undefined);
        for (const ending of [...sessions.keys()]) {
          void releaseSession(ending).catch(() => reportTestDiagnostic("agent.session.end-failed"));
        }
        return;
      }
      // A `stop` naming a session this worker does not have is about somebody else's work.
      if (!sessions.has(frame.sessionId)) {
        reportTestDiagnostic("agent.stop.other-session");
        return;
      }
      // This session's calls, and only this session's (004/T105a). The unnamed stop above is the
      // owner's; a named one is one agent's session ending, and another agent's batch is still its
      // own work. Its questions go the same way, inside `releaseSession`.
      stops.stopSession(frame.sessionId);
      // Nothing this session attached may outlive it: the session ending is the last moment the
      // owner's grant could still be said to cover a debugger this worker opened.
      void releaseSession(frame.sessionId).catch(() =>
        reportTestDiagnostic("agent.session.end-failed"),
      );
    },
    onSessionEnded(ended) {
      // The relay saw one server's socket close. That server's session is over and no other is:
      // 003 released "the" session here, which with several live released the wrong agent's tabs.
      if (!sessions.has(ended)) {
        reportTestDiagnostic("agent.session.end-unknown");
        return;
      }
      void releaseSession(ended).catch(() => reportTestDiagnostic("agent.session.end-failed"));
    },
    onRelayStarted(relayPid, recordPath) {
      lastRelayPid = relayPid;
      // Kept only when the greeting named one: a relay from before the field must not blank a
      // path its predecessor gave, which is still where the record is.
      if (recordPath !== undefined) lastRecordPath = recordPath;
      // The greeting side of the T169 ring: which worker instance was greeted by which host. Two
      // instance ids greeted inside one test is the two-instances shape; one id with a new host
      // pid is a drop and re-open.
      void recordBridgeGreeting(relayPid, recordPath).catch(() => reportTestDiagnostic("agent.bridge.greeting-record-failed"));
      /**
       * A relay announced itself on a freshly opened port. Every session this worker still holds
       * has to greet that relay again inside the bound; the ones that do not are released.
       *
       * The window is opened in storage rather than in memory, and closed by an alarm, so the whole
       * of it survives the worker being evicted in the middle - which is the likeliest thing to
       * happen during fifteen seconds in which no agent is calling anything.
       */
      void tabs
        .beginReconciliation(new Date().toISOString())
        .then(scheduleReconcileAlarm, () => reportTestDiagnostic("agent.reconcile.arm-failed"));
    },
    scheduleRetry: scheduleRetryAlarm,
    onStatusChange(status) {
      if (status === "connected") {
        clearRetryAlarm();
        scheduleHeartbeatAlarm();
      } else {
        clearHeartbeatAlarm();
        // The link is gone, so the connection that raised a pairing prompt is gone with it. The
        // prompt is dropped before the panel is told anything, so the owner is never shown an
        // Accept button whose answer could reach nobody. The same is true of a question about an
        // effect (B3): the call that raised it cannot be answered any more, so an Allow pressed
        // afterwards would run an effect for nobody. Both questions end here.
        prompts.cancel();
        void pairing.abandonPending();
      }
      options.onStatusChange?.(status);
      notify();
    },
    reportDiagnostic: reportTestDiagnostic,
  });

  return {
    bridge,
    pairing,
    tabs,
    siteModes,
    prompts,
    status: () => bridge.status(),
    async projection(): Promise<AgentPanelState> {
      const state = await pairing.state();
      // A session appears only for an agent that is *currently* paired and connected: an entry for
      // one the owner just unpaired would show tabs nobody may still drive.
      const live: Array<{ sessionId: string; agentId: string; agentName: string; tabs: AgentTab[]; lastActivityAt: string }> = [];
      for (const [id, session] of sessions) {
        if (!(await pairing.isPaired(session.agentId))) continue;
        live.push({
          sessionId: id,
          agentId: session.agentId,
          // The greeting's name, not the pairing record's: one agent id is shared by every MCP
          // client on the machine, and the record names whichever client paired first.
          agentName: session.agentName,
          tabs: (await tabs.context(id)).tabs,
          lastActivityAt: session.lastActivityAt,
        });
      }
      /**
       * The browser's tabs, with who holds each (004/T109a, FR-060).
       *
       * Beside the per-session lists rather than inside them: a session's list answers "what is
       * this agent working on", and this answers "who has my tabs" - including the two cases a
       * session's own list cannot contain, a tab nobody holds and one another session does. Built
       * from the browser's tab records and the lease store, never from a document: the panel is
       * held to the same rule `tabs_context` is, because listing takes no lease.
       */
      const [snapshots, leases] = await Promise.all([queryTabSnapshots(), tabs.leases()]);
      const holders = new Map(leases.map((lease) => [lease.tabId, lease.sessionId]));
      const browserTabs: AgentPanelTab[] = snapshots.map((tab) => {
        const holder = holders.get(tab.id);
        return {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
          holder: holder === undefined ? "none" : { sessionId: holder },
        };
      });
      const prompt = prompts.current();
      const plan = prompts.currentPlan();
      /**
       * The sites the owner has decided about, plus the ones the session's tabs are actually on.
       *
       * Both halves are needed and neither is enough. Without the stored half the owner could not
       * see a decision they made yesterday; without the live half they could not make a *first*
       * decision at all - a site enters the store only when it has a mode, so a list of stored sites
       * alone would never contain the page the agent is about to act on. An undecided site appears
       * here at its default, `ask`, which is exactly what it is under.
       */
      const decided = await siteModes.list();
      const known = new Set(decided.map((record) => record.site));
      const visible = [...decided];
      for (const session of live) {
        for (const tab of session.tabs) {
          const site = siteOfUrl(tab.url);
          if (site && !known.has(site)) {
            known.add(site);
            visible.push({ site, mode: "ask", diagnosticsGranted: false });
          }
        }
      }
      /**
       * What each card says (006 R-127): the *sites* a session is on - host names, deduped, never
       * a title, because a title is the page's word and the panel shows nothing a page authored -
       * and whether it is the one the owner is being asked about right now.
       */
      const waitingOn = prompts.currentSession();
      // The recording line each card shows (008 FR-109): read from the session area, so a card is
      // right about a recording a previous worker started.
      const recordings = await recorder.listStates().catch(() => ({}) as Awaited<ReturnType<typeof recorder.listStates>>);
      const cards = live.map((session) => {
        const recording = recordings[session.sessionId];
        return {
          ...session,
          sites: [
            ...new Set(session.tabs.map((tab) => hostOfUrl(tab.url)).filter((host): host is string => host !== undefined)),
          ],
          state: session.sessionId === waitingOn ? ("waiting" as const) : ("working" as const),
          ...(recording === undefined ? {} : { recording }),
          // What happened on this session's tabs while the owner may have been looking elsewhere
          // (008 FR-113), and the one thing the panel is telling them without asking (FR-114).
          ...(activity.has(session.sessionId) ? { activity: activity.get(session.sessionId) } : {}),
          ...(notices.has(session.sessionId) ? { notice: notices.get(session.sessionId) } : {}),
        };
      });
      const agentName = state.paired[0]?.displayName;
      const requestedAt = state.pending ? pairingRequestedAt.get(state.pending.agentId) : undefined;
      return {
        ...(state.pending ? { pending: { ...state.pending, ...(requestedAt === undefined ? {} : { requestedAt }) } } : {}),
        paired: state.paired,
        sessions: cards,
        tabs: browserTabs,
        sites: visible,
        ...(prompt ? { prompt } : {}),
        ...(plan ? { plan } : {}),
        bridge: bridge.status(),
        ...(agentName === undefined ? {} : { agentName }),
        diagnostics: await readBridgeDiagnostics(),
      };
    },
    bindPanelPresence(presence: AgentPanelPresence): void {
      panelPresence = presence;
      // A panel opening is an answer arriving at a question the person could not see, and a panel
      // closing can leave one standing that nobody can. Both change what the icon should say.
      presence.onPresenceChange(() => refreshAttention());
    },
    start(): void {
      // 011 FR-152: once, on wake, before anything else can raise a question. A worker Chrome
      // evicted mid-question comes back with the browser still showing its badge, and nothing else
      // in the life of this worker would ever clear it - the question it was about is gone.
      refreshAttention();
      // Before anything connects: a debugger this extension left attached across a worker eviction
      // is let go of, and every later navigation - including the ones no tool of ours started -
      // becomes something the grant can be re-checked against (C1).
      void diagnostics.start().catch(() => reportTestDiagnostic("agent.diagnostics.start-failed"));
      // 004/T099l: a group still titled "Agent" from a browser restart or an extension reload
      // belongs to no session this worker can reach, and the owner reads it as an agent driving
      // their tabs. Nothing else in the life of a worker gets the chance to answer for it.
      void tabs
        .sweepOrphanedGroups()
        .catch(() => reportTestDiagnostic("agent.groups.sweep-failed"));
      // Subscribed at worker start for the reason the message listener below is: a download that
      // begins after an eviction is delivered to the worker Chrome wakes for it, and a listener
      // added any later than this would not be there (005/FR-077).
      downloads.start();
      /**
       * Registered at worker start rather than when a tab is claimed: MV3 evicts the worker between
       * events, and a listener added later would not exist in the worker Chrome wakes to deliver
       * the owner's click.
       *
       * `false` is returned deliberately - this message is not answered, and a listener that
       * claimed it would answer asynchronously is what makes `sendMessage` hang (004/T107a).
       */
      chrome.runtime?.onMessage?.addListener((message: unknown, sender: ContentMessageSender) => {
        // The one listener, deliberately: a second one for the announcement would be a second
        // thing returning `false` about every message the first one already saw (004/T107a). Both
        // messages are answered the same way - by what the worker *does*, never through the port -
        // so `false` stays honest and no sender is left waiting on a reply that never comes.
        void announced(message, sender).catch(() =>
          reportTestDiagnostic("agent.indicator.announce-failed"),
        );
        void focusMainTab(message, sender).catch(() =>
          reportTestDiagnostic("agent.focus-main.failed"),
        );
        return false;
      });
      // A heartbeat a predecessor left armed (evicted while connected) would otherwise keep firing
      // beside the retry alarm in an instance that never reaches `connected` (review B121 #5); the
      // link's own `connected` re-arms it.
      clearHeartbeatAlarm();
      chrome.alarms?.onAlarm.addListener((alarm) => {
        if (alarm.name === AGENT_RETRY_ALARM && bridge.status() !== "connected") {
          bridge.connect();
        }
        // The heartbeat's work is done by firing at all; what it checks is the same thing the
        // references check on theirs - that the link it exists to protect is still there.
        if (alarm.name === AGENT_HEARTBEAT_ALARM && bridge.status() !== "connected") {
          bridge.connect();
        }
        if (alarm.name === AGENT_RECONCILE_ALARM) {
          // The bound is up. Whatever did not greet the relay that is running now is released, and
          // the answer comes from storage so a worker that was evicted mid-window can still give it.
          void tabs
            .reconcile()
            .then(async (stale) => {
              for (const ending of stale) await releaseSession(ending);
            })
            .catch(() => reportTestDiagnostic("agent.reconcile-failed"));
        }
      });
      bridge.connect();
    },
    connect(): void {
      bridge.connect();
    },
    async unpair(agentId: string): Promise<void> {
      await pairing.unpair(agentId);
      // The badge goes when the permission does (FR-062): the session may still hold its leases
      // until it ends, but an unpaired agent can do nothing in those tabs, and a page still saying
      // an agent is working in it would be telling the owner something that is no longer true.
      //
      // Read from the leases rather than from the session's tab list (004/T111b): the lease is the
      // only authority the sender recognises - it is what `answerAnnouncement` asks - so the tabs
      // told here are exactly the tabs that would be told anything else.
      const held = await tabs.leases();
      for (const [live, session] of sessions) {
        if (session.agentId !== agentId) continue;
        for (const lease of held) {
          if (lease.sessionId !== live) continue;
          indicator.lower(lease.tabId);
          // And the debugger with it (004/T121): an unpaired agent may deliver nothing, so a tab
          // left attached would only be Chrome telling the owner it is being controlled by nobody.
          void attachments.release(lease.tabId).catch(() => undefined);
        }
      }
      // Only the agent on the wire right now is told. The frame carries the id either way, but a
      // decline sent down a link belonging to a *different* agent is an answer that session never
      // asked for, and the host would read it as its own (M2 review A1).
      for (const [live, session] of sessions) {
        if (session.agentId === agentId) {
          bridge.notifyUnpaired(agentId, live);
        }
      }
    },
    async setSiteMode(site: string, mode: SiteMode): Promise<void> {
      await siteModes.set(site, { mode });
      notify();
    },
    async clearSiteMode(site: string): Promise<void> {
      // The whole record, diagnostics grant included: a revoked site is one the owner has decided
      // nothing about, and a debugger attached under the old grant has no grant left to sit on.
      await diagnostics.revoke(site);
      await siteModes.clear(site);
      notify();
    },
    async stopSessionFromOwner(sessionId: string): Promise<void> {
      if (!sessions.has(sessionId)) {
        reportTestDiagnostic("agent.stop.other-session");
        return;
      }
      // The same two steps a relay-named stop takes (`onStop` above), in the same order: the calls
      // in flight are flagged first so a `wait` between polls answers `owner-stopped` rather than
      // `not-paired`, and then the session goes with its group marking and its questions - a call
      // parked on one of those answers `owner-stopped` too (FR-087).
      stops.stopSession(sessionId);
      try {
        await releaseSession(sessionId, "stopped");
      } catch {
        // The panel's command is not rejected over a storage write: whatever was released stays
        // released, the panel re-reads the picture, and the failure is said where a gate reads it.
        reportTestDiagnostic("agent.session.end-failed");
        notify();
      }
    },
    async releaseSessionTabs(sessionId: string): Promise<void> {
      if (!sessions.has(sessionId)) return;
      // The session's question, if one is up, is about a tab that is the owner's from here on: the
      // parked call is refused as any unheld tab is, and the card stops saying "waiting for you".
      prompts.cancelSession(sessionId, "released");
      // The same order as a session ending (FR-108): a session handing back every tab it holds has
      // nothing left to record, and the file has to be written while the lease still attributes it.
      await recorder.exportIfFrames(sessionId).catch(() => reportTestDiagnostic("agent.recording.export-failed"));
      const held = await tabs.context(sessionId);
      for (const tab of held.tabs) {
        // Exactly what `tabs_release` does for one tab (agent-tools/tabs.ts): the lease goes, the
        // page binding with it, and the debugger and diagnostics attached to that tab are let go.
        // One tab failing does not strand the rest; the failure is reported and the next is tried.
        try {
          await tabs.release(sessionId, tab.tabId);
          bindings.invalidate(tab.tabId);
          await diagnostics.release(tab.tabId).catch(() => undefined);
          await attachments.release(tab.tabId).catch(() => undefined);
          dialogs.forget(tab.tabId);
        } catch {
          reportTestDiagnostic("agent.release.tab-failed");
        }
      }
      notify();
    },
    async setDiagnostics(site: string, granted: boolean): Promise<void> {
      await siteModes.set(site, { diagnosticsGranted: granted });
      if (!granted) await diagnostics.revoke(site);
      notify();
    },
    subscribe(listener: () => void): void {
      listeners.push(listener);
    },
  };
}
