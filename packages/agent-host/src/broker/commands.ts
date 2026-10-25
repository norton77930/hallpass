import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  agentBrowserIdSchema,
  CONVERSATION_AGENTS,
  CONVERSATION_MAX_ENTRIES,
  conversationCommandFrameSchema,
  type AgentInstallState,
  type ConversationAgent,
  type ConversationAgentAvailability,
  type ConversationError,
  type ConversationInstallPhase,
  type ConversationLinkCommand,
  type ConversationEventPayload,
  type ConversationMode,
} from "@hallpass/contracts";
import { launchSettings, writeLaunchFiles } from "./agent-launch-settings.js";
import type { ConversationListNotice } from "./index-store.js";
import { isProcessAlive, writeHostFileAtomically } from "../bridge-link.js";
import { isWindowsDeviceName } from "../host-paths.js";
import {
  AGENT_ADAPTERS,
  AGENT_DESCRIPTIONS,
  LAUNCH_EXEC_BOUND_MS,
  TESTED_AGENT_VERSIONS,
  adapterLaunchSpec,
  agentAvailability,
  type AdapterLaunchSpec,
  type AgentPorts,
  type ReadinessAttempt,
} from "./agents.js";
import type { ConversationIndex, FolderList } from "./conversation-index.js";
import type { CommandOutcome, ConversationPool, LaunchResolution, ResumeGate } from "./conversation.js";
import type { FolderActions } from "./folders.js";
import { INSTALL_CANCELLED_DETAIL, type InstallControl, type InstallEstimate, type InstallProgress, type InstallResult } from "./install.js";
import { redact, withoutUserProfile } from "./redact.js";
import {
  acquireInstallLock,
  isRunningInstallPhase,
  liveInstallLockHolder,
  readInstallState,
  readSharedState,
  SHARED_STATE_POLL_MS,
  shownInstallState,
  watchSharedState,
  writeInstallState,
  type InstallLockHolder,
  type SharedStateSnapshot,
  type SharedStateWatch,
} from "./shared-agent-state.js";

/**
 * The broker's side of the panel's commands (019 T540; contracts/conversation-frames.md). A
 * `conversation-command` frame from the worker is validated against the contract once more (the
 * worker validated it at the panel port; the broker trusts no frame it did not check), carried out,
 * and answered with exactly one `conversation-result`. A change to the list follows as a
 * `conversation-overview`; `open` is followed by the conversation's log as `conversation-page`s.
 *
 * The index and the folder list are the host files of S7 (`index-store.ts`, `folders.ts`, T560/T562);
 * `add-folder` opens the Windows folder dialog (R-320) and `open-folder` Explorer through the
 * injected `folderActions`. The browser token (`conversation-browser-token`, R-321) is the agent
 * run's (`conversation.ts`, `browser-token.ts`); `send` hands it the panel's start tab.
 *
 * Consent (FR-299) is the broker's own record as well as the worker's, per browser (T558):
 * `<data>\conversation-consent\<browserId>.json`, written temp + rename. Starting an agent - a new
 * conversation, or a stopped one resumed by `send` / `open` - and downloading a connector need it
 * granted; withdrawing it revokes every live run's browser token.
 */

const DETAIL_MAX = 600;

/**
 * 024 R-375: how long after the last `ui.conversation.check-agents` - which the settings page sends on
 * every connect - the shared files are still watched while no install or test runs in this broker and
 * the shared files show no download under way in a live broker (another browser's). Then the watch
 * ends by itself; the page's next connect starts it again.
 */
export const SHARED_STATE_WATCH_IDLE_MS = 60_000;

/** What a command produced: `start` names the conversation it minted, the rest nothing. */
type Outcome = CommandOutcome | CommandOutcome<{ conversationId: string }>;

const failure = (code: ConversationError["code"], detail: string): { ok: false; error: ConversationError } => ({
  ok: false,
  error: { code, detail: redact(detail).slice(0, DETAIL_MAX) },
});

/* ------------------------------------------------------------------------------------------- */
/* Consent                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export type ConsentState = "unknown" | "granted" | "withdrawn";
export type ConsentStore = {
  read(): Promise<ConsentState>;
  write(granted: boolean, at: string): Promise<void>;
};

const consentFileSchema = z.strictObject({ granted: z.boolean(), at: z.string().min(1).max(64) });

/**
 * FR-299: the one-time consent, as this browser's broker keeps it. Absent or unreadable is `unknown`
 * (ask again). T558: one file per browser, `<data>\conversation-consent\<browserId>.json`, as the
 * worker's is per browser profile - so a withdrawal in one browser leaves another's answer. The
 * earlier shared `<data>\conversation-consent.json` is no browser's answer: not read, not migrated
 * (one browser's grant must not become every browser's), not removed.
 */
