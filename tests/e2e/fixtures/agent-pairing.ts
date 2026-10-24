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
 * The part of `SettingsPageDriver` (`settings-page-driver.ts`) the unpair helper uses, named
 * structurally for the same reason `PairingPanel` is: the helper is also driven against a rendered
 * settings view in jsdom.
 */
export type PairingSettings = {
  /** Moves the page to a route (`#sites`) and waits for that section. */
  goto(route: string): Promise<void>;
  evaluateSettings(expression: string, userGesture?: boolean): Promise<unknown>;
};

/**
 * Unpairs on the settings page (024 FR-385, R-385): Sites & permissions lists the paired outside
 * agents, each with its own Unpair - the status row's menu holds only "Settings" now (FR-392). With
 * `agentName` it is that agent's row, otherwise the first one. Resolves once the side panel is back on
 * the not-connected page, which is the signal that is false while anything is still paired.
 */
export async function unpairAgent(
  panel: PairingPanel,
  settings: PairingSettings,
  options: PairingOptions & { agentName?: string },
): Promise<void> {
  const { locale, timeoutMs = 30_000, pollMs = 250, agentName } = options;
  await settings.goto("#sites");
  const unpairText = lookup("settings.outside.unpair", locale);
  const label =
    agentName === undefined ? undefined : lookup("settings.outside.unpairLabel", locale).replace("{name}", () => agentName);
  const clicked = await settings.evaluateSettings(
    `(()=>{const b=[...document.querySelectorAll('[data-paired] button')].find((x)=>${
      label === undefined
        ? `x.textContent?.trim()===${JSON.stringify(unpairText)}`
        : `x.getAttribute('aria-label')===${JSON.stringify(label)}`
    });if(!b)return false;b.click();return true})()`,
    true,
  );
  if (clicked !== true) throw new Error(`agent-unpair-missing:${agentName ?? "first paired agent"}`);
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
  const arrival = await awaitPairingPrompt(panel, locale, deadline, pollMs);
  if (arrival.kind === "timeout") throw new Error(`agent-pairing-prompt-timeout:${arrival.lastText}`);
  return arrival.kind === "already-paired" ? "already-paired" : clickAcceptAndConfirm(panel, locale, deadline, pollMs);
}

type PromptArrival = { kind: "prompted" } | { kind: "already-paired" } | { kind: "timeout"; lastText: string };

async function awaitPairingPrompt(
  panel: PairingPanel,
  locale: AppLocale,
  deadline: number,
  pollMs: number,
): Promise<PromptArrival> {
  const pairingTitle = lookup("agent.pairingTitle", locale);
  let lastText = "";
  while (Date.now() < deadline) {
    // The pairing an earlier run left in extension storage is answered by the worker without ever
    // asking the owner again, so an already-paired panel is a legitimate arrival - but it is read
    // off the same discriminating signal, never assumed.
    if (await isAgentPaired(panel, locale)) return { kind: "already-paired" };
    lastText = await panel.panelText();
    if (lastText.includes(pairingTitle)) return { kind: "prompted" };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { kind: "timeout", lastText };
}

async function clickAcceptAndConfirm(
  panel: PairingPanel,
  locale: AppLocale,
  deadline: number,
  pollMs: number,
): Promise<PairingOutcome> {
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
  const { locale, timeoutMs = 30_000, pollMs = 250 } = options;
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Past the SDK's 60 s default and the host's own pairing bound, so the harness is never what ends
  // the call; the card wait below is the bound this helper answers to.
  const issue = () =>
    client.callTool("tabs_context", {}, { timeoutMs: timeoutMs + 60_000 }).then(
      // Settled either way, so a card that never came does not leave an unhandled rejection behind.
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
  let answered = issue();
  // A relay that dies while carrying the first call takes the call with it and no card is ever
  // raised (gate run 20261021-054821, attempt 2). So when no card has come by half the bound, the
  // call is issued once more - the MCP server dials whichever relay serves the browser by then -
  // and the second call has the rest of the same bound. The first call's late answer is ignored.
  let arrival = await awaitPairingPrompt(panel, locale, started + Math.floor(timeoutMs / 2), pollMs);
  if (arrival.kind === "timeout") {
    console.log(
      `[pairing-retry] no pairing prompt ${Date.now() - started} ms after the first tabs_context; issuing it once more (panel: ${arrival.lastText.slice(0, 160)})`,
    );
    answered = issue();
    arrival = await awaitPairingPrompt(panel, locale, deadline, pollMs);
  }
  if (arrival.kind === "timeout") {
    throw new Error(`agent-pairing-prompt-timeout:${arrival.lastText}\nstderr:\n${client.stderr()}`);
  }
  const outcome =
    arrival.kind === "already-paired" ? "already-paired" : await clickAcceptAndConfirm(panel, locale, deadline, pollMs);
  const settled = await answered;
  if ("error" in settled) {
    throw new Error(`agent-pairing-first-call-failed:${String(settled.error)}\nstderr:\n${client.stderr()}`);
  }
  if (settled.result.isError) {
    throw new Error(`agent-pairing-first-call-refused:${settled.result.text}\nstderr:\n${client.stderr()}`);
  }
  return outcome;
}
