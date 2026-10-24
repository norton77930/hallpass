import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { win32 } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AgentTestResult, ConversationAgent, ConversationError, ConversationEventPayload } from "@hallpass/contracts";
import type { AdapterLaunchSpec } from "./agents.js";
import type { AgentTestRunnerPort } from "./commands.js";
import { Conversation, systemClock, type Clock, type LaunchResolution } from "./conversation.js";
import { killTreeAsync } from "./run-command.js";
import { writeLastTest } from "./shared-agent-state.js";
import type { UserEnvironmentPorts } from "./user-environment.js";

/**
 * 024 R-379 (D-024-10, FR-381): the settings page's Test of an agent - one short prompt to a copy of
 * the agent that is not a conversation. A `Conversation` built here directly, never through the pool:
 * it is not admitted (the running cap of 3 is untouched, no idle conversation is evicted), not in the
 * index, and gets no browser connection - no token, so it never opens tabs or asks for consent. It
 * runs in strict mode in its own folder `<data>\agent-tests\<id>\`, within 90 s in all; then its
 * process tree is ended and the folder removed, and only then is the result written to
 * `last-test.json` (R-375), where every browser's settings page reads it.
 *
 * The result says how the start went, whether the model answered (and how fast, or why not in the
 * agent's redacted words), whether the agent's runs get the browser tools (from the local check), and
 * for Hermes the *name* of its key variable when 023 R-369 found it outside the browser's environment.
 * No prompt text, answer or key value is kept.
 */

/** The one prompt; a word any model can say back. */
export const AGENT_TEST_PROMPT = "This is a connection test from Hallpass. Reply with the single word OK.";
/** The whole test, start to answer. */
export const AGENT_TEST_BOUND_MS = 90_000;
const REASON_MAX = 600;

export type AgentTestRunnerOptions = {
  /** `%LOCALAPPDATA%\hallpass`. */
  dataDir: string;
  /** The launch a strict conversation of the agent would get (the launcher's own). */
  resolveLaunch: (agent: ConversationAgent, mode: "strict") => Promise<LaunchResolution>;
  /** From the local check (R-374): whether this agent's runs get the browser tools. */
  browserTools: (agent: ConversationAgent) => Promise<AgentTestResult["browserTools"]>;
  spawnAgent?: (spec: AdapterLaunchSpec, cwd: string) => ChildProcess;
  userEnvironment?: UserEnvironmentPorts;
  log?: (code: string, detail?: string) => void;
  clock?: Clock;
  boundMs?: number;
  newId?: () => string;
};

export type AgentTestRunner = AgentTestRunnerPort & {
  /** Runs (or joins) the agent's test and resolves with its result once `last-test.json` has it. */
  run(agent: ConversationAgent): Promise<AgentTestResult>;
  /** Ends every test under way (broker shutdown). */
  shutdown(): Promise<void>;
};

/** A launch or start failure as the result's start code. */
function startCode(error: ConversationError): AgentTestResult["start"] {
  switch (error.code) {
    case "agent-missing":
    case "install-needed":
      return "agent-missing";
    case "agent-version":
      return "agent-version";
    default:
      return "agent-exited";
  }
}

