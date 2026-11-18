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
type RawCaller = (tool: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
type Point = { x: number; y: number };
type Typed = {
  outcome?: string;
  observed?: { effect?: string; verified?: boolean; verdict?: string; charactersChanged?: number };
  hint?: string;
};
type Dragged = { outcome?: string; reason?: string; observed?: { effect?: string; verified?: boolean; verdict?: string } };

/**
 * 039 live checks (SC-253..SC-255): typing and dragging after a point, on the pages 039's fixtures
 * stand for.
 *
 * - SC-253: `type` at the point of text two spans deep inside a contenteditable editor enters the text
 *   and answers `verified`. The placing click focuses the editing host, an ancestor of the span named;
 *   before 039 that failed the focus check as `focus-lost` and nothing was typed (FR-568).
 * - SC-254: `type` at a point on a label's text goes into the input that label is for, and the answer's
 *   hint names that input (FR-568, FR-569); `type` at a point on a control whose click moves focus to an
 *   unrelated input is refused `focus-lost` with that input unchanged.
 * - SC-255: `drag` between two points inside one canvas is delivered, and the canvas records the press
 *   and the release at the named points (FR-570), and the answer is `verified` (040 FR-572, SC-258). Before
 *   039 it answered `same-endpoints`, before 040 `not-moved`.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install of the
 * native host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` of THIS checkout loaded in the attached
 * browser, and the fixture servers (`npm run dev:test-pages`) started AFTER this change - they list the
 * pages they were started with, and `/editor-039` and `/drag-039` are new.
 */
test.describe("agent typing and dragging after a point (spec 039)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("SC-253: type at a point on a nested span of a contenteditable editor enters the text, verified", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/editor-039`, SITE);

      const point = await centreOf(page.locator("#word"));
      const typed = (await call("type", { tabId, target: point, text: " added", mode: "insert" })) as Typed;

      expect(typed, JSON.stringify(typed)).toMatchObject({ observed: { effect: "text-entered", verified: true, verdict: "verified" } });
      expect(typed.observed?.charactersChanged, JSON.stringify(typed)).toBe(" added".length);
      await expect.poll(() => page.locator("#editor").innerText()).toContain("added");
      expect(await page.evaluate(() => document.body.dataset["focus"])).toBe("editor");
    });
  });

  test("SC-254: type at a point on label text goes into the labelled input and names it; a point whose click focuses an unrelated input is refused", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, callRaw, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/editor-039`, SITE);

      const labelPoint = await centreOf(page.locator("#label-text"));
      const typed = (await call("type", { tabId, target: labelPoint, text: "Ada", mode: "insert" })) as Typed;

      expect(typed, JSON.stringify(typed)).toMatchObject({ observed: { effect: "text-entered", verified: true, verdict: "verified" } });
      await expect.poll(() => page.locator("#name").inputValue()).toBe("Ada");
      expect(typed.hint, JSON.stringify(typed)).toContain("textbox");
      expect(typed.hint, JSON.stringify(typed)).toContain("Full name");

      // The press moves focus to the coupon input, which is not on the path of the control pressed.
      const grabPoint = await centreOf(page.locator("#grab"));
      const refused = await callRaw("type", { tabId, target: grabPoint, text: "SAVE10", mode: "insert" });

      expect(refused.text, refused.text).toContain("focus-lost");
      expect(await page.locator("#other").inputValue(), "the unrelated input was typed into").toBe("");
      expect(await page.locator("#name").inputValue(), "the labelled input changed").toBe("Ada");
      expect(await page.evaluate(() => document.body.dataset["focus"])).toBe("other");
    });
  });

  test("SC-255: a drag between two points inside one canvas is delivered at the named points", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId, page } = await openTab(context, call, settings, `${SITE}/drag-039`, SITE);

      const board = await boxOf(page.locator("#board"));
      const from = { x: Math.round(board.x + 100), y: Math.round(board.y + 90) };
      const to = { x: Math.round(board.x + 420), y: Math.round(board.y + 210) };
      const dragged = (await call("drag", { tabId, from, to })) as Dragged;

      expect(dragged.reason, JSON.stringify(dragged)).not.toBe("same-endpoints");
      // 040 FR-572, SC-258: both ends are the one canvas, so the answer is the press point's confirmation.
      expect(dragged, JSON.stringify(dragged)).toMatchObject({ observed: { effect: "dragged", verified: true, verdict: "verified" } });
      const recorded = await page.evaluate(
        () => (window as unknown as { __drag039: { downs: Point[]; ups: Point[] } }).__drag039,
      );
      expect(recorded.downs, JSON.stringify(recorded)).toHaveLength(1);
      expect(recorded.ups, JSON.stringify(recorded)).toHaveLength(1);
      expect(Math.abs((recorded.downs[0]?.x ?? NaN) - from.x), JSON.stringify(recorded)).toBeLessThanOrEqual(1);
      expect(Math.abs((recorded.downs[0]?.y ?? NaN) - from.y), JSON.stringify(recorded)).toBeLessThanOrEqual(1);
      expect(Math.abs((recorded.ups[0]?.x ?? NaN) - to.x), JSON.stringify(recorded)).toBeLessThanOrEqual(1);
      expect(Math.abs((recorded.ups[0]?.y ?? NaN) - to.y), JSON.stringify(recorded)).toBeLessThanOrEqual(1);
    });
  });
});

async function boxOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no-box");
  return box;
}

/** The viewport centre of one element, as the coordinate an agent would point at (CSS pixels). */
async function centreOf(locator: ReturnType<Page["locator"]>): Promise<Point> {
  const box = await boxOf(locator);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

type SessionContext = { context: BrowserContext; call: Caller; callRaw: RawCaller; settings: SettingsPageDriver };

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
    // The same call without the success assertion, for a refusal that is the claim under test.
    const callRaw: RawCaller = async (tool, args) => {
      const result = await live.callTool(tool, args);
      return { isError: result.isError, text: result.text };
    };
    await body({ context: extensionContext, call, callRaw, settings });
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
