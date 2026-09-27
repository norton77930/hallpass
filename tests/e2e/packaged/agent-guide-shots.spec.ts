import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const SITE = "https://127.0.0.1:19443";
const DIALOGS = `${SITE}/dialogs`;

/**
 * 008/T236 - the two pictures `docs/qa-guide.html` embeds (FR-123). Not a test of behaviour.
 *
 * Same shape as 006/T199 (`agent-panel-shots.spec.ts`): the real side panel is the only page the
 * worker projects to, so the pictures are taken on its own CDP session rather than on a rendered
 * copy of the components. Two compositions QA has to recognise: a session that has just exported a
 * recording (the recording line plus the activity list), and the `ask`-mode question a page's
 * confirm raises.
 *
 * The guide is written in zh-TW and the panel takes its language from the *browser* - so the panel
 * document is told to answer `zh-TW` before the shell mounts, and every label this journey waits
 * for is looked up in that same language. Nothing else about the run is localized: the worker, the
 * tools and the fixture are language-free.
 *
 * Runs only when asked for (`HALLPASS_PANEL_SHOTS=1`), in attach mode, and writes under
 * `specs/008-recording-and-dialogs/screenshots/`.
 */
const GUIDE_LOCALE = "zh-TW" as const;
const copy = copyFor(GUIDE_LOCALE);
const ui = (key: string): string => lookup(key, GUIDE_LOCALE);
const OUT = join(process.cwd(), "specs", "008-recording-and-dialogs", "screenshots");

type Blocked = { reason?: string; refusal?: { reason?: string } };

test.describe("008 guide screenshots", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT || !process.env.HALLPASS_PANEL_SHOTS,
    "screenshots are taken on request only (HALLPASS_PANEL_SHOTS=1), in attach mode",
  );

  test("captures the recording card and the dialog card for the QA guide", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(900_000);
    mkdirSync(OUT, { recursive: true });
    leaveDialogsToTheExtension(extensionContext);
    await letTheBrowserNameTheFile(extensionContext);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let openTab: number | undefined;

    const shoot = async (name: string): Promise<number> => {
      await panel.sendToPanel("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
      const data = (shot.result as { data?: string } | undefined)?.data;
      expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
      const bytes = Buffer.from(data ?? "", "base64");
      writeFileSync(join(OUT, `${name}.png`), bytes);
      await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] });
      // eslint-disable-next-line no-console -- the size the guide's data URI will carry.
      console.log(`[T236] ${name}.png ${bytes.length} bytes`);
      return bytes.length;
    };

    try {
      // ============= the dialog card: `ask` mode, an unchained accept =============
      const dialogTab = ((await call("tabs_create", { url: DIALOGS })) as { tabId: number }).tabId;
      openTab = dialogTab;
      await setSiteMode(panel, SITE, "ask");
      await call("read_page", { tabId: dialogTab, filter: "interactive" });
      const timerRef = await refFor(call, dialogTab, "Confirm three seconds later");

      const timerClick = client.callTool("click", { tabId: dialogTab, target: { ref: timerRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await timerClick).isError).toBe(false);
      await expect
        .poll(
          async () => {
            const probe = (await client.callTool("get_page_text", { tabId: dialogTab })).json as Blocked;
            return probe.reason ?? probe.refusal?.reason ?? "none";
          },
          { timeout: 15_000 },
        )
        .toBe("blocked-by-dialog");

      const asked = client.callTool("dialog", { tabId: dialogTab, action: "accept" });
      await panel.waitForText(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));
      await shoot("dialog-card");
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await asked).isError).toBe(false);
      await call("tabs_close", { tabId: dialogTab });
      openTab = undefined;

      // ============= the recording card: the same session, after it wrote its GIF =============
      // The dialog above is on the card's activity list by now, which is the second half of this
      // picture: what the page said, and which file the run was written to.
      const formTab = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      openTab = formTab;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId: formTab, filter: "interactive" });
      await call("gif_recorder", { action: "start" });
      const safe = await refFor(call, formTab, "Safe action");
      const nickname = await refFor(call, formTab, "Nickname");
      await call("click", { tabId: formTab, target: { ref: safe } });
      await call("type", { tabId: formTab, target: { ref: nickname }, text: "TC-1234" });
      await call("key", { tabId: formTab, key: "Tab" });
      await panel.waitForText(ui("agent.session.recording").replace("{frames}", "4"));

      const exported = (await call("gif_recorder", { action: "export", filename: "TC-1234" })) as {
        filename: string;
        frames: number;
      };
      await panel.waitForText(ui("agent.session.recordingExported").replace("{filename}", exported.filename));
      await shoot("recording-card");

      await call("tabs_close", { tabId: formTab });
      openTab = undefined;
    } finally {
      // A native dialog nobody answered wedges the next connection to this browser (T229).
      await tidyUp(live, openTab);
      await live?.close();
      live = undefined;
    }
  });
});

/** One paired MCP session with the panel open and speaking the guide's language. */
async function pairedSession(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<{
  panel: SidePanelDriver;
  client: McpHarnessClient;
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
}> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("offscreen");

  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });

  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await speakGuideLanguage(panel);

  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale: GUIDE_LOCALE });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

/**
 * Makes the panel render the guide's language whatever the browser's own is.
 *
 * The shell reads `chrome.i18n.getUILanguage()` once, when it mounts (006), so the answer is
 * replaced in the panel document before its first script runs and the document is reloaded. This
 * touches the picture only: no worker, storage or tool behaviour depends on it.
 */
async function speakGuideLanguage(panel: SidePanelDriver): Promise<void> {
  await panel.sendToPanel("Page.enable");
  await panel.sendToPanel("Page.addScriptToEvaluateOnNewDocument", {
    source:
      `(() => { try { Object.defineProperty(chrome.i18n, "getUILanguage", ` +
      `{ value: () => ${JSON.stringify(GUIDE_LOCALE)}, configurable: true, writable: true }); } catch { /* keep the browser's */ } })();`,
  });
  await panel.sendToPanel("Page.reload");
  await waitForAgentPanel(panel);
  expect(await panel.evaluatePanel("document.documentElement.lang")).toBe(GUIDE_LOCALE);
}

async function tidyUp(client: McpHarnessClient | undefined, tabId: number | undefined): Promise<void> {
  if (!client || tabId === undefined) return;
  await client.callTool("dialog", { tabId, action: "dismiss" }).catch(() => undefined);
  await client.callTool("tabs_close", { tabId, force: true }).catch(() => undefined);
}

/**
 * Puts the browser back on its own download behaviour for this run.
 *
 * Playwright names every download of a browser it attached to itself and drops it in its artifacts
 * directory (measured 2026-09-13, `agent-downloads`), so the card would name an opaque GUID rather
 * than the file a tester will find - and the picture is the promise this guide makes about naming.
 * `behavior: "default"` is what an owner's Chrome does: its own download folder, its own uniquifying.
 */
async function letTheBrowserNameTheFile(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await cdp.detach();
}

/** As in `agent-dialogs.spec.ts`: Playwright answers a page's dialogs unless the page has a listener. */
function leaveDialogsToTheExtension(context: BrowserContext): void {
  const arm = (page: Page): void => {
    page.on("dialog", () => undefined);
  };
  for (const page of context.pages()) arm(page);
  context.on("page", arm);
}

async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
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
    `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
      `const row=rows.find((r)=>r.textContent?.includes(site));const sel=row?.querySelector('select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect
    .poll(
      async () =>
        panel.evaluatePanel(
          `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
            `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
        ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}
