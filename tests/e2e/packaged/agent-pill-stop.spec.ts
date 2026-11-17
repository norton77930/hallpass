import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { hostDataDirectory } from "@hallpass/agent-host";
import { HELD_HINT } from "@hallpass/contracts";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { clickOnCard, copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, readLiveBrowserRecords, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 034 FR-523: the words, written out here rather than read from the catalog, so a drifted catalog
 * is a red test and not a green one. The pill's words come from the worker (R-518); these are what
 * the owner reads on the page and on the card.
 */
const WORDS = {
  "en-US": {
    stop: "Stop",
    held: "Stopped",
    resume: "Resume",
    cardHeld: "Stopped from the page",
    cardResume: "Resume",
    stopUndelivered:
      "Stop didn't reach Hallpass. Open the side panel (toolbar icon or Alt+A) and choose End session.",
  },
  "zh-TW": {
    stop: "停止",
    held: "已停止",
    resume: "繼續",
    cardHeld: "已從頁面停止",
    cardResume: "繼續",
    stopUndelivered: "停止沒有送達。請打開側邊欄（工具列圖示或 Alt+A），按「結束工作階段」。",
  },
} as const;
const words = WORDS[locale];

/** The pill's own attribute (`INDICATOR_PILL_ATTRIBUTE`, content-runtime/indicator.ts), spelled out for the page side. */
const PILL = "data-hallpass-pill";

/**
 * 034 / T1017 - Stop and Resume on the in-page pill, end to end (quickstart scenarios 1-11).
 *
 * Every press on the pill's controls is made the way a person makes it: `Input.dispatchMouseEvent`
 * through CDP at the control's own coordinates, so the click the content script sees is trusted
 * (agent-claim.spec.ts does the same for the "back to the agent's tab" control). The one exception is
 * scenario 5, which calls `click()` from the page's own world to show that does nothing.
 *
 * Attach mode only, like every agent journey: the bridge is a machine install.
 *
 * Locale: the browser decides its own UI language and `HALLPASS_LOCALE` says which one it was started
 * with, so a locale cannot be switched per test. Scenario 1 therefore runs under en-US and scenario 11
 * (the same story, with the zh-TW words) under `HALLPASS_LOCALE=zh-TW`; each is skipped under the
 * other. Scenarios 2-10 run under either and read their words from the table above.
 *
 * Prerequisites: `npm run build`, `apps/extension/dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (`npm run dev:test-pages`).
 */
test.describe("pill stop", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("1. Stop on the pill holds the session; the pill and the card say so within a second", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.skip(locale !== "en-US", "scenario 11 is this story under HALLPASS_LOCALE=zh-TW");
    test.setTimeout(240_000);
    await stoppedFromThePage({ extensionContext, extensionId, extensionWorker }, testInfo, "s01");
  });

  test("2. a held session's calls all answer stopped / owner-held and the page is untouched", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { tabId, page } = await openHeldTab(journey, client, "/ordinary");
      const ref = await refFor(client, tabId, "Safe action");
      const baseline = await clickedText(page);
      expect(baseline).toBe("not clicked yet");

      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);

      const calls: Array<[string, Record<string, unknown>]> = [
        ["click", { tabId, target: { ref } }],
        ["read_page", { tabId, filter: "all" }],
        ["screenshot", { tabId }],
        ["tabs_context", {}],
        ["find", { tabId, query: "Safe action" }],
      ];
      for (const [tool, args] of calls) {
        const result = await client.callTool(tool, args);
        expectHeldRefusal(result, tool, client);
      }
      // The refused click never reached the page.
      await page.waitForTimeout(1_000);
      expect(await clickedText(page), "a refused click must not have run").toBe(baseline);
    } finally {
      await journey.close();
    }
  });

  test("3. Stop while a consent card is up withdraws the card and answers owner-interrupted", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { tabId, page } = await openHeldTab(journey, client, "/ordinary");
      // The site is left at its default, Ask: a click raises a card, a read does not.
      const ref = await refFor(client, tabId, "Safe action");
      const asking = client.callTool("click", { tabId, target: { ref } });
      await journey.panel.waitForText(ui("agent.promptTitle"), 30_000);

      await pressOnPill(journey.context, page, words.stop);

      const answered = await asking;
      expect(answered.isError, `text: ${answered.text}\nstderr:\n${client.stderr()}`).toBe(true);
      expect(answerOf(answered), `text: ${answered.text}`).toMatchObject({
        outcome: "stopped",
        reason: "owner-interrupted",
      });
      await expect
        .poll(async () => (await safely(() => journey.panel.panelText(), "")).includes(ui("agent.promptTitle")), {
          timeout: 5_000,
          message: "the consent card must be withdrawn when the owner presses Stop",
        })
        .toBe(false);
      // Nothing was decided about the site: with no record it is still at the default, Ask.
      expect(await storedModeOf(journey.worker, SITE)).toBeUndefined();
      // And the page was not touched by the call the card was waiting to release.
      expect(await clickedText(page)).toBe("not clicked yet");
    } finally {
      await journey.close();
    }
  });

  test("4. Stop on one session leaves the other session working", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const first = await pairedClient(journey);
      const second = await journey.connect();
      const a = await openHeldTab(journey, first, "/ordinary");
      const b = await openHeldTab(journey, second, "/form");

      await pressOnPill(journey.context, a.page, words.stop);
      await waitForHeldPill(a.page);

      // The pressed session is refused ...
      expectHeldRefusal(await first.callTool("tabs_context"), "tabs_context", first);
      // ... and the other one runs every call it makes, reads and an effect alike.
      const settings = await journey.settings();
      await settings.setSiteMode(SITE, "skip-checks");
      await callOk(second, "tabs_context");
      await callOk(second, "read_page", { tabId: b.tabId, filter: "all" });
      await callOk(second, "get_page_text", { tabId: b.tabId });
      await callOk(second, "click", { tabId: b.tabId, target: { ref: await refFor(second, b.tabId, "Safe action") } });

      // Only the pressed session's card says it was stopped; the pill of the other tab is untouched.
      const cards = await cardViews(journey.panel);
      expect(cards.filter((card) => card.held !== null), JSON.stringify(cards)).toHaveLength(1);
      const otherPill = await readPill(b.page);
      expect(otherPill?.buttons, "the second session's pill must still offer Stop").toContain(words.stop);
    } finally {
      await journey.close();
    }
  });

  test("5. a click the page makes on Stop or Resume changes nothing", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");

      // Twenty page-made clicks on Stop: the session is not held afterwards, and its calls run.
      expect(await pageMadeClicks(page, words.stop, 20), "the pill's Stop control was not on the page").toBe(20);
      await page.waitForTimeout(1_500);
      await callOk(client, "tabs_context");
      expect((await cardViews(journey.panel)).filter((card) => card.held !== null)).toHaveLength(0);
      expect(await readPill(page), "a page click must not turn the pill into the stopped state").toMatchObject({
        buttons: expect.arrayContaining([words.stop]),
      });

      // The owner's own press holds it; twenty page-made clicks on Resume do not lift it.
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      expect(await pageMadeClicks(page, words.resume, 20), "the pill's Resume control was not on the page").toBe(20);
      await page.waitForTimeout(1_500);
      expectHeldRefusal(await client.callTool("tabs_context"), "tabs_context", client);
      expectHeldPill(await readPill(page));
      expect((await cardViews(journey.panel)).filter((card) => card.held !== null)).toHaveLength(1);
    } finally {
      await journey.close();
    }
  });

  test("6. Resume on the pill, then Resume on the card, each lets the next call run and replays none", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { tabId, page } = await openHeldTab(journey, client, "/ordinary");
      const settings = await journey.settings();
      await settings.setSiteMode(SITE, "skip-checks");
      const baseline = await clickedText(page);
      expect(baseline).toBe("not clicked yet");

      // ---- held, then Resume on the pill (the ref is read first: a held session cannot read) ----
      const firstRef = await refFor(client, tabId, "Safe action");
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      await shootPill(page, testInfo, "s06-pill-held");
      await shootPanel(journey.panel, testInfo, "s06-card-held");
      const refused = await client.callTool("click", { tabId, target: { ref: firstRef } });
      expectHeldRefusal(refused, "click", client);
      expect(await clickedText(page)).toBe(baseline);

      await pressOnPill(journey.context, page, words.resume);
      await waitForWorkingPill(page);
      await shootPill(page, testInfo, "s06-pill-resumed");
      await expect
        .poll(async () => (await cardViews(journey.panel)).filter((card) => card.held !== null).length, { timeout: 5_000 })
        .toBe(0);
      // The refused click was not replayed by the resume: the page is still as it was.
      await page.waitForTimeout(1_500);
      expect(await clickedText(page), "the refused click must not run after Resume").toBe(baseline);
      await callOk(client, "click", { tabId, target: { ref: await refFor(client, tabId, "Safe action") } });
      const afterFirst = await clickedText(page);
      expect(afterFirst).toMatch(/^clicked at /);

      // ---- held again, then Resume on the card ----
      const secondRef = await refFor(client, tabId, "Safe action");
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      const sessionId = await sessionIdOnPanel(journey.panel);
      const refusedAgain = await client.callTool("click", { tabId, target: { ref: secondRef } });
      expectHeldRefusal(refusedAgain, "click", client);
      expect(await clickedText(page)).toBe(afterFirst);

      await clickOnCard(journey.panel, sessionId, words.cardResume);
      await expect
        .poll(async () => (await cardViews(journey.panel)).filter((card) => card.held !== null).length, { timeout: 5_000 })
        .toBe(0);
      await shootPanel(journey.panel, testInfo, "s06-card-resumed");
      await waitForWorkingPill(page);
      await page.waitForTimeout(1_500);
      expect(await clickedText(page), "the second refused click must not run after Resume").toBe(afterFirst);
      await callOk(client, "click", { tabId, target: { ref: await refFor(client, tabId, "Safe action") } });
      expect(await clickedText(page)).not.toBe(afterFirst);
    } finally {
      await journey.close();
    }
  });

  test("7. the hold survives the service worker restarting", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(480_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      await waitForHeldCard(journey.panel);

      // Chrome recycling the worker, as it does on its own schedule (closing the target rather than
      // `chrome.runtime.reload()`, which unloads a CDP-loaded extension and does not bring it back).
      const cdp = await journey.context.newCDPSession(journey.ownerPage);
      const targets = await cdp.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${journey.extensionId}/`),
      );
      expect(worker, "the extension's worker target").toBeTruthy();
      await cdp.send("Target.closeTarget", { targetId: worker?.targetId ?? "" });
      await cdp.detach();
      await journey.worker.waitForEvent("close");

      // The session's registry is memory only, so the fresh worker knows the session again only when
      // the session greets it; the card is the panel's picture of exactly that. A call made before
      // then is the bridge's own honesty (`session-ended`), not the hold's, so it is not made yet.
      await waitForHeldCard(journey.panel, 180_000);
      const answer = await pollUntil(
        () => client.callTool("tabs_context"),
        (result) => isHeldRefusal(result),
        60_000,
      );
      expectHeldRefusal(answer, "tabs_context after the worker restarted", client);

      // The pill is still the stopped one, and so is the card.
      expectHeldPill(await readPill(page));
      const cards = await cardViews(journey.panel);
      expect(cards.filter((card) => card.held !== null), JSON.stringify(cards)).toHaveLength(1);
      expect(cards.find((card) => card.held !== null)?.buttons).toContain(words.cardResume);
      await shootPill(page, testInfo, "s07-pill-after-restart");
      await shootPanel(journey.panel, testInfo, "s07-card-after-restart");
    } finally {
      await journey.close();
    }
  });

  test("8. a held tab that reloads draws a held pill", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);

      await page.reload();
      await expect
        .poll(async () => isHeldPill(await readPill(page)), {
          timeout: 20_000,
          message: "the reloaded page's pill must say Stopped with Resume",
        })
        .toBe(true);
      expectHeldPill(await readPill(page));
    } finally {
      await journey.close();
    }
  });

  test("9. End session ends the hold with the session; a new session of the agent is not held", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");
      const sessionId = await sessionIdOnPanel(journey.panel);
      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      await waitForHeldCard(journey.panel);

      // The card keeps End session beside Resume (FR-520); pressing it ends the session.
      await clickOnCard(journey.panel, sessionId, ui("agent.session.stop"));
      await expect
        .poll(() => journey.panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 15_000 })
        .toBe(0);

      // A new session of the same, already paired, agent: its calls run and no card says stopped.
      const next = await journey.connect();
      await callOk(next, "tabs_context");
      await callOk(next, "tabs_create", { url: `${SITE}/form` });
      expect((await cardViews(journey.panel)).filter((card) => card.held !== null)).toHaveLength(0);
    } finally {
      await journey.close();
    }
  });

  test("10. a press the page cannot deliver says so on the pill within 3 s", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");

      // Reloading the extension leaves the page's old script alive but without an extension context
      // (its `sendMessage` rejects), which is what an undelivered press is. The pill stays on the page.
      const endpoint = process.env.HALLPASS_CDP_ENDPOINT ?? "";
      try {
        await reloadExtension(endpoint);
      } catch (error) {
        test.skip(true, `this browser refused Extensions.loadUnpacked, so the extension cannot be reloaded under it: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await readPill(page), "the old pill must still be on the page after the reload").toBeDefined();

      await pressOnPill(journey.context, page, words.stop);
      await expect
        .poll(async () => (await readPill(page))?.text ?? "", {
          timeout: 3_000,
          intervals: [100, 200, 200, 250, 250, 250],
          message: "no answer to the press: the pill must say Stop did not arrive within 3 s",
        })
        .toContain(words.stopUndelivered);
      // The pill keeps its previous state: Stop is still there to press again.
      expect((await readPill(page))?.buttons).toContain(words.stop);
    } finally {
      await journey.close();
    }
  });

  test("11. scenario 1 in zh-TW: the words on the pill and the card", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.skip(locale !== "zh-TW", "run with HALLPASS_LOCALE=zh-TW (the browser started with --lang=zh-TW)");
    test.setTimeout(240_000);
    await stoppedFromThePage({ extensionContext, extensionId, extensionWorker }, testInfo, "s11-zh");
  });

  test("12. a side-panel conversation's turn: Stop on the pill ends the turn, no hold, no Resume", async ({ extensionContext, extensionId, extensionWorker }) => {
    // Side-panel conversations are Windows-only (CLAUDE.md); the fake ACP agent must be wired in (T557's set-up).
    test.skip(process.platform !== "win32", "side-panel conversations are Windows-only");
    test.skip(!conversationConfigured, CONVERSATION_SKIP_REASON);
    test.setTimeout(240_000);
    await resetHostConversationState(extensionWorker);
    try {
      // The conversation works in the tab the owner is viewing (agent-conversation.spec.ts part 2).
      const { panel, ownerPage } = await ownerPanel({ extensionContext, extensionId, extensionWorker, path: "/ordinary" });
      await startConversation(panel);
      expect(await clickedText(ownerPage)).toBe("not clicked yet");

      // The read puts the viewed tab into the conversation's session; the click on an Ask site then waits
      // on a consent card, so the turn is still running, in that tab, when the press lands.
      const callsBefore = (await fakeLog()).length;
      await sendMessage(panel, 'mcp:get_page_text:{"tabId":"$this"} mcp:click:{"tabId":"$this","target":"$ref:Safe%20action"}');
      await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("mcp:get_page_text:ok:");
      await expect
        .poll(async () => (await pinnedPrompt(panel))?.prompt ?? null, { timeout: 30_000, message: "the click must be waiting on a consent card" })
        .toBe("consent");
      expect(await composerReady(panel), "the turn is still running").toBe(false);

      // Mode conversation: the pill offers Stop and never Resume.
      await waitForWorkingPill(ownerPage);
      const working = await readPill(ownerPage);
      expect(working?.buttons, JSON.stringify(working)).toContain(words.stop);
      expect(working?.buttons).not.toContain(words.resume);

      await pressOnPill(extensionContext, ownerPage, words.stop);

      // The turn ends the way the conversation's own Stop ends it, and the card it waited on is gone.
      await waitComposerReady(panel);
      await expect.poll(() => stoppedSaid(panel), { timeout: 10_000, message: "the panel says the turn was stopped" }).toBe(true);
      await expect.poll(() => noCardUp(panel), { timeout: 10_000, message: "the consent card is withdrawn" }).toBe(true);
      expect(
        (await fakeLog()).slice(callsBefore).some((line) => line.method === "session/cancel"),
        "the conversation's own Stop reached the agent",
      ).toBe(true);

      // No hold: for three seconds the pill never says Stopped or offers Resume, and no card says it either.
      const seen: Array<PillView | undefined> = [];
      for (let sample = 0; sample < 12; sample += 1) {
        seen.push(await readPill(ownerPage));
        await sleep(250);
      }
      for (const view of seen) {
        expect(view?.buttons ?? [], JSON.stringify(view)).not.toContain(words.resume);
        expect(view?.label ?? "", JSON.stringify(view)).not.toBe(words.held);
      }
      await chooseTab(panel, "sessions");
      expect(
        (await cardViews(panel)).filter((card) => card.held !== null).length,
        "no session card says stopped from the page",
      ).toBe(0);
      await chooseTab(panel, "conversation");

      // The action of the stopped turn did not run.
      expect(await clickedText(ownerPage), "the click of the stopped turn must not have run").toBe("not clicked yet");
      expect(
        (await fakeLog()).slice(callsBefore).some((line) => line.event === "mcp-call" && line.tool === "click" && line.isError === false),
        "no click answered ok",
      ).toBe(false);

      // The next message's turn can use the browser again: a read of the tab succeeds.
      const beforeNext = (await fakeLog()).length;
      await sendMessage(panel, 'mcp:get_page_text:{"tabId":"$this"}');
      await expect
        .poll(
          async () =>
            (await fakeLog()).slice(beforeNext).some((line) => line.event === "mcp-call" && line.tool === "get_page_text" && line.isError === false),
          { timeout: 30_000, message: "the next turn's read of the tab must succeed" },
        )
        .toBe(true);
      await waitComposerReady(panel);
      expect(await pinnedPrompt(panel), "a read raises no card").toBeNull();
    } finally {
      await stopBrokers();
      await clearHostFiles();
    }
  });
});

type Fixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
};

/** Scenarios 1 and 11: the one story, under whichever locale the run was started with. */
async function stoppedFromThePage(fixtures: Fixtures, testInfo: TestInfo, tag: string): Promise<void> {
  const journey = await openJourney(fixtures);
  try {
    const client = await pairedClient(journey);
    const { page } = await openHeldTab(journey, client, "/ordinary");
    // Before the press: the pill offers Stop (never Resume) in the owner's words.
    const working = await readPill(page);
    expect(working?.buttons, JSON.stringify(working)).toContain(words.stop);
    expect(working?.buttons).not.toContain(words.resume);
    await shootPill(page, testInfo, `${tag}-pill-working`);

    await pressOnPill(journey.context, page, words.stop);
    // SC-225: from the owner's press to both pictures, a second.
    await Promise.all([
      expect
        .poll(async () => isHeldPill(await readPill(page)), {
          timeout: 1_000,
          intervals: [50, 100, 100, 100, 100],
          message: `the pill must say ${words.held} and offer ${words.resume} within 1 s`,
        })
        .toBe(true),
      expect
        .poll(async () => (await cardViews(journey.panel)).some((card) => card.held === words.cardHeld), {
          timeout: 1_000,
          intervals: [50, 100, 100, 100, 100],
          message: `the card must say ${words.cardHeld} within 1 s`,
        })
        .toBe(true),
    ]);
    const pill = await readPill(page);
    expectHeldPill(pill);
    expect(pill?.label).toBe(words.held);

    const [card] = (await cardViews(journey.panel)).filter((view) => view.held !== null);
    expect(card?.held).toBe(words.cardHeld);
    expect(card?.buttons, JSON.stringify(card)).toContain(words.cardResume);
    // End session stays beside Resume, and there is no step to interrupt on a held session.
    expect(card?.buttons).toContain(ui("agent.session.stop"));
    expect(card?.buttons).not.toContain(ui("agent.session.interrupt"));

    await shootPill(page, testInfo, `${tag}-pill-held`);
    await shootPanel(journey.panel, testInfo, `${tag}-card-held`);
  } finally {
    await journey.close();
  }
}

