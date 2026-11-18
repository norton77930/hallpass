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
const GITHUB = "https://github.com";

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };
type Caller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type Click = { outcome?: string; observed?: { effect?: string; verified?: boolean; verdict?: string } };
type Found = { outcome: string; matches: Array<{ ref: string; role?: string; label?: string }> };
type Read = { nodes: Array<{ ref?: string; role?: string; name?: string }> };

/**
 * 038 live checks (SC-248..SC-250, and SC-252 on a public GitHub page): a click lands where a person
 * points, whatever element is there, and a page's own widget roles are visible to `read_page` and `find`.
 *
 * - SC-248: `click` at the coordinates of a popover menu item's label (an inner `span` three levels
 *   inside `li[role=menuitemradio]`) answers `verified` and the page records that item chosen. Before
 *   038 the span was outside the agent's walk and the click answered `target-not-located` (FR-562).
 * - SC-249: `find` names the item by role and label, `click` on that ref and on a ref a point click
 *   named earlier both answer `verified`, and an interactive read lists every `div[role=option]` with
 *   its name (FR-562, FR-565..567).
 * - SC-250: a point click inside a large element away from its centre reaches that element and not the
 *   button covering its centre, and the page does not scroll (FR-563). This one needs the point
 *   delivery of 038's slice C; without it the click lands on the centre button or the page scrolls.
 * - SC-252: the same claim as SC-248 on github.com's branch picker. Runs only with HALLPASS_LIVE_GITHUB=1
 *   because it needs the public site, which the other journeys never touch.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install of the
 * native host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` of THIS checkout loaded in the attached
 * browser, and the fixture servers (`npm run dev:test-pages`) started AFTER this change - they list the
 * pages they were started with, and `/popover-038` and `/cover-038` are new.
 */
