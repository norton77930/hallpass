import {
  agentCallBoundMs,
  AGENT_CALL_TIMEOUT_MS,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolOutcome,
  type PromptWaitingFrame,
} from "@hallpass/contracts";

/**
 * Correlation between the agent's MCP calls and the frames that answer them.
 *
 * The link is one duplex stream carrying interleaved frames, so "which answer belongs to which
 * call" is the router's whole job, and it is decided by `callId` rather than by arrival order: two
 * calls on two tabs finish in whichever order the pages allow, and an order-based router would hand
 * one tab's answer to the other tab's caller.
 *
 * The router holds no policy. Pairing, tab ownership and the per-site gate are all decided in the
 * worker, where the owner's decisions live; everything here is about not losing or mixing up an
 * answer.
 */

/**
 * The host's backstop for a call the worker never answers.
 *
 * It is a backstop and nothing else (003 D-M3-1). Every deadline that means something to the owner
 * belongs to the worker: the `ask` prompt's own bound is 25 s there, strictly under this, so a
 * prompt nobody answers is reported as the worker's `timed-out` with the tool's own reason rather
 * than as the transport giving up. This one only exists because an MV3 worker torn down mid-call, a
 * page that never settles, and a relay whose socket died without an EOF all look identical from
 * here, and a promise that never settles turns any of them into a hung agent session. When it does
 * fire, the host also sends a `stop` naming the call, so the worker cancels whatever it was still
 * holding for it instead of prompting the owner about a call that has already been answered.
 *
 * It is the bound for every call whose duration its arguments do not state. A `wait` and a
 * `browser_batch` do state theirs, and are given what they asked for up to a cap
 * (`agentCallBoundMs`): they are the two calls that legitimately outlive this, and cutting them off
 * here would report a call doing exactly what the agent asked for as a transport failure.
 */
export const CALL_TIMEOUT_MS = AGENT_CALL_TIMEOUT_MS;

/**
 * The round trip the backstop leaves after the prompt's own bound (011 R-162).
 *
 * A `prompt-waiting` tick says how much of the question's bound is left; the backstop is re-armed
 * to that plus this. The slack is what makes the *worker's* `timed-out` the answer the agent gets:
 * the worker ends the question at its own bound and sends a real outcome, and this backstop only
 * fires if that answer never arrives at all, which is the transport failure it exists for.
 */
export const KEEP_ALIVE_SLACK_MS = 10_000;

/**
 * The longest a call may be held by ticks, from the moment it was admitted (011 R-162).
 *
 * The two-minute closed-panel bound plus the slack, and not a millisecond more. Without a cap the
 * ticks would be a way for the far side to hold a call open indefinitely - a worker with a stuck
 * prompt, or a frame from anywhere else - and the one promise this router makes is that every call
 * ends. A call whose own arguments asked for longer (`wait`, `browser_batch`) keeps what it asked
 * for: the cap bounds what a tick may *add*, never what the agent already stated.
 */
export const KEEP_ALIVE_CAP_MS = 130_000;

export type CallRouterOptions = {
  /** Writes one frame towards the worker. Throwing here fails the call rather than the router. */
  send: (frame: AgentNativeRequest) => void;
  /**
   * Told when the backstop fired for one call (003 D-M3-1). The agent has already been answered, so
   * whatever the worker is still holding for that call - an `ask` prompt in particular - is a
   * question about a call that is over, and the worker is asked to drop it.
   */
  onTimeout?: (callId: string) => void;
  /**
   * One bound for every call, overriding the per-call one. For tests that need a shorter wait than
   * a real agent would; nothing in the host sets it.
   */
  timeoutMs?: number;
};