/* ------------------------------------------------------------------------------------------------
 * The journey: the side panel, the clients of this test and the owner's own tab.
 * ---------------------------------------------------------------------------------------------- */

type Journey = {
  context: BrowserContext;
  extensionId: string;
  worker: PackagedWorker;
  ownerPage: Page;
  panel: SidePanelDriver;
  /** Starts one more MCP server process for the agent "Claude Code"; closed with the journey. */
  connect(): Promise<McpHarnessClient>;
  /** The settings page, opened on the first ask; setSiteMode lives on it. */
  settings(): Promise<SettingsPageDriver>;
  close(): Promise<void>;
};

async function openJourney(fixtures: Fixtures): Promise<Journey> {
  const { extensionContext: context, extensionId, extensionWorker: worker } = fixtures;
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  // The owner's own tab stays on a page nothing here reads or presses: the agent works in tabs it makes.
  const ownerPage = context.pages()[0] ?? (await context.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);

  const clients: McpHarnessClient[] = [];
  let settingsDriver: SettingsPageDriver | undefined;
  return {
    context,
    extensionId,
    worker,
    ownerPage,
    panel,
    async connect() {
      const started = await startMcpClient({ clientName: "Claude Code" });
      clients.push(started);
      return started;
    },
    async settings() {
      settingsDriver ??= await openSettingsPage({ context, worker, extensionId, locale, route: "#sites" });
      return settingsDriver;
    },
    async close() {
      for (const started of clients) await started.close().catch(() => undefined);
    },
  };
}

