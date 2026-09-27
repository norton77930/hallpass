import type { BrowserContext, Page } from "@playwright/test";
import { ATTENTION_SENTENCES } from "@hallpass/contracts";
import { ATTENTION_BADGE_TEXT } from "../../../apps/extension/src/chrome-adapters/action-badge.js";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing, pairWithFirstCall, unpairAgent } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const ORDINARY = `${SITE}/ordinary`;
const GESTURES = `${SITE}/gestures`;

/**
 * The three bounds this journey is about, named here rather than imported.
 *
 * `prompts.ts` and `pairing-controller.ts` are service-worker modules: importing either into a
 * Playwright test would pull the worker's `chrome.*` surface into Node to read two numbers. They
 * are pinned by the unit and contract suites (011/T283, T290); what a packaged run adds is that
 * the browser actually behaves as if they hold, which is what the waits below measure.
 */
/** `CLOSED_PANEL_TIMEOUT_MS` - the bound the worker fixes at raise when no panel is connected. */
const CLOSED_PANEL_BOUND_MS = 120_000;
/** `PAIRING_BOUND_MS` - the bound that would have applied had a panel been connected. */
const OPEN_PANEL_PAIRING_BOUND_MS = 45_000;
/** `PROMPT_WAITING_TICK_MS` plus the trip through relay, host and stdio (contract: 5 000 ±500). */
const FIRST_TICK_BUDGET_MS = 6_000;

/**
 * How far the pointer's travel may differ from the distance between the two controls it moved
 * between. The press is addressed to the element's centre (`effects.ts` `centreOf`), so the two are
 * the same number; the slack is for sub-pixel layout and the page's own reflow, not for a mark that
 * landed somewhere else.
 */
const POINTER_TRAVEL_TOLERANCE_PX = 15;

/** Below this the fixture is not showing an approach at all, whatever the pointer did. */
const POINTER_MIN_SPAN_PX = 40;

/**
 * 011/T297 — the first call of a session, made into a browser whose side panel nobody has opened.
 *
 * This is the observed failure the whole feature exists for: Chrome opens the side panel only on a
 * user gesture (R-160), so an agent's first tool call draws a pairing card into a panel that is not
 * there, and the person at the terminal sees a timeout and no instruction. Only a real browser can
 * settle whether the answer works, because every part of it is a fact about another process: the
 * progress notification has to cross worker → relay → host → stdio inside five seconds, the badge
 * is browser state the worker does not hold, and the two-minute bound is worth nothing unless the
 * call is still open when the person finally clicks Accept.
 *
 * Each test leaves the browser unpaired, because the fixture's reset is what the *next* file
 * depends on and a paired browser makes a pairing card impossible to observe.
 *
 * Attach mode only, like every other agent journey: the bridge starts with a machine install of
 * the native-messaging host, which a browser the runner launched is not registered against.
 */
