import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const FIXTURE = `${SITE}/viewport`;

/**
 * 012/T317 — US1 and US2 on the packaged extension (FR-156..FR-166, SC-085..SC-089).
 *
 * Every claim of this feature is about what a *real* browser does, and three of them contradict
 * what the protocol documentation suggests (R-166): `captureVisibleTab` photographs the window
 * rather than an emulated viewport, a crop asked for in CSS pixels lands 25 % off on a dense
 * display unless the density is divided out, and an emulation outlives the debugger detach that
 * was supposed to end it. A unit test can only prove that the worker decided what we told it to
 * decide; only this file proves the browser agreed.
 *
 * The five journeys are the quickstart's five steps, in its order: the phone width and the owner's
 * untouched window; the wide viewport, its picture and a click that can only land at that width;
 * the four ways the page gets its own size back; the worker that was killed in the middle; and the
 * picture's density, its scale and the region the frame does not contain.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install
 * of the native-messaging host, which a browser the runner launched is not registered against.
 */
test.describe("agent viewport", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started against the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("sets a phone-sized viewport on a tab and leaves the owner's window alone", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      const windowId = await windowOfTab(extensionWorker, tabId);
      const before = await windowNow(extensionWorker, windowId);
      const real = await pageSize(page);
      expect(real.width, "the fixture must start at the window's own width").toBeGreaterThan(400);

      const answer = (await call("viewport", { tabId, action: "set", width: 375, height: 812 })) as {
        width: number;
        height: number;
        emulated: boolean;
      };
      expect(answer).toEqual({ width: 375, height: 812, emulated: true });

      // The page, asked itself: the answer above is the worker's claim, this is the browser's.
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 375, height: 812 });
      // And the layout followed the size, which is the whole point of asking for one (SC-085).
      expect(await layoutFacts(page)).toEqual({ bar: "rgb(220, 0, 0)", menuShown: true, wideShown: false });

      // The owner's window is exactly where it was: no bound moved, no state changed (FR-157).
      expect(await windowNow(extensionWorker, windowId)).toEqual(before);

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("photographs the whole emulated viewport, and a click lands on what only that width lays out", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);

      await call("viewport", { tabId, action: "set", width: 2560, height: 1440 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 2560, height: 1440 });
      expect(await layoutFacts(page)).toEqual({ bar: "rgb(0, 140, 0)", menuShown: false, wideShown: true });

      // ============= the picture is of the emulated viewport, not of the window (R-166) =============
      const shot = await client.callTool("screenshot", { tabId });
      if (shot.isError) {
        // A 2 560x1 440 picture can exceed the frame bound, and the refusal is then obliged to name
        // the scale that would fit rather than merely saying no (FR-162).
        const reason = String((shot.json as { reason?: string } | undefined)?.reason ?? shot.text);
        expect(reason, `stderr:\n${client.stderr()}`).toContain("screenshot-too-large; retry with scale ≤ ");
        const named = Number(/scale ≤ ([0-9.]+)/.exec(reason)?.[1]);
        expect(named, `no scale named in: ${reason}`).toBeGreaterThan(0);

        const retried = await client.callTool("screenshot", { tabId, scale: named });
        expect(retried.isError, `the named scale was refused too: ${retried.text}`).toBe(false);
        expect(retried.images).toHaveLength(1);
        const answer = retried.json as { scale: number; frame: { width: number; height: number }; coverage: string };
        expect(answer.scale).toBe(named);
        expect(answer.frame).toEqual({ width: 2560, height: 1440 });
        expect(answer.coverage).toBe("viewport");
        const size = pngSize(retried.images[0]!.data);
        expect(Math.abs(size.width - Math.round(2560 * named)), `picture ${size.width}x${size.height}`).toBeLessThanOrEqual(2);
        expect(Math.abs(size.height - Math.round(1440 * named))).toBeLessThanOrEqual(2);
      } else {
        expect(shot.images).toHaveLength(1);
        const answer = shot.json as { frame: { width: number; height: number }; coverage: string };
        expect(answer.frame).toEqual({ width: 2560, height: 1440 });
        expect(answer.coverage).toBe("viewport");
        expect(pngSize(shot.images[0]!.data)).toEqual({ width: 2560, height: 1440 });
      }

      // ============= an element that exists only at this width can be clicked (SC-088) =============
      // The site's mode is the owner's decision, taken through the panel's own control: the claim
      // here is about the coordinate frame a click is delivered in, not about consent.
      await setSiteModeViaPanel(panel, SITE, "skip-checks");
      const found = (await call("find", { tabId, query: "Wide only" })) as {
        outcome: string;
        matches: Array<{ ref: string }>;
      };
      expect(found.outcome, JSON.stringify(found)).toBe("resolved");
      await call("click", { tabId, target: { ref: found.matches[0]?.ref } });
      await expect
        .poll(() => page.evaluate(() => document.getElementById("wide-only")?.dataset.clicked ?? null), {
          timeout: 15_000,
        })
        .toBe("1");

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("gives the page its real size back on reset, release, the owner's take-back and the session's end", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let tabId = 0;
    try {
      tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      const real = await pageSize(page);

      // ---- 1/4: the explicit reset, which answers the real size rather than the asked-for one ----
      await call("viewport", { tabId, action: "set", width: 375, height: 812 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 375 });
      const reset = (await call("viewport", { tabId, action: "reset" })) as { width: number; emulated: boolean };
      expect(reset.emulated).toBe(false);
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: real.width, height: real.height });

      // ---- 2/4: the tab handed back by the agent ----
      await call("viewport", { tabId, action: "set", width: 375, height: 812 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 375 });
      await call("tabs_release", { tabId });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: real.width, height: real.height });

      // ---- 3/4: the owner taking their tabs back from the card ----
      await call("tabs_claim", { tabId });
      await call("viewport", { tabId, action: "set", width: 375, height: 812 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 375 });
      await releaseTabsViaPanel(panel);
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: real.width, height: real.height });

      // ---- 4/4: the session simply ending, which is how most of them end ----
      await call("tabs_claim", { tabId });
      await call("viewport", { tabId, action: "set", width: 375, height: 812 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 375 });
      await live.close();
      live = undefined;
      await expect.poll(() => pageSize(page), { timeout: 30_000 }).toMatchObject({ width: real.width, height: real.height });
    } finally {
      await live?.close();
      live = undefined;
      if (tabId) await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    }
  });

  test("keeps the emulation across a worker restart, and a second set is idempotent", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);

      await call("viewport", { tabId, action: "set", width: 800, height: 600 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 800, height: 600 });

      // ============= the worker goes, exactly as `agent-panel-multi` kills it =============
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
      // honesty, not the emulation's.
      await expect
        .poll(async () => (await live!.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);

      // What the browser did with the emulation while the worker was gone differs by build: Chromium
      // 151 keeps it, branded Chrome 153 drops it with the attachment (gate runs of 2026-09-22,
      // R-176). Neither is the product's promise. The promise (FR-160, SC-087) is that the record
      // outlived the worker and the *first call that needs the attachment* puts the emulation back -
      // a screenshot under a record is such a call (S2c F2) - so that is what is asserted.
      const afterRestart = await pageSize(page);
      console.log(`[T317] page after the worker restart: ${afterRestart.width}x${afterRestart.height}`);
      const shot = await live!.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      expect((shot.json as { frame: { width: number; height: number } }).frame).toEqual({ width: 800, height: 600 });
      await expect.poll(() => pageSize(page), { timeout: 15_000 }).toMatchObject({ width: 800, height: 600 });
      const again = (await call("viewport", { tabId, action: "set", width: 800, height: 600 })) as {
        emulated: boolean;
      };
      expect(again).toEqual({ width: 800, height: 600, emulated: true });
      expect(await pageSize(page)).toMatchObject({ width: 800, height: 600 });

      await call("viewport", { tabId, action: "reset" });
      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("crops at the picture's own density, scales it, and refuses a region outside the frame", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);

      // ============= a denser display than CSS, forced by the harness's own CDP =============
      // The runner cannot choose the machine's display density, so it emulates one: this is the
      // harness speaking to the page directly, not the agent - nothing of the extension knows about
      // it, which is what makes the next assertions a test of the *crop* rather than of the setup.
      const cdp = await extensionContext.newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1200,
        height: 800,
        deviceScaleFactor: 2,
        mobile: false,
      });

      // ---- the visible-tab path: the crop is region x the picture's own density (FR-163) ----
      const whole = await client.callTool("screenshot", { tabId });
      expect(whole.isError, whole.text).toBe(false);
      const wholeAnswer = whole.json as { width: number; height: number; frame: { width: number; height: number } };
      const density = wholeAnswer.width / wholeAnswer.frame.width;
      // Asserted as the relation rather than as one machine's numbers: on the DPR-2 display this
      // step is named for, region 300x100 comes back 600x200, and on any other density it comes
      // back at that density - what must never happen again is a crop taken in image pixels, which
      // is this same rectangle cut 25 % small on a 1.25 display (R-166 finding 2).
      console.log(`[T317] picture ${wholeAnswer.width}x${wholeAnswer.height} of frame ${wholeAnswer.frame.width}x${wholeAnswer.frame.height} - density ${density}`);
      const nativeRegion = await client.callTool("screenshot", {
        tabId,
        region: { x: 100, y: 200, width: 300, height: 100 },
      });
      expect(nativeRegion.isError, nativeRegion.text).toBe(false);
      expect(pngSize(nativeRegion.images[0]!.data)).toEqual({
        width: Math.round(300 * density),
        height: Math.round(100 * density),
      });

      // ---- the protocol path: an emulated viewport is DPR 1, so a region is its own size ----
      // The tool always emulates at deviceScaleFactor 1, so the agent's `set` replaces the density
      // the harness forced above; the picture is then exactly what the agent asked to see.
      await call("viewport", { tabId, action: "set", width: 1200, height: 800 });
      // `dpr` is 1.0000000149 under a deviceScaleFactor override (gate run 1), so it is compared by rounding.
      await expect.poll(async () => { const s = await pageSize(page); return { ...s, dpr: Math.round(s.dpr * 1000) / 1000 }; }, { timeout: 15_000 }).toMatchObject({ width: 1200, height: 800, dpr: 1 });

      const region = await client.callTool("screenshot", { tabId, region: { x: 100, y: 200, width: 300, height: 100 } });
      expect(region.isError, region.text).toBe(false);
      expect(pngSize(region.images[0]!.data)).toEqual({ width: 300, height: 100 });
      expect(region.json).toMatchObject({
        coverage: "region",
        frame: { width: 1200, height: 800 },
        region: { x: 100, y: 200, width: 300, height: 100 },
      });

      const half = await client.callTool("screenshot", {
        tabId,
        region: { x: 100, y: 200, width: 300, height: 100 },
        scale: 0.5,
      });
      expect(half.isError, half.text).toBe(false);
      expect(pngSize(half.images[0]!.data)).toEqual({ width: 150, height: 50 });
      expect(half.json).toMatchObject({ scale: 0.5 });

      // ---- a region the frame does not contain is refused, and the frame is named (FR-164) ----
      const outside = await client.callTool("screenshot", {
        tabId,
        region: { x: 1100, y: 700, width: 300, height: 200 },
      });
      expect(outside.isError, outside.text).toBe(true);
      expect(String((outside.json as { reason?: string } | undefined)?.reason ?? outside.text)).toContain(
        "region-outside-viewport (frame ",
      );

      await call("viewport", { tabId, action: "reset" });
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await cdp.detach();
      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });
});