/** A client the owner has paired: the first call raises the card, Accept is pressed, the call is answered. */
async function pairedClient(journey: Journey): Promise<McpHarnessClient> {
  const client = await journey.connect();
  await journey.panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, journey.panel, { locale });
  return client;
}

/** The session opens a tab on `path`; resolves once its pill is up, offering Stop. */
async function openHeldTab(
  journey: Journey,
  client: McpHarnessClient,
  path: string,
): Promise<{ tabId: number; page: Page }> {
  const created = (await callOk(client, "tabs_create", { url: `${SITE}${path}` })) as { tabId: number };
  const page = await agentPage(journey.context, `${SITE}${path}`);
  await waitForWorkingPill(page);
  return { tabId: created.tabId, page };
}

/* ------------------------------------------------------------------------------------------------
 * The pill, read and pressed from the page side.
 * ---------------------------------------------------------------------------------------------- */

type PillView = { text: string; label: string; buttons: string[] };

/** What the pill says and offers; `undefined` when there is none (or the page is between documents). */
async function readPill(page: Page): Promise<PillView | undefined> {
  try {
    return await page.evaluate((attribute) => {
      const pill = document.querySelector(`[${attribute}]`);
      if (!pill) return undefined;
      const label = pill.querySelector("span");
      return {
        text: pill.textContent ?? "",
        label: label?.textContent ?? "",
        buttons: [...pill.querySelectorAll("button")].map((button) => button.textContent ?? ""),
      };
    }, PILL);
  } catch {
    return undefined;
  }
}

