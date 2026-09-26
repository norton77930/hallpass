import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";

/**
 * 004/T098a — the one way a packaged journey establishes pairing.
 *
 * Every `agent-*.spec.ts` used to carry its own copy of this, and the copy proved nothing. It
 * returned as soon as the panel's text contained the agent's display name - but the *pairing prompt
 * itself* renders that name, so the copy could skip the Accept click and report success - and the
 * journeys then waited for `agent.pairedTitle`, which is a permanent section heading that is on
 * screen even above the sentence "no agents are paired". A journey built on either signal could run
 * its whole tool list against an unpaired browser and only fail somewhere else, or not at all.
 *
 * What this helper does instead is the only shape that is evidence:
 *   1. it waits for the *pending prompt* by its own locale key, `agent.pairingTitle`;
 *   2. it clicks Accept, and fails loudly if the button is not there;
 *   3. it confirms with a signal that is false when nothing is paired - the composition the
 *      rebuilt shell derives from the projection (006 R-125), read off its `data-agent-state`
 *      attribute: `idle` or `sessions` only ever renders for a paired browser, and the
 *      not-connected page renders for everything else.
 *
 * It is locale-driven throughout, so the owner's zh-TW browser and an en-US run take the same path.
 */

/**
 * The part of `SidePanelDriver` this helper uses, named structurally so the helper can also be
 * driven against a rendered panel in jsdom - which is where its discrimination is proven.
 */
export type PairingPanel = {
  panelText(): Promise<string>;
  clickIfPresent(label: string): Promise<boolean>;
  evaluatePanel(expression: string, userGesture?: boolean): Promise<unknown>;
};

export type PairingOptions = {
  locale: AppLocale;
  /** The whole bound: waiting for the prompt and then for the panel to say it is paired. */
  timeoutMs?: number;
  pollMs?: number;
};

/** `accepted` when this call did the pairing, `already-paired` when a previous run had. */
export type PairingOutcome = "accepted" | "already-paired";

/** The expression that reads the shell's composition; `null` when the shell is not on screen. */
const SHELL_STATE_EXPRESSION =
  "document.querySelector('[data-agent-state]')?.getAttribute('data-agent-state') ?? null";

/**
 * Whether the panel is showing a *paired* browser, as opposed to a page about pairing.
 *
 * The shell computes its composition from the worker's projection alone (006 R-125): `idle` and
 * `sessions` exist only when the bridge is up and an agent is paired, and both the pairing card and
 * the agent's name can be on screen over the not-connected page. Reading the composition rather
 * than any sentence keeps a half-rendered frame from being read as pairing. The status row's
 * "connected" word is cross-checked, so the two renderings of the fact have to agree.
 */
export async function isAgentPaired(panel: PairingPanel, locale: AppLocale): Promise<boolean> {
  const state = await panel.evaluatePanel(`(()=>${SHELL_STATE_EXPRESSION})()`);
  if (state !== "idle" && state !== "sessions") return false;
  return (await panel.panelText()).includes(lookup("agent.status.connected", locale));
}

/**
 * Unpairs from the status row (006 FR-083): the control sits behind the overflow menu, so it is
 * opened first. Resolves once the shell is back on the not-connected page.
 */
export async function unpairAgent(panel: PairingPanel, options: PairingOptions): Promise<void> {
  const { locale, timeoutMs = 30_000, pollMs = 250 } = options;
  const opened = await panel.clickIfPresent(lookup("agent.status.menu", locale));
  if (!opened) throw new Error("agent-status-menu-missing");
  const clicked = await panel.clickIfPresent(lookup("agent.unpair", locale));
  if (!clicked) throw new Error("agent-unpair-missing");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await panel.evaluatePanel(`(()=>${SHELL_STATE_EXPRESSION})()`)) === "not-connected") return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`agent-unpair-not-confirmed:${await panel.panelText()}`);
}

export async function acceptPairing(panel: PairingPanel, options: PairingOptions): Promise<PairingOutcome> {
  const { locale, timeoutMs = 30_000, pollMs = 250 } = options;
  const deadline = Date.now() + timeoutMs;
  const pairingTitle = lookup("agent.pairingTitle", locale);

  let prompted = false;
  let lastText = "";
  while (Date.now() < deadline) {
    // The pairing an earlier run left in extension storage is answered by the worker without ever
    // asking the owner again, so an already-paired panel is a legitimate arrival - but it is read
    // off the same discriminating signal, never assumed.
    if (await isAgentPaired(panel, locale)) return "already-paired";
    lastText = await panel.panelText();
    if (lastText.includes(pairingTitle)) {
      prompted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!prompted) throw new Error(`agent-pairing-prompt-timeout:${lastText}`);

  const clicked = await panel.clickIfPresent(lookup("agent.accept", locale));
  if (!clicked) throw new Error("agent-pairing-accept-missing");

  while (Date.now() < deadline) {
    if (await isAgentPaired(panel, locale)) return "accepted";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`agent-pairing-not-confirmed:${await panel.panelText()}`);
}

/**
 * The part of `McpHarnessClient` the helper below uses, named structurally for the same reason
 * `PairingPanel` is.
 */
export type PairingCaller = {
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<{ isError: boolean; text: string }>;
  stderr(): string;
};

/**
 * 004 FR-059a — the pairing request is raised by a tool call, never by connecting.
 *
 * So a journey that pairs has to *call* first: this starts a `tabs_context` (a read that touches no
 * tab), accepts the card that call raised through `acceptPairing`, and then requires the call itself
 * to have come back answered - the call waiting on the owner and the owner answering are one
 * exchange, and a journey that saw only half of it would prove nothing about the other.
 */
export async function pairWithFirstCall(
  client: PairingCaller,
  panel: PairingPanel,
  options: PairingOptions,
): Promise<PairingOutcome> {
  const { timeoutMs = 30_000 } = options;
  // Past the SDK's 60 s default and the host's own pairing bound, so the harness is never what ends
  // the call; the card wait below is the bound this helper answers to.
  const first = client.callTool("tabs_context", {}, { timeoutMs: timeoutMs + 60_000 });
  // Settled either way, so a card that never came does not leave an unhandled rejection behind.
  const answered = first.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const outcome = await acceptPairing(panel, options);
  const settled = await answered;
  if ("error" in settled) {
    throw new Error(`agent-pairing-first-call-failed:${String(settled.error)}\nstderr:\n${client.stderr()}`);
  }
  if (settled.result.isError) {
    throw new Error(`agent-pairing-first-call-refused:${settled.result.text}\nstderr:\n${client.stderr()}`);
  }
  return outcome;
}