test.describe("agent point clicks (spec 038)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("SC-248: a click at a menu item's label coordinates is verified and chooses the item", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/popover-038`, SITE);
      await openMenu(page);

      const point = await centreOf(page.locator("li[role=menuitemradio] span", { hasText: "Custom" }));
      const clicked = (await call("click", { tabId, target: point })) as Click;

      expect(clicked, JSON.stringify(clicked)).toMatchObject({ observed: { verified: true } });
      await expect.poll(() => page.evaluate(() => document.body.dataset["chosen"])).toBe("Custom");
    });
  });

  test("SC-249: find names the item by role and label, its ref and a point-named ref click, an interactive read lists the options", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/popover-038`, SITE);
      await openMenu(page);

      // A fresh page: nothing has named the label's inner span yet, so `find` answers with the item.
      const found = (await call("find", { tabId, query: "Custom" })) as Found;
      expect(found.outcome, JSON.stringify(found)).toBe("resolved");
      expect(found.matches[0], JSON.stringify(found)).toMatchObject({ role: "menuitemradio", label: "Custom" });
      const clickedRef = (await call("click", { tabId, target: { ref: found.matches[0]?.ref } })) as Click;
      expect(clickedRef, JSON.stringify(clickedRef)).toMatchObject({ observed: { verified: true } });
      await expect.poll(() => page.evaluate(() => document.body.dataset["chosen"])).toBe("Custom");

      // A point click names the inner span of another item; the next `find` may hand that span's ref
      // back (it is the innermost element holding the words). Either way the click on it is located.
      await openMenu(page);
      const point = await centreOf(page.locator("li[role=menuitemradio] span", { hasText: "7 days" }));
      const pointClicked = (await call("click", { tabId, target: point })) as Click;
      expect(pointClicked, JSON.stringify(pointClicked)).toMatchObject({ observed: { verified: true } });
      await expect.poll(() => page.evaluate(() => document.body.dataset["chosen"])).toBe("7 days");

      await openMenu(page);
      const spanRef = (await call("find", { tabId, query: "7 days" })) as Found;
      expect(spanRef.outcome, JSON.stringify(spanRef)).toBe("resolved");
      const namedRefClick = (await call("click", { tabId, target: { ref: spanRef.matches[0]?.ref } })) as Click;
      expect(namedRefClick, JSON.stringify(namedRefClick)).toMatchObject({ observed: { verified: true } });

      const read = (await call("read_page", { tabId, filter: "interactive" })) as Read;
      for (const name of ["Issues", "Contents"]) {
        const node = read.nodes.find((entry) => entry.name === name);
        expect(node, `${name} is not in the interactive read: ${JSON.stringify(read.nodes)}`).toMatchObject({ role: "option" });
        expect(node?.ref, `${name} has no ref`).toBeTruthy();
      }
    });
  });

  test("SC-250: a point click inside a large element away from its centre reaches it, not the centre button, and does not scroll", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/cover-038`, SITE);
      // Put the large element near the top of the viewport, so a run that scrolls it to the middle of
      // the viewport (the old delivery) moves the page and a point click does not.
      await page.evaluate(() => window.scrollTo(0, 900));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);

      const big = await boxOf(page.locator("#big"));
      const point = { x: Math.round(big.x + 60), y: Math.round(big.y + 40) };
      const scrollBefore = await page.evaluate(() => window.scrollY);

      const clicked = (await call("click", { tabId, target: point })) as Click;
      const received = await page.evaluate(() => ({
        big: document.body.dataset["big"],
        cover: document.body.dataset["cover"],
        scrollY: window.scrollY,
      }));

      expect.soft(clicked, JSON.stringify(clicked)).toMatchObject({ observed: { verified: true } });
      expect.soft(received.big, `the large element did not receive the click: ${JSON.stringify(received)}`).toBe("1");
      expect.soft(received.cover, `the button at the centre received a click: ${JSON.stringify(received)}`).toBe("0");
      expect.soft(received.scrollY, "the page scrolled").toBe(scrollBefore);
    });
  });

  test("SC-252: on github.com a click at a branch-menu item's coordinates is verified and the branch changes", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.skip(process.env.HALLPASS_LIVE_GITHUB !== "1", "needs the public site: set HALLPASS_LIVE_GITHUB=1 to run it.");
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const repo = `${GITHUB}/microsoft/vscode`;
      const { tabId, page } = await openTab(context, call, settings, repo, GITHUB);
      await page.waitForLoadState("load");

      // Open the branch picker the way a person does; the claim is about the click on an item.
      // GitHub's picker (measured 2026-11-18): items are li[role=menuitemradio] with aria-checked, not options.
      // The picker answers only once the page's script has hydrated it, so the opening click is
      // repeated until the list shows (a test-side step; the agent's click below is the claim).
      const picker = page.locator('#ref-picker-repos-header-ref-selector, button[aria-label*="branch" i]').first();
      const items = page.locator('[role=menuitemradio][aria-checked="false"]:visible, [role=option][aria-selected="false"]:visible');
      await expect(async () => {
        if (!(await items.first().isVisible())) await picker.click();
        await expect(items.first()).toBeVisible({ timeout: 3_000 });
      }, "the branch picker did not list a branch to choose").toPass({ timeout: 45_000 });
      const item = items.first();
      const label = (await item.innerText()).split("\n")[0]?.trim() ?? "";
      expect(label, "the first unselected branch item has no label").not.toBe("");

      const before = page.url();
      // The coordinates of the label's own text, not of the item: the innermost element there is the
      // span GitHub's picker wraps it in, which is what a screenshot would point at.
      const point = await centreOf(item.getByText(label, { exact: true }).first());
      const clicked = (await call("click", { tabId, target: point })) as Click;

      expect(clicked, JSON.stringify(clicked)).toMatchObject({ observed: { verified: true } });
      await expect
        .poll(() => page.url(), { message: `choosing "${label}" did not change the page from ${before}`, timeout: 20_000 })
        .not.toBe(before);
    });
  });
});

/** Opens the menu the way a person does, so the claim under test is only the agent's click on an item. */
async function openMenu(page: Page): Promise<void> {
  await page.locator("#open").click();
  await expect(page.locator("#menu")).toBeVisible();
}

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