test.describe("agent first run: the panel nobody opened", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  /**
   * US1 scenarios 1 and 2; SC-078, SC-079 (the answered half), SC-080 (set, then cleared).
   *
   * The Accept is deliberately pressed *past* `OPEN_PANEL_PAIRING_BOUND_MS`. Accepting at ten
   * seconds would pass under either bound and would prove nothing about which one applied; a call
   * that is still open at fifty seconds can only be one the worker gave two minutes.
   */
  test("tells the agent where to click, badges the icon, and is still waiting past the open-panel bound", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(ORDINARY);
    await ownerPage.bringToFront();
    const ownerTabId = await activeTabId(extensionWorker);

    // The precondition is the whole point, so it is established and then checked, never assumed:
    // the fixture's own wake-up opens a panel document and closes it again, and a leftover one
    // would silently turn this into the 45-second journey the sibling files already cover.
    await closePanelDocuments(extensionContext, ownerPage, extensionId);
    await expect.poll(() => panelDocumentCount(extensionWorker), { timeout: 15_000 }).toBe(0);

    let client: McpHarnessClient | undefined;
    let panel: SidePanelDriver | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const notes: ProgressNote[] = [];
      let settled = false;
      const startedAt = Date.now();
      const call = live
        .callTool(
          "tabs_context",
          {},
          // Past the SDK's own 60 s default, which would otherwise end the call before the person
          // this journey is about has finished walking to their browser (see `ToolCallOptions`).
          { onProgress: (note) => notes.push({ ...note, at: Date.now() }), timeoutMs: 150_000 },
        )
        .then((result) => {
          settled = true;
          return result;
        });

      // --- Scenario 1: the agent is told, in words it will relay, within five seconds. ---
      await expect
        .poll(() => notes.filter((note) => note.message === ATTENTION_SENTENCES.pairing).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const first = notes.find((note) => note.message === ATTENTION_SENTENCES.pairing);
      const elapsed = (first?.at ?? Date.now()) - startedAt;
      // eslint-disable-next-line no-console -- SC-078's number, which is the claim, not a detail.
      console.log(`[T297] the pairing sentence reached the client ${elapsed} ms after the call`);
      expect(elapsed, "SC-078: the person hears within five seconds of the call").toBeLessThan(FIRST_TICK_BUDGET_MS);
      // The bound travelled with it: the client is told it has two minutes, not twenty-five seconds.
      expect(first?.total).toBe(CLOSED_PANEL_BOUND_MS);

      // --- SC-080, first transition: the icon carries the mark while the question waits. ---
      await expect.poll(() => badgeText(extensionWorker), { timeout: 15_000 }).toBe(ATTENTION_BADGE_TEXT);

      // --- FR-148: the call is still open where the open-panel bound would have ended it. ---
      await ownerPage.waitForTimeout(Math.max(0, startedAt + OPEN_PANEL_PAIRING_BOUND_MS + 5_000 - Date.now()));
      expect(
        settled,
        `FR-148: the call must outlive the ${OPEN_PANEL_PAIRING_BOUND_MS} ms bound that applies with a panel open`,
      ).toBe(false);
      expect(await panelDocumentCount(extensionWorker), "no panel was opened behind the test's back").toBe(0);

      // --- Scenario 2: the person opens the panel, the card is already there, and the call lands. ---
      panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
      await waitForAgentPanel(panel);
      // `acceptPairing` fails loudly if the card is not on screen, so its `accepted` is FR-149's
      // evidence: the request raised into a closed panel was waiting in the panel that opened.
      expect(await acceptPairing(panel, { locale, timeoutMs: 60_000 })).toBe("accepted");

      const result = await call;
      expect(result.isError, `tabs_context failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
      expect(Array.isArray(result.json)).toBe(true);

      // --- SC-080, second transition: answered, so the icon is plain again. ---
      await expect.poll(() => badgeText(extensionWorker), { timeout: 15_000 }).toBe("");

      await unpairAgent(panel, { locale });
    } finally {
      await client?.close();
    }
  });

  /**
   * US2 scenarios 1, 2, 3 and 5 — the same mechanism for a consent card, which is the case that
   * recurs for the whole life of a session rather than only at its start.
   *
   * The last third is the control the spec asks for (scenario 5, SC-081): the identical effect with
   * a panel connected must reach the person through the card alone - no sentence, no badge.
   */
  test("says the same for a consent card, shows it on opening, and says nothing when a panel is open", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(ORDINARY);
    await ownerPage.bringToFront();
    const ownerTabId = await activeTabId(extensionWorker);

    let client: McpHarnessClient | undefined;
    let panel: SidePanelDriver | undefined;
    let heldTab: number | undefined;
    try {
      panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
      await waitForAgentPanel(panel);
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale, timeoutMs: 60_000 });
      const call = callThrough(live);

      heldTab = ((await call("tabs_create", { url: ORDINARY })) as { tabId: number }).tabId;
      const held = heldTab;
      await setSiteMode(panel, SITE, "ask");
      // A read is not an effect, so it asks nothing - and it gives the ref the click needs.
      await call("read_page", { tabId: held, filter: "interactive" });

      // --- The person closes the panel and walks away; the agent acts on an `ask` site. ---
      await closePanelDocuments(extensionContext, ownerPage, extensionId);
      await expect.poll(() => panelDocumentCount(extensionWorker), { timeout: 15_000 }).toBe(0);

      // Resolved before the clock starts: SC-078 counts from the call that raises the card, and a
      // `find` round trip folded into that number would be measuring the wrong thing.
      const target = { ref: await refFor(call, held, "Safe action") };
      const notes: ProgressNote[] = [];
      const startedAt = Date.now();
      const clicking = live.callTool("click", { tabId: held, target }, {
        onProgress: (note) => notes.push({ ...note, at: Date.now() }),
        // The card is given two minutes; the client must not be the thing that gives up first.
        timeoutMs: 150_000,
      });

      // --- Scenario 1: the sentence for a consent card, and the badge. ---
      await expect
        .poll(() => notes.filter((note) => note.message === ATTENTION_SENTENCES.consent).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const first = notes.find((note) => note.message === ATTENTION_SENTENCES.consent);
      const elapsed = (first?.at ?? Date.now()) - startedAt;
      // eslint-disable-next-line no-console -- the consent half of SC-078's number.
      console.log(`[T297] the consent sentence reached the client ${elapsed} ms after the call`);
      expect(elapsed).toBeLessThan(FIRST_TICK_BUDGET_MS);
      expect(first?.total).toBe(CLOSED_PANEL_BOUND_MS);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 15_000 }).toBe(ATTENTION_BADGE_TEXT);

      // --- Scenarios 2 and 3: the card is there the moment a panel is, and answering completes
      //     the original call. No second call was made, and the panel was never reloaded. ---
      panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const clicked = await clicking;
      expect(clicked.isError, `click failed: ${clicked.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 15_000 }).toBe("");

      // --- Scenario 5, the control: with a panel connected nothing is said and nothing is marked.
      //     The answer is deliberately withheld past one tick, so the *absence* of the sentence is
      //     a sentence that was due and neutral rather than one that was never sent. ---
      const quiet: ProgressNote[] = [];
      const controlled = live.callTool(
        "click",
        { tabId: held, target: { ref: await refFor(call, held, "Safe action") } },
        { onProgress: (note) => quiet.push({ ...note, at: Date.now() }) },
      );
      await panel.waitForText(ui("agent.promptTitle"));
      await ownerPage.waitForTimeout(FIRST_TICK_BUDGET_MS + 1_000);
      expect(quiet.map((note) => note.message)).not.toContain(ATTENTION_SENTENCES.consent);
      expect(quiet.map((note) => note.message)).not.toContain(ATTENTION_SENTENCES.pairing);
      expect(await badgeText(extensionWorker), "FR-147: a card the person can see needs no badge").toBe("");
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await controlled).isError).toBe(false);

      await call("tabs_close", { tabId: held });
      heldTab = undefined;
      await unpairAgent(panel, { locale });
    } finally {
      if (client && heldTab !== undefined) {
        await client.callTool("tabs_close", { tabId: heldTab, force: true }).catch(() => undefined);
      }
      await client?.close();
    }
  });

  /**
   * US1 scenario 3; SC-079's second half — nobody comes, and the answer says where they should have.
   *
   * This one waits the real two minutes. There is no shorter road: `HALLPASS_AGENT_PAIRING_TIMEOUT_MS`
   * shortens the *server's* bound, and `extendPairingBound` (mcp-server.ts) only ever lengthens it,
   * so the worker's first closed-panel tick at five seconds raises whatever the env set back to
   * 120 000. Shortening the worker's bound would need a lever for `closedPanelTimeoutMs`
   * (`agent-tools/prompts.ts`), and the packaged worker is handed none - a service worker cannot
   * read an environment, and the runtime passes the dep through from nowhere.
   *
   * What this therefore does *not* assert is SC-080's third transition, the badge clearing on
   * expiry. The host withdraws the pairing exchange at its bound and tells the worker nothing
   * (`agent.pair.withdrawn`), so the worker's own card - which has no bound of its own - stays
   * pending and the badge stays lit. The transition is real for a consent prompt, whose controller
   * does expire on its own deadline; reaching it in a packaged build is what the missing lever
   * would buy, and the unit suite pins it in the meantime (`prompt-waiting.test.ts`).
   */
  test("ends the call with the sentence as a hint when nobody opens the panel", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(420_000);

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(ORDINARY);
    await ownerPage.bringToFront();
    await closePanelDocuments(extensionContext, ownerPage, extensionId);
    await expect.poll(() => panelDocumentCount(extensionWorker), { timeout: 15_000 }).toBe(0);

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const notes: ProgressNote[] = [];
      const startedAt = Date.now();
      const result = await live.callTool("tabs_context", {}, {
        onProgress: (note) => notes.push({ ...note, at: Date.now() }),
        /**
         * The SDK's default is 60 s, and a client that gave up at 60 s would answer this test with
         * `McpError: Request timed out` - the harness's verdict, not the product's. The bound here
         * is longer than the two minutes the worker fixed, so what ends the call is the thing under
         * test. Claude Code's own bound is hours (R-161), so this is the faithful setting, not a
         * generous one.
         */
        timeoutMs: 200_000,
      });
      const waited = Date.now() - startedAt;
      // eslint-disable-next-line no-console -- SC-079's second number.
      console.log(`[T297] the unanswered call ended after ${waited} ms with ${notes.length} progress notices`);

      expect(result.isError).toBe(true);
      expect(result.json).toMatchObject({
        outcome: "timed-out",
        reason: "not-paired: no answer",
        hint: ATTENTION_SENTENCES.pairing,
      });
      // The two minutes were actually spent: neither the host's 30 s backstop nor the client's own
      // bound ended it early, and it did not run past the router's 130 s cap either.
      expect(waited).toBeGreaterThan(CLOSED_PANEL_BOUND_MS - 20_000);
      expect(waited).toBeLessThan(CLOSED_PANEL_BOUND_MS + 40_000);
      // It said so all the way through, not once at the start (FR-148's "at least every 5 seconds").
      expect(notes.filter((note) => note.message === ATTENTION_SENTENCES.pairing).length).toBeGreaterThan(10);
    } finally {
      await client?.close();
    }
  });

  /**
   * US3 scenario 1; SC-083's baseline half (FR-153) — the pointer is a real approach, not a jump.
   *
   * What is asserted of each press is the thing the owner asked for: the pointer is on the target,
   * drawn with the glide transition, and it travelled there from where the previous gesture left
   * it. It is read off the page's own DOM, never off a worker internal.
   *
   * Everything is measured in **document** coordinates. The first run of this test (2026-09-21)
   * read the mark in viewport coordinates and saw travels of 21 px and 9 px between controls the
   * fixture lays out far further apart, which is what locating a ref does: it scrolls the element
   * to the centre of the viewport (`effects.ts` ~:633, `collector.ts:827`, `block: "center"`), so
   * every click point lands at roughly the same place *on screen* however far the page moved under
   * it. The cursor is `position: fixed`, so its transform is a viewport point; adding the scroll
   * offset read in the same evaluation puts both the mark and the target on the page's own ruler,
   * where the distance between two controls is a fact about the fixture rather than about scrolling.
   */
  test("draws the pointer on each target before pressing it, travelling the distance between them", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(ORDINARY);
    await ownerPage.bringToFront();
    const ownerTabId = await activeTabId(extensionWorker);

    let client: McpHarnessClient | undefined;
    let heldTab: number | undefined;
    try {
      const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
      await waitForAgentPanel(panel);
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale, timeoutMs: 60_000 });
      const call = callThrough(live);

      heldTab = ((await call("tabs_create", { url: GESTURES })) as { tabId: number }).tabId;
      const held = heldTab;
      // The pointer is the subject here, so no card stands between the calls and the page.
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId: held, filter: "interactive" });

      const page = await pageAt(extensionContext, GESTURES);
      /**
       * Three controls of the gestures fixture that a plain click does not lay out again: the menu
       * button is left out because hovering it reveals the submenu and moves everything below it,
       * which would move the targets between the measurement and the press.
       */
      const labels = ["Open on double-click", "Context target", "Beta"];
      const refs = new Map<string, string>();
      for (const label of labels) refs.set(label, await refFor(call, held, label));

      // Top, bottom, middle: the first travel is the whole span of the three, so the run's own log
      // says at once whether the fixture offers a distance worth calling a glide.
      const centres = new Map<string, DocumentPoint>();
      for (const label of labels) centres.set(label, await centreOf(page, label));
      const order = labels
        .slice()
        .sort((left, right) => (centres.get(left)?.y ?? 0) - (centres.get(right)?.y ?? 0));
      const clicks = [order[0], order[2], order[1]].map((label) => label ?? "");
      expect(clicks.every((label) => label.length > 0)).toBe(true);
      // eslint-disable-next-line no-console -- the fixture's own geometry, in document pixels.
      console.log(
        `[T297] target centres ${clicks
          .map((label) => `${label}=(${Math.round(centres.get(label)?.x ?? 0)},${Math.round(centres.get(label)?.y ?? 0)})`)
          .join(" ")}`,
      );

      const travels: number[] = [];
      const expected: number[] = [];
      let previous: { label: string; at: DocumentPoint } | undefined;
      for (const label of clicks) {
        const before = await readPointer(page, label);
        if (previous) {
          expect(before.mark, `FR-153: the pointer is on the page before the press on ${label}`).not.toBeNull();
        }
        const ref = refs.get(label);
        expect(ref, `no ref for ${label}`).toBeTruthy();
        await call("click", { tabId: held, target: { ref: ref as string } });

        // One evaluation for the mark, the target's box and the scroll, so the three cannot
        // disagree about which moment they describe.
        const after = await readPointer(page, label);
        expect(after.mark, `FR-153: the pointer is drawn for the press on ${label}`).not.toBeNull();
        expect(after.rect, `the gestures fixture lost the control labelled '${label}'`).not.toBeNull();
        const mark = after.mark as NonNullable<PointerReading["mark"]>;
        const rect = after.rect as NonNullable<PointerReading["rect"]>;
        // The glide, not a jump: the transform is animated by the browser (cursor.ts GLIDE_TRANSITION)
        // and `input.ts` waits for its `transitionend` before dispatching the press.
        expect(mark.transition).toContain("transform");
        // And it ended on the target: the point the press was addressed to is inside the element
        // the press landed on, which is only true if the arrival happened first. Both sides of this
        // are viewport numbers from the same evaluation, so the scroll is common to them.
        expect(mark.x, `pointer x on ${label}`).toBeGreaterThanOrEqual(rect.left - 1);
        expect(mark.x, `pointer x on ${label}`).toBeLessThanOrEqual(rect.right + 1);
        expect(mark.y, `pointer y on ${label}`).toBeGreaterThanOrEqual(rect.top - 1);
        expect(mark.y, `pointer y on ${label}`).toBeLessThanOrEqual(rect.bottom + 1);

        const at: DocumentPoint = { x: mark.x + after.scroll.x, y: mark.y + after.scroll.y };
        if (previous) {
          const from = centres.get(previous.label) as DocumentPoint;
          const to = centres.get(label) as DocumentPoint;
          travels.push(Math.hypot(at.x - previous.at.x, at.y - previous.at.y));
          expected.push(Math.hypot(to.x - from.x, to.y - from.y));
        }
        previous = { label, at };
      }

      // eslint-disable-next-line no-console -- SC-083's distances, kept with the run.
      console.log(
        `[T297] pointer travelled ${travels.map((value) => Math.round(value)).join(", ")} px ` +
          `against target distances ${expected.map((value) => Math.round(value)).join(", ")} px`,
      );
      expect(travels).toHaveLength(2);
      // The mark went exactly as far as the controls are apart: it left the previous target and
      // arrived at this one, rather than being re-drawn wherever the page happened to scroll to.
      for (const [index, travel] of travels.entries()) {
        expect(
          Math.abs(travel - (expected[index] ?? 0)),
          `press ${index + 2}: the pointer travelled ${Math.round(travel)} px between controls ` +
            `${Math.round(expected[index] ?? 0)} px apart`,
        ).toBeLessThanOrEqual(POINTER_TRAVEL_TOLERANCE_PX);
      }
      // A fixture whose controls sit on top of each other could satisfy the above and still show
      // nothing anyone would call an approach, so the span says so in its own words.
      expect(
        expected[0] ?? 0,
        "the three gestures controls are too close together to prove a glide; pick controls further apart",
      ).toBeGreaterThan(POINTER_MIN_SPAN_PX);

      await call("tabs_close", { tabId: held });
      heldTab = undefined;
      await unpairAgent(panel, { locale });
    } finally {
      if (client && heldTab !== undefined) {
        await client.callTool("tabs_close", { tabId: heldTab, force: true }).catch(() => undefined);
      }
      await client?.close();
    }
  });
});

