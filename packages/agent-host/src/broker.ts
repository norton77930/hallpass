import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_LINK_PROTOCOL, agentBrowserIdSchema, agentLinkFrameSchema } from "@hallpass/contracts";
import { dialRelay, isProcessAlive, type BridgeRecord, type RelayDial } from "./bridge-link.js";
import { browserRecordPath, inspectBrowserRecord } from "./browser-record.js";
import { removeOwnBrokerSidecar, removeOwnBrokerSidecarSync } from "./broker-launch.js";
import { defaultAgentPorts } from "./broker/agents.js";
import { watchBrowserProcess } from "./broker/browser-process.js";
import { createBrowserAccess } from "./broker/browser-token.js";
import { codexConfigPath } from "./broker/codex-config.js";
import { createAgentLauncher, createCommandHandler, fileConsentStore, type CommandHandler } from "./broker/commands.js";
import { createFolderActions, fileFolderList, folderListPath } from "./broker/folders.js";
import { conversationIndexPath, fileConversationIndex } from "./broker/index-store.js";
import { ConversationPool, spawnAgentProcess } from "./broker/conversation.js";
import { cleanStaging, installAgent, shippedManifestsDirectory } from "./broker/install.js";
import { createKillOnCloseJob } from "./broker/job.js";
import { createBrokerLifetime } from "./broker/lifetime.js";
import { redact } from "./broker/redact.js";
import { runCommand } from "./broker/run-command.js";
import { readBrokerTestOverrides } from "./broker/test-mode.js";
import { hostDataDirectory, isWindowsDeviceName } from "./host-paths.js";

/**
 * The conversation broker (019 R-312, R-313, T526): one per browser run, started by that browser's
 * relay (`broker-launch.ts`), reached over the same loopback link every MCP server dials.
 *
 * Its order of business is fixed. First the kill-on-close job (R-313) - before anything is spawned,
 * so nothing it starts can outlive it; a broker that cannot have the job exits instead of running
 * agents unprotected. Then the secret, read from stdin as one line: the only proof it is the
 * process its relay started (it never appears in a log, an argument or the environment). Then the
 * link, greeting with `role: "broker"` and that secret.
 *
 * Lifetime (R-312, T575): the broker belongs to the browser run, not to a relay. At start it finds the
 * browser's main process above its relay and watches it (`broker/browser-process.ts`, R-330): the
 * browser gone ends the run at once. On `relay-gone`, on the link closing, or on its stdin closing
 * (the spawning relay is gone), it redials every second for up to 35 s while the browser is alive -
 * 15 s when the browser is not known (`broker/lifetime.ts`) - and only a relay whose record carries
 * the same `browserRunId` will do. A record of another run that is live means the browser
 * restarted: this run is over. Any way out, it removes its own sidecar, stops its agents within
 * 3 s, and exits; the job ends whatever is left.
 *
 * Conversations (S4, T539/T540): `conversation-command` frames from the worker go to the command
 * handler (`broker/commands.ts`), which drives the pool of agent processes (`broker/conversation.ts`);
 * events, results, overviews and pages go back on the same link. The agent a conversation starts is
 * the installed adapter found by discovery (R-315), except under `HALLPASS_TEST_MODE=1`, where
 * `HALLPASS_BROKER_TEST_AGENT` (a JSON argv) replaces every adapter launch - so the relay-process
 * tests can put a real tree under the job without an installed agent - and
 * `HALLPASS_BROKER_TEST_IDLE_MS` shortens the idle limit for the packaged gate (`broker/test-mode.ts`).
 */

const logPath = join(hostDataDirectory(), "broker.log");
const ROTATED_LOG_PATH = `${logPath}.1`;
/** As `relay.log` (004 B107): checked at start, rotated once rather than truncated. */
const LOG_SIZE_CAP_BYTES = 5 * 1024 * 1024;

/** How often the broker looks for a relay of its own run inside its window (`broker/lifetime.ts`). */
const REDIAL_MS = 1_000;
/** Graceful stop of the agents before the exit (R-313's first layer); the job is the backstop. */
const SHUTDOWN_BOUND_MS = 3_000;
/** A broker whose relay never hands it a secret has nothing to prove itself with. */
const SECRET_READ_BOUND_MS = 10_000;

/**
 * Codes and pids only - never the secret, never anything an agent said (contracts README §2). The
 * detail still passes the one redactor (R-326) so a later caller cannot put a credential here.
 */
