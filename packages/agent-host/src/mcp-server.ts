import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  agentControlFrameSchema,
  agentNativeResponseSchema,
  agentUploadImageRequestSchema,
  promptWaitingFrameSchema,
  AGENT_TOOL_DESCRIPTORS,
  ATTENTION_SENTENCES,
  type AgentNativeResponse,
  type AgentToolName,
  type PromptWaitingFrame,
} from "@hallpass/contracts";
import { dialRelay, DIAL_RETRY_MS, readBridgeRecord, type RelayDial } from "./bridge-link.js";
import { IMPLEMENTED_AGENT_TOOL_NAMES, SERVER_NAME, SERVER_VERSION } from "./tool-offering.js";
import { agentIdFilePath, hostDataDirectory } from "./host-paths.js";
import { CallRouter, KEEP_ALIVE_CAP_MS } from "./router.js";
import { createScreenshotCache, SCREENSHOT_UPLOAD_SENTENCES } from "./screenshot-cache.js";
import { readUploadConfig, resolveUploadFiles } from "./upload-policy.js";

/**
 * The MCP server the agent (Claude Code) spawns and talks to over stdio (T012, R-102).
 *
 * It is the agent's side of the bridge. Chrome always spawns its *own* native-messaging host, so
 * this process cannot be the one Chrome talks to; it dials the relay Chrome spawned, on the port
 * that relay published in `bridge.json`, and keeps dialling while there is none (004/R-111). 003
 * had it the other way round - this process listened and wrote the record - which is why two agent
 * sessions could not run at once. The token comes from the relay's record and travels in `hello`:
 * it proves this process could read a file only this user can read, which is all a local link can
 * prove. It is not the pairing - the pairing is the owner's Accept in the side panel.
 *
 * Nothing page-derived is written to stderr. `stdout` belongs to the MCP transport alone; a stray
 * `console.log` here corrupts the JSON-RPC stream, which is why every diagnostic goes to stderr
 * through `log`.
 */

/**
 * The host's name, its version and the tools it offers live in `tool-offering.ts`: this file is an
 * entry point, so anything a test needs to read has to sit where importing it does not start a
 * server on stdio.
 */

/**
 * How long a tool call waits for the owner to answer a first-time pairing prompt.
 *
 * Well inside the client's own bounds, so the agent is told `denied`/`timed-out` in the contract's
 * own words rather than losing the request to a transport timeout it cannot interpret. This file
 * used to say the client's bound was 60 s; that is the MCP SDK's default, not Claude Code's.
 * Measured 2026-09-21 (011 research.md R-161): Claude Code's `MCP_TOOL_TIMEOUT` defaults to about
 * 28 hours of wall clock and its stdio idle bound is 30 minutes, so the two-minute closed-panel
 * wait of FR-148 is held on the call rather than answered early. The progress notifications below
 * are kept for a different reason than they were introduced for: they are the carrier of the
 * message that tells the person where to click (FR-146), and they keep the idle bound alive as a
 * side effect. Other clients are not documented here; the assumption that they tolerate two
 * minutes is recorded in the spec and checked by first use, not by us.
 */
export const PAIRING_TIMEOUT_MS = 45_000;

/**
 * The shortest bound FR-059 allows, held as a statement rather than as a clamp (004/T100).
 *
 * The spec promises the owner at least thirty seconds to answer, so this is what the shipped bound
 * above is measured against. It is deliberately not applied to the environment override: that
 * override exists so a test need not wait three quarters of a minute for a prompt nobody will
 * answer, and clamping it would make every such test that long. `pairing-timing.test.ts` fails if
 * the product's own bound is ever shortened past this.
 */
export const PAIRING_TIMEOUT_FLOOR_MS = 30_000;

/**
 * How often a call waiting on the owner's answer tells its client it is still waiting (R-112).
 *
 * MCP's progress notification is the standard way for a server to say "still working", and since
 * 011 it is also the only channel that reaches the person at the terminal while a card waits in a
 * side panel they have not opened. Without them the owner's reading time is spent inside a call
 * that says nothing at all (the owner's E2).
 */
export const PAIRING_PROGRESS_MS = 5_000;

/**
 * What a waiting call says when the owner can see the question (011 FR-151).
 *
 * Two fixed sentences, because a notification must carry nothing page-derived and nothing about
 * what the agent asked for: the card itself says which site and which action, and it is in front
 * of the owner. When it is *not* in front of them - no side panel is connected - the message is one
 * of the contract's `ATTENTION_SENTENCES` instead, which is the sentence that says where to click.
 */
export const PAIRING_PROGRESS_MESSAGE = "waiting for the owner to answer the pairing prompt";

export const PROMPT_PROGRESS_MESSAGE = "waiting for the owner to answer a question in the side panel";

/** How the progress cadence is shortened for a test, for the reason the bounds below are. */
export const PAIRING_PROGRESS_ENV = "HALLPASS_AGENT_PAIRING_PROGRESS_MS";

function pairingProgressMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[PAIRING_PROGRESS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : PAIRING_PROGRESS_MS;
}

/**
 * How the bound is overridden for a test that cannot wait 45 s for a prompt nobody answers.
 *
 * It is read from the environment rather than passed as an argument because the process an agent
 * spawns takes no arguments: a test drives the same entry point Claude Code does, so the only place
 * it can say "answer faster" is the environment it spawns the server in.
 */
export const PAIRING_TIMEOUT_ENV = "HALLPASS_AGENT_PAIRING_TIMEOUT_MS";

function pairingTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[PAIRING_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : PAIRING_TIMEOUT_MS;
}

/**
 * The furthest a worker's tick may push the end of a pairing exchange (011 review L4).
 *
 * The router caps what a tick may add to a call for the reason this caps what it may add to an
 * exchange: every wait has to end, whatever the far side keeps saying. It is the router's own
 * number because it is the same promise about the same ticks - two minutes of closed-panel wait
 * plus a round trip - and a call parked on this exchange is held by that cap anyway.
 */
