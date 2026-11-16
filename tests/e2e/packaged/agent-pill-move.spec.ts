import { resolve } from "node:path";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { HELD_HINT } from "@hallpass/contracts";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/** The 035 fixture page (tests/e2e/fixtures/pages/pill-move-035.html): #corner, #centre, #tall and the probe. */
const FIXTURE = "/pill-move-035";
const CORNER = "Corner button";
const CENTRE = "Centre button";
const TALL = "Tall side element";

/**
 * 034's words, written out here (a drifted catalog is a red test, not a green one). The words 035 added
 * (FR-536) come from the extension's own locale tables, so the one spec passes under either locale.
 */
const WORDS034 = {
  "en-US": {
    stop: "Stop",
    held: "Stopped",
    resume: "Resume",
    cardHeld: "Stopped from the page",
    stopUndelivered:
      "Stop didn't reach Hallpass. Open the side panel (toolbar icon or Alt+A) and choose End session.",
  },
  "zh-TW": {
    stop: "停止",
    held: "已停止",
    resume: "繼續",
    cardHeld: "已從頁面停止",
    stopUndelivered: "停止沒有送達。請打開側邊欄（工具列圖示或 Alt+A），按「結束工作階段」。",
  },
} as const;
const words = {
  ...WORDS034[locale],
  moveToTop: ui("agent.indicator.moveToTop"),
  moveToBottom: ui("agent.indicator.moveToBottom"),
  openPanel: ui("agent.indicator.openPanel"),
  panelUnopened: ui("agent.indicator.panelUnopened"),
};

/** The pill's own attribute (`INDICATOR_PILL_ATTRIBUTE`, content-runtime/indicator.ts), spelled out for the page side. */
const PILL = "data-hallpass-pill";

/**
 * 035 / T1047 - move the pill, step aside from the agent, open the side panel; quickstart scenarios 1-13
 * end to end in the attached test Chromium.
 *
 * How the facts are observed (nothing here imports a private module of the product):
 *  - Pill place: the pill's bounding box against the viewport (centre above the middle = top). The fixture
 *    page's own probe (`window.__pill035`) records every change of place, so "at the bottom from the start"
 *    and "never at the top" are read from the page, not guessed from a later sample.
 *  - The owner's press: `Input.dispatchMouseEvent` through CDP at the control's own coordinates, so the
 *    click the content script sees is trusted (as agent-pill-stop.spec.ts does). A page-made press is the
 *    page's own `click()`, which the controls ignore.
 *  - Stepping aside: the fixture records, for every press that reaches `#corner`, where the pill was at
 *    that moment, and every press that reaches the pill's own controls. A step that "pressed no pill
 *    control" is an empty pill record plus a stored edge and session state that did not change.
 *  - Side panel opened: the worker's own `chrome.runtime.getContexts` (a `SIDE_PANEL` context of
 *    side-panel.html), read over the worker's DevTools socket.
 *  - The stored edge: `chrome.storage.local` key `agentPillEdge` read the same way.
 *
 * Restart: scenario 3 restarts the service worker (as 034 scenario 7 does). A restart of the whole
 * browser is out of scope for the automated run; the owner's run (SC-233, T1051) covers it.
 *
 * Locale: the browser decides its own UI language and `HALLPASS_LOCALE` says which one it was started
 * with; every journey reads its words from the tables above, so the same spec passes in en-US and zh-TW.
 *
 * The edge is put back to top at the end of each journey, and the per-test reset clears `storage.local`
 * before the next one starts.
 *
 * Attach mode only, like every agent journey. Prerequisites: `npm run build`, `apps/extension/dist/agent`
 * loaded in the attached browser, `npm run agent-host:install`, and the fixture services running
 * (`npm run dev:test-pages`).
 */
