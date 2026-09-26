import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { isAgentPaired, unpairAgent } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 015 SC-113 (FR-216 - FR-219, contracts/pairing-withdraw.md, T423): a pairing card nobody is
 * waiting on any more leaves the panel.
 *
 * When the host's pairing bound passes it answers the agent `timed-out` and sends `pair-withdraw`;
 * the worker takes that session off the card, and drops the card when nobody is left on it. The
 * claim is that the owner is never left looking at a question the agent was already told nobody
 * answered - so it is read where the owner reads it, on the panel, within 2 s of the agent's answer.
 *
 * **The short bound.** `HALLPASS_AGENT_PAIRING_TIMEOUT_MS` on one `mcp-server` process shortens
 * that session's host bound (mcp-server.ts `PAIRING_TIMEOUT_ENV`). The panel is open throughout, so
 * the worker never asks for the closed-panel extension and the host bound is the one that ends the
 * exchange - while the worker's own mirrored bound is the product's 45 s. A card gone within 2 s of
 * an ~8 s host bound can therefore only have been removed by the withdrawal.
 *
 * **Both link shapes (FR-219).** The host puts a `requestId` on a `pair-request` only once the
 * worker has advertised `pair-withdraw` in a `pair-result`; the withdrawal itself is sent either
 * way. A fresh session's first exchange has had no answer yet, so it is the id-less shape; an
 * exchange after the owner pressed Ignore follows a `pair-result`, so it carries an id. Journey 1
 * covers both. Which shape crossed is not visible from here (the host logs no id), so the two are
 * told apart by construction, not by observation.
 *
 * Pairing is per agent and persists in the extension, so each journey starts by unpairing a pairing
 * an earlier journey left, and never accepts - it leaves the browser unpaired.
 *
 * Attach mode only, like every `agent-*` journey. Prerequisites: `npm run build`, `dist/agent`
 * loaded, `npm run agent-host:install` from this checkout (a 0.7.0 relay/worker never withdraws,
 * and the card would wait out the worker's own 45 s instead).
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
/** The shortened host bound for the session whose card is expected to be withdrawn. */
const SHORT_BOUND_MS = 8_000;
/** SC-113: from the agent's `timed-out` to the card leaving the panel. */
const WITHDRAW_BUDGET_MS = 2_000;
/** The worker's own bound with a panel open (`PAIRING_BOUND_MS`), which must not be what ended it. */
const WORKER_BOUND_MS = 45_000;

test.describe("015 pairing withdrawal", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("a card whose only session timed out leaves the panel within 2 s, first exchange and later (SC-113)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const panel = await unpairedPanel(extensionContext, extensionId, extensionWorker);
    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({
        clientName: "Claude Code",
        env: { HALLPASS_AGENT_PAIRING_TIMEOUT_MS: String(SHORT_BOUND_MS) },
      });
      const live = client;

      // ============ the first exchange: no answer yet, so no requestId ============
      await expectWithdrawnAfterTimeout(live, panel, "first exchange");

      // ============ Ignore: a pair-result, which advertises pair-withdraw ============
      const ignored = live.callTool("tabs_context", {}, { timeoutMs: 60_000 });
      await waitForPairingCard(panel);
      await panel.clickButton(ui("agent.ignore"));
      const declined = await ignored;
      expect(declined.isError, `text: ${declined.text}`).toBe(true);
      expect(declined.json, `text: ${declined.text}`).toMatchObject({ reason: "not-paired" });
      await expect.poll(() => pairingCardUp(panel), { timeout: 5_000 }).toBe(false);

      // ============ a later exchange: raised after that answer, so it carries a requestId ============
      await expectWithdrawnAfterTimeout(live, panel, "later exchange");

      // Both withdrawals were said by the host as sent, not merely attempted.
      expect(live.stderr().split("agent.pair.withdraw-sent").length - 1, live.stderr()).toBeGreaterThanOrEqual(2);
      expect(live.stderr()).not.toContain("agent.pair.withdraw-unsent");
      // And none of this paired the browser.
      expect(await isAgentPaired(panel, locale)).toBe(false);
    } finally {
      await client?.close().catch(() => undefined);
    }
  });

  test("with two sessions waiting, one timing out leaves the card up for the other (SC-113)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const panel = await unpairedPanel(extensionContext, extensionId, extensionWorker);
    let patient: McpHarnessClient | undefined;
    let hurried: McpHarnessClient | undefined;
    try {
      // The patient session keeps the product's bound on the host; the worker's own 45 s is the
      // bound that matters for it, and the journey answers well inside it.
      patient = await startMcpClient({ clientName: "Claude Code" });
      hurried = await startMcpClient({
        clientName: "Claude Code",
        env: { HALLPASS_AGENT_PAIRING_TIMEOUT_MS: String(SHORT_BOUND_MS) },
      });
      const waiting = patient;
      const quick = hurried;

      const patientCall = waiting.callTool("tabs_context", {}, { timeoutMs: 120_000 });
      await waitForPairingCard(panel);
      const startedAt = Date.now();
      const hurriedCall = quick.callTool("tabs_context", {}, { timeoutMs: 60_000 });
      // One card, two sessions on it.
      await panel.waitForText(waitingText(2), SHORT_BOUND_MS - 1_000);
      expect(await pairingCardCount(panel)).toBe(1);

      const timedOut = await hurriedCall;
      const answeredAt = Date.now();
      expect(timedOut.isError, `text: ${timedOut.text}`).toBe(true);
      expect(timedOut.json, `text: ${timedOut.text}`).toMatchObject({
        outcome: "timed-out",
        reason: "not-paired: no answer",
      });
      expect(answeredAt - startedAt).toBeLessThan(WORKER_BOUND_MS);

      // The count drops to one - which the card shows as no count line at all (PromptCard: the
      // line is empty below two) - and the card itself stays, because someone is still waiting.
      await expect
        .poll(() => waitingLine(panel), { timeout: WITHDRAW_BUDGET_MS, intervals: [100] })
        .toBe("");
      // Past the budget, so "stayed" is a fact and not a race with a slow removal.
      await panel.waitForText(ui("agent.pairingTitle"));
      await new Promise((resolve) => setTimeout(resolve, WITHDRAW_BUDGET_MS));
      expect(await pairingCardUp(panel), "the card left while a session was still waiting on it").toBe(true);
      expect(await pairingCardCount(panel)).toBe(1);
      expect(quick.stderr()).toContain("agent.pair.withdraw-sent");

      // The remaining session is still waiting, not answered by the other's withdrawal.
      const stillOpen = await Promise.race([
        patientCall.then(() => "answered" as const),
        new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 500)),
      ]);
      expect(stillOpen, "the patient session's call was ended by the other session's withdrawal").toBe("open");

      // The owner answers the one that is left; Ignore, so the browser stays unpaired.
      await panel.clickButton(ui("agent.ignore"));
      const declined = await patientCall;
      expect(declined.isError, `text: ${declined.text}`).toBe(true);
      expect(declined.json, `text: ${declined.text}`).toMatchObject({ reason: "not-paired" });
      await expect.poll(() => pairingCardUp(panel), { timeout: 5_000 }).toBe(false);
    } finally {
      await hurried?.close().catch(() => undefined);
      await patient?.close().catch(() => undefined);
    }
  });
});