/** One `notifications/progress`, with the moment this process saw it - which is what SC-078 counts. */
type ProgressNote = { at: number; progress: number; total?: number; message?: string };

/** A point on the page's own ruler: viewport coordinates plus the scroll they were read at. */
type DocumentPoint = { x: number; y: number };

/**
 * One instant of the page: where the pointer mark is, where the control it was sent to is, and how
 * far the page is scrolled. Read together because a scroll between two of them would make the
 * three describe different moments - which is the mistake the first run of this test made.
 */
type PointerReading = {
  /** Viewport coordinates, from the fixed mark's own transform; `null` when nothing is drawn. */
  mark: { x: number; y: number; transition: string } | null;
  /** The target's box in the same viewport coordinates. */
  rect: { top: number; bottom: number; left: number; right: number } | null;
  scroll: DocumentPoint;
};

/** The tab the owner is looking at, which is the one a panel is opened against. */
async function activeTabId(worker: PackagedWorker): Promise<number> {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
}

/** What the toolbar icon is wearing, read from the browser rather than from the worker's intent. */
async function badgeText(worker: PackagedWorker): Promise<string> {
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

/**
 * How many side-panel documents exist, asked of Chrome.
 *
 * "Closed" is this journey's precondition, so it is checked against the browser's own register of
 * extension contexts rather than against the worker's port bookkeeping - which is the very thing
 * the closed-panel bound is derived from, and so cannot be its own witness.
 */
async function panelDocumentCount(worker: PackagedWorker): Promise<number> {
  return worker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({});
    return contexts.filter((context) => (context.documentUrl ?? "").includes("side-panel.html")).length;
  });
}

