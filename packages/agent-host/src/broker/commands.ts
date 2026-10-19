import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  agentBrowserIdSchema,
  CONVERSATION_AGENTS,
  CONVERSATION_MAX_ENTRIES,
  conversationCommandFrameSchema,
  type ConversationAgent,
  type ConversationAgentAvailability,
  type ConversationError,
  type ConversationInstallPhase,
  type ConversationLinkCommand,
  type ConversationEventPayload,
} from "@hallpass/contracts";
import type { ConversationListNotice } from "./index-store.js";
import { writeHostFileAtomically } from "../bridge-link.js";
import { isWindowsDeviceName } from "../host-paths.js";
import {
  AGENT_ADAPTERS,
  TESTED_AGENT_VERSIONS,
  adapterLaunchSpec,
  agentAvailability,
  type AdapterLaunchSpec,
  type AgentPorts,
} from "./agents.js";
import type { ConversationIndex, FolderList } from "./conversation-index.js";
import type { CommandOutcome, ConversationPool, LaunchResolution, ResumeGate } from "./conversation.js";
import type { FolderActions } from "./folders.js";
import type { InstallProgress, InstallResult } from "./install.js";
import { redact } from "./redact.js";

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
  resolveLaunch: (agent: ConversationAgent) => Promise<LaunchResolution>;
  availability: (agent: ConversationAgent) => Promise<ConversationAgentAvailability>;
};

/**
 * Discovery (R-315) turned into a launch: the installed adapter with the owner's CLI, or the reason
 * there is none - `agent-missing`, `agent-version` (a CLI whose `--version` says nothing usable),
 * `install-needed`. `testAgent` replaces discovery with one fixed command; the broker passes it only
 * under `HALLPASS_TEST_MODE=1` (`broker.ts`).
 */
export function createAgentLauncher(options: { ports: AgentPorts; testAgent?: AdapterLaunchSpec }): AgentLauncher {
  const { ports, testAgent } = options;
  return {
    async availability(agent) {
      if (testAgent !== undefined) return { agent, availability: "ready", version: "0.0.0-test" };
      return (await agentAvailability(agent, ports)).availability;
    },
    async resolveLaunch(agent) {
      const label = AGENT_ADAPTERS[agent].label;
      const tested = TESTED_AGENT_VERSIONS[agent];
      if (testAgent !== undefined) {
        return { ok: true, spec: testAgent, versions: { agent, tested, found: "0.0.0-test" } };
      }
      const status = await agentAvailability(agent, ports);
      const { availability, version, detail } = status.availability;
      switch (availability) {
        case "missing":
          return failure("agent-missing", `${label} was not found on this computer. Install it, sign in once, then try again.`);
        case "version-problem":
          return failure("agent-version", detail ?? `${label} was found, but its version could not be read (tested with ${tested}).`);
        case "needs-install":
          return failure("install-needed", `The ${label} connector has not been downloaded yet.`);
        case "ready":
          break;
      }
      try {
        const spec = await adapterLaunchSpec(agent, status.cliPath!, ports);
        return { ok: true, spec, versions: { agent, tested, ...(version === undefined ? {} : { found: version }) } };
      } catch (error) {
        return failure("install-needed", `The ${label} connector needs to be downloaded again: ${error instanceof Error ? error.message : ""}`);
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
  "start" | "send" | "stop" | "answer" | "setMode" | "open" | "remove" | "page" | "views" | "folderOf" | "revokeBrowserTokens"
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
  /** `installAgent` with the broker's ports (install.ts); `onProgress` hears each phase (T547, G2). */
  install: (agent: ConversationAgent, onProgress?: (progress: InstallProgress) => void) => Promise<InstallResult>;
  /**
   * T563: what the list could not keep (`index-store.ts`), read for every overview. A code only, so
   * neither the broker's text nor the kept file's name reaches the panel.
   */
  listNotice?: () => ConversationListNotice | undefined;
  log?: (code: string, detail?: string) => void;
};

export type CommandHandler = {
  handle(frame: unknown): Promise<void>;
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

  const refreshAgents = async (): Promise<void> => {
    agents = await Promise.all(
      CONVERSATION_AGENTS.map((agent) =>
        options.availability(agent).catch((): ConversationAgentAvailability => ({ agent, availability: "missing" })),
      ),
    );
    agentsKnown = true;
  };

  const sendOverview = async (): Promise<void> => {
    if (!agentsKnown) await refreshAgents();
    // First: reading the list is what finds an unreadable index, so the notice below is current.
    const conversations = (await pool.views()).slice(0, CONVERSATION_MAX_ENTRIES);
    const notice = options.listNotice?.();
    const listed = agents.map((entry) => {
      const phase = installPhases.get(entry.agent);
      return phase === undefined ? entry : { ...entry, installing: phase };
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

  const install = (agent: ConversationAgent): Promise<InstallResult> => {
    const running = installs.get(agent);
    if (running !== undefined) return running;
    const started = options
      .install(agent, ({ phase }) => {
        // T547 (G2): every phase change is an overview, so the panel shows the phase it is told.
        if (installPhases.get(agent) === phase) return;
        installPhases.set(agent, phase);
        scheduleOverview();
      })
      .finally(() => {
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
        const started = await pool.start(command.payload.agent, command.payload.folder, consentGate);
        if (!started.ok && (started.error.code === "agent-missing" || started.error.code === "agent-version" || started.error.code === "install-needed")) {
          await refreshAgents();
        }
        return { outcome: started, after: scheduleOverview };
      }
      case "ui.conversation.send":
        // FR-306 (T552): the tab the owner was viewing goes with the run's token as the turn's start tab.
        // A stopped conversation's agent starts again only with the consent, as a start does (FR-299).
        return {
          outcome: await pool.send(command.payload.conversationId, command.payload.text, command.payload.activeTabId, consentGate),
        };
      case "ui.conversation.stop":
        return { outcome: await pool.stop(command.payload.conversationId) };
      case "ui.conversation.answer":
        return { outcome: await pool.answer(command.payload.conversationId, command.payload.requestId, command.payload.answer) };
      case "ui.conversation.set-mode":
        return { outcome: await pool.setMode(command.payload.conversationId, command.payload.mode) };
      case "ui.conversation.open": {
        const { conversationId } = command.payload;
        const opened = await pool.open(conversationId, consentGate);
        return { outcome: opened, ...(opened.ok ? { after: () => sendPages(conversationId) } : {}) };
      }
      case "ui.conversation.remove":
        return { outcome: await pool.remove(command.payload.conversationId), after: scheduleOverview };
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
    scheduleOverview,
    sendOverview,
    refreshAgents,
    eventFrame: (payload) => ({ type: "conversation-event", sessionId, ...payload }),
  };
}

const needsConsent = () =>
  failure("consent-needed", "Hallpass needs your one-time consent before it starts an agent or downloads its connector.");
