import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ElicitResultSchema,
  type ClientCapabilities,
  type ElicitRequestFormParams,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TERMINAL_CONSENT_FEATURE,
  type PromptAnswerFrame,
  type PromptChoice,
  type PromptRaisedFrame,
  type PromptSettledFrame,
} from "@hallpass/contracts";

/**
 * 031 terminal consent, the host's half (R-450..R-453, contracts/terminal-consent.md).
 *
 * The worker keeps the one pending question and stays the only party that admits or refuses. This
 * module is one more place the owner's answer can come from: when the worker says a question was
 * raised for one of this session's calls, the agent's own MCP client is asked the same question,
 * and an explicit choice there goes back as `prompt-answer`. The worker settles it first-answer-wins
 * and says so with `prompt-settled`, which ends the request here.
 *
 * The one rule that carries the weight (R-452, D-031-5): only `accept` with one of the choices the
 * worker offered is an answer. A decline, a cancel, a result of the wrong shape, a choice nobody
 * offered, an error, the timeout and an abort all send nothing, so the side-panel card keeps waiting.
 * A client that dismisses by itself can therefore neither refuse nor admit on the owner's behalf.
 */

/**
 * How much earlier than the worker's bound the client's request gives up (R-453). The worker's own
 * `timed-out` must be the answer the agent gets, and a client still showing the question after the
 * card has gone would offer the owner a choice that can no longer count.
 */
export const ELICITATION_MARGIN_MS = 2_000;

/** What the owner reads for each choice (contracts/terminal-consent.md). */
export const PROMPT_CHOICE_TITLES: Readonly<Record<PromptChoice, string>> = {
  once: "Allow once",
  session: "Allow on this site for this session",
  deny: "Deny",
};

/**
 * Whether the client said at initialize that it can show a form (R-451).
 *
 * `elicitation.form` is the current shape. A bare `elicitation: {}` predates modes and means form
 * for backward compatibility; the SDK's `elicitInput` refuses it, which is why the request below is
 * sent through the low-level API. `url` alone is not a form.
 */
export function clientCanBeAsked(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation: unknown = capabilities?.elicitation;
  if (typeof elicitation !== "object" || elicitation === null) {
    return false;
  }
  const modes = elicitation as Record<string, unknown>;
  return modes.form !== undefined || Object.keys(modes).length === 0;
}

/**
 * 032 R-485 (contracts/terminal-consent-032.md): a site change and a site plan say their `session`
 * in their own words - the transition card's Continue and the site-plan card's approval, both for
 * this session only. Neither kind has a word for "always": that stays Chrome's (D-032-1).
 */
const SESSION_TITLES: Readonly<Partial<Record<PromptRaisedFrame["kind"], string>>> = {
  transition: "Continue for this session",
  "site-plan": "Allow these sites for this session",
};

function titleOf(kind: PromptRaisedFrame["kind"], choice: PromptChoice): string {
  return (choice === "session" ? SESSION_TITLES[kind] : undefined) ?? PROMPT_CHOICE_TITLES[choice];
}

/** What the form asks, per kind: both ends of a move, every site of a plan, or the effect on its site. */
function messageOf(frame: PromptRaisedFrame, agentLabel: string): string {
  if (frame.kind === "transition") {
    return `Hallpass: ${agentLabel}'s tab moved from ${frame.from ?? "another site"} to ${frame.site}. Continue on ${frame.site}?`;
  }
  if (frame.kind === "site-plan") {
    const sites = frame.sites ?? [frame.site];
    return `Hallpass: allow ${agentLabel} to act on these sites for this session: ${sites.join(", ")}?`;
  }
  return `Hallpass: allow ${agentLabel} to ${frame.action} on ${frame.site}?`;
}

/** The form for one raised question: one required `choice`, offering exactly what the worker did. */
export function elicitationParams(frame: PromptRaisedFrame, agentLabel: string): ElicitRequestFormParams {
  const choices = [...frame.choices];
  return {
    message: messageOf(frame, agentLabel),
    requestedSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          title: "Your answer",
          description: choices.map((choice) => `${choice}: ${titleOf(frame.kind, choice)}`).join("; "),
          enum: choices,
          enumNames: choices.map((choice) => titleOf(frame.kind, choice)),
        },
      },
      required: ["choice"],
    },
  };
}

/**
 * The owner's choice in a client's result, or `undefined` when the result is not an answer (R-452).
 * `offered` is the raised frame's own list: a `session` the worker did not offer is not a choice.
 */
export function choiceFromResult(result: unknown, offered: readonly PromptChoice[]): PromptChoice | undefined {
  const parsed = ElicitResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.action !== "accept") {
    return undefined;
  }
  const choice = parsed.data.content?.choice;
  return typeof choice === "string" && (offered as readonly string[]).includes(choice)
    ? (choice as PromptChoice)
    : undefined;
}

/** Where one question's answer goes: the link its call runs on (018 R-272). */
export type ConsentRoute = {
  /** The worker's latest advertised features on that link, read at ask time and again at answer time. */
  features: () => ReadonlySet<string>;
  /** Sends one frame on that link; `false` when the link is down. */
  send: (frame: PromptAnswerFrame) => boolean;
};

