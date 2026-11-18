import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The fixture origin, which is also the site the owner's per-site mode is keyed by (R-108). */
const SITE = "https://127.0.0.1:19443";

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };
type Caller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type Click = {
  outcome?: string;
  hint?: string;
  observed?: { verified?: boolean; documentChanged?: boolean; observedForMs?: number; newTabs?: unknown[]; downloads?: unknown[] };
};

/** The hint a press on a link that caused nothing carries (015/FR-201, contracts press-outcomes rule 6). */
const LINK_HINT = /^The link was pressed, but nothing navigated, opened or downloaded within \d+ ms\. The page may handle it itself/;

/**
 * 039 live check (SC-256): a click at a point on a span inside an `a[href]` answers with the link hint.
 *
 * `/link-039` wraps a `span` in a link whose navigation the page cancels, so the press causes nothing.
 * A point click names the innermost element at the point - the span, whose own role is not `link` - and
 * before 039 the press-outcome hint asked only about that element's own role, so the answer had no hint.
 * The link is its nearest ancestor in the same document, and the locate now says so (FR-571).
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install of the
 * native host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` of THIS checkout loaded in the attached
 * browser, and the fixture servers (`npm run dev:test-pages`) started AFTER this change - they list the
 * pages they were started with, and `/link-039` is new.
 */
test.describe("agent link ancestor (spec 039)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("SC-256: a click at a point on the span inside a link answers with the link hint", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const url = `${SITE}/link-039`;
      const { tabId, page } = await openTab(context, call, settings, url, SITE);

      const point = await centreOf(page.locator("#go span"));
      const clicked = (await call("click", { tabId, target: point })) as Click;

      // The page cancelled the navigation, so nothing happened - and the answer says it pressed a link.
      expect(clicked.observed, JSON.stringify(clicked)).toMatchObject({ documentChanged: false });
      expect(clicked.observed?.observedForMs, JSON.stringify(clicked)).toEqual(expect.any(Number));
      expect(clicked.hint, JSON.stringify(clicked)).toMatch(LINK_HINT);
      // The link did receive the click, and the tab stayed where it was.
      await expect.poll(() => page.evaluate(() => document.body.dataset["clicks"])).toBe("1");
      expect(page.url()).toBe(url);
    });
  });
});

async function boxOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no-box");
  return box;
}

/** The viewport centre of one element, as the coordinate an agent would point at (CSS pixels). */
async function centreOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number }> {
  const box = await boxOf(locator);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

type SessionContext = { context: BrowserContext; call: Caller; settings: SettingsPageDriver };

/** The pairing, panel and settings plumbing every sibling journey repeats, around one test body. */
async function withSession(fixtures: Fixtures, body: (session: SessionContext) => Promise<void>): Promise<void> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });

  let client: McpHarnessClient | undefined;
  try {
    client = await startMcpClient({ clientName: "Claude Code" });
    const live = client;
    await panel.clickIfPresent(ui("agent.retry"));
    await pairWithFirstCall(live, panel, { locale });
    const call: Caller = async (tool, args) => {
      const result = await live.callTool(tool, args);
      expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
      return result.json;
    };
    await body({ context: extensionContext, call, settings });
  } finally {
    await client?.close();
  }
}

/** Opens one page as a tab of the session, under skip-checks for its site, with the tab in front. */
async function openTab(
  context: BrowserContext,
  call: Caller,
  settings: SettingsPageDriver,
  url: string,
  site: string,
): Promise<{ tabId: number; page: Page }> {
  const created = (await call("tabs_create", { url })) as { tabId: number };
  const page = await agentPage(context, (candidate) => candidate === url || candidate.startsWith(`${url}/`) || candidate.startsWith(`${url}?`));
  await settings.setSiteMode(site, "skip-checks");
  await page.bringToFront();
  return { tabId: created.tabId, page };
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(
  context: { pages: () => Page[] },
  matches: (url: string) => boolean,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => matches(page.url()));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("agent-tab-not-found");
}
