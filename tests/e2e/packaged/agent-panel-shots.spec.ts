import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, settingsPageDriver } from "../fixtures/settings-page-driver.js";
import {
  copyFor,
  localeFromEnv,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const SITE = "https://127.0.0.1:19443";
/** A second site, so the list shows two rows: one acting without asking, one asking with diagnostics. */
const SITE_ASK = "https://127.0.0.1:19445";
const AGENT = "Claude Code";
const LABEL_A = "shop-frontend";
const LABEL_B = "report-tool";
const LOCALES: readonly AppLocale[] = ["zh-TW", "en-US"];
const SCHEMES = ["light", "dark"] as const;

/**
 * 006/T199, redone for 016/T452 - the screenshots the owner approves before 0.9.0 (US6 scenario 3).
 * Not a test of behaviour. The real side panel is the only page the worker projects to
 * (`isTrustedControlSender`), so the pictures are taken on its own CDP session - the colour scheme
 * emulated both ways, the language replaced in the panel document before its shell mounts (the
 * shell reads `chrome.i18n.getUILanguage()` once, as `agent-guide-shots.spec.ts` does).
 *
 * The composition: two sessions spawned in two scratch folders, `shop-frontend` (idle, holding a
 * tab on a skip-checks site) and `report-tool` (waiting on the owner, its consent card on top,
 * holding a tab on an `ask` site with diagnostics granted). Each picture is written to the run's
 * output directory and copied to `docs/media/016-panel-{locale}-{scheme}.png` for the owner.
 *
 * The tab strip cannot be captured from the panel's CDP session, so the group titles and colours
 * are recorded in the test output instead.
 *
 * Runs only when asked for (`HALLPASS_PANEL_SHOTS=1`), in attach mode.
 */
const MEDIA = join(process.cwd(), "docs", "media");

test.describe("agent panel screenshots", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT || !process.env.HALLPASS_PANEL_SHOTS,
    "screenshots are taken on request only (HALLPASS_PANEL_SHOTS=1), in attach mode",
  );

  test("captures two sessions and two sites in zh-TW and en-US, light and dark", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(420_000);
    mkdirSync(MEDIA, { recursive: true });

    const scratch = mkdtempSync(join(tmpdir(), "hallpass-016-shots-"));
    const folderA = join(scratch, LABEL_A);
    const folderB = join(scratch, LABEL_B);
    mkdirSync(folderA);
    mkdirSync(folderB);

    const panel = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale: LOCALES[0]! });
    let override: string | undefined = await speak(panel, LOCALES[0]!, undefined);

    let a: McpHarnessClient | undefined;
    let b: McpHarnessClient | undefined;
    const openTabs: number[] = [];
    try {
      a = await startMcpClient({ clientName: AGENT, cwd: folderA });
      await panel.clickIfPresent(lookup("agent.retry", LOCALES[0]!));
      await pairWithFirstCall(a, panel, { locale: LOCALES[0]! });
      b = await startMcpClient({ clientName: AGENT, cwd: folderB });
      const alpha = a;
      const beta = b;

      const tabA = ((await ok(alpha, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      openTabs.push(tabA);
      const tabB = ((await ok(beta, "tabs_create", { url: `${SITE_ASK}/ordinary` })) as { tabId: number }).tabId;
      openTabs.push(tabB);
      // 024 FR-385: the modes are set on the settings page. The 016 composition also granted diagnostics
      // on the `ask` site; since 024 no surface offers that grant (the panel's site row is gone and the
      // settings page leaves it out), so the picture shows the site without it.
      await settings.setSiteMode(SITE, "skip-checks");
      await settings.setSiteMode(SITE_ASK, "ask");
      await expect
        .poll(() => panel.evaluatePanel("document.querySelectorAll('section[data-session-id]').length"), { timeout: 20_000 })
        .toBe(2);

      for (const locale of LOCALES) {
        if (locale !== LOCALES[0]) override = await speak(panel, locale, override);
        const ui = (key: string): string => lookup(key, locale);
        await expect
          .poll(() => panel.evaluatePanel("document.querySelectorAll('section[data-session-id]').length"), { timeout: 20_000 })
          .toBe(2);

        // report-tool asks for an effect on the `ask` site: its consent card comes up and it waits.
        const ref = await refFor(beta, tabB, "Safe action");
        const pending = beta.callTool("click", { tabId: tabB, target: { ref } });
        await panel.waitForText(ui("agent.promptTitle"), 20_000);
        await expect
          .poll(() => panel.evaluatePanel(`document.querySelector('section[data-session-state="waiting"]') !== null`), { timeout: 15_000 })
          .toBe(true);
        // shop-frontend has been quiet for more than a second: idle, with its last action.
        await expect
          .poll(() => panel.evaluatePanel(`document.querySelector('section[data-session-state="idle"]') !== null`), { timeout: 15_000 })
          .toBe(true);
        for (const label of [LABEL_A, LABEL_B]) {
          expect(await panel.panelText(), `the card for ${label}`).toContain(`${AGENT} · ${label}`);
        }

        const groups = {
          [LABEL_A]: await groupOf(extensionWorker, tabA),
          [LABEL_B]: await groupOf(extensionWorker, tabB),
        };
        // eslint-disable-next-line no-console -- the tab strip is not in the panel's own screenshot.
        console.log(`[T452] ${locale} tab groups: ${JSON.stringify(groups)}`);

        for (const scheme of SCHEMES) {
          await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
          await new Promise((resolve) => setTimeout(resolve, 400));
          const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
          const data = (shot.result as { data?: string } | undefined)?.data;
          expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
          const name = `016-panel-${locale}-${scheme}.png`;
          const saved = test.info().outputPath(name);
          writeFileSync(saved, Buffer.from(data ?? "", "base64"));
          copyFileSync(saved, join(MEDIA, name));
          // eslint-disable-next-line no-console -- where the owner finds the picture.
          console.log(`[T452] ${name} -> ${saved}`);
        }
        await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] });

        // 0.9.0 owner check: the site rows and the upload directories - on the settings page since 024
        // (FR-385), in this locale.
        const sites = settingsPageDriver(settings.page, locale);
        await sites.setAppearance({ language: locale, theme: "light" });
        await sites.goto("#sites");
        const lowerName = `016-panel-${locale}-sites.png`;
        const lowerSaved = test.info().outputPath(lowerName);
        await sites.screenshot(lowerSaved);
        // The last line of the upload list is the host's config path, which follows the LOCALAPPDATA the
        // *browser* was launched with. docs/media ships in the public repo and the snapshot check reads
        // text, not pixels, so a path naming the maintainer's account never reaches docs/media.
        const listPath = await sites.evaluateSettings("document.querySelector('[data-section-body=sites]')?.innerText ?? ''");
        const leak = namesThisAccount(typeof listPath === "string" ? listPath : "");
        expect
          .soft(leak, `${lowerName} shows ${JSON.stringify(listPath)}; launch the browser with a neutral LOCALAPPDATA (e.g. C:\\hallpass-demo) and retake. Kept only at ${lowerSaved}`)
          .toBe(false);
        if (!leak) copyFileSync(lowerSaved, join(MEDIA, lowerName));

        await panel.clickButton(ui("agent.refuse"));
        const refused = await pending;
        expect(refused.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      }

      await ok(alpha, "tabs_close", { tabId: tabA });
      await ok(beta, "tabs_close", { tabId: tabB });
      openTabs.length = 0;
      // The `ask` row was this run's own; forget it for the next gate.
      await settings.revokeSite(SITE_ASK);
      await settings.setAppearance({ language: "system", theme: "system" });
    } finally {
      for (const tabId of openTabs) {
        await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      }
      await a?.close().catch(() => undefined);
      await b?.close().catch(() => undefined);
      // The panel goes back to the browser's own language, so a later gate reusing it reads that.
      if (override !== undefined) {
        await panel.sendToPanel("Page.removeScriptToEvaluateOnNewDocument", { identifier: override }).catch(() => undefined);
        await panel.sendToPanel("Page.reload").catch(() => undefined);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * True when `text` names this account: its name, or any path under the folder that holds the home
 * directories (`C:\Users\` - which also catches an 8.3 short form such as `JANEDO~1`).
 * Case-insensitive. A neutral LOCALAPPDATA lives outside that folder.
 */
function namesThisAccount(text: string): boolean {
  const haystack = text.toLowerCase();
  return [`${dirname(homedir())}${sep}`, userInfo().username]
    .map((needle) => needle.trim().toLowerCase())
    .some((needle) => needle.length > 1 && haystack.includes(needle));
}

async function ownerPanel(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<SidePanelDriver> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
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
    copy: copyFor(localeFromEnv()),
  });
  await waitForAgentPanel(panel);
  return panel;
}

/**
 * Makes the panel render `locale` whatever the browser's own language is: the previous override is
 * removed, the new one installed before the document's first script, and the document reloaded.
 * Returns the new override's identifier.
 */
async function speak(panel: SidePanelDriver, locale: AppLocale, previous: string | undefined): Promise<string> {
  await panel.sendToPanel("Page.enable");
  if (previous !== undefined) {
    await panel.sendToPanel("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
  }
  const added = await panel.sendToPanel("Page.addScriptToEvaluateOnNewDocument", {
    source:
      `(() => { try { Object.defineProperty(chrome.i18n, "getUILanguage", ` +
      `{ value: () => ${JSON.stringify(locale)}, configurable: true, writable: true }); } catch { /* keep the browser's */ } })();`,
  });
  const identifier = (added.result as { identifier?: string } | undefined)?.identifier;
  expect(identifier, JSON.stringify(added).slice(0, 300)).toBeTruthy();
  await panel.sendToPanel("Page.reload");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForAgentPanel(panel);
  await expect.poll(() => panel.evaluatePanel("document.documentElement.lang"), { timeout: 10_000 }).toBe(locale);
  return identifier!;
}

async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

async function refFor(client: McpHarnessClient, tabId: number, label: string): Promise<string> {
  const found = await client.callTool("find", { tabId, query: label });
  expect(found.isError, `find '${label}' failed: ${found.text}`).toBe(false);
  const answer = found.json as { outcome: string; matches: Array<{ ref: string; label?: string }> };
  expect(answer.outcome, `find '${label}' answered ${answer.outcome}`).toBe("resolved");
  const match = answer.matches.find((candidate) => candidate.label === label) ?? answer.matches[0];
  expect(match?.ref, `find '${label}' returned no ref: ${found.text}`).toBeTruthy();
  return match!.ref;
}

/** A tab's group as the browser has it: id, title and colour. */
async function groupOf(
  worker: PackagedWorker,
  tabId: number,
): Promise<{ groupId: number; title?: string | undefined; color?: string | undefined }> {
  return worker.evaluate(async (id: number) => {
    const tab = await chrome.tabs.get(id);
    const group = tab.groupId === undefined || tab.groupId < 0 ? undefined : await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group?.title, color: group?.color };
  }, tabId);
}