/**
 * One call nobody answers: the card is raised, the host's short bound ends the call `timed-out`,
 * and the card is gone from the panel within the budget - long before the worker's own bound.
 */
async function expectWithdrawnAfterTimeout(client: McpHarnessClient, panel: SidePanelDriver, label: string): Promise<void> {
  const startedAt = Date.now();
  const call: Promise<ToolCallResult> = client.callTool("tabs_context", {}, { timeoutMs: 60_000 });
  await waitForPairingCard(panel);
  const result = await call;
  const answeredAt = Date.now();
  expect(result.isError, `${label}: ${result.text}`).toBe(true);
  expect(result.json, `${label}: ${result.text}\nstderr:\n${client.stderr()}`).toMatchObject({
    outcome: "timed-out",
    reason: "not-paired: no answer",
  });
  // The host's bound ended it, not the worker's and not the client's.
  expect(answeredAt - startedAt, `${label}: answered after ${answeredAt - startedAt} ms`).toBeGreaterThanOrEqual(
    SHORT_BOUND_MS - 1_000,
  );
  expect(answeredAt - startedAt, `${label}: answered after ${answeredAt - startedAt} ms`).toBeLessThan(WORKER_BOUND_MS);

  await expect
    .poll(() => pairingCardUp(panel), { timeout: WITHDRAW_BUDGET_MS, intervals: [100], message: `${label}: card still up` })
    .toBe(false);
  // eslint-disable-next-line no-console -- SC-113's number.
  console.log(`[T423] ${label}: card gone ${Date.now() - answeredAt} ms after the timed-out answer`);
}

/**
 * The owner's panel, open for the whole journey, on a browser no agent is paired with.
 *
 * Open, because an open panel is what keeps the worker from asking the host for the closed-panel
 * two minutes (011 FR-148) - which would make the host bound, and so this journey, 120 s long.
 */
async function unpairedPanel(
  extensionContext: BrowserContext,
  extensionId: string,
  extensionWorker: PackagedWorker,
): Promise<SidePanelDriver> {
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({
    context: extensionContext,
    extensionId,
    fixturePage: ownerPage,
    tabId: ownerTabId,
    copy,
  });
  await panel.waitForText(ui("agent.appTitle"));
  await panel.clickIfPresent(ui("agent.retry"));
  if (await isAgentPaired(panel, locale)) await unpairAgent(panel, { locale });
  expect(await pairingCardUp(panel), "a pairing card was already up before the journey began").toBe(false);
  return panel;
}

async function waitForPairingCard(panel: SidePanelDriver): Promise<void> {
  await expect.poll(() => pairingCardUp(panel), { timeout: 15_000 }).toBe(true);
  await panel.waitForText(ui("agent.pairingTitle"));
}

async function pairingCardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel("document.querySelector('[data-prompt=pairing]') !== null")) === true;
}

async function pairingCardCount(panel: SidePanelDriver): Promise<number> {
  return (await panel.evaluatePanel("document.querySelectorAll('[data-prompt=pairing]').length")) as number;
}

/** The card's waiting-count line, as the owner reads it; `null` with no card. */
async function waitingLine(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('[data-prompt=pairing] .agent-prompt-waiting')?.textContent ?? null",
  )) as string | null;
}

function waitingText(count: number): string {
  return ui("agent.pairingWaiting").replace("{count}", String(count));
}
