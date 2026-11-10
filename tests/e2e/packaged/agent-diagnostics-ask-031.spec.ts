import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { messages as enMessages } from "../../../apps/extension/src/locales/en-US.js";
import { messages as zhMessages } from "../../../apps/extension/src/locales/zh-TW.js";
import { scaledMs } from "../../../packages/test-kit/src/time-scale.js";
import {
  alwaysReply,
  repliesInOrder,
  startElicitingClient,
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
 * 031 US3 (FR-476, FR-477, R-460, R-461, T936): `read_console` on a site whose diagnostics grant is
 * off is no longer refused out of hand; the owner is asked, in the agent's own client and on the
 * side-panel card, and the first answer in either place decides it.
 *
 * Same rig as `agent-terminal-consent-031.spec.ts`: a scripted MCP client
 * (`tests/harness/elicitation-mcp-client.ts`) talks to the real `dist/mcp-server.js` and answers
 * `elicitation/create` from a per-test script; the owner's side is the real side panel and the real
 * settings page, read and pressed through their DOM.
 *
 * Each claim is read on two surfaces: what the tool answered (the agent's view) and what the settings
 * page's diagnostics checkbox shows afterwards (the owner's standing grant). "This session" and "Once"
 * must leave the checkbox off; only "Always on this site", which exists on the card alone, turns it on.
 *
 * The spec reads `read_console` only. `evaluate` stays behind the effect gate as well (FR-477) and is
 * covered by the unit gate; it would raise a second, separate question here.
 *
 * Attach mode only, like every `agent-*` journey. Prerequisites: `npm run build`, `dist/agent` loaded in
 * the attached browser, `npm run agent-host:install` from this checkout, and the page fixtures running
 * (`npm run dev:test-pages`, `https://localhost:19443`).
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/**
 * A card word whose catalogue key may not exist yet when this file is read. ASSUMPTION (T934): the
 * diagnostics card's third button is "Always on this site" under the key `agent.diagnosticsAlways`
 * (R-461 names the words; `agent.allowAlways` is the consent card's "Always allow on this site" and is
 * a different button). Falls back to the English words of R-461 when the key is absent from the
 * catalogue. Confirm against PromptCard.tsx once T934 lands.
 */
const ALWAYS_ON_SITE_KEY = "agent.diagnosticsAlways";
const ALWAYS_ON_SITE_FALLBACK = "Always on this site";
function alwaysOnSiteLabel(): string {
  const bag = (locale === "zh-TW" ? zhMessages : enMessages) as Record<string, string>;
  const english = enMessages as Record<string, string>;
  return bag[ALWAYS_ON_SITE_KEY] || english[ALWAYS_ON_SITE_KEY] || ALWAYS_ON_SITE_FALLBACK;
}

const SITE = "https://127.0.0.1:19443";
const ORDINARY = `${SITE}/ordinary`;

test.describe("031 diagnostics ask", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("session answer in the client: read_console is asked here and on the card, the second call runs unasked, and the checkbox stays off", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        // Only the first question is answered. Were the second call asked, the client would sit on the
        // question and nobody presses the card, so the call could not complete.
        script: repliesInOrder({ kind: "accept", choice: "session", afterMs: 4_000 }),
      });
      expect(await rig.diagnosticsChecked(), "the grant starts off").toBe(false);

      const first = a.beginReadConsole();
      const q = await a.client.waitForElicitation(0);
      expect(q.choices, "a diagnostics question offers once, session and deny").toEqual(["once", "session", "deny"]);
      expect(q.choiceRequired).toBe(true);
      expect(q.message, "the question names the site").toContain(SITE);
      expect(q.message, "and says what is being asked for").toMatch(/diagnostic|console/iu);
      expect(q.state, "the owner has not answered yet").toBe("pending");

      // The card is up in the panel at the same time (FR-467), with the four words R-461 gives it.
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 15_000 }).toBe(true);
      expect(await rig.panel.panelText()).toContain(SITE);
      expect(await hasButton(rig.panel, ui("agent.allowOnce"))).toBe(true);
      expect(await hasButton(rig.panel, ui("agent.allowSession"))).toBe(true);
      expect(await hasButton(rig.panel, alwaysOnSiteLabel()), "the card (and only the card) offers 'always'").toBe(true);
      expect(await hasButton(rig.panel, ui("agent.refuse"))).toBe(true);
      // The client's question has only three choices: always is not given from a terminal (R-461).
      expect(q.choices).not.toContain("always");

      const ran = await first;
      expect(ran.isError, failure("read_console answered 'session' in the client", ran, a.client)).toBe(false);
      expect((ran.json as { messages?: unknown }).messages, "read_console answered with its messages").toBeInstanceOf(Array);
      expect(q.state).toBe("answered");
      expect(a.client.stderr()).toContain("agent.consent.answered");

      // First answer wins and withdraws the other place (FR-471): the card is gone.
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 10_000 }).toBe(false);

      // Same session, same site: admitted with no question anywhere.
      const second = await a.client.callTool("read_console", { tabId: a.tabId }, { timeoutMs: scaledMs(30_000) });
      expect(second.isError, failure("the second read_console under the session grant", second, a.client)).toBe(false);
      expect(a.client.elicitations(), "the second call was not asked").toHaveLength(1);
      expect(await diagnosticsCardUp(rig.panel), "and no card was raised for it").toBe(false);

      // A session answer is not the standing grant: the owner's checkbox is still off.
      expect(await rig.diagnosticsChecked(), "'This session' does not tick the settings checkbox").toBe(false);
    } finally {
      await rig.cleanup();
    }
  });

  test("always on the card: the client's question is dismissed, the owner presses 'Always on this site', the call runs and the checkbox is on", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      // A client that declines is no answer (FR-472): the card keeps waiting.
      const a = await rig.openSession({ script: alwaysReply({ kind: "decline", afterMs: 500 }) });
      expect(await rig.diagnosticsChecked(), "the grant starts off").toBe(false);

      const call = a.beginReadConsole();
      const q = await a.client.waitForElicitation(0);
      await a.client.waitForSettled(q);
      expect(q.state).toBe("declined");
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 15_000 }).toBe(true);

      const outcome = await Promise.race([
        call.then(() => "settled" as const),
        sleep(scaledMs(3_000)).then(() => "open" as const),
      ]);
      expect(outcome, `a client's decline must not settle the call; stderr:\n${a.client.stderr()}`).toBe("open");
      expect(await rig.diagnosticsChecked(), "nothing is granted while the card waits").toBe(false);

      await rig.panel.clickButton(alwaysOnSiteLabel());
      const ran = await call;
      expect(ran.isError, failure("read_console allowed 'always' on the card", ran, a.client)).toBe(false);
      expect((ran.json as { messages?: unknown }).messages).toBeInstanceOf(Array);
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 10_000 }).toBe(false);

      // 'Always' is the existing standing grant, the same one the settings checkbox sets (R-460).
      await expect.poll(() => rig.diagnosticsChecked(), { timeout: 15_000 }).toBe(true);

      // And it covers the next call with no question.
      const next = await a.client.callTool("read_console", { tabId: a.tabId }, { timeoutMs: scaledMs(30_000) });
      expect(next.isError, failure("read_console under the standing grant", next, a.client)).toBe(false);
      expect(a.client.elicitations(), "the next call was not asked").toHaveLength(1);
    } finally {
      // The cleanup puts the grant back off before it closes the tabs.
      await rig.cleanup();
    }
  });

  test("deny in the client: read_console answers diagnostics-not-granted, the card leaves and the checkbox stays off", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "accept", choice: "deny", afterMs: 1_500 }) });
      expect(await rig.diagnosticsChecked(), "the grant starts off").toBe(false);

      const call = a.beginReadConsole();
      const q = await a.client.waitForElicitation(0);
      expect(q.choices).toEqual(["once", "session", "deny"]);
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 15_000 }).toBe(true);

      const denied = await call;
      expect(denied.isError).toBe(true);
      expect(denied.json, failure("a deny chosen in the client", denied, a.client)).toMatchObject({
        outcome: "denied",
        reason: "diagnostics-not-granted",
      });
      await expect.poll(() => diagnosticsCardUp(rig.panel), { timeout: 10_000 }).toBe(false);
      expect(await rig.diagnosticsChecked(), "a refusal grants nothing").toBe(false);
    } finally {
      await rig.cleanup();
    }
  });
});