test.describe("pill move", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  /* ---------------------------------------------------------------- US1: move (gate live-us1-move) */

  test("1. a trusted press on Move to bottom puts every held tab's pill at the bottom within 1 s", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const first = await openHeldTab(journey, client, FIXTURE);
      const second = await openHeldTab(journey, client, "/ordinary");

      for (const page of [first.page, second.page]) {
        const view = await readPill(page);
        expect(view?.place, JSON.stringify(view)).toBe("top");
        expect(view?.buttons, "the move control names the edge the pill is not at").toContain(words.moveToBottom);
        expect(view?.buttons).toContain(words.openPanel);
      }
      await shootPill(first.page, testInfo, "s01-pill-top");

      await pressOnPill(journey.context, first.page, words.moveToBottom);
      // FR-526, SC-232: from the owner's press to every pill, a second.
      await Promise.all(
        [first.page, second.page].map((page) =>
          expect
            .poll(async () => pillAt(await readPill(page), "bottom"), {
              timeout: 1_000,
              intervals: [50, 100, 100, 100, 100],
              message: `the pill must be at the bottom and offer ${words.moveToTop} within 1 s`,
            })
            .toBe(true),
        ),
      );
      expect(await storedEdge(journey)).toBe("bottom");
      await shootPill(first.page, testInfo, "s01-pill-bottom");
    } finally {
      await journey.close();
    }
  });

  test("2. a navigation and a new tab of the session draw their pills at the bottom from the start", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { tabId, page } = await openHeldTab(journey, client, "/ordinary");
      await movePill(journey, page, "bottom");

      // Tab 1 goes to the fixture: the new document's pill is first seen at the bottom.
      await callOk(client, "navigate", { tabId, url: `${SITE}${FIXTURE}` });
      await expect
        .poll(async () => (await safely(() => firstPlaceOf(page), undefined)) ?? "none", {
          timeout: 20_000,
          message: "the pill of the navigated page was never drawn",
        })
        .not.toBe("none");
      expect(await firstPlaceOf(page), "the navigated page's pill must be drawn at the bottom from the start").toBe("bottom");

      // Another tab of the session is drawn at the bottom too.
      await callOk(client, "tabs_create", { url: `${SITE}${FIXTURE}?third=1` });
      const third = await agentPage(journey.context, `${SITE}${FIXTURE}?third=1`);
      await expect
        .poll(async () => (await safely(() => firstPlaceOf(third), undefined)) ?? "none", {
          timeout: 20_000,
          message: "the new tab's pill was never drawn",
        })
        .not.toBe("none");
      expect(await firstPlaceOf(third), "a new tab's pill must be drawn at the bottom from the start").toBe("bottom");
    } finally {
      await journey.close();
    }
  });

  test("3. the edge holds after the service worker restarts", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(480_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, "/ordinary");
      await movePill(journey, page, "bottom");
      expect(await storedEdge(journey)).toBe("bottom");

      // Chrome recycling the worker, as 034 scenario 7 does it (closing the target, not runtime.reload()).
      const cdp = await journey.context.newCDPSession(journey.ownerPage);
      const targets = await cdp.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${journey.extensionId}/`),
      );
      expect(worker, "the extension's worker target").toBeTruthy();
      await cdp.send("Target.closeTarget", { targetId: worker?.targetId ?? "" });
      await cdp.detach();
      await journey.worker.waitForEvent("close");

      // The registry is memory only: the session is known to the fresh worker once it greets it again,
      // and the card is the panel's picture of that. (A brand-new MCP session would need no more than
      // this one does; the run reuses the paired client rather than risk a second pairing card.)
      await expect
        .poll(async () => (await cardViews(journey.panel)).length, { timeout: 180_000, message: "no session card after the restart" })
        .toBeGreaterThan(0);
      const created = await pollUntil(
        () => client.callTool("tabs_create", { url: `${SITE}${FIXTURE}?restarted=1` }),
        (result) => !result.isError,
        60_000,
      );
      expect(created.isError, `tabs_create after the restart: ${created.text}\nstderr:\n${client.stderr()}`).toBe(false);
      const fresh = await agentPage(journey.context, `${SITE}${FIXTURE}?restarted=1`);
      await expect
        .poll(async () => (await safely(() => firstPlaceOf(fresh), undefined)) ?? "none", {
          timeout: 30_000,
          message: "the new session's pill was never drawn after the restart",
        })
        .not.toBe("none");
      // SC-233: the first place the new pill is seen at is the bottom, and the store still says so.
      expect(await firstPlaceOf(fresh), "after a worker restart the pill must be drawn at the bottom").toBe("bottom");
      expect(await storedEdge(journey)).toBe("bottom");
    } finally {
      await journey.close();
    }
  });

  test("4. a click the page makes on the move control changes nothing", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      const before = await storedEdge(journey);

      expect(await pageMadeClicks(page, words.moveToBottom, 20), "the pill's move control was not on the page").toBe(20);
      await page.waitForTimeout(1_500);
      const view = await readPill(page);
      expect(view?.place, `a page click must not move the pill: ${JSON.stringify(view)}`).toBe("top");
      expect(view?.buttons).toContain(words.moveToBottom);
      expect(await storedEdge(journey), "a page click must not change the stored edge").toBe(before);
      expect(isWorkingPill(view)).toBe(true);
    } finally {
      await journey.close();
    }
  });

  /* ------------------------------------------------ US2: step aside (gate live-us2-step-aside) */

  test("5. twenty ref clicks on a button under the top-right pill all reach it; no pill control is pressed", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const settings = await journey.settings();
      // The settings page lists a site only once a session tab is on it (as agent-actions.spec.ts does).
      const { tabId, page } = await openHeldTab(journey, client, FIXTURE);
      await settings.setSiteMode(SITE, "skip-checks");
      expect((await readPill(page))?.place).toBe("top");
      const ref = await refFor(client, tabId, CORNER);
      const edgeBefore = await storedEdge(journey);

      for (let index = 0; index < 20; index += 1) {
        await callOk(client, "click", { tabId, target: { ref } });
      }

      const probe = await readProbe(page);
      expect(clicksOf(probe.corner), `the button must get every click: ${JSON.stringify(probe.corner.slice(0, 6))}`).toBe(20);
      // SC-234: the pill was at the bottom whenever a press reached the button (the step moved it first).
      expect(probe.corner.length).toBeGreaterThan(0);
      expect(
        probe.corner.filter((hit) => hit.place !== "bottom"),
        "every press that reached the button must find the pill at the bottom",
      ).toEqual([]);
      expect(probe.pill.filter((press) => press.trusted), "no press may reach a pill control").toEqual([]);
      expect(await storedEdge(journey), "the stored edge is the owner's and did not change").toBe(edgeBefore);
      const view = await readPill(page);
      expect(isWorkingPill(view), `the session must not be held: ${JSON.stringify(view)}`).toBe(true);
      await callOk(client, "tabs_context");
      await shootPill(page, testInfo, "s05-pill-stepped-aside");
    } finally {
      await journey.close();
    }
  });

  test("6. the next agent step elsewhere brings the pill back to the top", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const settings = await journey.settings();
      // The settings page lists a site only once a session tab is on it (as agent-actions.spec.ts does).
      const { tabId, page } = await openHeldTab(journey, client, FIXTURE);
      await settings.setSiteMode(SITE, "skip-checks");
      const cornerRef = await refFor(client, tabId, CORNER);
      const centreRef = await refFor(client, tabId, CENTRE);

      await callOk(client, "click", { tabId, target: { ref: cornerRef } });
      expect((await readProbe(page)).corner.filter((hit) => hit.type === "click").map((hit) => hit.place)).toEqual(["bottom"]);

      await callOk(client, "click", { tabId, target: { ref: centreRef } });
      // SC-235: the press at the centre found the pill back at its own edge.
      const probe = await readProbe(page);
      expect(clicksOf(probe.centre)).toBe(1);
      expect(probe.centre.filter((hit) => hit.place !== "top"), "the pill must be back at the top for the next step").toEqual([]);
      await expect.poll(async () => (await readPill(page))?.place, { timeout: 2_000 }).toBe("top");
      await shootPill(page, testInfo, "s06-pill-back-at-top");
    } finally {
      await journey.close();
    }
  });

  test("7. a tall right-side target covering both places leaves the pill at the owner's edge", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const settings = await journey.settings();
      // The settings page lists a site only once a session tab is on it (as agent-actions.spec.ts does).
      const { tabId, page } = await openHeldTab(journey, client, FIXTURE);
      await settings.setSiteMode(SITE, "skip-checks");
      await page.evaluate(() => {
        const tall = document.getElementById("tall");
        if (tall) tall.style.display = "block";
      });
      const ref = await refFor(client, tabId, TALL);

      // Owner's edge top: the agent hovers the tall element; the pill never leaves the top.
      await clearProbe(page);
      await callOk(client, "hover", { tabId, target: { ref } });
      let probe = await readProbe(page);
      expect(probe.tall.length, "the hover must reach the tall element").toBeGreaterThan(0);
      expect(
        probe.places.filter((entry) => entry.place === "bottom"),
        "a target covering both places must not move the pill (owner's edge top)",
      ).toEqual([]);
      expect((await readPill(page))?.place).toBe("top");

      // Owner's edge bottom: the same hover leaves it at the bottom.
      await movePill(journey, page, "bottom");
      await clearProbe(page);
      await callOk(client, "hover", { tabId, target: { ref } });
      probe = await readProbe(page);
      expect(
        probe.places.filter((entry) => entry.place === "top"),
        "a target covering both places must not move the pill (owner's edge bottom)",
      ).toEqual([]);
      expect((await readPill(page))?.place).toBe("bottom");
      await shootPill(page, testInfo, "s07-pill-tall-target");
    } finally {
      await journey.close();
    }
  });

  test("8. a computer left_click at a point under the pill reaches the page; no pill control is pressed", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const settings = await journey.settings();
      // The settings page lists a site only once a session tab is on it (as agent-actions.spec.ts does).
      const { tabId, page } = await openHeldTab(journey, client, FIXTURE);
      await settings.setSiteMode(SITE, "skip-checks");
      expect((await readPill(page))?.place).toBe("top");
      const edgeBefore = await storedEdge(journey);
      // CSS pixels, as the tool takes them when no screenshot has been made of the tab yet.
      const point = await centreOf(page, "#corner");

      await callOk(client, "computer", { tabId, action: "left_click", x: Math.round(point.x), y: Math.round(point.y) });

      const probe = await readProbe(page);
      expect(clicksOf(probe.corner), `the button must get the click: ${JSON.stringify(probe.corner)}`).toBe(1);
      expect(
        probe.corner.filter((hit) => hit.place !== "bottom"),
        "the press must find the pill at the bottom (a point has no box)",
      ).toEqual([]);
      expect(probe.pill.filter((press) => press.trusted), "no press may reach a pill control").toEqual([]);
      expect(await storedEdge(journey)).toBe(edgeBefore);
      expect(isWorkingPill(await readPill(page))).toBe(true);
    } finally {
      await journey.close();
    }
  });

  /* ------------------------------------------------------------ US3: open (gate live-us3-open) */

  test("9. a trusted press on Open side panel opens this window's panel within 1 s and changes no session or mode", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      // The panel was open to pair; this journey needs it closed. Chrome's own register says when it is.
      await closePanels(journey);
      await expect.poll(() => panelContexts(journey), { timeout: 10_000, message: "the panel must be closed" }).toEqual([]);
      const modesBefore = await storedModes(journey);
      const edgeBefore = await storedEdge(journey);

      await pressOnPill(journey.context, page, words.openPanel);
      // FR-531, SC-236: a side panel context exists within a second of the press.
      await expect
        .poll(async () => (await panelContexts(journey)).includes("SIDE_PANEL"), {
          timeout: 1_000,
          intervals: [50, 100, 100, 100, 100],
          message: "no side panel context within 1 s of the press",
        })
        .toBe(true);

      // FR-532: opening grants and changes nothing.
      expect(await storedModes(journey)).toBe(modesBefore);
      expect(await storedEdge(journey)).toBe(edgeBefore);
      await callOk(client, "tabs_context");
      const view = await readPill(page);
      expect(isWorkingPill(view), `the session must not be held: ${JSON.stringify(view)}`).toBe(true);
      expect(view?.text ?? "", "no not-opened message after a successful open").not.toContain(words.panelUnopened);
    } finally {
      await journey.close();
    }
  });

  test("10. pressing Open side panel with the panel already open changes nothing", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      const open = await panelContexts(journey);
      expect(open, "the journey's own panel must be open").toContain("SIDE_PANEL");
      const modesBefore = await storedModes(journey);
      const edgeBefore = await storedEdge(journey);

      await pressOnPill(journey.context, page, words.openPanel);
      await page.waitForTimeout(2_500);

      expect(await panelContexts(journey), "the panel stays as it was: still open, not duplicated").toEqual(open);
      expect(await storedModes(journey)).toBe(modesBefore);
      expect(await storedEdge(journey)).toBe(edgeBefore);
      await callOk(client, "tabs_context");
      const view = await readPill(page);
      expect(isWorkingPill(view)).toBe(true);
      expect(view?.text ?? "", "no not-opened message when the panel was already open").not.toContain(words.panelUnopened);
    } finally {
      await journey.close();
    }
  });

  test("11. a click the page makes on Open side panel opens nothing", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      await closePanels(journey);
      await expect.poll(() => panelContexts(journey), { timeout: 10_000, message: "the panel must be closed" }).toEqual([]);

      expect(await pageMadeClicks(page, words.openPanel, 20), "the pill's open control was not on the page").toBe(20);
      await page.waitForTimeout(2_500);

      expect(await panelContexts(journey), "a page click must open no panel").toEqual([]);
      const view = await readPill(page);
      expect(view?.text ?? "", "an untrusted click does not even try, so there is no message").not.toContain(words.panelUnopened);
    } finally {
      await journey.close();
    }
  });

  test("9b. when the open does not go through the pill says so", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      // As 034 scenario 10: after an extension reload the page's old script has no extension context, so
      // the open press is rejected - the one way to reach "the panel did not open" with a real press.
      await reloadOrSkip();
      await new Promise((done) => setTimeout(done, 1_500));
      expect(await readPill(page), "the old pill must still be on the page after the reload").toBeDefined();

      await pressOnPill(journey.context, page, words.openPanel);
      await expect
        .poll(async () => (await readPill(page))?.text ?? "", {
          timeout: 3_500,
          intervals: [100, 200, 250, 250, 250, 500],
          message: "no answer to the press: the pill must say the panel did not open within 2 s",
        })
        .toContain(words.panelUnopened);
      await shootPill(page, testInfo, "s09b-pill-not-opened");
    } finally {
      await journey.close();
    }
  });

  /* ------------------------------------ Edge cases at the bottom (gate live-034-at-bottom) */

  test("12. at the bottom, Stop and Resume (034) behave as at the top", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      await movePill(journey, page, "bottom");

      await pressOnPill(journey.context, page, words.stop);
      await waitForHeldPill(page);
      expect((await readPill(page))?.place, "the held pill stays at the bottom").toBe("bottom");
      await expect
        .poll(async () => (await cardViews(journey.panel)).some((card) => card.held === words.cardHeld), {
          timeout: 5_000,
          message: `the card must say ${words.cardHeld}`,
        })
        .toBe(true);
      expectHeldRefusal(await client.callTool("tabs_context"), "tabs_context", client);
      await shootPill(page, testInfo, "s12-pill-held-at-bottom");

      await pressOnPill(journey.context, page, words.resume);
      await waitForWorkingPill(page);
      expect((await readPill(page))?.place, "the resumed pill stays at the bottom").toBe("bottom");
      await expect
        .poll(async () => (await cardViews(journey.panel)).filter((card) => card.held !== null).length, { timeout: 5_000 })
        .toBe(0);
      await callOk(client, "tabs_context");
      expect(await storedEdge(journey), "Stop and Resume do not touch the owner's edge").toBe("bottom");
      await shootPill(page, testInfo, "s12-pill-resumed-at-bottom");
    } finally {
      await journey.close();
    }
  });

  test("12b. at the bottom, a Stop the page cannot deliver says so on the pill within 3 s", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(240_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { page } = await openHeldTab(journey, client, FIXTURE);
      await movePill(journey, page, "bottom");

      await reloadOrSkip();
      await new Promise((done) => setTimeout(done, 1_500));
      expect(await readPill(page), "the old pill must still be on the page after the reload").toBeDefined();

      await pressOnPill(journey.context, page, words.stop);
      await expect
        .poll(async () => (await readPill(page))?.text ?? "", {
          timeout: 3_000,
          intervals: [100, 200, 200, 250, 250, 250],
          message: "no answer to the press: the pill must say Stop did not arrive within 3 s",
        })
        .toContain(words.stopUndelivered);
      const view = await readPill(page);
      expect(view?.place, "the message sits in the pill, which stays at the bottom").toBe("bottom");
      expect(view?.buttons).toContain(words.stop);
      await shootPill(page, testInfo, "s12b-pill-undelivered-at-bottom");
    } finally {
      await journey.close();
    }
  });

  test("13. a screenshot hides the pill at the bottom and shows it again after", async ({ extensionContext, extensionId, extensionWorker }, testInfo) => {
    test.setTimeout(300_000);
    const journey = await openJourney({ extensionContext, extensionId, extensionWorker });
    try {
      const client = await pairedClient(journey);
      const { tabId, page } = await openHeldTab(journey, client, FIXTURE);
      await movePill(journey, page, "bottom");
      await clearProbe(page);

      await callOk(client, "screenshot", { tabId });

      // The marks were hidden for the capture (data-hallpass-hidden on the pill, seen by the page) while
      // the pill was at the bottom, and are shown again; nothing is left hidden.
      await expect
        .poll(async () => (await readProbe(page)).hidden.at(-1)?.on, { timeout: 5_000, message: "the pill was not shown again after the capture" })
        .toBe(false);
      const hidden = (await readProbe(page)).hidden;
      expect(
        hidden.some((entry) => entry.on && entry.place === "bottom"),
        `the pill must be hidden at the bottom during the capture: ${JSON.stringify(hidden)}`,
      ).toBe(true);
      const after = await page.evaluate((attribute) => {
        const pill = document.querySelector(`[${attribute}]`);
        return pill ? { hidden: pill.hasAttribute("data-hallpass-hidden"), opacity: getComputedStyle(pill).opacity } : undefined;
      }, PILL);
      expect(after, "the pill must still be on the page").toBeDefined();
      expect(after?.hidden).toBe(false);
      expect(Number(after?.opacity)).toBeGreaterThan(0.99);
      expect((await readPill(page))?.place).toBe("bottom");
      await shootPill(page, testInfo, "s13-pill-shown-after-capture");
    } finally {
      await journey.close();
    }
  });
});

type Fixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
};

/* ------------------------------------------------------------------------------------------------
 * The journey: the side panel, the clients of this test and the owner's own tab.
 * ---------------------------------------------------------------------------------------------- */

type Journey = {
  context: BrowserContext;
  extensionId: string;
  worker: PackagedWorker;
  ownerPage: Page;
  panel: SidePanelDriver;
  connect(): Promise<McpHarnessClient>;
  settings(): Promise<SettingsPageDriver>;
  /** Puts the edge back to top, then closes the clients. */
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
  const journey: Journey = {
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
      await restoreEdgeToTop(journey).catch(() => undefined);
      for (const started of clients) await started.close().catch(() => undefined);
    },
  };
  return journey;
}

/** A client the owner has paired: the first call raises the card, Accept is pressed, the call is answered. */
async function pairedClient(journey: Journey): Promise<McpHarnessClient> {
  const client = await journey.connect();
  await journey.panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, journey.panel, { locale });
  return client;
}

/** The session opens a tab on `path`; resolves once its pill is up, offering Stop. */
async function openHeldTab(journey: Journey, client: McpHarnessClient, path: string): Promise<{ tabId: number; page: Page }> {
  const created = (await callOk(client, "tabs_create", { url: `${SITE}${path}` })) as { tabId: number };
  const page = await agentPage(journey.context, `${SITE}${path}`);
  await waitForWorkingPill(page);
  return { tabId: created.tabId, page };
}

/**
 * The end of a journey: when the owner's edge is still the bottom, a trusted press on a "Move to top"
 * control puts it back (through the worker, as an owner would); failing that the stored value is
 * written directly (the per-test reset clears `storage.local` before the next journey in any case).
 */
async function restoreEdgeToTop(journey: Journey): Promise<void> {
  if ((await storedEdge(journey)) !== "bottom") return;
  for (const page of journey.context.pages()) {
    const view = await readPill(page);
    if (view?.buttons.includes(words.moveToTop)) {
      await pressOnPill(journey.context, page, words.moveToTop);
      break;
    }
  }
  await new Promise((done) => setTimeout(done, 500));
  if ((await storedEdge(journey)) === "bottom") {
    await workerEval(journey.extensionId, `chrome.storage.local.set({ agentPillEdge: "top" })`);
  }
}

/* ------------------------------------------------------------------------------------------------
 * The pill, read and pressed from the page side.
 * ---------------------------------------------------------------------------------------------- */

type Place = "top" | "bottom";
type PillView = { text: string; label: string; buttons: string[]; place: Place };

/** What the pill says and offers, and which half of the viewport it is in; `undefined` when there is none. */
async function readPill(page: Page): Promise<PillView | undefined> {
  try {
    return await page.evaluate((attribute) => {
      const pill = document.querySelector(`[${attribute}]`);
      if (!pill) return undefined;
      const label = pill.querySelector("span");
      const box = pill.getBoundingClientRect();
      return {
        text: pill.textContent ?? "",
        label: label?.textContent ?? "",
        buttons: [...pill.querySelectorAll("button")].map((button) => button.textContent ?? ""),
        place: (box.top + box.height / 2 < window.innerHeight / 2 ? "top" : "bottom") as "top" | "bottom",
      };
    }, PILL);
  } catch {
    return undefined;
  }
}

/** At `place`, with the move control naming the other edge. */
function pillAt(view: PillView | undefined, place: Place): boolean {
  return view !== undefined && view.place === place && view.buttons.includes(place === "bottom" ? words.moveToTop : words.moveToBottom);
}

function isHeldPill(view: PillView | undefined): boolean {
  return view !== undefined && view.label === words.held && view.buttons.includes(words.resume) && !view.buttons.includes(words.stop);
}

function isWorkingPill(view: PillView | undefined): boolean {
  return view !== undefined && view.buttons.includes(words.stop) && !view.buttons.includes(words.resume);
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
 * content script sees is trusted (see agent-pill-stop.spec.ts).
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

/** The page's own `click()` on a pill control, `times` times; what a hostile page can do to its document. */
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

/** A trusted press on the move control, then until every drawn pill of the page is at the edge. */
async function movePill(journey: Journey, page: Page, to: Place): Promise<void> {
  await pressOnPill(journey.context, page, to === "bottom" ? words.moveToBottom : words.moveToTop);
  await expect
    .poll(async () => pillAt(await readPill(page), to), { timeout: 5_000, message: `the pill never moved to the ${to}` })
    .toBe(true);
  expect(await storedEdge({ extensionId: journey.extensionId })).toBe(to);
}

/* ------------------------------------------------------------------------------------------------
 * The fixture page's probe (tests/e2e/fixtures/pages/pill-move-035.html).
 * ---------------------------------------------------------------------------------------------- */

type Hit = { type: string; place: Place | "none"; trusted: boolean };
type Probe = {
  places: Array<{ place: Place | "none" }>;
  hidden: Array<{ on: boolean; place: Place | "none" }>;
  corner: Hit[];
  centre: Hit[];
  tall: Hit[];
  pill: Array<{ type: string; trusted: boolean }>;
};

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __pill035: unknown }).__pill035)) as Probe);
}

async function clearProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as unknown as { __pill035: Record<string, unknown[]> }).__pill035;
    for (const list of Object.values(probe)) list.length = 0;
  });
}

/** The first place the page's pill was seen at; `undefined` until the pill has been drawn. */
async function firstPlaceOf(page: Page): Promise<Place | undefined> {
  for (const entry of (await readProbe(page)).places) {
    if (entry.place !== "none") return entry.place;
  }
  return undefined;
}

function clicksOf(hits: Hit[]): number {
  return hits.filter((hit) => hit.type === "click").length;
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) throw new Error(`no ${query}`);
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
}

/* ------------------------------------------------------------------------------------------------
 * The worker's own state, read over its DevTools socket (one fresh socket per read, so a restarted
 * worker is read as well as the first one).
 * ---------------------------------------------------------------------------------------------- */

async function workerEval<T>(extensionId: string, expression: string): Promise<T> {
  const endpoint = process.env.HALLPASS_CDP_ENDPOINT ?? "";
  const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
  const target = targets.find((entry) => entry.type === "service_worker" && entry.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!target?.webSocketDebuggerUrl) throw new Error("extension-worker-target-missing");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((ready, failed) => {
    socket.addEventListener("open", () => ready(), { once: true });
    socket.addEventListener("error", () => failed(new Error("cdp-worker-socket-failed")), { once: true });
  });
  try {
    const reply = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }>((done, failed) => {
      const timer = setTimeout(() => failed(new Error("cdp-worker-evaluation-timeout")), 15_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number };
        if (message.id !== 1) return;
        clearTimeout(timer);
        done(message as never);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || reply.result?.exceptionDetails) throw new Error(`cdp-worker-evaluation-failed:${JSON.stringify(reply.error ?? reply.result?.exceptionDetails)}`);
    return reply.result?.result?.value as T;
  } finally {
    socket.close();
  }
}

/** The owner's stored edge (`agentPillEdge`); nothing stored reads as top, today's place. */
async function storedEdge(of: { extensionId: string }): Promise<Place> {
  const value = await workerEval<string | null>(of.extensionId, `chrome.storage.local.get("agentPillEdge").then((raw) => raw.agentPillEdge ?? null)`);
  return value === "bottom" ? "bottom" : "top";
}

/** The site-mode records as one string, to compare before and after. */
async function storedModes(of: { extensionId: string }): Promise<string> {
  return workerEval<string>(of.extensionId, `chrome.storage.local.get("agentSiteModes").then((raw) => JSON.stringify(raw.agentSiteModes ?? null))`);
}

/** The context types of every side-panel document Chrome has (`SIDE_PANEL` for one `sidePanel.open` made). */
async function panelContexts(of: { extensionId: string }): Promise<string[]> {
  return workerEval<string[]>(
    of.extensionId,
    `chrome.runtime.getContexts({}).then((contexts) => contexts.filter((context) => (context.documentUrl ?? "").includes("side-panel.html")).map((context) => context.contextType))`,
  );
}

/** Closes every side-panel document (the browser's own way of closing it: its document goes). */
async function closePanels(journey: Journey): Promise<void> {
  const session = await journey.context.newCDPSession(journey.ownerPage);
  try {
    const { targetInfos } = (await session.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; url: string }> };
    for (const target of targetInfos) {
      if (target.url.startsWith(`chrome-extension://${journey.extensionId}/side-panel.html`)) {
        await session.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
      }
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
  await journey.ownerPage.bringToFront();
}

