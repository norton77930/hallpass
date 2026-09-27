import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The fixture origin, which is also the site the owner's per-site mode is keyed by (R-108). */
const SITE = "https://127.0.0.1:19443";

/**
 * 004/T140 — US7 end to end: the `computer` tool acts by *position* rather than by naming an
 * element, on `canvas.html` (004/T074), whose toolbar sits at coordinates fixed in the fixture
 * itself so a click "at (x, y)" means the same thing across a run.
 *
 * Three claims, each settled the way only a real browser can settle it:
 *   1. a `left_click` at the toolbar's own coordinates changes the fixture's own
 *      `data-active-tool` state and its on-page readout - never the tool's verdict word alone;
 *   2. a point outside the tab's viewport is refused, and the refusal names that viewport;
 *   3. under `ask`, the owner's prompt carries a crop of where the click would land, because a
 *      position effect has no label or role for the panel to show instead (FR-069, T139a).
 *
 * The `computer` tool works in viewport coordinates and dispatches at tab level *by design*: it
 * resolves no element and is never routed through a frame's CDP session, so this journey does not
 * ask it to.
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the three test services running (ports 18786/18787/19443).
 */
test.describe("agent computer", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("clicks the canvas toolbar by position, refuses a point outside the viewport, and shows the crop under ask", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("nativeMessaging");

    // Deliberately a fixture the agent never visits: every assertion below reads the canvas page,
    // so the owner's own tab must never be sitting on it.
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

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });

      const created = (await call("tabs_create", { url: `${SITE}/canvas` })) as { tabId: number };
      const tabId = created.tabId;
      const canvasPage = await agentPage(extensionContext, `${SITE}/canvas`);
      await setSiteMode(panel, SITE, "skip-checks");

      // ================= 1. a position click changes the fixture's own state =================
      const before = await canvasPage.locator("body").getAttribute("data-active-tool");
      expect(before).toBe("none");
      const drawPoint = await centreOf(canvasPage, "#tool-draw");
      const clicked = await call("computer", { tabId, action: "left_click", x: drawPoint.x, y: drawPoint.y });
      expect(clicked).toMatchObject({ observed: { effect: "activated" } });
      // The fixture's own state, not the tool's verdict word: only a click that actually landed on
      // the toolbar button sets it.
      await expect(canvasPage.locator("body")).toHaveAttribute("data-active-tool", "draw");
      await expect(canvasPage.locator("#active-tool")).toHaveText("draw");

      // ================= 2. a point outside the viewport is refused, naming it =================
      const viewport = await canvasPage.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      }));
      const outside = await live.callTool("computer", {
        tabId,
        action: "left_click",
        // Within the schema's own coordinate ceiling (50,000) but far past any real viewport.
        x: 40_000,
        y: 40_000,
      });
      expect(outside.isError, `mcp-server stderr:\n${live.stderr()}`).toBe(true);
      expect(outside.json).toMatchObject({ outcome: "failed", reason: "outside-viewport" });
      const refusal = (outside.json as { refusal?: { reason?: string; width?: number; height?: number } }).refusal;
      expect(refusal?.reason).toBe("outside-viewport");
      // The refusal names the real viewport: close to the page's own measurement (a scrollbar can
      // move the two by a pixel depending on which is measured first), never a placeholder value.
      expect(Math.abs((refusal?.width ?? 0) - viewport.width)).toBeLessThanOrEqual(2);
      expect(Math.abs((refusal?.height ?? 0) - viewport.height)).toBeLessThanOrEqual(2);
      // Refused, not merely reported: the toolbar state from claim 1 is untouched.
      await expect(canvasPage.locator("body")).toHaveAttribute("data-active-tool", "draw");

      // ================= 3. under ask, the prompt shows the crop of where it would land =================
      await setSiteMode(panel, SITE, "ask");
      const erasePoint = await centreOf(canvasPage, "#tool-erase");
      const asked = client.callTool("computer", { tabId, action: "left_click", x: erasePoint.x, y: erasePoint.y });

      await panel.waitForText(ui("agent.promptTitle"));
      const cropAlt = ui("agent.promptCropAlt");
      const cropShown = await panel.evaluatePanel(
        `(()=>{const img=[...document.querySelectorAll('img')].find((el)=>el.alt===${JSON.stringify(cropAlt)});` +
          `return !!img && typeof img.src === 'string' && img.src.startsWith('data:image/png;base64,') && img.src.length > 100})()`,
      );
      expect(cropShown, "no position crop image in the ask prompt").toBe(true);

      // The claim is what the owner is shown, not what they decide; deny it and confirm nothing
      // ran, the same way every other ask-mode effect in this suite is closed out.
      await panel.clickButton(ui("agent.refuse"));
      const denied = await asked;
      expect(denied.isError).toBe(true);
      expect(denied.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      await expect(canvasPage.locator("body")).toHaveAttribute("data-active-tool", "draw");

      await call("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });
});

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
function callerFor(
  client: () => McpHarnessClient | undefined,
): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (tool, args) => {
    const live = client();
    if (!live) throw new Error("mcp-client-missing");
    const result = await live.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
    return result.json;
  };
}

/** The viewport centre of one element, as the coordinate an agent would point at. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `no box for ${selector}`).toBeTruthy();
  if (!box) throw new Error(`no-box:${selector}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(
  context: { pages: () => Page[] },
  url: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

/**
 * Sets one site's mode through the panel's own control (FR-042), never by writing storage: the
 * claim is that the owner can decide from what they are shown, and poking the store behind the
 * panel would prove only that the store works.
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
  // The worker answers with a fresh projection; waiting for it is what makes the next call's mode
  // the one just chosen rather than a race with it.
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
