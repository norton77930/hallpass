import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 008/T233 — US4 end to end: the owner's window is given back (FR-118..FR-120, D-008-6).
 *
 * There is no reference behaviour for any of this (design-notes §5), so the gate *is* the proof. The
 * unit tests decide the four edge cases against a fake window; here the window is real, maximized
 * by the browser itself, and the only thing that can put it back is the worker deciding to.
 *
 * Three claims, and the third is why the record lives in `chrome.storage.session` at all:
 *
 *  - a resize that had to un-maximise the window is undone when the session hands the tab back,
 *    and the answer the agent got was the *real* size all along (003 FR-045);
 *  - a window the owner re-maximised by hand before the release is not touched, and the card says
 *    nothing about it - the restore is what the card reports, so no line means no `windows.update`;
 *  - a worker terminated between the resize and the release still gives the window back, because
 *    what it owes is written down rather than remembered.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine
 * install of the native-messaging host, which a browser the runner launched is not registered
 * against. The window must also be a *headed* one - `maximized` is not a state a headless browser
 * has.
 */
test.describe("agent window restore", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started against the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("gives a maximized window back when the session hands the tab over", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const windowId = await windowOfTab(extensionWorker, tabId);
      await setWindowState(extensionWorker, windowId, "maximized");
      const maximized = await windowNow(extensionWorker, windowId);
      expect(maximized.state, "the browser under test must be headed for this journey").toBe("maximized");

      // ============= the resize: the window comes out of "maximized" so the size can land =============
      const resized = (await call("resize_window", { tabId, width: 1024, height: 768 })) as {
        width: number;
        height: number;
      };
      const sized = await windowNow(extensionWorker, windowId);
      expect(sized.state).toBe("normal");
      // The answer is what Chrome did, not what was asked for (FR-046): the display may clamp it,
      // and whatever it is, it is the same size the window actually has.
      expect(resized).toEqual({ width: sized.width, height: sized.height });

      // ============= the release: the owner's window comes back =============
      const releasedAt = Date.now();
      await call("tabs_release", { tabId });
      await expect
        .poll(async () => (await windowNow(extensionWorker, windowId)).state, { timeout: 3_000, intervals: [100] })
        .toBe("maximized");
      console.log(`[T233] restored after ${Date.now() - releasedAt} ms`);

      // The card says what happened to the owner's window, in the panel's own words (FR-119).
      await expect.poll(() => restoreLines(panel), { timeout: 10_000 }).toHaveLength(1);

      await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("leaves a window the owner re-maximised by hand alone", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const windowId = await windowOfTab(extensionWorker, tabId);
      await setWindowState(extensionWorker, windowId, "maximized");
      await call("resize_window", { tabId, width: 1024, height: 768 });
      expect((await windowNow(extensionWorker, windowId)).state).toBe("normal");

      // The owner takes their window back themselves, before the session lets go of it.
      await setWindowState(extensionWorker, windowId, "maximized");

      await call("tabs_release", { tabId });

      // Nothing was owed any more, so nothing was done: the state is the owner's own, and the card
      // - which only ever says "put back" when this worker put it back - says nothing at all.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect((await windowNow(extensionWorker, windowId)).state).toBe("maximized");
      expect(await restoreLines(panel)).toEqual([]);

      await setWindowState(extensionWorker, windowId, "normal");
      await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("still gives the window back after the worker was terminated in between", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const windowId = await windowOfTab(extensionWorker, tabId);
      await setWindowState(extensionWorker, windowId, "maximized");
      await call("resize_window", { tabId, width: 1024, height: 768 });
      expect((await windowNow(extensionWorker, windowId)).state).toBe("normal");

      // ============= the worker goes, exactly as `agent-recording` kills it =============
      const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
      const cdp = await extensionContext.newCDPSession(ownerPage);
      const targets = await cdp.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
      );
      expect(worker, "worker target").toBeTruthy();
      await cdp.send("Target.closeTarget", { targetId: worker!.targetId });
      await cdp.detach();
      // The fresh worker has to re-link before a call is answered at all; that is the bridge's own
      // honesty, not the restore's.
      await expect
        .poll(async () => (await live!.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);

      const releasedAt = Date.now();
      await call("tabs_release", { tabId });
      await expect
        .poll(async () => (await windowNow(extensionWorker, windowId)).state, { timeout: 3_000, intervals: [100] })
        .toBe("maximized");
      console.log(`[T233] restored after a worker kill in ${Date.now() - releasedAt} ms`);

      await setWindowState(extensionWorker, windowId, "normal");
      await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    } finally {
      await live?.close();
      live = undefined;
    }
  });
});

/** The window the tab sits in - the thing `resize_window` actually changes (FR-046). */
async function windowOfTab(worker: PackagedWorker, tabId: number): Promise<number> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).windowId, tabId);
}

/** The window as the browser has it now, read through the browser rather than through the worker's memory. */
async function windowNow(
  worker: PackagedWorker,
  windowId: number,
): Promise<{ state?: string | undefined; width?: number | undefined; height?: number | undefined }> {
  return worker.evaluate(async (id: number) => {
    const window = await chrome.windows.get(id);
    return { state: window.state, width: window.width, height: window.height };
  }, windowId);
}

/**
 * The owner's own hand on the window.
 *
 * Driven through `chrome.windows.update` rather than CDP's `Browser.setWindowBounds` because the
 * window under test is the one the runner is attached to: the CDP call names a *target's* window
 * and the extension's tabs, the panel and this test all live in it, while the browser API names the
 * window by the id the journey already has.
 */
async function setWindowState(worker: PackagedWorker, windowId: number, state: string): Promise<void> {
  await worker.evaluate(
    async ({ id, next }: { id: number; next: string }) =>
      void (await chrome.windows.update(id, { state: next as chrome.windows.WindowState })),
    { id: windowId, next: state },
  );
}

/** Every "window put back" line the card is showing; the restore is the only thing that writes one. */
async function restoreLines(panel: SidePanelDriver): Promise<string[]> {
  const needle = ui("agent.activity.restore").replace("{state}", "").trim();
  const found = await panel.evaluatePanel(
    `(()=>[...document.querySelectorAll('.agent-activity-text')]` +
      `.map((node)=>node.textContent ?? '')` +
      `.filter((text)=>text.includes(${JSON.stringify(needle)})))()`,
  );
  return (found as string[] | null) ?? [];
}

/** One paired MCP session with the panel open, exactly as the sibling journeys start. */
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
  ).toContain("tabGroups");

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
  await acceptPairing(panel, { locale });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}
