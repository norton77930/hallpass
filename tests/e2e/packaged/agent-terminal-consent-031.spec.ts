import type { BrowserContext, Page } from "@playwright/test";
import { CONSENT_TIMEOUT_HINT } from "@hallpass/contracts";
import { ATTENTION_BADGE_TEXT } from "../../../apps/extension/src/chrome-adapters/action-badge.js";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { scaledMs } from "../../../packages/test-kit/src/time-scale.js";
import {
  alwaysReply,
  repliesInOrder,
  startElicitingClient,
  type ElicitationCapability,
  type ElicitationRecord,
  type ElicitationScript,
  type ElicitingMcpClient,
} from "../../harness/elicitation-mcp-client.js";
import type { ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SiteMode } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 031 US1 + US2 (FR-467 - FR-475, contracts/terminal-consent.md, T928): an outside agent's consent
 * question is put to the owner in the agent's own client as well as on the side-panel card, and the
 * first answer in either place decides it.
 *
 * The agent side is a scripted MCP client (`tests/harness/elicitation-mcp-client.ts`) that talks to
 * the real `dist/mcp-server.js` over stdio and answers `elicitation/create` from a per-test script,
 * so every client-side branch runs without a person. The owner's side is the real side panel, read
 * and pressed through its DOM like every other `agent-*` journey.
 *
 * Each claim is read on two surfaces, because either alone can lie: what the tool answered (the
 * agent's view) and what the fixture page shows afterwards (the browser's view). A test about a
 * question that was *not* answered also reads the card, since "the card keeps waiting" is the
 * claim.
 *
 * **No answer.** The worker's 120 s bound is a product constant: the packaged worker is handed no
 * lever to shorten it (`closedPanelTimeoutMs` has no source in a service worker; see the note in
 * agent-first-run.spec.ts), and this gate adds none. The no-answer branch therefore waits the real
 * two minutes, like the first-run gate's timeout journey; `HALLPASS_TEST_TIME_SCALE` scales only
 * this file's harness waits and the test's own deadline, never the bound under test. Leave it out of
 * a quick run with `--grep-invert "no answer"`.
 *
 * Attach mode only, like every `agent-*` journey. Prerequisites: `npm run build`, `dist/agent`
 * loaded in the attached browser, `npm run agent-host:install` from this checkout, and the page
 * fixtures running (`npm run dev:test-pages`, `https://localhost:19443`).
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const ORDINARY = `${SITE}/ordinary`;
const FORM = `${SITE}/form`;

/** The worker's one bound for a question (`CLOSED_PANEL_TIMEOUT_MS`, R-453). The claim in the no-answer branch. */
const QUESTION_BOUND_MS = 120_000;

/** How the grant's source reads on a session card (R-458, FR-475): the word for a client answer. */
const FROM_TERMINAL = locale === "zh-TW" ? /終端/u : /terminal/iu;