function isHeldPill(view: PillView | undefined): boolean {
  return view !== undefined && view.label === words.held && view.buttons.includes(words.resume) && !view.buttons.includes(words.stop);
}

function isWorkingPill(view: PillView | undefined): boolean {
  return view !== undefined && view.buttons.includes(words.stop) && !view.buttons.includes(words.resume);
}

function expectHeldPill(view: PillView | undefined): void {
  expect(isHeldPill(view), `the pill should say ${words.held} with ${words.resume}: ${JSON.stringify(view)}`).toBe(true);
}

async function waitForHeldPill(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect
    .poll(async () => isHeldPill(await readPill(page)), { timeout: timeoutMs, message: "the pill never showed the stopped state" })
    .toBe(true);
}

async function waitForWorkingPill(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect
    .poll(async () => isWorkingPill(await readPill(page)), { timeout: timeoutMs, message: "the pill never offered Stop" })
    .toBe(true);
}

/**
 * The owner's press: the browser's own mouse events at the control's coordinates, so the click the
 * content script sees is trusted. `Input.dispatchMouseEvent` is the protocol Chrome's input pipeline is
 * fed from; there is no other way to make a trusted click from outside the browser.
 */
async function pressOnPill(context: BrowserContext, page: Page, label: string): Promise<void> {
  await page.bringToFront();
  const centre = await page.evaluate(
    ({ attribute, wanted }) => {
      const pill = document.querySelector(`[${attribute}]`);
      const control = [...(pill?.querySelectorAll("button") ?? [])].find((button) => button.textContent === wanted);
      if (!control) return undefined;
      const rect = control.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    { attribute: PILL, wanted: label },
  );
  expect(centre, `the pill has no ${label} control to press`).toBeDefined();
  const cdp = await context.newCDPSession(page);
  try {
    const point = { x: centre?.x ?? 0, y: centre?.y ?? 0, button: "left" as const, clickCount: 1 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, clickCount: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The page's own `click()` on a pill control, `times` times; what a hostile page can do to its document. Returns how many were made. */
async function pageMadeClicks(page: Page, label: string, times: number): Promise<number> {
  return page.evaluate(
    ({ attribute, wanted, count }) => {
      const pill = document.querySelector(`[${attribute}]`);
      const control = [...(pill?.querySelectorAll("button") ?? [])].find((button) => button.textContent === wanted);
      if (!(control instanceof HTMLButtonElement)) return -1;
      for (let index = 0; index < count; index += 1) control.click();
      return count;
    },
    { attribute: PILL, wanted: label, count: times },
  );
}

/* ------------------------------------------------------------------------------------------------
 * The session card, read and pressed through the side panel's own DOM.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The card as the panel draws it: `held` is the state line's text while the session is stopped from the page
 * (034 FR-520; 036 FR-541 draws it as the state line in the attention tone, and a waiting session's line says
 * waiting, so it is not read as held), else null. `buttons` is every button on the card, the header's
 * Answer/Resume/Interrupt and the open body's footer among them.
 */
type CardView = { sessionId: string; held: string | null; buttons: string[] };

async function cardViews(panel: SidePanelDriver): Promise<CardView[]> {
  const views = await safely(
    () =>
      panel.evaluatePanel(
        `[...document.querySelectorAll('[data-session-id]')].map((card) => ({` +
          `sessionId: card.getAttribute('data-session-id') ?? '',` +
          `held: (()=>{const s=card.querySelector('.agent-session-state');return s&&s.getAttribute('data-tone')==='attention'&&card.getAttribute('data-session-state')!=='waiting'?(s.textContent??'').trim():null})(),` +
          `buttons: [...card.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '')}))`,
      ),
    [],
  );
  return Array.isArray(views) ? (views as CardView[]) : [];
}

/** Until some card says the session was stopped from the page. */
async function waitForHeldCard(panel: SidePanelDriver, timeoutMs = 10_000): Promise<void> {
  await expect
    .poll(async () => (await cardViews(panel)).some((card) => card.held === words.cardHeld), {
      timeout: timeoutMs,
      message: `no session card said ${words.cardHeld}`,
    })
    .toBe(true);
}

/** The one session card on the panel, by the id the projection gave it. */
async function sessionIdOnPanel(panel: SidePanelDriver): Promise<string> {
  await expect.poll(async () => (await cardViews(panel)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [first] = await cardViews(panel);
  return first?.sessionId ?? "";
}

/* ------------------------------------------------------------------------------------------------
 * Calls, answers and the rest.
 * ---------------------------------------------------------------------------------------------- */

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** FR-515, FR-521: the one answer a held session gets for any tool. */
function isHeldRefusal(result: ToolCallResult): boolean {
  const answer = answerOf(result) as { outcome?: unknown; reason?: unknown } | undefined;
  return result.isError && answer?.outcome === "stopped" && answer?.reason === "owner-held";
}

function expectHeldRefusal(result: ToolCallResult, what: string, client: McpHarnessClient): void {
  expect(result.isError, `${what} was not refused: ${result.text}\nstderr:\n${client.stderr()}`).toBe(true);
  expect(answerOf(result), `${what}: ${result.text}`).toMatchObject({
    outcome: "stopped",
    reason: "owner-held",
    hint: HELD_HINT,
  });
}

/** Calls a tool and fails loudly, with the host's own stderr, when it did not answer `ok`. */
async function callOk(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

/** One live ref for a named control, from a structural read of the tab (a held session cannot read, so take it first). */
async function refFor(client: McpHarnessClient, tabId: number, name: string): Promise<string> {
  const page = (await callOk(client, "read_page", { tabId, filter: "all" })) as {
    nodes: Array<{ ref?: string; name?: string }>;
  };
  const node = page.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
  expect(node, `read_page offered no ref named '${name}'`).toBeTruthy();
  return node?.ref as string;
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(context: BrowserContext, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

/** The fixture's click record: "not clicked yet" until a click lands on its Safe action button. */
async function clickedText(page: Page): Promise<string> {
  return (await page.locator("#clicked").textContent()) ?? "";
}

async function storedModeOf(worker: PackagedWorker, site: string): Promise<unknown> {
  return worker.evaluate(async (origin: string) => {
    const raw = await chrome.storage.local.get(["agentSiteModes"]);
    const records = (raw.agentSiteModes ?? {}) as Record<string, { mode?: string }>;
    return records[origin]?.mode;
  }, site);
}

/** Retries a call until it satisfies `accept`, so a reconnect in flight is waited for, not raced. */
async function pollUntil<T>(attempt: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await attempt();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await attempt();
  }
  return last;
}

/** A read that may fail while the panel or a page is between documents; the fallback is "nothing seen". */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/**
 * Reloads the extension in place (`Extensions.loadUnpacked` with the path it was loaded from, which is
 * what the gate's own freshness check does). The page's old content script loses its extension context;
 * its pill stays where it was drawn.
 */
async function reloadExtension(endpoint: string): Promise<void> {
  const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((ready, failed) => {
    socket.addEventListener("open", () => ready(), { once: true });
    socket.addEventListener("error", () => failed(new Error("cdp-browser-socket-failed")), { once: true });
  });
  try {
    await new Promise<void>((done, failed) => {
      const timer = setTimeout(() => failed(new Error("cdp-browser-command-timeout:Extensions.loadUnpacked")), 30_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) failed(new Error(JSON.stringify(message.error)));
        else done();
      });
      socket.send(
        JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: resolve("apps/extension/dist/agent") } }),
      );
    });
  } finally {
    socket.close();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Scenario 12: the side-panel conversation with the fake ACP agent. Copied from
 * agent-conversation.spec.ts (set-up, panel driver and clean-up), only as far as scenario 12 needs.
 * ---------------------------------------------------------------------------------------------- */

const execFileAsync = promisify(execFile);
const FAKE_LOG = process.env.FAKE_ACP_LOG;
const FAKE_STORE = process.env.FAKE_ACP_STORE;
const AGENT_NAME = ui("conversation.agent.claude-code");
const conversationConfigured =
  process.env.HALLPASS_TEST_MODE === "1" &&
  Boolean(process.env.HALLPASS_BROKER_TEST_AGENT) &&
  Boolean(FAKE_LOG) &&
  Boolean(FAKE_STORE);
const CONVERSATION_SKIP_REASON =
  "attach mode with the fake agent: HALLPASS_TEST_MODE=1, HALLPASS_BROKER_TEST_AGENT, FAKE_ACP_LOG and " +
  "FAKE_ACP_STORE, set alike for the browser under test and this runner (see agent-conversation.spec.ts)";

type FakeLogLine = { method?: string; event?: string; tool?: string; isError?: boolean; [key: string]: unknown };

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function fakeLog(): Promise<FakeLogLine[]> {
  const raw = await readFile(FAKE_LOG!, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FakeLogLine);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Each conversation test starts with no consent, no list and an empty agent log (see agent-conversation.spec.ts). */
async function resetHostConversationState(worker: PackagedWorker): Promise<void> {
  const ownIdentity = () =>
    worker.evaluate(async () => {
      const stored = (await chrome.storage.local.get("agentBrowserIdentity")).agentBrowserIdentity as { browserId?: string } | undefined;
      return stored?.browserId ?? null;
    });
  await expect.poll(ownIdentity, { timeout: 30_000, message: "this browser's identity" }).not.toBeNull();
  const current = (await ownIdentity())!;
  await expect
    .poll(async () => (await readLiveBrowserRecords()).some((record) => record.browserId === current), {
      timeout: 30_000,
      message: "this browser's relay record",
    })
    .toBe(true);
  await stopBrokers(current);
  await clearHostFiles();
  await writeFile(FAKE_LOG!, "");
}

/** Stops every broker a sidecar names, except `keep`'s, while its command line is still that broker's. */
async function stopBrokers(keep?: string): Promise<void> {
  const data = hostDataDirectory();
  const named = new Map<number, string>();
  for (const name of await readdir(join(data, "brokers")).catch(() => [] as string[])) {
    if (!name.endsWith(".json") || name === `${keep}.json`) continue;
    try {
      const pid = (JSON.parse(await readFile(join(data, "brokers", name), "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number" && alive(pid)) named.set(pid, name.slice(0, -".json".length));
    } catch {
      // gone or being rewritten
    }
  }
  const commandLines = await commandLinesOf([...named.keys()]);
  const pids = [...named]
    .filter(([pid, browserId]) => {
      const line = commandLines.get(pid) ?? "";
      return /broker\.js/u.test(line) && line.includes(`--browser-id ${browserId}`);
    })
    .map(([pid]) => pid);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await expect.poll(() => pids.filter(alive).length, { timeout: 15_000, message: "the stopped brokers exit" }).toBe(0);
}

/** The command lines of the given live pids (Windows, one CIM query); a pid that is gone is absent. */
async function commandLinesOf(pids: number[]): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  if (pids.length === 0) return lines;
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [Console]::Out.WriteLine(('{0}' -f $_.ProcessId) + [char]9 + $_.CommandLine) }`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 30_000,
  });
  for (const row of stdout.split(/\r?\n/u)) {
    const tab = row.indexOf("\t");
    if (tab > 0) lines.set(Number(row.slice(0, tab)), row.slice(tab + 1));
  }
  return lines;
}

async function clearHostFiles(): Promise<void> {
  const data = hostDataDirectory();
  for (const name of ["conversation-consent", "conversation-consent.json", "conversations.json", "folders.json"]) {
    await rm(join(data, name), { recursive: true, force: true });
  }
}

/** The broker's record of the panel consent: one file per browser, or the earlier single file. */
async function readConsentFile(): Promise<boolean | undefined> {
  const data = hostDataDirectory();
  const perBrowser = (await readdir(join(data, "conversation-consent")).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(data, "conversation-consent", name));
  const single = join(data, "conversation-consent.json");
  for (const path of existsSync(single) ? [...perBrowser, single] : perBrowser) {
    try {
      return (JSON.parse(await readFile(path, "utf8")) as { granted: boolean }).granted;
    } catch {
      // being rewritten
    }
  }
  return undefined;
}

/** The owner's tab on `path` with the side panel open on it. */
async function ownerPanel(fixtures: Fixtures & { path: string }): Promise<{ panel: SidePanelDriver; ownerPage: Page }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}${fixtures.path}`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy, tab: "as-remembered" });
  await waitForAgentPanel(panel);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('[role=tablist]') !== null"), { timeout: 20_000 })
    .toBe(true);
  return { panel, ownerPage };
}

async function selectedTab(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('[role=tab][aria-selected=true]')?.id?.replace('agent-tab-','') ?? null",
  )) as string | null;
}

async function chooseTab(panel: SidePanelDriver, name: "conversation" | "sessions"): Promise<void> {
  expect(
    await panel.evaluatePanel(`(()=>{const b=document.getElementById('agent-tab-${name}');if(!b)return false;b.click();return true})()`, true),
  ).toBe(true);
  await expect.poll(() => selectedTab(panel), { timeout: 10_000 }).toBe(name);
}

/** The question slot's card (`data-prompt` says which), or null. */
async function pinnedPrompt(panel: SidePanelDriver): Promise<{ prompt: string | null } | null> {
  return (await panel.evaluatePanel(
    "(()=>{const card=document.querySelector('.agent-prompt');return card?{prompt:card.getAttribute('data-prompt')}:null})()",
  )) as { prompt: string | null } | null;
}

/** Neither the extension's consent card (the pinned prompt) nor a permission card of the conversation is up. */
async function noCardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel(
    "document.querySelector('.agent-prompt') === null && document.querySelector('.agent-conversation-permission') === null",
  )) as boolean;
}

