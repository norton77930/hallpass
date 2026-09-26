import { existsSync, rmSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 015 SC-109 (FR-200 - FR-202, T408, contracts/press-outcomes.md): the answer to a press says what
 * the press did.
 *
 * Eight presses on the `/press-outcomes` fixture - a same-tab link, a cross-origin link, a link
 * through a same-origin redirect, a `target=_blank` link, a link to
 * an attachment, a link whose handler cancels it, a button that calls `window.open`, and the page's
 * plain heading - each made three ways: `click` by a ref from `find`, `computer left_click` at the
 * element's centre, and a `click` step inside `browser_batch`. Every answer is compared with what
 * the browser itself says happened, read from the extension worker (`chrome.tabs`,
 * `chrome.downloads`), never with the answer's own words:
 *   - same tab: `documentChanged` and the tab's real address;
 *   - a new tab (link or script): `newTabs` naming a tab that really exists with the pressed tab as
 *     its opener, `held: false`, and the `tabs_claim` hint;
 *   - a download: `downloads` naming a real download item;
 *   - nothing: `observedForMs`, the link hint for a link pressed by ref, and no hint otherwise.
 *
 * `computer` presses a point, not an element, so it never knows it pressed a link: its "nothing"
 * answers carry no link hint by design (contracts rule 6 applies to a located link only).
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);
const SITE = "https://127.0.0.1:19443";
const FIXTURE = `${SITE}/press-outcomes`;

type Outcome = "same-tab" | "new-tab" | "download" | "nothing";
type Mode = "click" | "computer" | "batch";

type Variant = {
  name: string;
  /** The fixture's own selector, for the `computer` press's coordinates and the page checks. */
  selector: string;
  /** The label `find` names it by. */
  label: string;
  /** Whether the pressed element is a link with an address (FR-201's hint is for those). */
  link: boolean;
  outcome: Outcome;
  /** Where the press leads: this tab, the new tab, or the downloaded file. */
  url?: string;
};

const VARIANTS: Variant[] = [
  { name: "same-tab link", selector: "#same-tab", label: "Go to the ordinary page", link: true, outcome: "same-tab", url: `${SITE}/ordinary?from=press-outcomes` },
  // The two new-tab presses run before anything crosses origins (R-197): Chromium blocks the first
  // opener-keeping window.open pressed after a cross-origin round trip; that case is recorded, not gated.
  { name: "new-tab link", selector: "#new-tab", label: "Open the ordinary page in a new tab", link: true, outcome: "new-tab", url: `${SITE}/ordinary?from=new-tab` },
  { name: "window.open button", selector: "#open-tab", label: "Open a tab from script", link: false, outcome: "new-tab", url: `${SITE}/ordinary?from=window-open` },
  { name: "cross-origin link", selector: "#cross-origin", label: "Go to another site", link: true, outcome: "same-tab", url: "https://127.0.0.1:19445/ordinary?from=cross-origin" },
  { name: "redirected link", selector: "#redirected", label: "Go through a redirect", link: true, outcome: "same-tab", url: `${SITE}/ordinary?from=redirect` },
  { name: "download link", selector: "#download", label: "Download the report", link: true, outcome: "download", url: `${SITE}/press-outcomes/report.csv` },
  { name: "cancelled link", selector: "#cancelled", label: "A link the page handles itself", link: true, outcome: "nothing" },
  { name: "plain text", selector: "h1", label: "Press outcomes", link: false, outcome: "nothing" },
];

const MODES: Mode[] = ["click", "computer", "batch"];

/** 015/T402: the fixture's button whose handler holds the main thread; no variant above presses it. */
const BUSY_LABEL = "Keep the page busy";

type Observed = {
  effect?: string;
  documentChanged?: boolean;
  url?: string;
  newTabs?: Array<{ tabId: number; url: string; held: boolean }>;
  downloads?: Array<{ id: number; filename: string; url: string; state: string }>;
  observedForMs?: number;
};

type PressAnswer = { observed: Observed; hint?: string };

const LINK_HINT = /^The link was pressed, but nothing navigated, opened or downloaded within \d+ ms\. The page may handle it itself/;