export function cappedPairingBoundMs(requestedMs: number): number {
  return Math.min(requestedMs, KEEP_ALIVE_CAP_MS);
}

/**
 * How the dial cadence is shortened for a test (004/R-111).
 *
 * The product's own is 5 s, which is right for an agent waiting on a browser that may not be
 * running yet and far too long for a test that starts its stand-in relay a moment after the server.
 * Read from the environment for the same reason the pairing bound is: the process an agent spawns
 * takes no arguments.
 */
export const DIAL_RETRY_ENV = "HALLPASS_AGENT_DIAL_RETRY_MS";

function dialRetryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[DIAL_RETRY_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DIAL_RETRY_MS;
}

/**
 * How long a call waits for its own session's link to attach before it gives up (004/T094b).
 *
 * The FR-057 recovery bound: a record on disk means a relay published a port, so a link *is*
 * coming - the dial loop is between attempts, or the browser is still starting - and FR-055 says a
 * session's first call succeeds whether or not anybody else is live. Failing the instant the link
 * is not up yet made that promise depend on the agent being slow enough to lose the race.
 */
export const ATTACH_TIMEOUT_MS = 10_000;

/**
 * How the attach bound is shortened for a test that must not wait ten seconds for a link nothing
 * is going to acknowledge. Read from the environment for the same reason the two bounds above are:
 * the process an agent spawns takes no arguments.
 */
export const ATTACH_TIMEOUT_ENV = "HALLPASS_AGENT_ATTACH_TIMEOUT_MS";

function attachTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[ATTACH_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : ATTACH_TIMEOUT_MS;
}

/**
 * How the screenshot cache's two bounds are shortened for a test or a gate run (013/T341).
 *
 * The module's own constants are the product's - five minutes and eight mebibytes - and they stand
 * whenever these are unset. They are read here, at the one place that builds the cache, rather than
 * inside it: the cache is a pure module with an injected clock, and a module that read the
 * environment would be a second source of truth about the same two numbers.
 */
export const SCREENSHOT_RETENTION_ENV = "HALLPASS_SCREENSHOT_RETENTION_MS";
export const SCREENSHOT_BUDGET_ENV = "HALLPASS_SCREENSHOT_BUDGET_CHARS";

/**
 * The override, or nothing at all. Exported so the fall-back is a tested rule (S2c review F3).
 *
 * Anything that is not a positive finite number - a word, a zero, a negative, an empty variable -
 * is `undefined` rather than itself, because each of those would otherwise reach the cache as a
 * bound: `Number("abc")` is `NaN`, and a retention of `NaN` expires every picture on the next
 * sweep while a retention of `0` keeps none at all. A shortened bound is a test's lever, and a
 * mistyped one has to leave the product's own promise standing.
 */
export function positiveEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** What the owner is told the connection came through; the panel shows it beside the agent's name. */
const AGENT_ORIGIN = "stdio:local";

/**
 * The contract's bound on an identity field (`agentControlFrameSchema`). Both the agent id and the
 * display name are clamped to it *before* a frame is built: a name longer than this is a frame the
 * worker would refuse whole, so the owner would never be asked to pair at all.
 */
const IDENTITY_MAX_CHARS = 128;

function clampIdentity(value: string, field: string): string {
  if (value.length <= IDENTITY_MAX_CHARS) {
    return value;
  }
  log("agent.pair.name-clamped", field);
  return value.slice(0, IDENTITY_MAX_CHARS);
}

/**
 * How the pairing exchange for this session ended.
 *
 * A link that went away is deliberately not folded into `denied`: the owner deciding no and the
 * link dropping while they were still deciding are different facts, and an agent told "denied" for
 * a relay that simply died would stop asking (FR-032 is about the owner's decision, not the
 * link's). Since 004/T099a a drop is not an ending at all - the link comes back on its own
 * (FR-057), the exchange is re-requested on the next attach and the waiting call settles on the
 * owner's real answer - so the only outcome a drop can still reach is `timed-out`: the bound passed
 * and nobody answered, which is the fact, and still not a decision the owner never made.
 */
type PairingOutcome = "paired" | "denied" | "timed-out";

function log(code: string, detail?: string): void {
  process.stderr.write(detail === undefined ? `${code}\n` : `${code} ${detail}\n`);
}

/**
 * The stable id for this machine's agent installation, created once and never rewritten: a new id
 * every session would ask the owner to pair again every session (SC-020).
 */
async function readOrCreateAgentId(): Promise<string> {
  const path = agentIdFilePath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // No id yet; fall through and mint one.
  }
  const created = randomBytes(16).toString("hex");
  await mkdir(hostDataDirectory(), { recursive: true });
  await writeFile(path, `${created}\n`, "utf8");
  return created;
}

export type AgentMcpServer = {
  /** Ends the session: the worker is told, the link is dropped and stdio is closed. */
  close: () => Promise<void>;
};