async function setupCard(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('[data-setup]')?.getAttribute('data-setup') ?? null")) as string | null;
}

const AGENT_CHIP = ".agent-conversation-chips button.agent-conversation-chip[aria-haspopup=menu]";
const FIRST_MESSAGE = "opening";

/** Chooses the agent in the agent chip's menu, once the worker has reported it. */
async function pickAgent(panel: SidePanelDriver, name: string = AGENT_NAME): Promise<void> {
  await expect
    .poll(
      () => panel.evaluatePanel(`(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});return !!c&&!c.disabled})()`),
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(
    await panel.evaluatePanel(
      `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});if(!c)return false;if(c.getAttribute('aria-expanded')!=='true')c.click();return true})()`,
      true,
    ),
  ).toBe(true);
  await expect
    .poll(
      () =>
        panel.evaluatePanel(
          `(()=>{const b=[...document.querySelectorAll('.agent-conversation-menu-item[role=menuitemradio]')].find((x)=>!x.disabled&&x.querySelector('.agent-conversation-agent-name')?.textContent===${JSON.stringify(name)});if(!b)return false;b.click();return true})()`,
          true,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(() =>
      panel.evaluatePanel(
        `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});return !!c&&c.getAttribute('aria-expanded')==='false'&&(c.textContent??'').trim()===${JSON.stringify(name)}})()`,
      ),
    )
    .toBe(true);
}

/** Types the message into the box and presses Send, once Send is offered. */
async function fillAndSend(panel: SidePanelDriver, text: string): Promise<void> {
  const filled = await panel.evaluatePanel(
    `(()=>{const e=document.querySelector('.agent-conversation-composer textarea');if(!e)return false;` +
      `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});` +
      `e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  expect(filled).toBe(true);
  await expect
    .poll(
      () =>
        panel.evaluatePanel(
          "(()=>{const b=document.querySelector('.agent-conversation-composer button[type=submit]');if(!b||b.disabled)return false;b.click();return true})()",
          true,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function sendMessage(panel: SidePanelDriver, text: string): Promise<void> {
  await fillAndSend(panel, text);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 10_000 })
    .toBe("");
}

/** Consent given on the first-use card, then a scratch conversation with the agent, open and idle. */
async function startConversation(panel: SidePanelDriver): Promise<void> {
  await expect.poll(() => selectedTab(panel), { timeout: 15_000 }).toBe("conversation");
  await pickAgent(panel);
  await fillAndSend(panel, FIRST_MESSAGE);
  await expect.poll(() => setupCard(panel), { timeout: 15_000 }).toBe("first-use");
  await panel.clickButton(ui("conversation.firstUse.allow"));
  await expect.poll(() => readConsentFile(), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('section.agent-conversation[data-conversation-id]') !== null"), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 20_000 })
    .toBe("");
  await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain(`echo:${FIRST_MESSAGE}`);
  await waitComposerReady(panel);
}

/** Ready = no turn under way: the composer offers no Stop. */
async function composerReady(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel(
    `(()=>{const f=document.querySelector('.agent-conversation-composer');if(!f)return false;` +
      `const busy=[...f.querySelectorAll('button')].some((b)=>(b.textContent??'').trim()===${JSON.stringify(ui("conversation.stop"))});return !busy})()`,
  )) as boolean;
}

async function waitComposerReady(panel: SidePanelDriver): Promise<void> {
  await expect.poll(() => composerReady(panel), { timeout: 30_000 }).toBe(true);
}

async function logText(panel: SidePanelDriver): Promise<string> {
  return String((await panel.evaluatePanel("document.querySelector('.agent-conversation-log')?.innerText ?? ''")) ?? "");
}

async function stateLine(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('.agent-conversation-state')?.textContent ?? null")) as string | null;
}

/** Whether the panel says the last turn was stopped: the stopped state line, or a notice in the log. */
async function stoppedSaid(panel: SidePanelDriver): Promise<boolean> {
  if ((await stateLine(panel)) === ui("conversation.state.stopped")) return true;
  // The words in the owner's locale (the run's HALLPASS_LOCALE), up to each message's first placeholder.
  const said = ["conversation.state.stopped", "conversation.questionEnded.cancelled", "conversation.answered.cancelled"].map(
    (key) => ui(key).split("{")[0] ?? "",
  );
  return (await panel.evaluatePanel(
    "(()=>{const items=[...document.querySelectorAll('.agent-conversation-log > *')];const last=items[items.length-1];" +
      `const said=${JSON.stringify(said)};` +
      "return !!last&&last.classList.contains('agent-conversation-notice')&&said.some((w)=>w.length>0&&(last.textContent??'').includes(w))})()",
  )) as boolean;
}

/* ------------------------------------------------------------------------------------------------
 * Screenshots, into the run's own output directory (the config's `outputDir`).
 * ---------------------------------------------------------------------------------------------- */

/** The pill (and a margin of page around it) and the whole viewport, as the owner sees them. */
async function shootPill(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.bringToFront();
  const box = await page.locator(`[${PILL}]`).boundingBox();
  if (box) {
    const clip = {
      x: Math.max(0, box.x - 16),
      y: Math.max(0, box.y - 16),
      width: box.width + 32,
      height: box.height + 32,
    };
    const closeUp = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: closeUp, clip });
    await testInfo.attach(name, { path: closeUp, contentType: "image/png" });
  }
  const whole = testInfo.outputPath(`${name}-page.png`);
  await page.screenshot({ path: whole });
  await testInfo.attach(`${name}-page`, { path: whole, contentType: "image/png" });
  // eslint-disable-next-line no-console -- where the owner finds the picture.
  console.log(`[T1017] ${name} -> ${whole}`);
}

/** The side panel as the owner sees it, through the panel's own CDP session. */
async function shootPanel(panel: SidePanelDriver, testInfo: TestInfo, name: string): Promise<void> {
  const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as { data?: string } | undefined)?.data;
  expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
  const saved = testInfo.outputPath(`${name}.png`);
  writeFileSync(saved, Buffer.from(data ?? "", "base64"));
  await testInfo.attach(name, { path: saved, contentType: "image/png" });
  // eslint-disable-next-line no-console -- where the owner finds the picture.
  console.log(`[T1017] ${name} -> ${saved}`);
}