test.describe("031 terminal consent", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("answer once: the client's choice admits that click, shows the card at the same time, and the next click asks again", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        script: repliesInOrder(
          // Held for a few seconds so the card and the badge can be read while the client's
          // question is open: FR-467 says both are raised at the same time.
          { kind: "accept", choice: "once", afterMs: 4_000 },
          { kind: "accept", choice: "deny", afterMs: 500 },
        ),
      });
      const before = await a.clickedText();

      const first = await a.beginClick();
      const q1 = await a.client.waitForElicitation(0);
      expect(q1.choices, "a covered page action offers once, session and deny").toEqual(["once", "session", "deny"]);
      expect(q1.choiceRequired).toBe(true);
      expect(q1.message).toContain("Hallpass");
      expect(q1.message, "the question names the site").toContain(SITE);
      expect(q1.state, "the owner has not answered yet").toBe("pending");

      // The card is up in the panel while the client's question is open (FR-467), and the toolbar
      // mark is shown although the panel is visible (FR-473, R-454).
      await rig.panel.waitForText(ui("agent.promptTitle"));
      expect(await rig.panel.panelText()).toContain(SITE);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe(ATTENTION_BADGE_TEXT);

      const ran = await first.done;
      expect(ran.isError, failure("the click chosen once in the client", ran, a.client)).toBe(false);
      expect(ran.json).toMatchObject({ observed: { effect: "activated", verified: true } });
      expect(await a.clickedText(), "the click really landed").not.toBe(before);
      expect(q1.state).toBe("answered");
      expect(a.client.stderr()).toContain("agent.consent.answered");

      // First answer wins and withdraws the other place (FR-471): the card is gone, the mark clears.
      await expect.poll(() => cardUp(rig.panel), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe("");

      // Once means once: the same click on the same site asks again.
      const afterFirst = await a.clickedText();
      const second = await a.beginClick();
      const q2 = await a.client.waitForElicitation(1);
      expect(q2.choices).toEqual(["once", "session", "deny"]);
      await rig.panel.waitForText(ui("agent.promptTitle"));
      const denied = await second.done;
      expect(denied.isError).toBe(true);
      expect(denied.json, failure("a deny chosen in the client", denied, a.client)).toMatchObject({
        outcome: "denied",
        reason: "owner-denied",
      });
      // Deny: nothing ran.
      expect(await a.clickedText()).toBe(afterFirst);
      expect(a.client.elicitations()).toHaveLength(2);
    } finally {
      await rig.cleanup();
    }
  });

  test("answer once: a client that declares a bare elicitation capability is asked too (R-451)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        capability: "bare",
        script: alwaysReply({ kind: "accept", choice: "once", afterMs: 500 }),
      });
      const before = await a.clickedText();
      const click = await a.beginClick();
      const ran = await click.done;
      expect(ran.isError, failure("the click chosen once under a bare capability", ran, a.client)).toBe(false);
      expect(a.client.elicitations(), "the host asked a client that advertised `elicitation: {}`").toHaveLength(1);
      expect(await a.clickedText()).not.toBe(before);
    } finally {
      await rig.cleanup();
    }
  });

  test("answer for this session: the next click on the site runs unasked, and a second session on it is asked", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(300_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        // Only the first question is answered. Were the second click asked, the client would sit on
        // the question and nobody presses the card, so the call could not complete.
        script: repliesInOrder({ kind: "accept", choice: "session", afterMs: 1_500 }),
      });
      const before = await a.clickedText();
      const first = await a.beginClick();
      await a.client.waitForElicitation(0);
      // The card for a covered page action offers "This session" (T925).
      await rig.panel.waitForText(ui("agent.promptTitle"));
      expect(await hasButton(rig.panel, ui("agent.allowSession"))).toBe(true);
      const ran = await first.done;
      expect(ran.isError, failure("the click chosen for the session", ran, a.client)).toBe(false);
      const afterFirst = await a.clickedText();
      expect(afterFirst).not.toBe(before);

      // The grant is given from the terminal and the panel's session card says so (FR-475).
      await expect
        .poll(async () => grantFromTerminalShown(rig.panel), { timeout: 15_000 })
        .toBe(true);

      // Second click, same site, same session: admitted with no question anywhere.
      const next = await a.beginClick();
      const unasked = await next.done;
      expect(unasked.isError, failure("the second click under the session grant", unasked, a.client)).toBe(false);
      expect(await a.clickedText(), "the second click landed").not.toBe(afterFirst);
      expect(a.client.elicitations(), "the second click was not asked").toHaveLength(1);
      expect(await cardUp(rig.panel), "and no card was raised for it").toBe(false);

      // A second MCP session on the same site is a different session: its click is asked.
      const b = await rig.openSession({
        url: FORM,
        script: alwaysReply({ kind: "accept", choice: "deny", afterMs: 1_500 }),
      });
      const submitted = await b.pageText("#submitted");
      const other = await b.beginClick("Sign in");
      const qb = await b.client.waitForElicitation(0);
      expect(qb.choices).toEqual(["once", "session", "deny"]);
      await rig.panel.waitForText(ui("agent.promptTitle"));
      const refused = await other.done;
      expect(refused.isError).toBe(true);
      expect(refused.json, failure("the second session's click", refused, b.client)).toMatchObject({
        outcome: "denied",
        reason: "owner-denied",
      });
      expect(await b.pageText("#submitted"), "nothing ran in the second session").toBe(submitted);
      // The first session's grant is untouched by the second session's question.
      expect(a.client.elicitations()).toHaveLength(1);
    } finally {
      await rig.cleanup();
    }
  });

  test("deny: the click is refused, nothing is done, and the card leaves", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "accept", choice: "deny", afterMs: 1_500 }) });
      const before = await a.clickedText();
      const click = await a.beginClick();
      await rig.panel.waitForText(ui("agent.promptTitle"));
      const denied = await click.done;
      expect(denied.isError).toBe(true);
      expect(denied.json, failure("a deny chosen in the client", denied, a.client)).toMatchObject({
        outcome: "denied",
        reason: "owner-denied",
      });
      expect(await a.clickedText(), "nothing ran").toBe(before);
      await expect.poll(() => cardUp(rig.panel), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe("");
    } finally {
      await rig.cleanup();
    }
  });

  for (const dismissal of ["decline", "cancel"] as const) {
    test(`${dismissal}: dismissing the client's question is no answer, and the card can still be answered`, async ({
      extensionContext,
      extensionId,
      extensionWorker,
    }) => {
      test.setTimeout(scaledMs(240_000));
      const rig = await openRig({ extensionContext, extensionId, extensionWorker });
      try {
        const a = await rig.openSession({ script: alwaysReply({ kind: dismissal, afterMs: 500 }) });
        const before = await a.clickedText();
        const click = await a.beginClick();
        const q = await a.client.waitForElicitation(0);
        await a.client.waitForSettled(q);
        expect(q.state).toBe(dismissal === "decline" ? "declined" : "cancelled");

        // FR-472: neither refused nor admitted. Given time to have been wrongly settled, the call
        // is still open, the card is still up and the page is as it was.
        const outcome = await Promise.race([
          click.done.then(() => "settled" as const),
          sleep(scaledMs(4_000)).then(() => "open" as const),
        ]);
        expect(outcome, `a client's ${dismissal} must not settle the call; stderr:\n${a.client.stderr()}`).toBe("open");
        expect(await cardUp(rig.panel), "the card keeps waiting").toBe(true);
        expect(await badgeText(extensionWorker), "and the mark stays").toBe(ATTENTION_BADGE_TEXT);
        expect(await a.clickedText()).toBe(before);
        expect(a.client.stderr()).not.toContain("agent.consent.answered");

        // The owner answers on the card and that admits the click.
        await rig.panel.clickButton(ui("agent.allowOnce"));
        const ran = await click.done;
        expect(ran.isError, failure("the click allowed on the card after a dismissal", ran, a.client)).toBe(false);
        expect(await a.clickedText()).not.toBe(before);
        await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe("");
      } finally {
        await rig.cleanup();
      }
    });
  }

  test("no capability: a client that cannot be asked is not, and the card alone decides", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ capability: "none" });
      const before = await a.clickedText();
      const click = await a.beginClick();
      await rig.panel.waitForText(ui("agent.promptTitle"));
      // Time for a question to have been sent, were one going to be.
      await sleep(scaledMs(3_000));
      expect(a.client.elicitations(), "a client without the capability is sent no question").toHaveLength(0);
      expect(a.client.stderr()).not.toContain("agent.consent.asked");
      expect(await badgeText(extensionWorker)).toBe(ATTENTION_BADGE_TEXT);

      await rig.panel.clickButton(ui("agent.allowOnce"));
      const ran = await click.done;
      expect(ran.isError, failure("the click allowed on the card", ran, a.client)).toBe(false);
      expect(await a.clickedText()).not.toBe(before);
    } finally {
      await rig.cleanup();
    }
  });

  test("card first: answering on the card withdraws the client's question, and a late client answer changes nothing", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "never" }) });
      const before = await a.clickedText();
      const click = await a.beginClick();
      const q = await a.client.waitForElicitation(0);
      // `waitForElicitation` refuses id 0, the one id the SDK would not deliver a cancellation for.
      expect(q.requestId).not.toBe(0);
      await rig.panel.waitForText(ui("agent.promptTitle"));
      expect(q.state, "the client's question is open").toBe("pending");

      await rig.panel.clickButton(ui("agent.refuse"));
      const denied = await click.done;
      expect(denied.isError).toBe(true);
      expect(denied.json, failure("a deny on the card", denied, a.client)).toMatchObject({
        outcome: "denied",
        reason: "owner-denied",
      });

      // FR-471: the question in the client is withdrawn (the request was aborted by the server).
      await a.client.waitForSettled(q, scaledMs(10_000));
      expect(q.state, "the client's open request was cancelled").toBe("aborted");

      // A client that answers anyway: "accept once" for a question that is over. Nothing the host
      // or the worker does may admit it.
      await a.client.sendLateAnswer(q, "once");
      await sleep(scaledMs(2_500));
      expect(await a.clickedText(), "a late answer admitted nothing").toBe(before);
      expect(a.client.stderr()).not.toContain("agent.consent.answered");
      // The host survived the stray reply: the session still answers.
      const alive = await a.client.callTool("tabs_context", {});
      expect(alive.isError, alive.text).toBe(false);
    } finally {
      await rig.cleanup();
    }
  });

  test("a tool a session grant does not cover offers only once and deny, here and on the card", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "accept", choice: "once", afterMs: 2_000 }) });
      // Closing a tab with `force` is asked each time (FR-470); it is the covered set's neighbour
      // that needs no diagnostics grant and no extra fixture.
      const close = a.client.callTool("tabs_close", { tabId: a.tabId, force: true }, { timeoutMs: 150_000 });
      void close.catch(() => undefined);
      const q = await a.client.waitForElicitation(0);
      expect(q.choices, "FR-468, FR-470: no session choice for an uncovered tool").toEqual(["once", "deny"]);
      expect(q.choiceNames).toEqual(["Allow once", "Deny"]);

      await rig.panel.waitForText(ui("agent.promptTitle"));
      expect(await hasButton(rig.panel, ui("agent.allowOnce"))).toBe(true);
      expect(await hasButton(rig.panel, ui("agent.allowSession")), "and the card has no 'This session'").toBe(false);

      const closed = await close;
      expect(closed.isError, failure("the forced close allowed once in the client", closed, a.client)).toBe(false);
      await expect
        .poll(
          () =>
            extensionWorker.evaluate(
              async (id: number) => chrome.tabs.get(id).then(() => true, () => false),
              a.tabId,
            ),
          { timeout: 15_000 },
        )
        .toBe(false);
      a.tabClosed();
    } finally {
      await rig.cleanup();
    }
  });

  test("no answer: with nobody answering anywhere the call times out after the bound, with the hint, and the question is withdrawn", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    // The real two minutes plus setup and slack; see the file note.
    test.setTimeout(scaledMs(420_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "never" }) });
      const before = await a.clickedText();
      const startedAt = Date.now();
      const click = await a.beginClick(undefined, QUESTION_BOUND_MS + 30_000);
      const q = await a.client.waitForElicitation(0);
      await rig.panel.waitForText(ui("agent.promptTitle"));
      await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe(ATTENTION_BADGE_TEXT);

      // Past the 25 s the pre-031 rule gave a visible card: it is still waiting (FR-473). Unscaled: the
      // 120 s bound is the claim here and never scales, so a scaled wait would land on the withdrawal.
      await sleep(30_000);
      expect(q.state, "the client's question is still open past 25 s").toBe("pending");
      expect(await cardUp(rig.panel)).toBe(true);

      const result = await click.done;
      const endedAt = Date.now();
      const elapsed = endedAt - startedAt;
      expect(result.isError).toBe(true);
      expect(result.json, failure("an unanswered question", result, a.client)).toMatchObject({
        outcome: "timed-out",
        hint: CONSENT_TIMEOUT_HINT,
      });
      expect(elapsed, "the worker's bound, not a shorter one and not the harness's").toBeGreaterThanOrEqual(
        QUESTION_BOUND_MS - 2_000,
      );
      expect(await a.clickedText(), "nothing ran").toBe(before);

      // The client's request ended before the call did (just under the bound, R-453), and the
      // question left the card and the toolbar.
      expect(q.state, "the client's question was withdrawn").toBe("aborted");
      expect(q.settledAt ?? Number.MAX_SAFE_INTEGER, "withdrawn no later than the answer").toBeLessThanOrEqual(
        endedAt,
      );
      await expect.poll(() => cardUp(rig.panel), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => badgeText(extensionWorker), { timeout: 10_000 }).toBe("");
    } finally {
      await rig.cleanup();
    }
  });
});

