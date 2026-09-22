import { randomBytes } from "node:crypto";
import {
  listenAndPublish,
  type FrameChannel,
  type HostEnvironment,
  type PublishedRelay,
} from "@hallpass/agent-host";
import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  type AgentControlFrame,
  type AgentNativeRequest,
  type AgentNativeResponse,
} from "@hallpass/contracts";

/**
 * A stand-in for Chrome's side of the bridge (T020, flipped for 004/S1).
 *
 * It does exactly what the relay plus the service worker do on the wire - publish `bridge.json`,
 * accept the servers that dial in, acknowledge a greeting that carries the record's token, answer
 * control frames and tool calls - and nothing else. That is what lets the MCP server's own
 * behaviour (pairing before tools, correlation, outcomes) be proven as a unit test, with no Chrome,
 * no registry and no installed host in the way.
 *
 * Since 004/R-111 it is the *listening* side: the server dials it. The direction is the whole point
 * of S1, so a harness left on the old one would prove the server against a link nothing speaks.
 *
 * It is deliberately not a second implementation of any policy: the answers come from a table the
 * test writes, so a test can only assert what the *server* did. It is not a second implementation
 * of the relay either - `createRelayMux` is the relay's routing and has its own tests; this hands
 * each answer straight back on the socket the call arrived on.
 */

export type ScriptedAnswer =
  | AgentNativeResponse
  | ((request: AgentNativeRequest) => AgentNativeResponse)
  /**
   * The call is recorded but never answered (004/T162) - a worker mid-call when the link it was
   * answering on goes away, which is the one shape a fixed `AgentNativeResponse` cannot express.
   */
  | "hang";

export type FakeAgentWorkerOptions = {
  /** Which `LOCALAPPDATA` the `bridge.json` goes under; tests point this at a temp dir. */
  env?: HostEnvironment;
  /** How the owner answers the pairing prompt. `ignore` never answers, which is the timeout case. */
  pairing?: "accept" | "decline" | "ignore";
  /** Per-tool answers. A tool with no entry is answered `failed`/`no-script`. */
  answers?: Partial<Record<string, ScriptedAnswer>>;
  /**
   * A token to demand that is not the one published, so the server's greeting cannot match it.
   * Stands in for a server that did not read this relay's record.
   */
  token?: string;
  /**
   * The browser run this worker says it belongs to, carried on its pairing answer (013/R-184).
   *
   * Absent is a worker from before the field existed, which is what every test that does not name
   * one exercises. Two fake workers started in one test with the *same* id are one browser whose
   * relay was respawned - a recycled service worker - and with different ids they are two browsers.
   */
  browserRunId?: string;
};

export type FakeAgentWorker = {
  /** Every control frame the server sent, in order - the pairing exchange as the worker saw it. */
  readonly controlFrames: readonly AgentControlFrame[];
  /** Every tool call the server sent, in order. */
  readonly requests: readonly AgentNativeRequest[];
  /** Every greeting the server sent, in order - one per attach, and one more per re-greeting (006). */
  readonly hellos: Array<{ sessionId: string }>;
  /** Sends a frame the worker originates, e.g. an unpair arriving as `pair-result{accepted:false}`. */
  send(frame: unknown): void;
  waitForControlFrame(type: AgentControlFrame["type"], timeoutMs?: number): Promise<AgentControlFrame>;
  close(): Promise<void>;
};

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

export async function startFakeAgentWorker(options: FakeAgentWorkerOptions = {}): Promise<FakeAgentWorker> {
  const controlFrames: AgentControlFrame[] = [];
  const requests: AgentNativeRequest[] = [];
  const hellos: Array<{ sessionId: string }> = [];
  const pairing = options.pairing ?? "accept";
  const published = randomBytes(32).toString("hex");
  const demanded = options.token ?? published;
  /** The sessions attached right now, newest last; a test's own frames go to the newest. */
  const attached: FrameChannel[] = [];

  const relay: PublishedRelay = await listenAndPublish(
    {
      onFrame(channel, value) {
        const link = agentLinkFrameSchema.safeParse(value);
        if (link.success && link.data.type === "hello") {
          if (link.data.token !== demanded) {
            // The relay's own refusal: a peer that cannot present the record's token never reaches
            // the worker at all, so no pairing prompt is ever raised for it.
            void channel.close();
            return;
          }
          if (!attached.includes(channel)) attached.push(channel);
          hellos.push({ sessionId: link.data.sessionId });
          channel.send({ type: "hello-ack", relayPid: process.pid });
          return;
        }
        const request = agentNativeRequestSchema.safeParse(value);
        if (request.success) {
          requests.push(request.data);
          const scripted = options.answers?.[request.data.tool];
          if (scripted === "hang") {
            return;
          }
          const answer: AgentNativeResponse =
            scripted === undefined
              ? { callId: request.data.callId, outcome: "failed", reason: "no-script" }
              : typeof scripted === "function"
                ? scripted(request.data)
                : { ...scripted, callId: request.data.callId };
          channel.send(answer);
          return;
        }
        const control = agentControlFrameSchema.safeParse(value);
        if (!control.success) {
          return;
        }
        controlFrames.push(control.data);
        if (control.data.type === "pair-request" && pairing !== "ignore") {
          channel.send({
            type: "pair-result",
            agentId: control.data.agentId,
            // Echoed from the request (T094a): the relay addresses a worker frame by its session,
            // so an answer that named none would be dropped before it reached this server.
            sessionId: control.data.sessionId,
            accepted: pairing === "accept",
            // 013/R-184: the worker's own answer is the frame that says which browser run this is.
            ...(options.browserRunId === undefined ? {} : { browserRunId: options.browserRunId }),
          });
        }
      },
      onClose(channel) {
        const index = attached.indexOf(channel);
        if (index >= 0) {
          attached.splice(index, 1);
        }
      },
    },
    { ...(options.env ? { env: options.env } : {}), token: published },
  );

  return {
    controlFrames,
    requests,
    hellos,
    send(frame) {
      attached.at(-1)?.send(frame);
    },
    async waitForControlFrame(type, timeoutMs = 5_000) {
      await waitFor(() => controlFrames.some((frame) => frame.type === type), timeoutMs, `control frame '${type}'`);
      const found = controlFrames.find((frame) => frame.type === type);
      if (!found) {
        throw new Error(`control frame '${type}' vanished`);
      }
      return found;
    },
    async close() {
      // Closes every attached socket, stops listening and retracts the record, which is what a
      // browser going away looks like to a server that is dialling.
      await relay.close();
    },
  };
}