export function fileConsentStore(dataDir: string, browserId: string): ConsentStore {
  if (!agentBrowserIdSchema.safeParse(browserId).success || isWindowsDeviceName(browserId)) {
    throw new Error("browser id is not a file name");
  }
  const path = join(dataDir, "conversation-consent", `${browserId}.json`);
  return {
    async read() {
      try {
        const parsed = consentFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (!parsed.success) return "unknown";
        return parsed.data.granted ? "granted" : "withdrawn";
      } catch {
        return "unknown";
      }
    },
    write: (granted, at) => writeHostFileAtomically(path, { granted, at }),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Which agent process a conversation starts                                                    */
/* ------------------------------------------------------------------------------------------- */

export type AgentLauncher = {
  /** The launch for a panel mode (default strict): launch-time agents start differently per mode (021 R-351). */
  resolveLaunch: (agent: ConversationAgent, mode?: ConversationMode) => Promise<LaunchResolution>;
  availability: (agent: ConversationAgent) => Promise<ConversationAgentAvailability>;
};

/**
 * Discovery (R-315) turned into a launch: the installed adapter with the owner's CLI, Hermes' own
 * program, or DeepSeek's fetched package, each in the panel mode asked for - or the reason there is
 * none: `agent-missing`, `agent-version` (a version Hallpass cannot use), `install-needed`.
 * `testAgent` replaces discovery with one fixed command for every agent; the broker passes it only
 * under `HALLPASS_TEST_MODE=1` (`broker.ts`). The mode's launch settings still apply on top of it
 * (021: Hermes' managed layer is written and named, DeepSeek's environment is set), so a test sees
 * what a real launch would hand the agent.
 */
export function createAgentLauncher(options: { ports: AgentPorts; testAgent?: AdapterLaunchSpec }): AgentLauncher {
  const { ports, testAgent } = options;
  return {
    async availability(agent) {
      if (testAgent !== undefined) return { agent, availability: "ready", version: "0.0.0-test" };
      return (await agentAvailability(agent, ports)).availability;
    },
    async resolveLaunch(agent, mode = "strict") {
      const label = AGENT_ADAPTERS[agent].label;
      const tested = TESTED_AGENT_VERSIONS[agent];
      if (testAgent !== undefined) {
        const settings = launchSettings(agent, mode, ports.dataDir);
        try {
          await writeLaunchFiles(settings.files, ports.fs);
        } catch (error) {
          return failure("broker-unavailable", `Hallpass could not prepare ${label}'s settings: ${error instanceof Error ? error.message : ""}`);
        }
        const spec = Object.keys(settings.env).length === 0 ? testAgent : { ...testAgent, env: { ...testAgent.env, ...settings.env } };
        return { ok: true, spec, versions: { agent, tested, found: "0.0.0-test" } };
      }
      const status = await agentAvailability(agent, ports);
      const { availability, version, detail } = status.availability;
      switch (availability) {
        case "missing":
          return failure("agent-missing", `${label} was not found on this computer. Install it, sign in once, then try again.`);
        case "version-problem":
          return failure("agent-version", detail ?? `${label} was found, but its version could not be read (tested with ${tested}).`);
        case "needs-install":
          return failure(
            "install-needed",
            AGENT_DESCRIPTIONS[agent].kind === "fetched"
              ? `${label} has not been downloaded yet.`
              : `The ${label} connector has not been downloaded yet.`,
          );
        case "ready":
          break;
      }
      try {
        const spec = await adapterLaunchSpec(agent, status.cliPath, ports, mode);
        return { ok: true, spec, versions: { agent, tested, ...(version === undefined ? {} : { found: version }) } };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        // Hermes downloads nothing: what can fail here is writing its managed settings layer.
        if (AGENT_DESCRIPTIONS[agent].kind === "installed") {
          return failure("broker-unavailable", `Hallpass could not prepare ${label}'s settings: ${reason}`);
        }
        return failure("install-needed", `The ${label} connector needs to be downloaded again: ${reason}`);
      }
    },
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The handler                                                                                  */
/* ------------------------------------------------------------------------------------------- */

/** What the handler needs of the pool; `ConversationPool` is it, a test may stand in. */
export type ConversationPoolPort = Pick<
  ConversationPool,
  | "start"
  | "send"
  | "stop"
  | "answer"
  | "setMode"
  | "open"
  | "remove"
  | "page"
  | "views"
  | "folderOf"
  | "revokeBrowserTokens"
  | "attach"
  | "cancelAttachment"
  | "agentAccepts"
  | "diagnostics"
  | "latestRun"
>;

export type CommandHandlerOptions = {
  /** The broker's own link session; every frame it sends names it (R-323). */
  sessionId: string;
  /** Sends on the link; `false` when there is none (the worker asks again on reconnect). */
  send: (frame: unknown) => boolean;
  pool: ConversationPoolPort;
  index: ConversationIndex;
  folders: FolderList;
  consent: ConsentStore;
  /** The folder dialog and Explorer (T562, `folders.ts`). */
  folderActions: FolderActions;
  availability: (agent: ConversationAgent) => Promise<ConversationAgentAvailability>;
  /**
   * 024 R-374: the settings page's readiness check (`checkAgentReadiness`, 5 s per command). When
   * given, it is what the overview's agents come from; `availability` stays the launch's own check.
   * A result with `versionTimedOut` is checked once more in the background with `attempt` (the
   * launch bound, and a signal that ends it when a newer check or the shutdown comes first).
   */
  checkAgent?: (agent: ConversationAgent, attempt?: ReadinessAttempt) => Promise<ReadinessResult>;
  /**
   * `installAgent` with the broker's ports (install.ts); `onProgress` hears each phase (T547, G2),
   * `control` carries the cancel signal and the estimates (024 R-376, R-377).
   */
  install: (agent: ConversationAgent, onProgress?: (progress: InstallProgress) => void, control?: InstallControl) => Promise<InstallResult>;
  /**
   * 024 R-375: the files every broker on this computer shares (`shared-agent-state.ts`) - the install
   * state, its lock and the last test. Absent: none are read or written (one broker alone, as before).
   */
  shared?: SharedStateOptions;
  /** 024 R-379: the settings page's Test, outside the pool (`agent-test.ts`). */
  tests?: AgentTestRunnerPort;
  /** 024 R-387: the user's profile folder, said as `%USERPROFILE%` in diagnostics by agent (default: this process's). */
  userProfile?: string;
  /**
   * T563: what the list could not keep (`index-store.ts`), read for every overview. A code only, so
   * neither the broker's text nor the kept file's name reaches the panel.
   */
  listNotice?: () => ConversationListNotice | undefined;
  log?: (code: string, detail?: string) => void;
};

/** 024 R-374: one agent's readiness, and whether its found program's `--version` timed out. */
export type ReadinessResult = { availability: ConversationAgentAvailability; versionTimedOut?: boolean };

export type SharedStateOptions = {
  /** `%LOCALAPPDATA%\hallpass`. */
  dataDir: string;
  /** This broker's browser and process, as its install state and lock name them. */
  browserId: string;
  pid: number;
  /** How often a broker following another's install looks at its lock and state (default 1 s). */
  followIntervalMs?: number;
  isAlive?: (pid: number) => boolean;
};

/** 024 R-379: what the handler needs of the test runner (`agent-test.ts`). */
export type AgentTestRunnerPort = {
  /** Starts the agent's test, or joins the one running; resolves when it is under way (the result goes to `last-test.json`). */
  start(agent: ConversationAgent, onDone: () => void): void;
  running(agent: ConversationAgent): boolean;
  /** R-387: the test's latest run of the agent, for diagnostics by agent. */
  latestRun(agent: ConversationAgent): { serial: number; lines: string[] } | undefined;
};

export type CommandHandler = {
  handle(frame: unknown): Promise<void>;
  /**
   * 024 R-375: stops watching the shared files now (the link to the worker went, or the broker is
   * shutting down). The watch also ends by itself `SHARED_STATE_WATCH_IDLE_MS` after the last
   * check-agents once nothing runs here or in another live broker's download; a check-agents starts it again.
   */
  stopWatching(): void;
  /** 024 R-374: ends the readiness retries running in the background (the broker is shutting down); none is applied after. */
  stopChecks(): void;
  /** Sends a fresh overview soon; several calls in one turn of the event loop send one. */
  scheduleOverview(): void;
  sendOverview(): Promise<void>;
  /** Refreshes the agents' availability (start, after an install, after consent). */
  refreshAgents(): Promise<void>;
  /** A conversation event as a link frame (R-318). */
  eventFrame(payload: ConversationEventPayload): Record<string, unknown>;
};

export function createCommandHandler(options: CommandHandlerOptions): CommandHandler {
  const { sessionId, pool, index, folders } = options;
  /**
   * T567: the consent as the commands see it - every read after the writes already asked for. The
   * frames are handled as they arrive, not one after another (an install runs for minutes), and the
   * first-use Download sends the consent and the install together: the install's read must see the
   * answer whose write (temp + rename) is still under way, not the record from before it.
   */
  let consentWrites: Promise<unknown> = Promise.resolve();
  const consent: ConsentStore = {
    read: () => consentWrites.then(() => options.consent.read()),
    write: (granted, at) => {
      const written = consentWrites.then(() => options.consent.write(granted, at));
      consentWrites = written.catch(() => undefined);
      return written;
    },
  };
  const log = options.log ?? (() => undefined);
  let agents: ConversationAgentAvailability[] = CONVERSATION_AGENTS.map((agent) => ({ agent, availability: "missing" }));
  let agentsKnown = false;
  /** One install per agent at a time; a second request joins the one in flight (S3 follow-up). */
  const installs = new Map<ConversationAgent, Promise<InstallResult>>();
  /** T547 (G2): the phase of each install in flight, which the overview names on its agent. */
  const installPhases = new Map<ConversationAgent, ConversationInstallPhase>();
  let overviewPending = false;
  /** Asked by the pool before a resume starts an agent run (T558 follow-up): granted, or `consent-needed`. */
  const consentGate: ResumeGate = async () => ((await consent.read()) === "granted" ? { ok: true } : needsConsent());

  const isAlive = options.shared?.isAlive ?? isProcessAlive;
  /** 024 R-374: the readiness check when there is one, else the launch's own. */
  const check = (agent: ConversationAgent, attempt?: ReadinessAttempt): Promise<ReadinessResult> =>
    options.checkAgent !== undefined ? options.checkAgent(agent, attempt) : options.availability(agent).then((availability) => ({ availability }));
  /**
   * 024 R-374: each agent's check generation - the newest started, and the one whose result the
   * overview holds. A result older than the one held is dropped, and a background retry counts only
   * while its check is still the newest: no late answer overwrites a newer one.
   */
  const startedChecks = new Map<ConversationAgent, number>();
  const heldChecks = new Map<ConversationAgent, number>();
  /** The background retry of each agent whose found program did not answer `--version` in time. */
  const retries = new Map<ConversationAgent, AbortController>();
  let checksStopped = false;
  /** 024 R-377: the cancel of each install this broker runs itself (not one it follows). */
  const cancels = new Map<ConversationAgent, AbortController>();
  /** 024 R-375: polling the shared files while a settings page asked lately, or something runs here or a live broker's download runs. */
  let watch: SharedStateWatch | undefined;
  /** When the last check-agents came (`Date.now()`). */
  let lastCheckAt = 0;
  /** The shared files as the last overview carried them, so the watch does not send the same again. */
  let sentShared: string | undefined;
  const busyHere = (): boolean => installs.size > 0 || CONVERSATION_AGENTS.some((agent) => options.tests?.running(agent) === true);
  /** The shared files as last read show a download under way whose broker is alive. */
  const runningInstallIn = (snapshot: SharedStateSnapshot | undefined): boolean =>
    snapshot !== undefined &&
    CONVERSATION_AGENTS.some((agent) => {
      const install = snapshot[agent]?.install;
      return install !== undefined && isRunningInstallPhase(install.phase) && isAlive(install.pid);
    });

  /**
   * The agents' state, kept until asked again (024 R-374): every agent, or `only` one of them once
   * all are known. The settings page asks on connect and on Check again; an install's end asks too.
   */
  const refreshAgents = async (only?: ConversationAgent): Promise<void> => {
    const targets = only === undefined || !agentsKnown ? CONVERSATION_AGENTS : [only];
    const generations = targets.map((agent) => {
      const generation = (startedChecks.get(agent) ?? 0) + 1;
      startedChecks.set(agent, generation);
      // An older check's retry is superseded: its program's tree ends, and its answer is not kept.
      retries.get(agent)?.abort();
      retries.delete(agent);
      return generation;
    });
    const fresh = await Promise.all(
      targets.map((agent) => check(agent).catch((): ReadinessResult => ({ availability: { agent, availability: "missing" } }))),
    );
    targets.forEach((agent, at) => {
      const generation = generations[at] ?? 0;
      const result = fresh[at];
      if (result === undefined || generation <= (heldChecks.get(agent) ?? 0)) return;
      // The overview names a timed-out answer, so the page does not read it as "no version number".
      hold(agent, generation, result.versionTimedOut === true ? { ...result.availability, versionTimedOut: true } : result.availability);
      if (result.versionTimedOut === true && generation === startedChecks.get(agent)) retryVersion(agent, generation);
    });
    agentsKnown = true;
  };

  const hold = (agent: ConversationAgent, generation: number, availability: ConversationAgentAvailability): void => {
    heldChecks.set(agent, generation);
    agents = agents.map((entry) => (entry.agent === agent ? availability : entry));
  };

  /**
   * 024 R-374: a found program whose `--version` did not answer within 5 s (a slow `hermes --version`
   * takes 6-11 s, T794) is checked once more, in the background, at the launch bound. The first check's
   * answer - Not installed, with the timed-out reason - is already in the overview; this one replaces it
   * only while its check is still the agent's newest, and only with an answer: timed out again, or still
   * no version, the first answer stands. A newer check or `stopChecks` aborts it, which ends its tree.
   */
  const retryVersion = (agent: ConversationAgent, generation: number): void => {
    if (checksStopped) return;
    const controller = new AbortController();
    retries.set(agent, controller);
    const current = () => !controller.signal.aborted && startedChecks.get(agent) === generation && heldChecks.get(agent) === generation;
    void check(agent, { boundMs: LAUNCH_EXEC_BOUND_MS, signal: controller.signal })
      .then(
        (result) => {
          const next = result.availability;
          if (!current() || result.versionTimedOut === true || (next.availability === "version-problem" && next.version === undefined)) return;
          hold(agent, generation, next);
          scheduleOverview();
        },
        () => log("broker.agent-recheck-failed", agent),
      )
      .finally(() => {
        if (retries.get(agent) === controller) retries.delete(agent);
      });
  };

  const stopChecks = (): void => {
    checksStopped = true;
    for (const controller of retries.values()) controller.abort();
    retries.clear();
  };

  const startWatching = (): void => {
    lastCheckAt = Date.now();
    if (options.shared === undefined || watch?.watching === true) return;
    watch = watchSharedState({
      dataDir: options.shared.dataDir,
      // This broker's own install writes its state and sends an overview of it: the watch reading the same is no news.
      onChange: (snapshot) => {
        if (JSON.stringify(snapshot) !== sentShared) scheduleOverview();
      },
      // A download that runs anywhere - here, or in another browser's broker whose pid lives - keeps the
      // page's picture of it current to its end (FR-396); with nothing running, the watch expires as before.
      keepWatching: (last) => Date.now() - lastCheckAt < SHARED_STATE_WATCH_IDLE_MS || busyHere() || runningInstallIn(last),
    });
    void watch.start().catch(() => log("broker.shared-watch-failed"));
  };

  const sendOverview = async (): Promise<void> => {
    if (!agentsKnown) await refreshAgents();
    // First: reading the list is what finds an unreadable index, so the notice below is current.
    const conversations = (await pool.views()).slice(0, CONVERSATION_MAX_ENTRIES);
    const notice = options.listNotice?.();
    // 024 R-375: what every broker on this computer shares - a download's state (another browser's
    // too, without its pid), the last test's result.
    const facts = options.shared === undefined ? undefined : await readSharedState(options.shared.dataDir).catch(() => undefined);
    if (facts !== undefined) sentShared = JSON.stringify(facts);
    const listed = agents.map((entry) => {
      const phase = installPhases.get(entry.agent);
      // 022 R-344: what the agent said it accepts when it last started here, so the panel can tell before a start.
      const accepts = pool.agentAccepts(entry.agent);
      const file = facts?.[entry.agent];
      const install = file?.install === undefined ? undefined : shownInstallState(file.install, isAlive);
      // Another broker's download in flight shows as this agent downloading here as well.
      const following = phase === undefined && install !== undefined && isRunningInstallPhase(install.phase) ? (install.phase as ConversationInstallPhase) : undefined;
      const installing = phase ?? following;
      return {
        ...entry,
        ...(installing === undefined ? {} : { installing }),
        ...(accepts === undefined ? {} : { accepts }),
        ...(install === undefined ? {} : { install }),
        ...(file?.lastTest === undefined ? {} : { lastTest: file.lastTest }),
        ...(options.tests?.running(entry.agent) === true ? { testing: true } : {}),
      };
    });
    options.send({
      type: "conversation-overview",
      sessionId,
      conversations,
      agents: listed,
      folders: await folders.list(),
      // T547: the consent record, so a worker that restarted shows the owner's answer.
      consent: await consent.read(),
      ...(notice === undefined ? {} : { notice }),
    });
  };

  const scheduleOverview = (): void => {
    if (overviewPending) return;
    overviewPending = true;
    setImmediate(() => {
      overviewPending = false;
      sendOverview().catch(() => log("broker.overview-failed"));
    });
  };

  const reply = (commandId: string, outcome: Outcome): void => {
    options.send(
      outcome.ok
        ? { type: "conversation-result", sessionId, commandId, ok: true, ...(outcome.value === undefined ? {} : { value: outcome.value }) }
        : { type: "conversation-result", sessionId, commandId, ok: false, error: outcome.error },
    );
  };

  /**
   * R-318: a conversation's log from `fromSeq` (the whole of it for `open`; from the seq the worker
   * names for its page request, T547 G4), page after page, each under the contract's bounds.
   */
  const sendPages = (conversationId: string, from = 0): void => {
    let fromSeq = from;
    for (;;) {
      const page = pool.page(conversationId, fromSeq);
      if (!page.ok) return;
      options.send({ type: "conversation-page", sessionId, conversationId, ...page.value });
      const last = page.value.events.at(-1);
      if (!page.value.more || last === undefined) return;
      fromSeq = last.seq + 1;
    }
  };

  /**
   * 024 R-375 / R-376: `install-state.json` of this broker's own download - Preparing (no percent)
   * until the first package folder, then the estimate each count, then how it ended - written whole,
   * one write after another, each followed by an overview.
   */
  const installStateWriter = (agent: ConversationAgent, shared: SharedStateOptions) => {
    const startedAt = new Date().toISOString();
    let phase: ConversationInstallPhase = "preparing";
    let estimate: Pick<InstallEstimate, "percent" | "etaSeconds"> = { percent: null, etaSeconds: null };
    let chain: Promise<void> = Promise.resolve();
    const owner = { startedAt, browserId: shared.browserId, pid: shared.pid };
    const write = (state: AgentInstallState): Promise<void> => {
      chain = chain
        .then(() => writeInstallState(shared.dataDir, agent, state))
        .then(scheduleOverview, () => log("broker.install-state-failed", agent));
      return chain;
    };
    const writeRunning = () =>
      void write({
        ...owner,
        phase: phase === "downloading" && estimate.percent === null ? "preparing" : phase,
        percent: estimate.percent,
        etaSeconds: phase === "downloading" ? estimate.etaSeconds : null,
      });
    writeRunning();
    return {
      phase(next: ConversationInstallPhase): void {
        if (next === phase) return;
        phase = next;
        writeRunning();
      },
      estimate(next: InstallEstimate): void {
        estimate = { percent: next.percent, etaSeconds: next.etaSeconds };
        writeRunning();
      },
      end(result: InstallResult, cancelled: boolean): Promise<void> {
        const endedAt = new Date().toISOString();
        if (result.ok) return write({ ...owner, phase: "done", percent: 100, etaSeconds: null, endedAt });
        return write({
          ...owner,
          phase: cancelled ? "cancelled" : "failed",
          percent: estimate.percent,
          etaSeconds: null,
          endedAt,
          ...(cancelled ? {} : { error: result.error.detail.slice(0, DETAIL_MAX) }),
        });
      },
    };
  };

  /** This broker's own `npm ci` of the agent, cancellable (R-377), its state in the shared file (R-375). */
  const runInstall = async (agent: ConversationAgent, controller: AbortController): Promise<InstallResult> => {
    const state = options.shared === undefined ? undefined : installStateWriter(agent, options.shared);
    let result: InstallResult;
    try {
      result = await options.install(
        agent,
        ({ phase }) => {
          state?.phase(phase);
          // T547 (G2): every phase change is an overview, so the panel shows the phase it is told.
          if (installPhases.get(agent) === phase) return;
          installPhases.set(agent, phase);
          scheduleOverview();
        },
        { signal: controller.signal, ...(state === undefined ? {} : { onEstimate: (estimate) => state.estimate(estimate) }) },
      );
    } catch (error) {
      result = failure("install-failed", `The install failed: ${error instanceof Error ? error.message : ""}`);
    }
    const cancelled = controller.signal.aborted && !result.ok;
    if (cancelled) result = failure("install-failed", INSTALL_CANCELLED_DETAIL);
    await state?.end(result, cancelled);
    return result;
  };

  /**
   * 024 R-375: another live broker holds this agent's install lock - its download is the one: no
   * second `npm ci`. Its progress reaches this broker's overview from the shared file; the answer
   * is how that download ended once its lock is gone (a holder that died reads as interrupted).
   */
  const follow = async (agent: ConversationAgent, shared: SharedStateOptions): Promise<InstallResult> => {
    log("broker.install-following", agent);
    const interval = shared.followIntervalMs ?? SHARED_STATE_POLL_MS;
    scheduleOverview();
    while ((await liveInstallLockHolder(shared.dataDir, agent, isAlive)) !== undefined) {
      await delay(interval);
      scheduleOverview();
    }
    const state = await readInstallState(shared.dataDir, agent);
    if (state?.phase === "done") return { ok: true, directory: join(shared.dataDir, "agents", agent) };
    const shown = state === undefined ? undefined : shownInstallState(state, isAlive);
    return failure(
      "install-failed",
      shown?.phase === "cancelled"
        ? "The download was cancelled in another browser."
        : (shown?.error ?? "The download in another browser did not finish."),
    );
  };

  const install = (agent: ConversationAgent): Promise<InstallResult> => {
    const running = installs.get(agent);
    if (running !== undefined) return running;
    // Registered at once, so a cancel that comes while the lock is being taken still reaches it.
    const controller = new AbortController();
    cancels.set(agent, controller);
    const started = (async (): Promise<InstallResult> => {
      const shared = options.shared;
      if (shared === undefined) return runInstall(agent, controller);
      const self: InstallLockHolder = { pid: shared.pid, browserId: shared.browserId };
      const lock = await acquireInstallLock(shared.dataDir, agent, self, isAlive);
      if (!lock.acquired) {
        // Not this broker's to cancel: the other browser's page has the Cancel of it.
        cancels.delete(agent);
        return follow(agent, shared);
      }
      try {
        return await runInstall(agent, controller);
      } finally {
        // After the final state is written: a follower that sees the lock gone reads how it ended.
        await lock.release();
      }
    })().finally(() => {
      cancels.delete(agent);
      installs.delete(agent);
      installPhases.delete(agent);
    });
    installs.set(agent, started);
    return started;
  };

  const run = async (command: ConversationLinkCommand): Promise<{ outcome: Outcome; after?: () => void }> => {
    switch (command.type) {
      case "worker.conversation.page": {
        // T547 (G4): the worker's own request, after a panel reconnected or a gap in the seqs.
        const { conversationId, fromSeq } = command.payload;
        if ((await index.get(conversationId)) === undefined) {
          return { outcome: failure("not-found", "This conversation is not in the list any more.") };
        }
        return { outcome: { ok: true }, after: () => sendPages(conversationId, fromSeq) };
      }
      case "ui.conversation.consent": {
        // T558: withdrawn, every live run loses browser access now - even when the answer cannot be
        // saved - and a later grant does not give it back; only a new agent run is minted a token.
        // The conversations themselves stay.
        if (!command.payload.granted) pool.revokeBrowserTokens();
        try {
          await consent.write(command.payload.granted, new Date().toISOString());
        } catch {
          return { outcome: failure("broker-unavailable", "Hallpass could not save your answer.") };
        }
        return { outcome: { ok: true }, after: scheduleOverview };
      }
      case "ui.conversation.install": {
        const { agent } = command.payload;
        // A second click while this agent's download runs joins it before any read: the first request
        // already checked consent and availability, and reads first would let it start another.
        const inFlight = installs.get(agent);
        if (inFlight !== undefined) {
          const joined = await inFlight;
          return { outcome: joined.ok ? { ok: true } : { ok: false, error: joined.error } };
        }
        if ((await consent.read()) !== "granted") return { outcome: needsConsent() };
        const availability = await options.availability(agent);
        if (availability.availability === "missing") {
          return { outcome: failure("agent-missing", `${AGENT_ADAPTERS[agent].label} was not found on this computer; install it first.`) };
        }
        const result = await install(agent);
        await refreshAgents();
        return { outcome: result.ok ? { ok: true } : { ok: false, error: result.error }, after: scheduleOverview };
      }
      case "ui.conversation.start": {
        if ((await consent.read()) !== "granted") return { outcome: needsConsent() };
        // T572: asked again by the pool after discovery, right before the agent is launched.
        // 021 FR-361: the mode chosen before the first message goes with the start (D-021-16: for good).
        const started = await pool.start(command.payload.agent, command.payload.folder, consentGate, command.payload.mode);
        if (!started.ok && (started.error.code === "agent-missing" || started.error.code === "agent-version" || started.error.code === "install-needed")) {
          await refreshAgents();
        }
        return { outcome: started, after: scheduleOverview };
      }
      case "ui.conversation.send":
        // FR-306 (T552): the tab the owner was viewing goes with the run's token as the turn's start tab.
        // A stopped conversation's agent starts again only with the consent, as a start does (FR-299).
        // 022: with the attachments the panel staged first (`ui.conversation.attach`), if any.
        return {
          outcome: await pool.send(
            command.payload.conversationId,
            command.payload.text,
            command.payload.activeTabId,
            consentGate,
            command.payload.attachments,
          ),
        };
      case "ui.conversation.attach": {
        // 022 R-337: one piece; its result is the panel's go-ahead for the next.
        const { conversationId, ...piece } = command.payload;
        return { outcome: await pool.attach(conversationId, piece) };
      }
      case "ui.conversation.attach-cancel":
        return { outcome: await pool.cancelAttachment(command.payload.conversationId, command.payload.attachmentId) };
      case "ui.conversation.stop":
        return { outcome: await pool.stop(command.payload.conversationId) };
      case "ui.conversation.answer":
        return { outcome: await pool.answer(command.payload.conversationId, command.payload.requestId, command.payload.answer) };
      case "ui.conversation.set-mode":
        // 021 R-351: a launch-time mode change starts a new agent run, so it needs the consent as a start does.
        return { outcome: await pool.setMode(command.payload.conversationId, command.payload.mode, consentGate) };
      case "ui.conversation.open": {
        const { conversationId } = command.payload;
        const opened = await pool.open(conversationId, consentGate);
        return { outcome: opened, ...(opened.ok ? { after: () => sendPages(conversationId) } : {}) };
      }
      case "ui.conversation.remove":
        return { outcome: await pool.remove(command.payload.conversationId), after: scheduleOverview };
      case "ui.conversation.diagnostics": {
        const { payload } = command;
        if ("conversationId" in payload) {
          // 023 R-367 (FR-372): the latest run's scrubbed lines, after the result; none for an unknown or removed one.
          const { conversationId } = payload;
          const lines = pool.diagnostics(conversationId);
          return { outcome: { ok: true }, after: () => options.send({ type: "conversation-diagnostics", sessionId, conversationId, lines }) };
        }
        // 024 R-387 (FR-387): the agent's most recent run in this broker, a conversation's or a test's,
        // read now; the user's profile folder is not said. None for an agent that has not run here.
        const { agent } = payload;
        const conversationRun = pool.latestRun(agent);
        const testRun = options.tests?.latestRun(agent);
        const latest =
          testRun !== undefined && (conversationRun === undefined || testRun.serial > conversationRun.serial)
            ? { lines: testRun.lines }
            : conversationRun;
        const frame = {
          type: "conversation-diagnostics",
          sessionId,
          agent,
          readAt: new Date().toISOString(),
          ...(latest !== undefined && "conversationId" in latest ? { conversationId: latest.conversationId } : {}),
          lines: (latest?.lines ?? []).map((line) => withoutUserProfile(line, options.userProfile ?? process.env.USERPROFILE)),
        };
        return { outcome: { ok: true }, after: () => options.send(frame) };
      }
      case "ui.conversation.check-agents": {
        // 024 R-374: the page asks on connect and on Check again; the shared files are watched from now
        // until SHARED_STATE_WATCH_IDLE_MS passes with no check-agents and nothing running here (R-375).
        startWatching();
        await refreshAgents(command.payload.agent);
        return { outcome: { ok: true }, after: scheduleOverview };
      }
      case "ui.conversation.install-cancel": {
        // 024 R-377: this broker's own download ends - npm's tree, its folder and the lock gone - before the answer.
        // Nothing running here (none, or another browser's): ok, nothing changes.
        const controller = cancels.get(command.payload.agent);
        if (controller === undefined) return { outcome: { ok: true } };
        controller.abort();
        await installs.get(command.payload.agent)?.catch(() => undefined);
        return { outcome: { ok: true }, after: scheduleOverview };
      }
      case "ui.conversation.test": {
        // 024 R-379: an agent process starts, so the consent applies as to a start (FR-299). The answer
        // comes at once; the result reaches the page in the overview (`testing`, then `lastTest`).
        if (options.tests === undefined) return { outcome: failure("broker-unavailable", "Hallpass cannot test agents here.") };
        if ((await consent.read()) !== "granted") return { outcome: needsConsent() };
        options.tests.start(command.payload.agent, scheduleOverview);
        return { outcome: { ok: true }, after: scheduleOverview };
      }
      case "ui.conversation.add-folder": {
        // T562 (R-320): the Windows folder dialog; the chosen folder reaches the panel in the overview.
        // T563: a typed path (the panel's answer to `path-entry`) is checked exactly as a chosen one.
        const { path } = command.payload;
        const added = path === undefined ? await options.folderActions.addFromDialog() : await options.folderActions.addTyped(path);
        switch (added.kind) {
          case "added":
            return { outcome: { ok: true }, after: scheduleOverview };
          case "cancelled":
            return { outcome: { ok: true } };
          case "path-entry":
            // The dialog cannot open on this desktop: the panel offers a typed path instead.
            return { outcome: failure("path-entry", added.detail) };
          case "failed":
            return { outcome: { ok: false, error: added.error } };
        }
      }
      case "ui.conversation.remove-folder": {
        if (!(await folders.remove(command.payload.path))) {
          return { outcome: failure("folder-missing", "That folder is not in your folder list.") };
        }
        return { outcome: { ok: true }, after: scheduleOverview };
      }
      case "ui.conversation.open-folder": {
        const entry = await index.get(command.payload.conversationId);
        if (entry === undefined) return { outcome: failure("not-found", "This conversation is not in the list any more.") };
        // T562 (FR-303): Explorer on the folder; `folder-missing` when it is gone.
        return { outcome: await options.folderActions.open(pool.folderOf(entry)) };
      }
    }
  };

  return {
    async handle(frame) {
      const parsed = conversationCommandFrameSchema.safeParse(frame);
      if (!parsed.success) {
        // Codes only: the frame may carry the owner's words (contracts README §2).
        log("broker.command-invalid", parsed.error.issues[0]?.path.join(".") ?? "");
        // T618: a sender that gave a commandId waits for its answer (the panel's next attachment
        // piece does), so it gets a refusal rather than silence.
        const commandId = readableCommandId(frame);
        if (commandId !== undefined) reply(commandId, invalidCommand(frame, parsed.error.issues));
        return;
      }
      const { commandId, command } = parsed.data;
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(command);
      } catch (error) {
        log("broker.command-failed", `${command.type} ${error instanceof Error ? error.name : "unknown"}`);
        result = { outcome: failure("broker-unavailable", "Hallpass could not carry this out.") };
      }
      reply(commandId, result.outcome);
      result.after?.();
    },
    stopWatching: () => watch?.stop(),
    stopChecks,
    scheduleOverview,
    sendOverview,
    refreshAgents: () => refreshAgents(),
    eventFrame: (payload) => ({ type: "conversation-event", sessionId, ...payload }),
  };
}

/** T618: the commandId of a frame that failed validation, when it is one a result can carry. */
function readableCommandId(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== "object") return undefined;
  const { type, commandId } = frame as { type?: unknown; commandId?: unknown };
  if (type !== "conversation-command" || typeof commandId !== "string") return undefined;
  return commandId.length >= 1 && commandId.length <= 128 ? commandId : undefined;
}

/**
 * T618: the refusal of a command that did not validate. An attachment piece is refused in the
 * attachment words the panel already shows - `attachment-too-large` when a bound was exceeded (its
 * data, name or thumbnail), else `attachment-type` (not a piece Hallpass takes). Any other command
 * gets `invalid-command`: a retry of the same frame cannot succeed (unlike `busy`), so the owner is
 * told to reload the side panel.
 */
function invalidCommand(frame: unknown, issues: readonly { code: string }[]): { ok: false; error: ConversationError } {
  const command = (frame as { command?: unknown }).command;
  const type = command !== null && typeof command === "object" ? (command as { type?: unknown }).type : undefined;
  if (type === "ui.conversation.attach" || type === "ui.conversation.attach-cancel") {
    return issues.some((issue) => issue.code === "too_big")
      ? failure("attachment-too-large", "Hallpass could not take this piece of the attachment: it is larger than a piece can be.")
      : failure("attachment-type", "Hallpass could not take this piece of the attachment; add it again.");
  }
  return failure("invalid-command", "Hallpass could not read this command; reload the side panel.");
}

const needsConsent = () =>
  failure("consent-needed", "Hallpass needs your one-time consent before it starts an agent or downloads its connector.");