// ======================================================================================
// the rig (the terminal-consent spec's, cut down to what a diagnostics question needs)
// ======================================================================================

type RigFixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };

type RigSession = {
  client: ElicitingMcpClient;
  tabId: number;
  /** Issues `read_console` on the session's tab; the client's own deadline is long enough that the harness is never what ends it. */
  beginReadConsole(timeoutMs?: number): Promise<ToolCallResult>;
};

type Rig = {
  panel: SidePanelDriver;
  openSession(options?: { script?: ElicitationScript }): Promise<RigSession>;
  /** The site's diagnostics checkbox on the settings page, read from a freshly opened page. */
  diagnosticsChecked(): Promise<boolean>;
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
  /** Whether this rig has ever seen the site's row, i.e. whether a cleanup can reset the checkbox. */
  let rowSeen = false;

  async function openSession(options: { script?: ElicitationScript } = {}): Promise<RigSession> {
    const client = await startElicitingClient({
      clientName: "Claude Code",
      capability: "form",
      ...(options.script === undefined ? {} : { script: options.script }),
    });
    const owned = { client, tabs: new Set<number>() };
    sessions.push(owned);
    if (!paired) {
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });
      paired = true;
    }
    const created = await client.callTool("tabs_create", { url: ORDINARY });
    expect(created.isError, `tabs_create failed: ${created.text}\nstderr:\n${client.stderr()}`).toBe(false);
    const tabId = (created.json as { tabId: number }).tabId;
    expect(typeof tabId).toBe("number");
    owned.tabs.add(tabId);
    // The site's row is listed while a session tab is on it (024 FR-385). Put the grant at its start
    // state (off) the way the owner would, so a run after a failed one still starts clean.
    await withSettings(fixtures, async (settings) => {
      await settings.setDiagnostics(SITE, false);
    });
    rowSeen = true;
    return {
      client,
      tabId,
      beginReadConsole(timeoutMs = 150_000) {
        const done = client.callTool("read_console", { tabId }, { timeoutMs });
        // A test that fails before awaiting the call must not leave an unhandled rejection behind.
        done.catch(() => undefined);
        return done;
      },
    };
  }

  async function diagnosticsChecked(): Promise<boolean> {
    return withSettings(fixtures, async (settings) => {
      const box = settings.page.locator(`li.site[data-site=${JSON.stringify(SITE)}] input[type=checkbox]`);
      await expect(box, `the settings row for ${SITE} offers no diagnostics checkbox`).toHaveCount(1, { timeout: 20_000 });
      return box.isChecked();
    });
  }

  async function cleanup(): Promise<void> {
    const anyTabs = sessions.some((session) => session.tabs.size > 0);
    // The grant goes back off while a tab still lists the site's row.
    if (rowSeen && anyTabs) {
      await withSettings(fixtures, async (settings) => {
        await settings.setDiagnostics(SITE, false);
      }).catch(() => undefined);
    }
    // Tabs a test left open are closed with `force`, which is asked under `ask`; skip-checks makes
    // that quiet, and the site goes back to `ask` (the default) afterwards.
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

  return { panel, openSession, diagnosticsChecked, cleanup };
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

/**
 * The diagnostics card by the words it is built on (`agent.diagnosticsText`, T934): the card shows
 * that text or its `{site}` label form, which contains it. The page-action card's own title
 * (`agent.promptTitle`) is deliberately not what this reads.
 */
async function diagnosticsCardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.panelText()).includes(ui("agent.diagnosticsText"));
}