/** The fixture tab as a page handle, which is the one reader a terminated worker cannot take away. */
async function fixturePage(context: BrowserContext): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = context.pages().find((page) => page.url().startsWith(FIXTURE));
        return found !== undefined;
      },
      { timeout: 30_000, intervals: [200] },
    )
    .toBe(true);
  if (!found) throw new Error("fixture-tab-missing");
  return found;
}

/** What the page says it is: the three numbers the fixture reports about its own viewport. */
async function pageSize(page: Page): Promise<{ width: number; height: number; dpr: number }> {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
}

/** Which layout the breakpoint chose, read off the rendered page rather than off the stylesheet. */
async function layoutFacts(page: Page): Promise<{ bar: string; menuShown: boolean; wideShown: boolean }> {
  return page.evaluate(() => {
    const shown = (id: string): boolean => {
      const node = document.getElementById(id);
      return node !== null && getComputedStyle(node).display !== "none";
    };
    const bar = document.getElementById("bar");
    return {
      bar: bar ? getComputedStyle(bar).backgroundColor : "",
      menuShown: shown("menu"),
      wideShown: shown("wide-only"),
    };
  });
}

/** The image's own pixels, from the PNG header: IHDR carries width and height at bytes 16 to 23. */
function pngSize(base64: string): { width: number; height: number } {
  const header = Buffer.from(base64.slice(0, 44), "base64");
  expect(header.length, "a PNG header is 24 bytes").toBeGreaterThanOrEqual(24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** The window the tab sits in - the thing `viewport` must *not* touch (FR-157). */
async function windowOfTab(worker: PackagedWorker, tabId: number): Promise<number> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).windowId, tabId);
}