/* ------------------------------------------------------------------------------------------------
 * The session card, read through the side panel's own DOM (034 held state).
 * ---------------------------------------------------------------------------------------------- */

type CardView = { sessionId: string; held: string | null; buttons: string[] };

async function cardViews(panel: SidePanelDriver): Promise<CardView[]> {
  const views = await safely(
    () =>
      panel.evaluatePanel(
        `[...document.querySelectorAll('[data-session-id]')].map((card) => ({` +
          `sessionId: card.getAttribute('data-session-id') ?? '',` +
          `held: card.querySelector('.agent-session-held')?.textContent?.trim() ?? null,` +
          `buttons: [...card.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '')}))`,
      ),
    [],
  );
  return Array.isArray(views) ? (views as CardView[]) : [];
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

/** One live ref for a named control, from a structural read of the tab. */
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

/** A read that may fail while a page is between documents; the fallback is "nothing seen". */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** Reloads the extension in place; a browser that refuses `Extensions.loadUnpacked` skips the journey. */
async function reloadOrSkip(): Promise<void> {
  try {
    await reloadExtension(process.env.HALLPASS_CDP_ENDPOINT ?? "");
  } catch (error) {
    test.skip(true, `this browser refused Extensions.loadUnpacked, so the extension cannot be reloaded under it: ${String(error)}`);
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
  console.log(`[T1047] ${name} -> ${whole}`);
}
