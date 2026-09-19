import {
  agentCallBoundMs,
  AGENT_CALL_TIMEOUT_MS,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolOutcome,
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
      // The bound comes from the call's own validated arguments, so a wait or a batch is given the
      // time it stated and every other call keeps the flat backstop.
      const timer = setTimeout(() => {
        const pending = this.#take(callId);
        if (!pending) return;
        pending.settle({ callId, outcome: "timed-out", reason: "no-answer" });
        // Only after the answer: the agent is never left waiting on the worker acknowledging this.
        this.#onTimeout?.(callId);
      }, this.#timeoutMs ?? agentCallBoundMs(request.tool, request.args));
      // `unref` where the runtime has it: a pending call must not be the reason the process refuses
      // to exit after its streams have closed.
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(callId, { tabKey: tabId, settle: resolve, timer });
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