type PendingCall = {
  tabKey: number | undefined;
  settle: (response: AgentNativeResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  /** When the call was admitted, so a tick's cap is measured from one fixed point (011). */
  admittedAt: number;
  /** When the backstop is armed to fire, so a tick can only ever move it later. */
  deadline: number;
  /** Fires the backstop; held so a tick can re-arm the same ending rather than describe it twice. */
  expire: () => void;
};

export class CallRouter {
  readonly #send: (frame: AgentNativeRequest) => void;
  readonly #onTimeout: ((callId: string) => void) | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #pending = new Map<string, PendingCall>();
  /** The tabs with a call in flight, so the second call on a busy tab is refused without a round trip. */
  readonly #busyTabs = new Set<number>();

  constructor(options: CallRouterOptions) {
    this.#send = options.send;
    this.#onTimeout = options.onTimeout;
    this.#timeoutMs = options.timeoutMs;
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  /**
   * Sends one call and resolves with its single answer.
   *
   * The promise always resolves - never rejects - because every ending of a tool call is one of the
   * contract's outcomes, and a rejection would make the transport's failures a different shape from
   * the page's failures for the agent to handle.
   */
  call(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId, tabId } = request;
    if (this.#pending.has(callId)) {
      return Promise.resolve({ callId, outcome: "failed", reason: "duplicate-call-id" });
    }
    if (tabId !== undefined && this.#busyTabs.has(tabId)) {
      // FR-043: one call in flight per tab. Calls that name no tab concern no page, so two of them
      // (a `tabs_context` while another is outstanding) do not contend and are not refused here.
      return Promise.resolve({ callId, outcome: "busy", reason: "tab-in-flight" });
    }
    return new Promise<AgentNativeResponse>((resolve) => {
      const expire = (): void => {
        const pending = this.#take(callId);
        if (!pending) return;
        pending.settle({ callId, outcome: "timed-out", reason: "no-answer" });
        // Only after the answer: the agent is never left waiting on the worker acknowledging this.
        this.#onTimeout?.(callId);
      };
      // The bound comes from the call's own validated arguments, so a wait or a batch is given the
      // time it stated and every other call keeps the flat backstop.
      const boundMs = this.#timeoutMs ?? agentCallBoundMs(request.tool, request.args);
      const admittedAt = Date.now();
      const timer = setTimeout(expire, boundMs);
      // `unref` where the runtime has it: a pending call must not be the reason the process refuses
      // to exit after its streams have closed.
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(callId, {
        tabKey: tabId,
        settle: resolve,
        timer,
        admittedAt,
        deadline: admittedAt + boundMs,
        expire,
      });
      if (tabId !== undefined) {
        this.#busyTabs.add(tabId);
      }
      try {
        this.#send(request);
      } catch {
        // The link went away underneath the call. 004: `bridge-unavailable` means there is no relay
        // at all, and a call that reached the router had one a moment ago.
        this.#take(callId)?.settle({ callId, outcome: "failed", reason: "bridge-lost" });
      }
    });
  }

  /**
   * Delivers one answer. Returns whether it matched a call still waiting, so a caller can log a
   * frame that names a call that already timed out instead of silently dropping it.
   */
  settle(response: AgentNativeResponse): boolean {
    const pending = this.#take(response.callId);
    if (!pending) {
      return false;
    }
    pending.settle(response);
    return true;
  }

  /**
   * The worker says one of its questions is still waiting, so the backstop steps back (011 FR-150).
   *
   * The only reason a call is held longer than the flat backstop is that a person is being asked
   * something they cannot yet see - a pairing or consent card in a side panel Chrome will not let
   * the worker open (R-160). The worker fixed that question's bound when it raised it and repeats
   * the arithmetic in every tick, so nothing is remembered here between ticks: the new ending is
   * "the rest of the bound, plus a round trip", and the worker's own `timed-out` is expected to
   * arrive inside that slack.
   *
   * Three things it deliberately does not do. It never extends a call this router is not holding -
   * a tick naming another session's call, or the pairing tick that names no call at all, is not
   * this router's business. It never moves an ending *earlier*, so a `browser_batch` that asked for
   * five minutes and raised a prompt on the way does not end at two. And it never postpones past
   * `KEEP_ALIVE_CAP_MS` from the moment the call was admitted, so a stuck prompt cannot hold a call
   * open for as long as it likes.
   */
  noteWaiting(frame: PromptWaitingFrame): void {
    if (frame.callId === undefined) {
      return;
    }
    const pending = this.#pending.get(frame.callId);
    if (!pending) {
      return;
    }
    const now = Date.now();
    const asked = now + Math.max(0, frame.boundMs - frame.waitedMs) + KEEP_ALIVE_SLACK_MS;
    const deadline = Math.max(pending.deadline, Math.min(asked, pending.admittedAt + KEEP_ALIVE_CAP_MS));
    if (deadline <= pending.deadline) {
      return;
    }
    clearTimeout(pending.timer);
    pending.deadline = deadline;
    pending.timer = setTimeout(pending.expire, deadline - now);
    (pending.timer as { unref?: () => void }).unref?.();
  }

  /** Ends every call in flight with one outcome; used when the link closes. */
  failAll(outcome: AgentToolOutcome, reason: string): void {
    for (const callId of [...this.#pending.keys()]) {
      this.#take(callId)?.settle({ callId, outcome, reason });
    }
  }

  #take(callId: string): PendingCall | undefined {
    const pending = this.#pending.get(callId);
    if (!pending) {
      return undefined;
    }
    this.#pending.delete(callId);
    clearTimeout(pending.timer);
    if (pending.tabKey !== undefined) {
      this.#busyTabs.delete(pending.tabKey);
    }
    return pending;
  }
}
