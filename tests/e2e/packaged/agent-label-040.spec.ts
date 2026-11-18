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
type Found = { outcome: string; matches: Array<{ ref: string; role?: string; label?: string }> };
type Read = { nodes: Array<{ ref?: string; role: string; name?: string }> };

/** The three controls of `/label-040` and the name each takes from its `<label>` (FR-573). */
const CONTROLS = [
  { query: "the email address input", role: "textbox", name: "Email address" },
  // FR-577: "checkbox" is a word for a checkbox's kind (before 040 it named nothing, so this query found nothing).
  { query: "the remember me checkbox", role: "checkbox", name: "Remember me" },
  { query: "the country select", role: "combobox", name: "Country" },
] as const;

/**
 * 040 live check (SC-259): `find` and `read_page` name a control from its `<label>`.
 *
 * `/label-040` has an input named by a `<label for>`, and a checkbox and a select named by a wrapping
 * `<label>`, none carrying an aria-label, title or placeholder. Before 040 they arrived nameless (or
 * named by their `name` attribute): the label's text belongs to the label, not to the control. The select's
 * option text is not part of its name.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install of the
 * native host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` of THIS checkout loaded in the attached
 * browser, and the fixture servers (`npm run dev:test-pages`) started AFTER this change - they list the
 * pages they were started with, and `/label-040` is new.
 */
test.describe("agent control names from labels (spec 040)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("SC-259: find and read_page name the labelled input, checkbox and select", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async ({ context, call, settings }) => {
      const { tabId } = await openTab(context, call, settings, `${SITE}/label-040`, SITE);

      const read = (await call("read_page", { tabId, filter: "interactive" })) as Read;
      for (const control of CONTROLS) {
        const node = read.nodes.find((candidate) => candidate.name === control.name && candidate.ref !== undefined);
        expect(node, `read_page offered no control named '${control.name}': ${JSON.stringify(read.nodes)}`).toBeTruthy();
        expect(node?.role, control.name).toBe(control.role);
      }

      for (const control of CONTROLS) {
        const found = (await call("find", { tabId, query: control.query })) as Found;
        expect(found.outcome, `find '${control.query}' answered ${found.outcome}`).toBe("resolved");
        expect(
          found.matches.map((match) => match.label),
          `find '${control.query}': ${JSON.stringify(found.matches)}`,
        ).toContain(control.name);
      }
    });
  });
});

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