const clipReason = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return "The agent gave no reason.";
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 3)}...` : flat;
};

export function createAgentTestRunner(options: AgentTestRunnerOptions): AgentTestRunner {
  const clock = options.clock ?? systemClock;
  const bound = options.boundMs ?? AGENT_TEST_BOUND_MS;
  const running = new Map<ConversationAgent, Promise<AgentTestResult>>();
  /** R-387: the latest test run of each agent, for diagnostics by agent. */
  const latest = new Map<ConversationAgent, Conversation>();
  const live = new Set<Conversation>();

  const runOnce = async (agent: ConversationAgent): Promise<AgentTestResult> => {
    const id = (options.newId ?? (() => randomBytes(8).toString("hex")))();
    const folder = win32.join(options.dataDir, "agent-tests", id);
    const deadline = clock.now() + bound;
    const browserTools = options.browserTools(agent).catch((): AgentTestResult["browserTools"] => "missing-component");
    let start: AgentTestResult["start"] = "ok";
    let model: AgentTestResult["model"] = { answered: false, reason: "The agent did not answer." };
    let keyHint: string | undefined;
    let conversation: Conversation | undefined;
    try {
      await mkdir(folder, { recursive: true });
      const launch = await options.resolveLaunch(agent, "strict");
      if (!launch.ok) {
        start = startCode(launch.error);
        model = { answered: false, reason: clipReason(launch.error.detail) };
      } else {
        const events: ConversationEventPayload[] = [];
        let wake: (() => void) | undefined;
        const testConversation = new Conversation(`agent-test-${id}`, agent, {
          clock,
          onEvent: (payload) => {
            events.push(payload);
            wake?.();
          },
          ...(options.spawnAgent === undefined ? {} : { spawnAgent: options.spawnAgent }),
          ...(options.log === undefined ? {} : { log: options.log }),
          ...(options.userEnvironment === undefined ? {} : { userEnvironment: options.userEnvironment }),
        });
        conversation = testConversation;
        live.add(testConversation);
        latest.set(agent, testConversation);
        /** Resolves on the next event, or at the deadline; false when the deadline came first. */
        const nextEvent = (): Promise<boolean> =>
          new Promise<boolean>((done) => {
            const left = deadline - clock.now();
            if (left <= 0) return done(false);
            const timer = clock.setTimer(() => {
              wake = undefined;
              done(false);
            }, left);
            wake = () => {
              wake = undefined;
              timer.cancel();
              done(true);
            };
          });
        /** `work`'s value, or none once the deadline comes first. */
        const withinDeadline = <T>(work: Promise<T>): Promise<T | undefined> =>
          new Promise<T | undefined>((done) => {
            const left = deadline - clock.now();
            if (left <= 0) return done(undefined);
            const timer = clock.setTimer(() => done(undefined), left);
            work.then(
              (value) => {
                timer.cancel();
                done(value);
              },
              () => {
                timer.cancel();
                done(undefined);
              },
            );
          });
        const keyNotice = () => {
          for (const { event } of events) {
            if (event.type === "notice" && event.code === "key-env-not-in-browser" && event.variable !== undefined) return event.variable;
          }
          return undefined;
        };
        let lateTimer: { cancel(): void } | undefined;
        const timeLeft = new Promise<"late">((done) => {
          lateTimer = clock.setTimer(() => done("late"), Math.max(deadline - clock.now(), 0));
        });
        const started = await Promise.race([
          testConversation.start({ cwd: folder, spec: launch.spec, versions: launch.versions, mode: "strict" }),
          timeLeft,
        ]);
        lateTimer?.cancel();
        if (started === "late") {
          model = { answered: false, reason: `The agent did not start within ${Math.round(bound / 1000)} s.` };
          start = "agent-exited";
        } else if (!started.ok) {
          // A start the model or key refused started the agent: that is the model's answer, not the start's.
          if (started.error.code === "agent-model-unreachable") start = "ok";
          else start = startCode(started.error);
          model = { answered: false, reason: clipReason(started.error.detail) };
        } else {
          const from = events.length;
          const sentAt = clock.now();
          const sent = testConversation.send(AGENT_TEST_PROMPT);
          if (!sent.ok) {
            model = { answered: false, reason: clipReason(sent.error.detail) };
          } else {
            let answered = false;
            let failedReason: string | undefined;
            let ended = false;
            let sawRunning = false;
            while (!ended) {
              for (const { event } of events.splice(from)) {
                if (event.type === "text" && event.role === "agent" && event.text.trim().length > 0) answered = true;
                if (event.type === "notice" && (event.code === "agent-model-unreachable" || event.code === "turn-failed")) failedReason = event.text;
                if (event.type === "notice" && event.code === "key-env-not-in-browser" && event.variable !== undefined) keyHint = event.variable;
                if (event.type === "state") {
                  if (event.state === "running" || event.state === "waiting-for-owner") sawRunning = true;
                  else if (sawRunning) ended = true;
                }
              }
              if (ended) break;
              if (!(await nextEvent())) break;
            }
            if (!ended) {
              // An answer whose turn never ended is no working agent either; the reason says which it was.
              model = {
                answered: false,
                reason: answered
                  ? `The agent answered but did not finish within ${Math.round(bound / 1000)} s.`
                  : `The agent did not answer within ${Math.round(bound / 1000)} s.`,
              };
            } else if (answered && failedReason === undefined) {
              model = { answered: true, ms: Math.max(0, Math.round(clock.now() - sentAt)) };
            } else {
              model = { answered: false, reason: clipReason(failedReason ?? "The agent ended its turn without an answer.") };
            }
          }
        }
        // 023 R-369: the key-name check is said (as a notice) when the model or key failed; names only.
        // A first turn that failed so begins it as the turn ends, and its query may take seconds: the
        // result waits for it, within the Test's bound. (A start that failed so has already waited.)
        const keyCheck = testConversation.keyNameCheckDone;
        if (keyCheck !== undefined) keyHint ??= await withinDeadline(keyCheck);
        await new Promise<void>((done) => setImmediate(done));
        keyHint ??= keyNotice();
      }
    } catch (error) {
      options.log?.("broker.agent-test-failed", `${agent} ${error instanceof Error ? error.name : "unknown"}`);
      if (start === "ok" && conversation === undefined) start = "agent-exited";
      model = { answered: false, reason: "Hallpass could not run the test." };
    } finally {
      // The process tree first (an adapter starts the CLI under it), then the folder.
      if (conversation !== undefined) {
        const pid = conversation.pid;
        if (pid !== undefined) await killTreeAsync(pid);
        await conversation.close("gone").catch(() => undefined);
        live.delete(conversation);
      }
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {
        options.log?.("broker.agent-test-folder-kept", agent);
      });
    }
    const tools = await browserTools;
    const outcome: AgentTestResult["outcome"] =
      start === "ok" && model.answered ? (tools === "available" ? "passed" : "partial") : "failed";
    const result: AgentTestResult = {
      outcome,
      start,
      model,
      browserTools: tools,
      ...(keyHint === undefined ? {} : { keyHint }),
      ranAt: new Date(clock.now()).toISOString(),
    };
    await writeLastTest(options.dataDir, agent, result);
    return result;
  };

  const run = (agent: ConversationAgent): Promise<AgentTestResult> => {
    const joined = running.get(agent);
    if (joined !== undefined) return joined;
    const started = runOnce(agent).finally(() => running.delete(agent));
    running.set(agent, started);
    return started;
  };

  return {
    run,
    start(agent, onDone) {
      run(agent).then(onDone, (error: unknown) => {
        options.log?.("broker.agent-test-failed", `${agent} ${error instanceof Error ? error.name : "unknown"}`);
        onDone();
      });
    },
    running: (agent) => running.has(agent),
    latestRun(agent) {
      const conversation = latest.get(agent);
      if (conversation === undefined || conversation.runSerial === 0) return undefined;
      return { serial: conversation.runSerial, lines: conversation.diagnostics() };
    },
    async shutdown() {
      await Promise.all(
        [...live].map(async (conversation) => {
          const pid = conversation.pid;
          if (pid !== undefined) await killTreeAsync(pid);
          await conversation.close("gone").catch(() => undefined);
        }),
      );
    },
  };
}