test.describe("015 press outcomes", () => {
  test.skip(!process.env.HALLPASS_CDP_ENDPOINT, "attach mode only");

  test("every press answers what the browser actually did: eight variants by ref, by position and as a batch step (SC-109)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    const downloadIds: number[] = [];
    let tabId: number | undefined;
    try {
      tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const pressed = tabId;
      await setSiteMode(panel, SITE, "skip-checks");

      const realUrl = async (id: number): Promise<string> =>
        extensionWorker.evaluate(async (tab: number) => {
          const found = await chrome.tabs.get(tab);
          return found.url || found.pendingUrl || "";
        }, id);
      /** Every tab whose opener is the pressed tab, as the browser keeps it - not as the answer says. */
      const openedBy = async (opener: number): Promise<Array<{ id: number; url: string }>> =>
        extensionWorker.evaluate(async (from: number) => {
          const tabs = await chrome.tabs.query({});
          return tabs
            .filter((tab) => tab.openerTabId === from && tab.id !== undefined)
            .map((tab) => ({ id: tab.id as number, url: tab.url || tab.pendingUrl || "" }));
        }, opener);

      for (const variant of VARIANTS) {
        for (const mode of MODES) {
          const label = `${variant.name} via ${mode}`;
          // A fresh document for every press: the previous one may have moved, and refs are per document.
          await call("navigate", { tabId: pressed, url: FIXTURE });
          await expect.poll(() => realUrl(pressed), { timeout: 10_000 }).toBe(FIXTURE);
          expect(await openedBy(pressed), `${label}: a tab from an earlier press is still open`).toEqual([]);
          const page = await agentPage(extensionContext, FIXTURE);

          const answer = await press(client, call, page, pressed, variant, mode);
          const observed = answer.observed;
          expect(observed, `${label}: no observation`).toBeTruthy();

          if (variant.outcome === "same-tab") {
            expect(observed.documentChanged, `${label}: ${JSON.stringify(answer)}`).toBe(true);
            expect(observed.url, `${label}: ${JSON.stringify(answer)}`).toBe(variant.url);
            await expect.poll(() => realUrl(pressed), { timeout: 10_000 }).toBe(variant.url);
            expect(observed.newTabs, label).toBeUndefined();
            expect(observed.downloads, label).toBeUndefined();
            expect(observed.observedForMs, label).toBeUndefined();
            expect(answer.hint, label).toBeUndefined();
          }

          if (variant.outcome === "new-tab") {
            expect(observed.documentChanged, `${label}: ${JSON.stringify(answer)}`).toBe(false);
            expect(observed.newTabs, `${label}: ${JSON.stringify(answer)}`).toHaveLength(1);
            const opened = observed.newTabs![0]!;
            expect(opened.held, label).toBe(false);
            expect(opened.url, label).toBe(variant.url);
            // Reality: that tab exists, the pressed tab is its opener, and it is the only one.
            const real = await openedBy(pressed);
            expect(real.map((tab) => tab.id), `${label}: the browser's own opener list`).toEqual([opened.tabId]);
            await expect.poll(() => realUrl(opened.tabId), { timeout: 10_000 }).toBe(variant.url);
            expect(answer.hint, label).toBe(
              `The press opened tab ${opened.tabId} (${opened.url}). It is not held by this session; use tabs_claim to act on it.`,
            );
            expect(observed.downloads, label).toBeUndefined();
            expect(observed.observedForMs, label).toBeUndefined();
            // The pressed tab itself did not move.
            expect(await realUrl(pressed), label).toBe(FIXTURE);
            // Not the session's tab, so not the session's to close: the browser closes it.
            await extensionWorker.evaluate(async (ids: { opened: number; pressed: number }) => {
              await chrome.tabs.remove(ids.opened);
              await chrome.tabs.update(ids.pressed, { active: true });
            }, { opened: opened.tabId, pressed });
          }

          if (variant.outcome === "download") {
            expect(observed.downloads, `${label}: ${JSON.stringify(answer)}`).toHaveLength(1);
            const reported = observed.downloads![0]!;
            downloadIds.push(reported.id);
            expect(reported.url, label).toBe(variant.url);
            // Reality: the browser has a download item by that id, for that address.
            const real = await extensionWorker.evaluate(
              async (id: number) => (await chrome.downloads.search({ id })).map((item) => ({ id: item.id, url: item.finalUrl || item.url })),
              reported.id,
            );
            expect(real, `${label}: no real download ${reported.id}`).toEqual([{ id: reported.id, url: variant.url }]);
            await expect
              .poll(
                () => extensionWorker.evaluate(async (id: number) => (await chrome.downloads.search({ id }))[0]?.state ?? "", reported.id),
                { timeout: 15_000 },
              )
              .toBe("complete");
            expect(observed.documentChanged, label).toBe(false);
            expect(observed.newTabs, label).toBeUndefined();
            expect(observed.observedForMs, label).toBeUndefined();
            expect(answer.hint, label).toBeUndefined();
            expect(await realUrl(pressed), label).toBe(FIXTURE);
          }

          if (variant.outcome === "nothing") {
            expect(observed.observedForMs, `${label}: ${JSON.stringify(answer)}`).toEqual(expect.any(Number));
            expect(observed.observedForMs!, label).toBeGreaterThan(0);
            expect(observed.documentChanged, label).toBe(false);
            expect(observed.url, label).toBeUndefined();
            expect(observed.newTabs, label).toBeUndefined();
            expect(observed.downloads, label).toBeUndefined();
            // `computer` presses a point, never a located link, so it cannot know to say this.
            if (variant.link && mode !== "computer") expect(answer.hint, label).toMatch(LINK_HINT);
            else expect(answer.hint, label).toBeUndefined();
            // Reality, a beat later: the tab stayed, no tab opened.
            await page.waitForTimeout(1_000);
            expect(await realUrl(pressed), label).toBe(FIXTURE);
            expect(await openedBy(pressed), label).toEqual([]);
            if (variant.selector === "#cancelled") {
              // The press did land: the page's own handler ran and cancelled it.
              await expect(page.locator("#handled")).toHaveText("handled by the page");
            }
          }
        }
      }

      // Every download this gate caused was a real item with its own id: one per press, none shared.
      expect(new Set(downloadIds).size).toBe(MODES.length);
      await call("tabs_close", { tabId: pressed });
      tabId = undefined;
    } finally {
      // The gate caused the files; the gate removes them. The extension has no way to (FR-076).
      const saved = await extensionWorker
        .evaluate(
          async (ids: number[]) =>
            (await Promise.all(ids.map(async (id) => (await chrome.downloads.search({ id }))[0]?.filename ?? ""))).filter(
              (name) => name !== "",
            ),
          downloadIds,
        )
        .catch(() => [] as string[]);
      for (const file of saved) if (existsSync(file)) rmSync(file, { force: true });
      if (tabId !== undefined) await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  test("a press the page does not answer is told page-not-responding at the deadline, and the tab answers again afterwards (T402, FR-206)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let tabId: number | undefined;
    try {
      tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const pressed = tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await agentPage(extensionContext, FIXTURE);
      const ref = await refFor(client, pressed, BUSY_LABEL);

      // `#busy` holds the page's main thread for 15 s, so the renderer does not answer the press.
      const started = Date.now();
      const busy = await client.callTool("click", { tabId: pressed, target: { ref } });
      const elapsed = Date.now() - started;
      expect(busy.isError, busy.text).toBe(true);
      expect(busy.json).toMatchObject({
        outcome: "failed",
        reason: "page-not-responding",
        hint: "The input reached the page, which then did not answer for 10 s; it is still open and the input may have taken effect. Take a screenshot or read the page before sending it again.",
      });
      expect(elapsed, `answered after ${elapsed} ms`).toBeLessThan(13_000);

      // Once the handler has let go, the same tab answers an ordinary read again.
      const wait = started + 16_000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const found = await client.callTool("find", { tabId: pressed, query: BUSY_LABEL });
      expect(found.isError, `find after the busy spell: ${found.text}`).toBe(false);
      expect(found.json).toMatchObject({ outcome: "resolved" });

      await call("tabs_close", { tabId: pressed });
      tabId = undefined;
    } finally {
      if (tabId !== undefined) await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});

/** One press of `variant`, made the `mode` way, answered in the one shape all three share. */
async function press(
  client: McpHarnessClient,
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
  page: Page,
  tabId: number,
  variant: Variant,
  mode: Mode,
): Promise<PressAnswer> {
  if (mode === "computer") {
    const point = await centreOf(page, variant.selector);
    return (await call("computer", { tabId, action: "left_click", x: point.x, y: point.y })) as PressAnswer;
  }
  const ref = await refFor(client, tabId, variant.label);
  if (mode === "click") return (await call("click", { tabId, target: { ref } })) as PressAnswer;
  const batch = (await call("browser_batch", { tabId, steps: [{ tool: "click", args: { target: { ref } } }] })) as {
    results: Array<{ index: number; outcome: string; result?: { observed: Observed }; hint?: string; reason?: string }>;
  };
  expect(batch.results, `${variant.name} batch: ${JSON.stringify(batch)}`).toHaveLength(1);
  const step = batch.results[0]!;
  expect(step.outcome, `${variant.name} batch step: ${JSON.stringify(step)}`).toBe("ok");
  return { observed: step.result?.observed as Observed, ...(step.hint === undefined ? {} : { hint: step.hint }) };
}

/** The ref `find` gives the element labelled exactly `label`, preferring an exact label match. */
async function refFor(client: McpHarnessClient, tabId: number, label: string): Promise<string> {
  const found = await client.callTool("find", { tabId, query: label });
  expect(found.isError, `find '${label}' failed: ${found.text}`).toBe(false);
  const answer = found.json as { outcome: string; matches: Array<{ ref: string; role?: string; label?: string }> };
  expect(answer.outcome, `find '${label}' answered ${answer.outcome}`).toBe("resolved");
  const match = answer.matches.find((candidate) => candidate.label === label) ?? answer.matches[0];
  expect(match?.ref, `find '${label}' returned no ref: ${found.text}`).toBeTruthy();
  return match!.ref;
}

/** The viewport centre of one element, as the coordinate an agent would point at. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `no box for ${selector}`).toBeTruthy();
  if (!box) throw new Error(`no-box:${selector}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(context: { pages: () => Page[] }, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((candidate) => candidate.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

async function pairedSession(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<{ panel: SidePanelDriver; client: McpHarnessClient; call: (tool: string, args?: Record<string, unknown>) => Promise<unknown> }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await panel.waitForText(ui("agent.appTitle"));
  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

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