function log(code: string, detail?: string): void {
  const line = `${new Date().toISOString()} ${code}${detail === undefined ? "" : ` ${redact(detail)}`}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // A log that cannot be written must not take the broker down with it.
  }
}

function startLog(): void {
  try {
    mkdirSync(hostDataDirectory(), { recursive: true });
    if (statSync(logPath).size > LOG_SIZE_CAP_BYTES) renameSync(logPath, ROTATED_LOG_PATH);
  } catch {
    // No file yet, or it cannot be rotated: the first append creates it.
  }
}

/** The first line on stdin, or `undefined` if the stream ends or the bound passes first. */
function readSecretLine(boundMs: number): Promise<string | undefined> {
  return new Promise((resolveLine) => {
    let buffered = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      buffered = "";
      resolveLine(value);
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(buffered.slice(0, newline).replace(/\r$/u, ""));
    };
    const onEnd = (): void => finish(undefined);
    const timer = setTimeout(() => finish(undefined), boundMs);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

function readArguments(): { browserId: string; browserRunId: string } | undefined {
  try {
    const { values } = parseArgs({
      options: { "browser-id": { type: "string" }, "browser-run-id": { type: "string" } },
      strict: true,
    });
    const browserId = values["browser-id"];
    const browserRunId = values["browser-run-id"];
    if (browserId === undefined || browserRunId === undefined) return undefined;
    if (!agentBrowserIdSchema.safeParse(browserId).success || isWindowsDeviceName(browserId)) return undefined;
    if (browserRunId.length < 1 || browserRunId.length > 64) return undefined;
    return { browserId, browserRunId };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  startLog();
  log("broker.started", String(process.pid));
  const identity = readArguments();
  process.on("uncaughtException", (error) => {
    log("broker.crashed", error.name);
    // T529 F1: synchronously, so no relay of this run adopts the ghost this process is about to be.
    if (identity !== undefined) removeOwnBrokerSidecarSync(identity.browserId, process.pid);
    process.exit(1);
  });

  if (identity === undefined) {
    log("broker.arguments-invalid");
    process.exit(2);
  }
  const { browserId, browserRunId } = identity;

  // R-313: the job before anything is spawned. Without it, nothing runs.
  try {
    createKillOnCloseJob();
    log("broker.job-ready");
  } catch (error) {
    log("broker.job-failed", error instanceof Error ? error.message : "unknown");
    process.exit(2);
  }

  // T575: found while the spawning relay is still there to be the first link of the chain.
  const browser = watchBrowserProcess();
  log("broker.browser", browser === undefined ? "unknown" : String(browser.pid));

  const secret = await readSecretLine(SECRET_READ_BOUND_MS);
  if (secret === undefined || secret.length < 43 || secret.length > 128) {
    log("broker.secret-missing");
    process.exit(2);
  }

  const dataDir = hostDataDirectory();
  // S3 follow-up: what an install interrupted by a crash left in `agents\<agent>\.install-*` (R-362;
  // never a tree an install pointer names) and 0.15.0's `.staging-*`.
  const staged = await cleanStaging(dataDir).catch(() => []);
  if (staged.length > 0) log("broker.staging-cleaned", String(staged.length));

  let dial: RelayDial | undefined;
  const sessionId = `broker-${randomBytes(12).toString("hex")}`;
  const send = (frame: unknown): boolean => dial?.send(frame) ?? false;

  // T560 / T562 (R-319): `conversations.json` and `folders.json`, shared with other browsers' brokers.
  const index = fileConversationIndex({
    path: conversationIndexPath(dataDir),
    log,
    // T563: the store logged it and keeps the code; the panel hears it in the next overview.
    onNotice: () => handler?.scheduleOverview(),
  });
  const folders = fileFolderList({ path: folderListPath(dataDir), log });
  const folderActions = createFolderActions({ folders, log });
  // SC-135: the Codex app-server shim, beside this file in both layouts (`dist/` and the flat `host/`).
  const ports = defaultAgentPorts(fileURLToPath(new URL("./codex-app-server-shim.js", import.meta.url)));
  const testMode = readBrokerTestOverrides(process.env);
  for (const code of testMode.codes) log(code);
  const testAgent = testMode.agent;
  const launcher = createAgentLauncher({ ports, ...(testAgent === undefined ? {} : { testAgent }) });
  let handler: CommandHandler | undefined;
  const ownerCodexConfig = codexConfigPath(process.env);
  const pool = new ConversationPool({
    dataDir,
    browserRunId,
    brokerPid: process.pid,
    index,
    folders,
    resolveLaunch: launcher.resolveLaunch,
    onEvent: (payload) => {
      if (handler !== undefined) send(handler.eventFrame(payload));
    },
    onChange: () => handler?.scheduleOverview(),
    spawnAgent: (spec, cwd) => {
      const child = spawnAgentProcess(spec, cwd);
      log("broker.agent-started", `broker=${process.pid} pid=${child.pid ?? "none"}`);
      return child;
    },
    // T552 (R-321, R-322): each agent run's token, and Hallpass's own mcp-server - beside this file in
    // both layouts (`dist/` and the package's flat `host/`) - run by this broker's node.
    browser: createBrowserAccess({
      sessionId,
      browserId,
      launch: { command: process.execPath, args: [fileURLToPath(new URL("./mcp-server.js", import.meta.url))] },
      send,
      // T566 (R-322): read-only, for whether the owner's own Codex `hallpass` can be merged over.
      ...(ownerCodexConfig === undefined ? {} : { codexConfigPath: ownerCodexConfig }),
    }),
    log,
    ...(testMode.idleMs === undefined ? {} : { idleMs: testMode.idleMs }),
  });
  handler = createCommandHandler({
    sessionId,
    send,
    pool,
    index,
    folders,
    consent: fileConsentStore(dataDir, browserId),
    folderActions,
    availability: launcher.availability,
    install: (agent, onProgress) =>
      installAgent(
        agent,
        {
          dataDir,
          // The shipped pinned manifests (`agents/<agent>`): beside this file in the package's flat
          // `host/`, beside its folder in the dev `dist/` (S9 packaging, coverage F5).
          manifestsDir: shippedManifestsDirectory(fileURLToPath(new URL(".", import.meta.url))),
          nodePath: process.execPath,
          run: runCommand,
        },
        // T547 (G2): each phase reaches the panel as an overview.
        onProgress,
      ),
    listNotice: index.notice,
    log,
  });

  let shuttingDown = false;
  let attachedRelayPid: number | undefined;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifetime.stop();
    log("broker.shutdown", reason);
    // First, so no relay adopts a broker that is on its way out; only while it is still this one's.
    await removeOwnBrokerSidecar(browserId, process.pid).catch(() => log("broker.sidecar-remove-failed"));
    await dial?.stop().catch(() => undefined);
    // The agents end with their input (R-313's first layer), within the bound; the job is the rest.
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pool.shutdown().catch(() => undefined),
      new Promise<void>((done) => (bound = setTimeout(done, SHUTDOWN_BOUND_MS + 500))),
    ]);
    if (bound !== undefined) clearTimeout(bound);
    log("broker.exit");
    process.exit(0);
  };

  /** The browser watch, and the relay window that opens once per absence (`broker/lifetime.ts`). */
  const lifetime = createBrokerLifetime({
    ...(browser === undefined ? {} : { browserGone: browser.isGone }),
    end: (reason) => void shutdown(reason),
    log,
  });
  const openWindow = (reason: string): void => {
    if (!shuttingDown) lifetime.openWindow(reason);
  };
  const closeWindow = (): void => lifetime.closeWindow();

  /**
   * This browser's record, only while it is this run's (R-312). A live relay of another run in it
   * means the browser restarted and has its own broker now (the relay spawned one): this run is over.
   */
  const target = async (): Promise<BridgeRecord | undefined> => {
    if (shuttingDown) return undefined;
    const reading = await inspectBrowserRecord(browserRecordPath(browserId));
    if (reading.status !== "ok") return undefined;
    const { record } = reading;
    if (record.browserRunId !== browserRunId) {
      if (isProcessAlive(record.relayPid)) void shutdown("other-run");
      return undefined;
    }
    return {
      port: record.port,
      token: record.token,
      relayPid: record.relayPid,
      startedAt: record.startedAt,
      protocol: AGENT_LINK_PROTOCOL,
    };
  };

  dial = dialRelay({
    hello: {
      sessionId,
      agentId: "hallpass-broker",
      displayName: "Hallpass conversations",
      role: "broker",
      brokerSecret: secret,
    },
    target,
    retryMs: REDIAL_MS,
    detachRetryMs: REDIAL_MS,
    onAttached(relayPid) {
      attachedRelayPid = relayPid;
      closeWindow();
      log("broker.attached", String(relayPid));
      // T552 (R-321): the worker revoked every token when this link went or its relay started;
      // the running agents' servers still hold theirs, so each live run's token is handed again.
      pool.regrantBrowserTokens();
      // A worker behind a new relay knows nothing yet: the list goes first (T540).
      void handler?.refreshAgents().then(() => handler?.sendOverview()).catch(() => log("broker.overview-failed"));
    },
    onDetached() {
      attachedRelayPid = undefined;
      openWindow("link-closed");
    },
    onFrame(value) {
      const frame = agentLinkFrameSchema.safeParse(value);
      if (frame.success && frame.data.type === "relay-gone") {
        log("broker.relay-gone");
        openWindow("relay-gone");
      }
      // 023 R-365: the worker accepted a conversation's `hallpass` server greeting - that run took the tools.
      if (!shuttingDown && frame.success && frame.data.type === "conversation-browser-attached" && frame.data.sessionId === sessionId) {
        pool.browserAttached(frame.data.conversationId);
      }
      // T540: the handler checks the command frame against the contract itself.
      if (
        !shuttingDown &&
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "conversation-command"
      ) {
        void handler?.handle(value);
      }
    },
    log,
  });
  // Until the first relay of this run admits it, the same window applies (its spawner may never publish).
  openWindow("start");

  // The spawning relay's pipe closed: it is gone, unless the broker already lives on another relay.
  process.stdin.on("end", () => {
    log("broker.stdin-closed");
    if (attachedRelayPid === undefined || attachedRelayPid === process.ppid) openWindow("spawner-gone");
  });
  process.stdin.on("error", () => undefined);
  process.stdin.resume();
}

await main();