/** The window as the browser has it now, read through the browser rather than the worker's memory. */
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
 * The owner taking their tabs back from the session card (the fourth release path, SC-086).
 *
 * The same control `agent-panel-states.spec.ts` presses, found on the one card a single-session
 * journey has: the claim is that the *owner's* decision clears the emulation, so it is taken
 * through what the owner is actually shown.
 */
async function releaseTabsViaPanel(panel: SidePanelDriver): Promise<void> {
  // 016 FR-234: "Take back tabs (N)", shown only once the card's projection holds a tab - so it is
  // matched on the template around the count and waited for rather than read once.
  const [before, after] = ui("agent.session.takeBack").split("{n}") as [string, string];
  const press = (): Promise<unknown> =>
    panel.evaluatePanel(
      `(()=>{const card=document.querySelector('[data-session-id]');` +
        `const b=card&&[...card.querySelectorAll('button')].find((x)=>{const t=x.textContent?.trim()??'';` +
        `return t.startsWith(${JSON.stringify(before)})&&t.endsWith(${JSON.stringify(after)})});` +
        `if(!b)return false;b.click();return true})()`,
      true,
    );
  await expect.poll(press, { timeout: 15_000, message: "no take-back control on the session card" }).toBe(true);
}

/** One site's mode through the panel's own control (the helper the sibling journeys carry). */
async function setSiteModeViaPanel(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const sel=document.querySelector('[data-site=${JSON.stringify(site)}] select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`), {
      timeout: 15_000,
    })
    .toBe(mode);
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
  ).toContain("debugger");

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

  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}
