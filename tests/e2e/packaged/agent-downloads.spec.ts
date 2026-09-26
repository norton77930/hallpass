import { existsSync, rmSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 005/T184 - US2 end to end: a file the page produced is reported to the session that caused it
 * (FR-076..FR-080, SC-042, half of SC-043; `download.html`).
 *
 * The unit tests prove the ring and the wait; this is the one place the whole path is real - the
 * browser's own `downloads.onCreated`/`onChanged`, the attribution by lease, the MCP answer, and a
 * `filename` that is a path on this machine's disk. Two claims that only a real browser can settle:
 * the saved path exists where the browser says it does, and a download that finished *before* the
 * wait was called is still answered once and never twice.
 *
 * The test deletes the file it caused afterwards; the extension never does (FR-076). The named zip
 * URL of the acceptance standard is the probe's case (s8), not this one: this gate does not reach
 * the public internet.
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 */

type DownloadRecord = {
  id: number;
  filename: string;
  url: string;
  state: string;
  startedAt: string;
  endedAt?: string;
  bytesReceived: number;
  totalBytes: number;
  danger: boolean;
  attribution: string;
};

type WaitAnswer = {
  outcome: string;
  waitedMs: number;
  download?: { id: number; filename: string; url: string; state: string };
};

test.describe("agent downloads", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("reports a page-produced file by its saved path, once, to the session that caused it", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("downloads");

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
    await panel.waitForText(ui("agent.appTitle"));

    let client: McpHarnessClient | undefined;
    let successor: McpHarnessClient | undefined;
    let savedPath: string | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });

      const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      // ============= 0. nothing yet: a fresh session has caused no download =============
      const before = (await call("downloads_context")) as { downloads: DownloadRecord[] };
      expect(before).toEqual({ downloads: [] });

      const created = (await call("tabs_create", { url: `${SITE}/download` })) as { tabId: number };
      const tabId = created.tabId;
      // The click is an effect and the site has no mode yet: the owner puts it into skip-checks
      // from the panel, as `agent-actions` does, so the click lands without a prompt.
      await setSiteMode(panel, SITE, "skip-checks");

      // ============= 1. click, then wait: the file is small, so it is done before the wait =============
      const link = await refFor(call, tabId, "Download report");
      await call("click", { tabId, target: { ref: link } });
      // A beat, on purpose: the claim is that a completion *before* the wait began is still answered
      // (FR-078's "click, then wait"), not that the wait happened to be first.
      await ownerPage.waitForTimeout(1_500);

      const waited = (await call("wait", { tabId, condition: "download-complete", maxMs: 15_000 })) as WaitAnswer;
      expect(waited.outcome).toBe("condition-met");
      expect(waited.download, JSON.stringify(waited)).toBeTruthy();
      const download = waited.download!;
      expect(download.state).toBe("complete");
      expect(download.url).toMatch(/^data:text\/csv/);
      // SC-042's claim from the caller's side: the path the browser reports is a file on this disk.
      expect(download.filename, "the browser's saved path must be non-empty").not.toBe("");
      expect(existsSync(download.filename), `${download.filename} does not exist`).toBe(true);
      // The name is not asserted here on purpose: a browser attached through Playwright's CDP
      // client has its downloads redirected to Playwright's artifacts directory under an opaque
      // name (measured 2026-09-13: `…\playwright-artifacts-*\<guid>`), so `report.csv` is only what
      // the owner's unattached browser would save. The name half of SC-042 is the probe's (S8).
      savedPath = download.filename;

      // ============= 2. listed once, complete, as this session's own =============
      const listed = (await call("downloads_context")) as { downloads: DownloadRecord[] };
      expect(listed.downloads.filter((record) => record.id === download.id)).toHaveLength(1);
      expect(listed.downloads[0]).toMatchObject({
        id: download.id,
        filename: download.filename,
        url: download.url,
        state: "complete",
        danger: false,
        attribution: "session",
      });
      expect(listed.downloads[0]?.endedAt).toBeTruthy();
      expect(listed.downloads[0]?.bytesReceived).toBeGreaterThan(0);

      // ============= 3. never twice: the same completion satisfies no second wait =============
      const again = await live.callTool("wait", { tabId, condition: "download-complete", maxMs: 1_000 });
      expect(again.isError, again.text).toBe(true);
      expect(JSON.parse(again.text)).toMatchObject({ outcome: "failed", reason: "bound-reached" });

      // ============= 4. a session started afterwards is told nothing of it (SC-043, second half) =============
      successor = await startMcpClient({ clientName: "Claude Code" });
      const later = await successor.callTool("downloads_context");
      expect(later.isError, later.text).toBe(false);
      expect(later.json).toEqual({ downloads: [] });

      await call("tabs_close", { tabId });
    } finally {
      await successor?.close();
      await client?.close();
      // The test caused the file; the test removes it. The extension has no way to (FR-076).
      if (savedPath && existsSync(savedPath)) rmSync(savedPath, { force: true });
    }
  });

  /**
   * 015 SC-111 (FR-207 - FR-209, T418, contracts/downloads.md): every finished download, once, in
   * finishing order.
   *
   * `/two-downloads` starts a slow file and then a fast one from one press; the server holds the
   * slow file's body back, so the file that began second finishes first. Two `download-complete`
   * waits answer the fast file and then the slow one - the order the browser itself records them
   * finishing in - and a third wait repeats neither.
   */
  test("answers two downloads once each, in the order they finished (SC-111)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    const saved: string[] = [];
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/two-downloads` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");

      const trigger = await refFor(call, tabId, "Download both");
      await call("click", { tabId, target: { ref: trigger } });

      const first = (await call("wait", { tabId, condition: "download-complete", maxMs: 15_000 })) as WaitAnswer;
      expect(first.outcome, JSON.stringify(first)).toBe("condition-met");
      expect(first.download?.url, JSON.stringify(first)).toBe(`${SITE}/two-downloads/fast.csv`);
      expect(first.download?.state).toBe("complete");
      if (first.download?.filename) saved.push(first.download.filename);

      const second = (await call("wait", { tabId, condition: "download-complete", maxMs: 15_000 })) as WaitAnswer;
      expect(second.outcome, JSON.stringify(second)).toBe("condition-met");
      expect(second.download?.url, JSON.stringify(second)).toBe(`${SITE}/two-downloads/slow.csv`);
      expect(second.download?.state).toBe("complete");
      if (second.download?.filename) saved.push(second.download.filename);
      expect(second.download?.id).not.toBe(first.download?.id);

      // Reality: the browser has both items, and it finished them in the order they were answered.
      const real = await extensionWorker.evaluate(
        async (ids: number[]) =>
          Promise.all(
            ids.map(async (id) => {
              const [item] = await chrome.downloads.search({ id });
              return { id, state: item?.state ?? "", endTime: item?.endTime ?? "" };
            }),
          ),
        [first.download!.id, second.download!.id],
      );
      expect(real.map((item) => item.state)).toEqual(["complete", "complete"]);
      expect(Date.parse(real[0]!.endTime), JSON.stringify(real)).toBeLessThanOrEqual(Date.parse(real[1]!.endTime));

      // Never twice: with both answered, a third wait answers neither and ends at its bound.
      const third = await client.callTool("wait", { tabId, condition: "download-complete", maxMs: 1_000 });
      expect(third.isError, third.text).toBe(true);
      expect(JSON.parse(third.text)).toMatchObject({ outcome: "failed", reason: "bound-reached" });

      await call("tabs_close", { tabId });
    } finally {
      await client.close().catch(() => undefined);
      // The test caused the files; the test removes them. The extension has no way to (FR-076).
      for (const file of saved) if (existsSync(file)) rmSync(file, { force: true });
    }
  });
});

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

async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as {
    outcome: string;
    matches: Array<{ ref: string }>;
  };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const first = found.matches[0]?.ref;
  expect(first, `find '${query}' returned no ref`).toBeTruthy();
  return first as string;
}

/**
 * Sets one site's mode through the panel's own control (FR-042), never by writing storage - the
 * same helper `agent-actions` uses, for the same reason.
 */
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
      async () => panel.evaluatePanel(
        `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
          `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
      ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}