/** Closes every side-panel document, including the launcher page the driver opens to get a gesture. */
async function closePanelDocuments(context: BrowserContext, controlPage: Page, extensionId: string): Promise<void> {
  const cdp = await context.newCDPSession(controlPage);
  try {
    const targets = await cdp.send("Target.getTargets");
    for (const target of targets.targetInfos) {
      if (!target.url.startsWith(`chrome-extension://${extensionId}/side-panel.html`)) continue;
      await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The sibling files' call helper: fail on the tool's own words, not on a later assertion. */
function callThrough(client: McpHarnessClient): (tool: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (tool, args = {}) => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
}

async function refFor(
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as { outcome: string; matches: Array<{ ref: string }> };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const first = found.matches[0]?.ref;
  expect(first, `find '${query}' returned no ref`).toBeTruthy();
  return first as string;
}

/** The same panel-driven site mode the sibling journeys use; never a storage write (FR-042). */
async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const sel=document.querySelector('[data-site=${JSON.stringify(site)}] select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`), {
      timeout: 15_000,
    })
    .toBe(mode);
}

/** The owner's own page for a url a tool opened, so the page's DOM can be read directly. */
async function pageAt(context: BrowserContext, url: string): Promise<Page> {
  let page: Page | undefined;
  const deadline = Date.now() + 15_000;
  while (!page && Date.now() < deadline) {
    page = context.pages().find((candidate) => candidate.url().startsWith(url));
    if (!page) await new Promise((wait) => setTimeout(wait, 200));
  }
  if (!page) throw new Error(`no page at ${url}`);
  return page;
}

/**
 * The centre of a labelled control, on the page's own ruler.
 *
 * The centre rather than a corner because that is the point a press is addressed to
 * (`effects.ts` `centreOf`), and the document ruler because locating a ref scrolls it to the middle
 * of the viewport, so a viewport number says more about the scroll than about the fixture.
 */
async function centreOf(page: Page, label: string): Promise<DocumentPoint> {
  const centre = await page.evaluate((wanted: string) => {
    const element = document.querySelector<HTMLElement>(`[aria-label="${wanted}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 + window.scrollX, y: rect.top + rect.height / 2 + window.scrollY };
  }, label);
  expect(centre, `the gestures fixture has no control labelled '${label}'`).not.toBeNull();
  return centre as DocumentPoint;
}

/**
 * The pointer as the page carries it, beside the control it was sent to and the page's scroll.
 *
 * `cursor.ts` draws one `position: fixed` mark and moves it by transform alone, so the transform
 * *is* the viewport point the press is addressed to; the scroll read in the same evaluation is what
 * turns it into a document point that two gestures can be compared across.
 */
async function readPointer(page: Page, label: string): Promise<PointerReading> {
  return page.evaluate((wanted: string) => {
    const drawn = document.querySelector<HTMLElement>("[data-hallpass-cursor]");
    const matched = drawn ? /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(drawn.style.transform) : null;
    const element = document.querySelector<HTMLElement>(`[aria-label="${wanted}"]`);
    const box = element?.getBoundingClientRect();
    return {
      mark:
        drawn && matched?.[1] && matched[2]
          ? { x: Number(matched[1]), y: Number(matched[2]), transition: drawn.style.transition }
          : null,
      rect: box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : null,
      scroll: { x: window.scrollX, y: window.scrollY },
    };
  }, label);
}