// ======================================================================================
// the rig
// ======================================================================================

type RigFixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };

type PendingCall = { done: Promise<ToolCallResult> };

type RigSession = {
  client: ElicitingMcpClient;
  tabId: number;
  page: Page;
  /** The page's `#clicked` text (the ordinary fixture's witness). */
  clickedText(): Promise<string>;
  /** Any element's text on this session's page. */
  pageText(selector: string): Promise<string>;
  /**
   * Resolves the target's ref first (a read, no question), then issues the click and hands back the
   * pending call. The client's own deadline is long enough that the harness is never what ends it.
   */
  beginClick(query?: string, timeoutMs?: number): Promise<PendingCall>;
  /** The test closed this session's tab itself. */
  tabClosed(): void;
};

type OpenSessionOptions = {
  capability?: ElicitationCapability;
  script?: ElicitationScript;
  /** The fixture page the session's tab opens; the ordinary page by default. */
  url?: string;
};

type Rig = {
  panel: SidePanelDriver;
  openSession(options?: OpenSessionOptions): Promise<RigSession>;
  cleanup(): Promise<void>;
};

async function openRig(fixtures: RigFixtures): Promise<Rig> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  // A fixture the agent never visits, so the owner's own tab is never one a test reads.
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
  await waitForAgentPanel(panel);
  // The question under test is `ask`, set the way the owner sets it (024 FR-385), never by a storage write.
  await setSiteMode(fixtures, SITE, "ask");

  const sessions: Array<{ client: ElicitingMcpClient; tabs: Set<number> }> = [];
  let paired = false;

  async function openSession(options: OpenSessionOptions = {}): Promise<RigSession> {
    const client = await startElicitingClient({
      clientName: "Claude Code",
      capability: options.capability ?? "form",
      ...(options.script === undefined ? {} : { script: options.script }),
    });
    const owned = { client, tabs: new Set<number>() };
    sessions.push(owned);
    if (!paired) {
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });
      paired = true;
    }
    const url = options.url ?? ORDINARY;
    const created = await client.callTool("tabs_create", { url });
    expect(created.isError, `tabs_create failed: ${created.text}\nstderr:\n${client.stderr()}`).toBe(false);
    const tabId = (created.json as { tabId: number }).tabId;
    expect(typeof tabId).toBe("number");
    owned.tabs.add(tabId);
    const page = await pageAt(extensionContext, url);

    const refFor = async (query: string): Promise<string> => {
      const found = await client.callTool("find", { tabId, query });
      expect(found.isError, `find '${query}' failed: ${found.text}`).toBe(false);
      const body = found.json as { outcome: string; matches: Array<{ ref: string }> };
      expect(body.outcome, `find '${query}' answered ${body.outcome}`).toBe("resolved");
      const ref = body.matches[0]?.ref;
      expect(ref, `find '${query}' returned no ref`).toBeTruthy();
      return ref as string;
    };

    return {
      client,
      tabId,
      page,
      async clickedText() {
        return (await page.locator("#clicked").textContent()) ?? "";
      },
      async pageText(selector) {
        return (await page.locator(selector).textContent()) ?? "";
      },
      async beginClick(query = "Safe action", timeoutMs = 150_000) {
        // A fresh ref for every click: a collection invalidates the handles the previous one issued.
        const ref = await refFor(query);
        const done = client.callTool("click", { tabId, target: { ref } }, { timeoutMs });
        // A test that fails before awaiting the call must not leave an unhandled rejection behind.
        done.catch(() => undefined);
        return { done };
      },
      tabClosed() {
        owned.tabs.delete(tabId);
      },
    };
  }

  async function cleanup(): Promise<void> {
    // Tabs a test left open are closed with `force`, which is asked under `ask`; skip-checks makes
    // that quiet, and the site goes back to `ask` (the default) afterwards.
    const anyTabs = sessions.some((session) => session.tabs.size > 0);
    if (anyTabs) {
      await setSiteMode(fixtures, SITE, "skip-checks").catch(() => undefined);
      for (const session of sessions) {
        for (const tabId of session.tabs) {
          await session.client
            .callTool("tabs_close", { tabId, force: true }, { timeoutMs: 20_000 })
            .catch(() => undefined);
        }
      }
    }
    await setSiteMode(fixtures, SITE, "ask").catch(() => undefined);
    for (const session of sessions) await session.client.close().catch(() => undefined);
  }

  return { panel, openSession, cleanup };
}