/** Whether a button with exactly this text is on the panel now. */
async function hasButton(panel: SidePanelDriver, label: string): Promise<boolean> {
  const found = await panel.evaluatePanel(
    `[...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === ${JSON.stringify(label)})`,
  );
  return found === true;
}

/** Runs `body` on a freshly opened sites page and closes the page again. */
async function withSettings<T>(
  fixtures: RigFixtures,
  body: (settings: Awaited<ReturnType<typeof openSettingsPage>>) => Promise<T>,
): Promise<T> {
  const settings = await openSettingsPage({
    context: fixtures.extensionContext,
    worker: fixtures.extensionWorker,
    extensionId: fixtures.extensionId,
    locale,
    route: "#sites",
  });
  try {
    return await body(settings);
  } finally {
    await settings.close();
  }
}

/** A site's mode, set on the settings page as the sibling journeys do; the page is closed again. */
async function setSiteMode(fixtures: RigFixtures, site: string, mode: SiteMode): Promise<void> {
  await withSettings(fixtures, async (settings) => {
    // A site with no stored mode is already at the default, Ask, and the page lists it only while a
    // session tab is on it (024 FR-385) - so on a fresh profile there is no row to set back to Ask.
    if (mode === "ask" && !(await settings.siteRows()).includes(site)) return;
    await settings.setSiteMode(site, mode);
  });
}