export async function startAgentMcpServer(): Promise<AgentMcpServer> {
  const agentId = clampIdentity(await readOrCreateAgentId(), "agentId");
  const pairingBoundMs = pairingTimeoutMs();
  const pairingProgressEveryMs = pairingProgressMs();
  const attachBoundMs = attachTimeoutMs();
  /**
   * The agent session's id, minted once for the life of this process (003 D-M3-3).
   *
   * A session is one *agent* session, not one relay connection: Chrome's relay comes and goes -
   * every worker restart is a new one - while the agent keeps talking to this same server. Minting
   * it here is what lets a reconnect reconcile the tab group the session already owns instead of
   * stranding it behind an id nothing will ask for again.
   */
  const sessionId = randomBytes(16).toString("hex");

  /**
   * The screenshots this session may still put into a page (013 US3, R-177).
   *
   * One cache per session object, which here means one per process - and that is the whole of
   * FR-175's isolation: another agent's pictures are in another process's memory, and the panel has
   * no way to ask this one for anything. It survives a worker recycling for the same reason, and
   * dies with the session without anybody having to remember to end it.
   */
  const retentionOverrideMs = positiveEnv(SCREENSHOT_RETENTION_ENV);
  const budgetOverrideChars = positiveEnv(SCREENSHOT_BUDGET_ENV);
  const screenshots = createScreenshotCache({
    ...(retentionOverrideMs === undefined ? {} : { retentionMs: retentionOverrideMs }),
    ...(budgetOverrideChars === undefined ? {} : { budgetChars: budgetOverrideChars }),
  });

  /**
   * The browser run the cache was filled under, and whether the link has dropped since it was last
   * confirmed (013/R-184, FR-168).
   *
   * The worker mints one id per browser start and keeps it in `chrome.storage.session`, so it
   * survives a worker recycling and dies with the browser; it arrives on every pairing answer.
   * These two variables are what turn that id into the retention rule: a run that came back the
   * same means only the port went away and the pictures stay, a run that changed means the browser
   * restarted and they go, and a worker that names no run at all leaves S1's answer standing - the
   * pictures go with the link - because nothing else can tell those two apart.
   */
  let browserRun: string | undefined;
  let linkDroppedSincePairing = false;

  /** The dial loop towards the relay, started once the MCP client has said who it is. */
  let link: RelayDial | undefined;
  /** Whether a relay has acknowledged the greeting on the current link. */
  let attached = false;
  /** Calls that arrived before this session's link was up, waiting to be told it is (T094b). */
  const attachWaiters = new Set<() => void>();
  let displayName = "Unknown agent";
  let initialized = false;
  let pairRequested = false;

  let pairing: Promise<PairingOutcome> | undefined;
  let settlePairing: ((outcome: PairingOutcome) => void) | undefined;
  /**
   * Whether the current exchange is still waiting for the worker's answer (004/T099a).
   *
   * A drop keeps a *pending* exchange - its promise, its bound and whoever is awaiting it - and
   * discards a settled one, so the next attach asks again instead of handing back an answer that
   * was given to a link that no longer exists.
   */
  let pairingPending = false;
  /**
   * The bound the open pairing exchange is running on, and how to lengthen it (011 FR-148).
   *
   * The worker is the only party that knows whether a side panel is open, so it is the only one
   * that can say the owner needs two minutes rather than forty-five seconds. It says so in its
   * `prompt-waiting` ticks and this adopts the larger of the two - never the smaller, because a
   * bound the owner is already inside must not shrink under them (spec edge case).
   */
  let pairingBoundNowMs = pairingBoundMs;
  let extendPairingBound: ((boundMs: number) => void) | undefined;
  /**
   * Whether the last tick for this session's pairing said no panel was connected (011 FR-146).
   *
   * It is what turns the eventual `timed-out` into an answer the agent can act on: "nobody
   * answered" plus the sentence that says the card was in a panel nobody had opened. Cleared with
   * every fresh exchange, so a later request that the owner *could* see is not hinted at.
   */
  let pairingPanelClosed = false;

  const router = new CallRouter({
    send: (frame) => {
      // `send` is false when the link went away between the check in `callTool` and here; the
      // router turns the throw into this call's own `bridge-lost`.
      if (!link?.send(frame)) {
        throw new Error("bridge-lost");
      }
    },
    onTimeout: (callId) => {
      // 003 D-M3-1: the agent has its answer, so anything the worker is still holding for this call
      // is a question nobody is waiting on. A `stop` naming the call is how it is told.
      log("agent.call.timed-out", callId);
      link?.send({ type: "stop", sessionId, callId });
    },
  });

  function resetPairing(): void {
    // A dropped link means the worker's answer can no longer arrive, so the next relay starts the
    // pairing exchange again. The *owner's* decision is durable in the extension, not here: a
    // re-request for an already-paired agent is answered immediately and never prompts.
    //
    // 004/T099a: an exchange the owner has not answered yet is *not* settled here. FR-057 brings
    // the link back without the owner doing anything, so the drop is an interruption, not an end -
    // the pending promise and its bound are kept, the next attach re-requests the pairing, and the
    // call waiting on it settles on the answer the owner is still about to give. Only the bound
    // passing with no attach ends it, as `timed-out`.
    pairRequested = false;
    if (!pairingPending) {
      pairing = undefined;
      settlePairing = undefined;
    }
  }

  /**
   * What the worker's pairing answer says about the retention (013/R-184, FR-168, gate finding F4).
   *
   * FR-168 asks for two things at once: the retention survives a worker recycling, and it ends when
   * the browser exits. S1 read both off the link dropping, which cannot be right - a recycled
   * service worker takes the native host down with it, so the two events look identical from here.
   * The browser run is the fact that separates them, and it arrives on the one frame the worker
   * sends on every (re)established link, before any call is released to read the cache.
   *
   * The rule, in the order the branches read: a worker that names no run leaves S1's answer
   * standing (a drop clears), because a mixed install must not silently start keeping pictures
   * across a browser restart; a first run recorded while the link has dropped is a run this process
   * cannot vouch for, so it clears once and records it; a run that came back unchanged keeps
   * everything, which is the recycling case; a run that changed clears, which is the browser having
   * exited. Nothing here clears merely because the port went away.
   */
  function noteBrowserRun(reported: string | undefined): void {
    const dropped = linkDroppedSincePairing;
    linkDroppedSincePairing = false;
    if (reported === undefined) {
      if (!dropped) return;
      screenshots.clear();
      log("agent.screenshots.cleared", "link-dropped-no-run");
      return;
    }
    if (browserRun === undefined) {
      browserRun = reported;
      // The session's *first* answer arrives before any picture could have been taken - a
      // screenshot needs a paired session - so there is nothing to clear unless a drop came first.
      if (!dropped) return;
      screenshots.clear();
      log("agent.screenshots.cleared", "browser-run-unknown");
      return;
    }
    if (browserRun === reported) return;
    browserRun = reported;
    screenshots.clear();
    log("agent.screenshots.cleared", "browser-run-changed");
  }

  /**
   * The worker forgot this session (006 FR-087): the owner pressed Stop on its card. This process
   * is still paired and still on the link, so the way on is a new session under the same id - the
   * relay keys one socket to one id - which the worker takes on a fresh greeting. The pairing
   * exchange starts over with it, answered at once for an agent the owner still has paired, and
   * the call that found out is retried once. `false` when no link is up to greet on, or the
   * relay did not acknowledge inside the attach bound.
   */
  async function reopenSession(): Promise<boolean> {
    attached = false;
    pairRequested = false;
    pairingPending = false;
    pairing = undefined;
    settlePairing = undefined;
    /**
     * 013/R-180, site 1 of 2 as R-184 left them - the session itself ended: the worker forgot it
     * and the way on is a new one (this is not a port that dropped). A
     * picture the *previous* session took is not this one's to upload, and `unknown-image-id` is
     * the honest answer for it.
     */
    screenshots.clear();
    log("agent.session.reopening", sessionId);
    if (!link?.greet()) {
      return false;
    }
    return waitForAttach();
  }

  function requestPairing(): void {
    if (pairRequested || !attached || !initialized) {
      return;
    }
    /**
     * An exchange that already has an answer is not asked again (004/T100).
     *
     * A withdrawn request leaves `pairRequested` false so the *next* call raises it - which is what
     * FR-059 asks for - and the owner may answer the withdrawn prompt a moment later. That late
     * answer is settled here, in `pairing`, and re-requesting would replace it with a fresh promise
     * nothing has answered, turning the owner's yes back into a wait.
     */
    if (pairing && !pairingPending) {
      return;
    }
    pairRequested = true;
    // A re-request after a drop (T099a) reuses the exchange that is still open, so the promise the
    // waiting call holds is the one the owner's answer settles. A fresh promise here would leave
    // that call awaiting something nothing will ever resolve.
    if (!pairingPending) {
      pairingPending = true;
      // A new exchange starts on the product's own bound and with no knowledge of the panel; the
      // worker's ticks are what change either.
      pairingBoundNowMs = pairingBoundMs;
      pairingPanelClosed = false;
      pairing = new Promise<PairingOutcome>((resolve) => {
        let done = false;
        const requestedAt = Date.now();
        const finish = (outcome: PairingOutcome): void => {
          if (done) return;
          done = true;
          pairingPending = false;
          extendPairingBound = undefined;
          clearTimeout(timer);
          resolve(outcome);
        };
        const expire = (): void => {
          finish("timed-out");
          /**
           * FR-059: the request is withdrawn when the bound passes with no answer.
           *
           * Without this the settled `timed-out` was the answer for the rest of the session - every
           * later call read it and the owner was never asked again, so an owner who was away from
           * their machine for one call had to restart the agent. Clearing the exchange makes the
           * next call raise the prompt afresh; an answer to the *withdrawn* prompt still arrives as
           * a `pair-result` and settles the session, which is why `requestPairing` refuses to
           * replace one.
           */
          pairing = undefined;
          pairRequested = false;
          settlePairing = undefined;
          log("agent.pair.withdrawn");
        };
        let timer = setTimeout(expire, pairingBoundNowMs);
        (timer as { unref?: () => void }).unref?.();
        /**
         * 011 FR-148: the owner needs longer when the card is in a panel they have not opened.
         *
         * The exchange keeps its own start, so a tick arriving twenty seconds in lengthens the
         * wait to the worker's bound *from the moment the card was raised* rather than from now -
         * otherwise every tick would push the ending further away and the exchange would never end.
         */
        extendPairingBound = (requestedMs: number): void => {
          // Never past the ceiling (review L4): a worker with a stuck card, or a frame from
          // anywhere else, must not be able to park every call on this exchange indefinitely.
          const boundMs = cappedPairingBoundMs(requestedMs);
          if (done || boundMs <= pairingBoundNowMs) {
            return;
          }
          pairingBoundNowMs = boundMs;
          clearTimeout(timer);
          timer = setTimeout(expire, Math.max(0, requestedAt + boundMs - Date.now()));
          (timer as { unref?: () => void }).unref?.();
          log("agent.pair.bound-extended", String(boundMs));
        };
        settlePairing = finish;
      });
    }
    log("agent.pair.requested", agentId);
    link?.send({
      type: "pair-request",
      agentId,
      displayName: clampIdentity(displayName, "displayName"),
      origin: AGENT_ORIGIN,
      sessionId,
    });
  }

  /**
   * Who a progress notification can be sent to, for the two things a call can be waiting on.
   *
   * A notification needs the client's own token, and MCP forbids reporting progress without one -
   * so a client that asked for no progress is simply absent from both of these. The call map is
   * keyed by `callId` because a tick names the call it is about; the pairing set is a set because
   * several calls can be parked on one pairing exchange and each is entitled to hear about it.
   */
  const callProgress = new Map<string, ProgressTarget>();
  const pairingProgress = new Set<ProgressTarget>();

  function reportProgress(target: ProgressTarget, update: { progress: number; total: number; message: string }): void {
    void target.extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: target.token, ...update } })
      // A client that closed its side mid-wait is not this call's failure to report.
      .catch(() => log("agent.progress.failed"));
  }

  /**
   * One question is still waiting, and the person may not be able to see it (011 R-162).
   *
   * Two things happen with one frame, because they are two halves of the same promise. The router
   * is told so its backstop steps out of the owner's way, and the client is told so the person at
   * the terminal learns - in the agent's own reply - that something is waiting and, when no panel
   * is connected, where to click. Pairing is the case with no call of its own: the tick lengthens
   * the exchange's bound instead, and every call parked on that exchange hears about it.
   */
  function onPromptWaiting(frame: PromptWaitingFrame): void {
    if (frame.sessionId !== sessionId) {
      // The relay addresses a worker frame by its session and never broadcasts, so this is a frame
      // that should not have arrived. Acting on it would let one session hold another's call open.
      log("agent.waiting.other-session");
      return;
    }
    router.noteWaiting(frame);
    // The worker sends ticks only while no panel is connected (011 review M1), so the open-panel
    // branch below is for a frame this server did not expect - an older worker, or a panel that
    // opened between the raise and the tick. Its neutral text says the wait and nothing about
    // clicking anything, and the server's own pairing ticker stays the progress source in that case.
    const message = frame.panelConnected
      ? frame.kind === "pairing"
        ? PAIRING_PROGRESS_MESSAGE
        : PROMPT_PROGRESS_MESSAGE
      : ATTENTION_SENTENCES[frame.kind === "pairing" ? "pairing" : "consent"];
    const update = { progress: frame.waitedMs, total: frame.boundMs, message };
    if (frame.callId !== undefined) {
      const target = callProgress.get(frame.callId);
      if (!target) {
        // The call was answered, or the backstop ended it, between the worker's tick and this.
        log("agent.waiting.unmatched");
        return;
      }
      reportProgress(target, update);
      return;
    }
    if (frame.kind !== "pairing") {
      // Only pairing has no call of its own. A consent tick that named none could not be attributed
      // to a caller at all, and guessing would report one call's wait on another's token.
      log("agent.waiting.no-call", frame.kind);
      return;
    }
    if (!frame.panelConnected) {
      pairingPanelClosed = true;
      extendPairingBound?.(frame.boundMs);
    }
    for (const target of pairingProgress) {
      reportProgress(target, update);
    }
  }

  function onRelayFrame(value: unknown): void {
    const waiting = promptWaitingFrameSchema.safeParse(value);
    if (waiting.success) {
      onPromptWaiting(waiting.data);
      return;
    }
    const response = agentNativeResponseSchema.safeParse(value);
    if (response.success) {
      if (!router.settle(response.data)) {
        log("agent.call.unmatched");
      }
      return;
    }
    const control = agentControlFrameSchema.safeParse(value);
    if (!control.success) {
      log("agent.frame.rejected");
      return;
    }
    switch (control.data.type) {
      case "pair-result":
        if (control.data.agentId !== agentId) {
          // The worker answers per agent, and one browser can hold several pairings. An answer
          // about somebody else - typically the owner unpairing a different agent - must not
          // settle this session's, or unpairing one agent would silently unpair them all.
          log("agent.pair.result-for-other-agent");
          return;
        }
        log("agent.pair.answered", control.data.accepted ? "accepted" : "declined");
        // Before the answer itself: the frame is also this worker's statement about which run of
        // the browser is on the other end of the link (R-184), and whether the pictures this
        // session is holding are still that browser's is a question about the run, not the answer.
        noteBrowserRun(control.data.browserRunId);
        // An `unpair` while a session is open arrives as a decline, which is what makes unpairing
        // effective immediately (FR-032): every later call reads this same settled answer.
        //
        // Both arms reassign `pairing`, not just the declining one: the prompt's own bound may
        // already have fired, and the owner answering a minute later is still the owner answering.
        // Without the reassignment the settled `timed-out` would be the answer for the rest of the
        // session, which is a refusal the owner never made.
        if (control.data.accepted) {
          pairing = Promise.resolve<PairingOutcome>("paired");
          settlePairing?.("paired");
        } else {
          pairing = Promise.resolve<PairingOutcome>("denied");
          settlePairing?.("denied");
          /**
           * 013/R-180, site 2 of 2 - an unpair arrives as a decline naming this agent, and takes
           * effect immediately (FR-032). The owner withdrawing the pairing withdraws what this
           * session is holding of their screen with it, so a later re-pair starts with nothing.
           */
          screenshots.clear();
        }
        settlePairing = undefined;
        pairingPending = false;
        return;
      case "bridge-unavailable":
        log("agent.bridge.unavailable");
        router.failAll("failed", "bridge-unavailable");
        return;
      case "stop":
        log("agent.stop.received");
        router.failAll("stopped", "owner-stopped");
        return;
      default:
        // `pair-request`, `unpair` and `hello` travel the other way; a worker sending one is not
        // speaking this protocol and is ignored rather than acted on.
        log("agent.frame.unexpected", control.data.type);
    }
  }

  /**
   * The server's half of the link (004/T094): dial the relay, greet it, and keep dialling.
   *
   * Started at `initialize` rather than at process start, because the greeting carries the name the
   * owner is asked about and that name is the MCP client's own - a dial made before the client
   * introduced itself would ask the owner to pair with "Unknown agent". Retrying is what makes a
   * browser restart cheap: Chrome respawns the relay, this loop finds the new record within one
   * cadence, and the session is re-attached without the agent restarting anything.
   */
  function startLink(): void {
    if (link) {
      return;
    }
    link = dialRelay({
      hello: { sessionId, agentId, displayName: clampIdentity(displayName, "displayName") },
      onFrame: onRelayFrame,
      onAttached(relayPid) {
        attached = true;
        log("agent.relay.attached", String(relayPid));
        requestPairing();
        // After the pairing request, so a call released here reads the exchange this attach
        // started rather than the absence of one.
        for (const notify of [...attachWaiters]) {
          notify();
        }
      },
      onDetached() {
        attached = false;
        /**
         * A call already sent to the relay is answered honestly, not with `bridge-lost` (004/T162).
         *
         * `bridge-lost` is what a call is told when it never left this process - no record yet, or
         * the attach wait's own bound passed - and a retry there is safe because nothing happened.
         * A call already forwarded may have reached the worker, or even the page, before this
         * socket closed: the relay's own drain (`relay-mux.ts`, `native-host.ts`) makes that
         * increasingly rare, but a call the drain's bound still could not answer lands here, and a
         * blind retry risks doing whatever it asked for twice. `call-unconfirmed` says the outcome
         * is unknown instead of implying it is safe to redo, the same distinction the effect
         * verdicts draw with `target-unconfirmed`.
         */
        router.failAll("failed", "call-unconfirmed");
        resetPairing();
        /**
         * 013/R-184 - the port going away is *not* the end of the retention (gate finding F4).
         *
         * R-180 cleared here, reading a dropped link as the browser having exited. A recycled
         * service worker kills the native host too, so that read forgot a picture FR-168 promises
         * to keep across exactly that recycling. What is recorded instead is that the link dropped:
         * the worker's next pairing answer names its browser run, and `noteBrowserRun` decides
         * there whether this is the same browser coming back or a new one.
         */
        linkDroppedSincePairing = true;
        log("agent.relay.detached");
      },
      retryMs: dialRetryMs(),
      log,
    });
  }

  /**
   * Waits for this session's link to attach, bounded. `false` means the bound passed with no link.
   *
   * The wait is per call rather than a single shared promise because each call is answered in its
   * own right: one giving up must not settle the others' waits.
   */
  function waitForAttach(): Promise<boolean> {
    if (attached) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        attachWaiters.delete(notify);
        resolve(ok);
      };
      const notify = (): void => finish(true);
      const timer = setTimeout(() => finish(false), attachBoundMs);
      (timer as { unref?: () => void }).unref?.();
      attachWaiters.add(notify);
    });
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /**
   * The one tool of the spike. Its argument list is empty on purpose: it proves the whole path -
   * agent stdio, loopback link, native messaging, worker, and back - with nothing else in the way.
   */
  /**
   * Whether a worker result is a picture rather than data (003/T037).
   *
   * `screenshot` is the one tool whose answer is not JSON: MCP carries images as their own content
   * block, and an agent handed base64 inside a text block would have a string it cannot look at.
   * The shape is recognised structurally rather than by tool name so this stays one function - the
   * worker declares what it produced (`agentScreenshotResultSchema`) and the host carries it.
   */
  function imageBlock(result: unknown): { data: string; mimeType: string } | undefined {
    if (!result || typeof result !== "object") return undefined;
    const candidate = result as { data?: unknown; mimeType?: unknown };
    return typeof candidate.data === "string" && typeof candidate.mimeType === "string"
      ? { data: candidate.data, mimeType: candidate.mimeType }
      : undefined;
  }

  /** One answer shape for every tool: the result as JSON, or the outcome and its stable reason. */
  function toolReply(outcome: AgentNativeResponse): {
    isError?: true;
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  } {
    if (outcome.outcome === "ok") {
      const image = imageBlock(outcome.result);
      if (image) {
        // Whatever rode beside the picture - `cropped`, and since 008 the recording's frame count and
        // an open dialog (FR-101, FR-110) - travels as a text block after it. The S9 probe
        // (2026-09-19) found an agent could not see `recording` on a screenshot's answer because only
        // the image was sent; the bytes themselves stay out of the text.
        const { data: _data, mimeType: _mimeType, ...rest } = outcome.result as Record<string, unknown>;
        /**
         * 013 FR-167: the picture is retained here, where it is recognised, and the id rides back
         * with it.
         *
         * At the same one place for the same reason the image block is built at one place: the
         * `computer` tool's screenshot action answers the same shape, so an id minted per tool name
         * would be an id the position-aiming agent never gets. The sentence is on the answer whether
         * or not the agent was looking for it - a retained picture says how to use it, and one too
         * large to keep says so on the spot rather than on the next call.
         */
        const issued = screenshots.issue(image.data, image.mimeType);
        const carried = {
          ...rest,
          imageId: issued.imageId,
          upload: issued.retained ? SCREENSHOT_UPLOAD_SENTENCES.retained : SCREENSHOT_UPLOAD_SENTENCES.oversize,
        };
        return {
          content: [
            { type: "image" as const, data: image.data, mimeType: image.mimeType },
            { type: "text" as const, text: JSON.stringify(carried) },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome.result ?? []) }] };
    }
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          // The outcome and the stable reason, never prose: the agent branches on these words. The
          // structured refusal rides beside them when the worker sent one (004/T105), because
          // `held-by-session` without the session it names is a refusal an agent can only repeat -
          // it is what tells "wait for that agent" from "claim it". Carried whole, never
          // reformatted: it is the contract's own shape and every field in it is a bounded code.
          // 011: `hint` rides here for the same reason, and is the one field of the three written
          // for a person rather than for the agent - it is the sentence the agent relays when a
          // question timed out in a side panel nobody had opened.
          text: JSON.stringify({
            outcome: outcome.outcome,
            reason: outcome.reason ?? "",
            ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
            ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
          }),
        },
      ],
    };
  }

  server.registerTool(
    "tabs_context",
    {
      title: "List the agent session's tabs",
      description: "Lists the tabs this agent session owns in the browser, as { tabId, url }.",
      inputSchema: {},
    },
    async (_args: Record<string, unknown>, extra: ToolCallExtra) =>
      toolReply(await callTool("tabs_context", {}, extra)),
  );

  /**
   * Every other tool, registered from the contract's own table (T029).
   *
   * Written once rather than once per tool, because the three things that must agree - the name the
   * router dispatches on, the arguments the worker will accept, and the prose the agent reads - all
   * come from the same row. A hand-written registration per tool is three places a new tool can be
   * half-added.
   */
  for (const descriptor of AGENT_TOOL_DESCRIPTORS) {
    if (!IMPLEMENTED_AGENT_TOOL_NAMES.has(descriptor.name)) {
      continue;
    }
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputShape,
      },
      async (args: Record<string, unknown>, extra: ToolCallExtra) =>
        toolReply(await callTool(descriptor.name, args ?? {}, extra)),
    );
  }

  /**
   * The part of the MCP request context this server uses: who to report progress to (R-112).
   *
   * Narrowed to the two members rather than taken as the SDK's `RequestHandlerExtra`, so the
   * pairing wait is testable and readable without the whole request-handling surface in view. A
   * client that asked for no progress sends no token, and MCP forbids reporting progress without
   * one - so the absence of a token is the client saying "do not".
   */
  type ToolCallExtra = {
    _meta?: { progressToken?: string | number | undefined } | undefined;
    sendNotification: (notification: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number; total?: number; message?: string };
    }) => Promise<void>;
  };

  /** One client that asked to be told about progress, and the token it asked to be told on. */
  type ProgressTarget = { extra: ToolCallExtra; token: string | number };

  /**
   * Waits for the owner's pairing answer, saying every five seconds that the wait is still on
   * (R-112, FR-059).
   *
   * The notifications are what the owner's reading time is spent *saying* rather than in silence.
   * R-161 measured what they are not: Claude Code's per-call bound is hours, not the 60 s this file
   * used to assume, so they are not what keeps the call alive - they are the carrier of the message
   * (011 FR-146), and since 011 that message is the sentence telling the person where to click when
   * the card is in a side panel nobody has opened. A client that ignores progress loses only the
   * message; the `timed-out` answer repeats it as a `hint`.
   */
  async function awaitPairing(extra: ToolCallExtra | undefined): Promise<PairingOutcome> {
    /**
     * 004/T099a - this await outlives a dropped link on purpose. If the relay goes away while the
     * owner is deciding, the exchange is re-requested on the next attach and this promise settles
     * on their real answer; the agent is only told something went wrong if the pairing bound passes
     * with nobody answering at all.
     */
    const exchange = pairing ?? Promise.resolve<PairingOutcome>("denied");
    const progressToken = extra?._meta?.progressToken;
    if (!extra || progressToken === undefined) {
      return exchange;
    }
    const started = Date.now();
    const target: ProgressTarget = { extra, token: progressToken };
    // 011: the worker's pairing ticks are reported on this call's token too, for as long as it is
    // the one waiting on the exchange.
    pairingProgress.add(target);
    const ticker = setInterval(() => {
      reportProgress(target, {
        progress: Date.now() - started,
        // Both follow what the worker's ticks said about the panel: the bound it chose, and - while
        // nobody can see the card - the sentence that says how to open it. No page-derived text
        // ever reaches a notification.
        total: pairingBoundNowMs,
        message: pairingPanelClosed ? ATTENTION_SENTENCES.pairing : PAIRING_PROGRESS_MESSAGE,
      });
    }, pairingProgressEveryMs);
    (ticker as { unref?: () => void }).unref?.();
    try {
      return await exchange;
    } finally {
      clearInterval(ticker);
      pairingProgress.delete(target);
    }
  }

  async function callTool(
    tool: AgentToolName,
    args: Record<string, unknown>,
    extra?: ToolCallExtra,
  ): Promise<AgentNativeResponse> {
    const first = await placeCall(tool, args, extra);
    if (first.reason !== "session-ended") {
      return first;
    }
    // Once, never a loop: a worker that says it again after a fresh greeting is answered as it said.
    if (!(await reopenSession())) {
      return first;
    }
    return placeCall(tool, args, extra);
  }

  async function placeCall(
    tool: AgentToolName,
    args: Record<string, unknown>,
    extra?: ToolCallExtra,
  ): Promise<AgentNativeResponse> {
    const callId = randomBytes(8).toString("hex");
    if (!attached) {
      /**
       * Two different facts, and the agent acts on them differently (004/R-111).
       *
       * A record on disk means a relay published a port and this session is simply not on it right
       * now - the browser restarted, the socket dropped, the dial loop is between attempts - so the
       * link is coming and the call waits for it (T094b) rather than being failed in a race it
       * never had to lose. No record at all means no relay ever ran: Chrome is not up, or the host
       * is not installed, nothing is coming, and that is
       * `bridge-unavailable`. 003 answered `bridge-unavailable` to a second agent session whose
       * record had been overwritten (the owner's E1); with one writer that state no longer exists,
       * and the code that reported it now says only what it says.
       */
      const record = await readBridgeRecord();
      if (!record) {
        return { callId, outcome: "failed", reason: "bridge-unavailable" };
      }
      /**
       * 004/T094b - a record means a link is on its way, so the call waits for it instead of
       * racing it. FR-055: a session's first call succeeds whether or not other sessions are live,
       * and the dial that would make it succeed is at most one cadence away. Only the bound passing
       * with no link is `bridge-lost`; a link that drops *after* this point is answered by the
       * router's `failAll`, which is the in-flight case and is unchanged.
       */
      if (!(await waitForAttach())) {
        return { callId, outcome: "failed", reason: "bridge-lost" };
      }
    }
    // A request the bound withdrew (FR-059) is raised again here rather than never: the owner was
    // away for the last call, not for the session. A no-op while an exchange is open or answered.
    requestPairing();
    const pairingOutcome = await awaitPairing(extra);
    if (pairingOutcome !== "paired") {
      return {
        callId,
        outcome: pairingOutcome === "timed-out" ? "timed-out" : "denied",
        // FR-059's own words for the two facts: nobody answered, or the owner said no.
        reason: pairingOutcome === "timed-out" ? "not-paired: no answer" : "not-paired",
        // 011 FR-146: nobody answered *because the card was in a panel nobody had opened*, which
        // is the one case where there is something the person can do about it.
        ...(pairingOutcome === "timed-out" && pairingPanelClosed ? { hint: ATTENTION_SENTENCES.pairing } : {}),
      };
    }
    /**
     * The one tool whose arguments change on this side of the link (US7, FR-051).
     *
     * The agent names paths because it is asking for the owner's own files; the browser is handed
     * bytes because it has no business resolving a path and no way to read one. This process - the
     * owner's own, started by their own agent - is where that translation happens, behind the
     * allowed-roots rule, and a path outside them is refused here, before it is opened and before
     * anything crosses to the browser.
     */
    if (tool === "file_upload") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string") : [];
      const resolved = await resolveUploadFiles(paths, await readUploadConfig());
      if (!resolved.ok) {
        // The code, never the path: the log says which rule refused, not what the owner has on disk.
        log("agent.upload.refused", resolved.code);
        return { callId, outcome: "denied", reason: resolved.reason };
      }
      const { paths: _dropped, ...rest } = args;
      args = { ...rest, files: resolved.files };
    }
    /**
     * The other tool whose arguments change on this side of the link (013 US1, FR-169, FR-172).
     *
     * `file_upload`'s shape exactly, with the disk swapped for this session's own memory: the agent
     * names a picture it was handed, the browser is handed bytes, and the id does not exist on the
     * far side. Both of FR-172's refusals are decided here, before the call crosses - so a picture
     * the host cannot resolve never raises a consent card and never touches a page.
     */
    if (tool === "upload_image") {
      const request = agentUploadImageRequestSchema.safeParse(args);
      if (!request.success) {
        // The MCP input schema cannot carry "exactly one of ref / coordinate", nor the file-name
        // rule, so this is where both become a refusal - and the kind, never the arguments, is what
        // the log gets.
        log("agent.upload-image.refused", "invalid-arguments");
        return { callId, outcome: "failed", reason: "invalid-arguments" };
      }
      const { imageId, ref, coordinate, filename, tabId: target } = request.data;
      const held = screenshots.take(imageId);
      if (held.kind === "unknown") {
        log("agent.upload-image.refused", "unknown-image-id");
        return {
          callId,
          outcome: "denied",
          // Two different facts for two different next moves: this session never gave out that id,
          // so quoting it again - or waiting - will not help.
          reason: "unknown-image-id; take a new screenshot and quote its imageId",
        };
      }
      if (held.kind === "gone") {
        log("agent.upload-image.refused", held.why);
        return {
          callId,
          outcome: "denied",
          reason: `image-no-longer-available (${held.why}); take a new screenshot`,
        };
      }
      args = {
        tabId: target,
        target: ref === undefined ? { coordinate } : { ref },
        file: { name: filename, type: held.file.type, bytesBase64: held.file.bytesBase64 },
      };
    }
    // The tab travels as a field of the frame as well as inside the arguments, because it is what
    // the router's one-call-per-tab rule is keyed by (FR-043). A tool that names no tab concerns no
    // page and does not contend with anything.
    const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
    /**
     * 011: this call is reachable by a progress notification for as long as it is outstanding.
     *
     * Registered for every call, not only the ones that end up waiting on the owner, because which
     * ones those are is decided in the worker - a click on an `ask` site raises a card, the same
     * click on a `skip-checks` site does not - and the frame that says so names the call by id.
     */
    const progressToken = extra?._meta?.progressToken;
    if (extra && progressToken !== undefined) {
      callProgress.set(callId, { extra, token: progressToken });
    }
    let response: AgentNativeResponse;
    try {
      response = await router.call({
        callId,
        // 004 S1: every call frame names its session now, so the relay can route several servers'
        // calls through one worker. The session id is the one the server already minted at
        // `initialize`; S1 is the slice that makes the relay and the worker act on it.
        sessionId,
        tool,
        ...(tabId === undefined ? {} : { tabId }),
        args,
      });
    } finally {
      callProgress.delete(callId);
    }
    log("agent.call.completed", response.outcome);
    return response;
  }

  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    displayName = client?.name ?? displayName;
    initialized = true;
    log("agent.mcp.initialized", displayName);
    startLink();
    requestPairing();
  };

  await server.connect(new StdioServerTransport());

  let closing: Promise<void> | undefined;

  return {
    close(): Promise<void> {
      // Every exit path leads here - stdin closing, a signal, a test - and the announcement below
      // must be made once. A second caller waits on the first rather than sending a second `stop`.
      closing ??= (async () => {
        router.failAll("failed", "server-closing");
        if (link) {
          /**
           * The one frame that says the *agent session* is over (M4 Part A).
           *
           * The worker cannot infer it: a socket closing is what a relay restart looks like too,
           * and treating that as the end would strand the session's tab group behind an id the
           * reconnect still uses. So the process that knows - this one - says so, and only then
           * lets the link go. `close()` waits for the socket, so the frame is not lost to the exit.
           */
          link.send({ type: "stop", sessionId });
          await link.stop();
        }
        await server.close();
      })();
      return closing;
    },
  };
}

const running = await startAgentMcpServer();

/**
 * `stdin` closing is how an MCP client says the session is over. The worker is told before the link
 * goes, so it releases this session's tabs instead of waiting out a relay that never comes back.
 */
process.stdin.on("close", () => {
  void running.close().finally(() => process.exit(0));
});

/**
 * The other way an agent ends a session: the owner interrupts the terminal it is running in.
 *
 * Windows delivers `SIGINT` to a process with a console and `SIGBREAK` on a close; neither runs the
 * shutdown above by itself, so without these the session would end with no `stop` frame and the
 * worker would keep the group marked "Agent" for an agent that is gone.
 */
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    void running.close().finally(() => process.exit(0));
  });
}