// ======================================================================================
// small readers
// ======================================================================================

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The tool's answer and the host's own stderr, for an assertion that failed on the answer. */
function failure(what: string, result: ToolCallResult, client: ElicitingMcpClient): string {
  const asked = client.elicitations().map((record: ElicitationRecord) => `${record.state}:${record.choices.join("/")}`);
  return `${what}: ${result.text}\nquestions received: ${JSON.stringify(asked)}\nmcp-server stderr:\n${client.stderr()}`;
}

/** What the toolbar icon is wearing, read from the browser rather than from the worker's intent. */
async function badgeText(worker: PackagedWorker): Promise<string> {
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

/** The consent card by its own title key, never by a sentence that the card's body may also carry. */
async function cardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.panelText()).includes(ui("agent.promptTitle"));
}

/** Whether a button with exactly this text is on the panel now. */
async function hasButton(panel: SidePanelDriver, label: string): Promise<boolean> {
  const found = await panel.evaluatePanel(
    `[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === ${JSON.stringify(label)})`,
  );
  return found === true;
}

/**
 * Whether the session cards list a grant for the site marked as given from the terminal (R-458).
 * Read as text, because the exact line is the card's wording (T925); the site and the source word
 * are the claim.
 */
async function grantFromTerminalShown(panel: SidePanelDriver): Promise<boolean> {
  const text = await panel.panelText();
  return text.includes(SITE) && FROM_TERMINAL.test(text);
}

/** A site's mode, set on the settings page as the sibling journeys do; the page is closed again. */
async function setSiteMode(fixtures: RigFixtures, site: string, mode: SiteMode): Promise<void> {
  const settings = await openSettingsPage({
    context: fixtures.extensionContext,
    worker: fixtures.extensionWorker,
    extensionId: fixtures.extensionId,
    locale,
    route: "#sites",
  });
  // A site with no stored mode is already at the default, Ask, and the page lists it only while a
  // session tab is on it (024 FR-385) — so on a fresh profile there is no row to set back to Ask.
  if (mode === "ask" && !(await settings.siteRows()).includes(site)) {
    await settings.close();
    return;
  }
  await settings.setSiteMode(site, mode);
  await settings.close();
}

/** The Playwright page for a tab the agent opened, so the fixture can be read independently. */
async function pageAt(context: BrowserContext, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await sleep(200);
  }
  throw new Error(`agent-tab-not-found:${url}`);
}