/** How one raised question ended here. Only `answered` sent anything to the worker. */
export type ConsentOutcome = "answered" | "no-answer" | "not-asked";

export type TerminalConsent = {
  /**
   * A question was raised for one of this session's calls. The caller has already checked that the
   * call is in flight on `route`'s link. Resolves when the request has ended, however it ended.
   */
  raised: (frame: PromptRaisedFrame, route: ConsentRoute) => Promise<ConsentOutcome>;
  /** The worker settled one question (by `promptId`): its open request, if any, is aborted. */
  settled: (frame: PromptSettledFrame) => void;
  /** The tool call ended: its open request, if any, is aborted. */
  callEnded: (callId: string) => void;
  /** The session is ending: every open request is aborted. */
  closeAll: () => void;
  /** The calls with a request open, for tests and diagnosis. */
  openCallIds: () => string[];
};

export type TerminalConsentOptions = {
  sessionId: string;
  /** This process's SDK server: its client's capabilities and its low-level request API. */
  server: Pick<Server, "getClientCapabilities" | "request">;
  /** How the question names the agent session (its client name and project label). */
  agentLabel: () => string;
  log?: (code: string, detail?: string) => void;
};

export function createTerminalConsent(options: TerminalConsentOptions): TerminalConsent {
  const log = options.log ?? ((): void => undefined);
  /**
   * One open request per question, keyed by the worker's `promptId` (T929 I1): a batch's steps share
   * one call, so the call does not say which question a request is for. A repeated raise of the
   * same question never opens a second.
   */
  const open = new Map<string, { callId: string; controller: AbortController }>();

  function abort(promptId: string, reason: string): void {
    const entry = open.get(promptId);
    if (entry === undefined) return;
    open.delete(promptId);
    entry.controller.abort(reason);
  }

  async function raised(frame: PromptRaisedFrame, route: ConsentRoute): Promise<ConsentOutcome> {
    if (frame.sessionId !== options.sessionId) {
      // The relay addresses worker frames by session and never broadcasts; one that names another
      // session should not be here, and asking about it would show this owner someone else's call.
      log("agent.consent.other-session");
      return "not-asked";
    }
    if (!clientCanBeAsked(options.server.getClientCapabilities())) {
      return "not-asked";
    }
    if (!route.features().has(TERMINAL_CONSENT_FEATURE)) {
      // A worker that cannot take the answer is never asked about (R-459): the choice would vanish.
      log("agent.consent.worker-cannot-answer");
      return "not-asked";
    }
    if (open.has(frame.promptId)) {
      log("agent.consent.duplicate-raise");
      return "not-asked";
    }
    const controller = new AbortController();
    open.set(frame.promptId, { callId: frame.callId, controller });
    log("agent.consent.asked", frame.kind);
    let result: unknown;
    try {
      result = await options.server.request(
        { method: "elicitation/create", params: elicitationParams(frame, options.agentLabel()) },
        ElicitResultSchema,
        { signal: controller.signal, timeout: Math.max(1, frame.boundMs - ELICITATION_MARGIN_MS) },
      );
    } catch {
      // A timeout, an abort, a client error and a result outside the SDK's schema are all no answer.
      log("agent.consent.no-answer", controller.signal.aborted ? "aborted" : "failed");
      return "no-answer";
    } finally {
      if (open.get(frame.promptId)?.controller === controller) open.delete(frame.promptId);
    }
    if (controller.signal.aborted) {
      // The question was settled elsewhere while the client's reply was on its way.
      log("agent.consent.no-answer", "aborted");
      return "no-answer";
    }
    const choice = choiceFromResult(result, frame.choices);
    if (choice === undefined) {
      const action = ElicitResultSchema.safeParse(result);
      log("agent.consent.no-answer", action.success ? action.data.action : "invalid");
      return "no-answer";
    }
    if (!route.features().has(TERMINAL_CONSENT_FEATURE)) {
      log("agent.consent.worker-cannot-answer");
      return "no-answer";
    }
    // The question's id goes back unchanged: the worker honours the answer only while that question
    // is the one open, never the next question of the same call (T929 I1).
    const sent = route.send({
      type: "prompt-answer",
      sessionId: options.sessionId,
      callId: frame.callId,
      promptId: frame.promptId,
      choice,
    });
    log(sent ? "agent.consent.answered" : "agent.consent.answer-unsent", choice);
    return sent ? "answered" : "no-answer";
  }

  return {
    raised,
    settled(frame) {
      if (frame.sessionId !== options.sessionId) {
        log("agent.consent.other-session");
        return;
      }
      abort(frame.promptId, "prompt-settled");
    },
    callEnded(callId) {
      for (const [promptId, entry] of [...open]) {
        if (entry.callId === callId) abort(promptId, "call-ended");
      }
    },
    closeAll() {
      for (const promptId of [...open.keys()]) abort(promptId, "session-closing");
    },
    openCallIds() {
      return [...open.values()].map((entry) => entry.callId);
    },
  };
}
