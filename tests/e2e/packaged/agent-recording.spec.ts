import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { decodeGif, nonBackgroundPixelsIn, sampleColorAt, type DecodedGif } from "@hallpass/test-kit";
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
 * 008/T223 — US1 and US2 end to end: a session records itself and writes a GIF (FR-100..FR-109).
 *
 * The unit tests prove the recorder's arithmetic and the offscreen document's drawing. This is the
 * only place where a frame is a real screenshot of a real page, the file is written by the browser's
 * own download facility, and the bytes are read back off the disk and decoded. Four claims that only
 * a real browser can settle:
 *
 *  - the frame count is exactly what the actions produced, with a batch's steps counting one each
 *    (R-132) and the initial frame at index 0;
 *  - the overlays are *on the picture*: a label box, a ring where the click actually landed at the
 *    canvas ÷ viewport scale (R-136 - a device-pixel-ratio scale would put it elsewhere), and the
 *    watermark bottom-left;
 *  - the frames survive the worker being terminated mid-recording (FR-103, measured 2026-09-19);
 *  - the cap holds at 200 and every later answer says so (FR-102).
 *
 * Attach mode only, exactly like every other agent journey: the bridge starts with a machine
 * install of the native-messaging host, which a browser the runner launched is not registered
 * against - there is no `gif_recorder` to call without it.
 */

/** The panel's accent, as `offscreen/overlay.ts` draws the ring with. */
const ACCENT: [number, number, number] = [0x1f, 0x6f, 0x78];

/** How far from the scaled point the ring may be and still be the ring for that click. */
const RING_TOLERANCE_PX = 3;

type DownloadRecord = { id: number; filename: string; state: string; attribution: string };

type RecordingAnswer = { state: string; frames: number; skipped: number; full: boolean; alreadyRecording?: boolean };

type ExportAnswer = {
  filename: string;
  frames: number;
  skipped: number;
  width: number;
  height: number;
  bytes: number;
  downloadId: number;
};

test.describe("agent recording", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started against the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  /**
   * Measurement (2026-09-19, T237): two S9 probe runs answered `type` with verdict `focus-lost` and
   * 0 characters while a recording was open, and S7 (no recording) typed 12 characters verified on the
   * same page. FR-101 says a recording never changes what an action does, so the gate now types with
   * a recording open and reads the value back, then does the same after `clear`.
   */
  test("typing lands the same with a recording open as without one", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { client, call, panel } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId, filter: "interactive" });

      await call("gif_recorder", { action: "start" });
      const nickname = await refFor(call, tabId, "Nickname");
      const typed = (await call("type", { tabId, target: { ref: nickname }, text: "while recording" })) as {
        observed: { verdict: string; charactersChanged?: number };
      };
      const after = (await call("find", { tabId, query: "Nickname" })) as { matches: Array<{ value?: string }> };
      console.log(`[T237] type while recording: verdict=${typed.observed.verdict} chars=${typed.observed.charactersChanged} value=${JSON.stringify(after.matches[0]?.value)}`);

      await call("gif_recorder", { action: "clear" });
      const password = await refFor(call, tabId, "Password");
      const typed2 = (await call("type", { tabId, target: { ref: password }, text: "after clear" })) as {
        observed: { verdict: string; charactersChanged?: number };
      };
      console.log(`[T237] type after clear: verdict=${typed2.observed.verdict} chars=${typed2.observed.charactersChanged}`);

      expect(after.matches[0]?.value, "the text typed while recording must be in the field").toBe("while recording");
      expect(typed.observed.verdict).not.toBe("focus-lost");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  /**
   * 014/T385 — the size a session gave a page is on the film too (FR-196).
   *
   * 012 added `viewport` and left it out of the recorded list, which shows up as a page that
   * narrows between two frames with nothing saying why. The frame count is the claim; what the
   * frame *says* (`viewport 480x640`, `viewport cleared`) is the label's own unit test, because
   * reading 40 characters of drawn text back out of a GIF proves less than it costs.
   */
  test("adds a frame for the viewport a session set and for the one it cleared", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { client, call, panel } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");

      const started = (await call("gif_recorder", { action: "start" })) as RecordingAnswer;
      expect(started).toMatchObject({ state: "recording", frames: 1 });

      const set = (await call("viewport", { tabId, action: "set", width: 480, height: 640 })) as {
        emulated: boolean;
        recording?: RecordingAnswer;
      };
      expect(set.emulated).toBe(true);
      expect(set.recording).toMatchObject({ state: "recording", frames: 2, skipped: 0 });

      const cleared = (await call("viewport", { tabId, action: "reset" })) as {
        emulated: boolean;
        recording?: RecordingAnswer;
      };
      expect(cleared.emulated).toBe(false);
      expect(cleared.recording).toMatchObject({ state: "recording", frames: 3, skipped: 0 });

      await call("gif_recorder", { action: "clear" });
      await call("tabs_close", { tabId });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("records a session, draws what it did, and writes the GIF the agent named", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");

      // ============= 0. start: the page as it was, before anything happened =============
      const started = (await call("gif_recorder", { action: "start" })) as RecordingAnswer;
      expect(started).toMatchObject({ state: "recording", frames: 1, skipped: 0, full: false });

      // A read first, so the labels know what the controls are (FR-106 is evaluated on what the
      // page said about each ref).
      await call("read_page", { tabId, filter: "interactive" });
      const safe = await refFor(call, tabId, "Safe action");
      const nickname = await refFor(call, tabId, "Nickname");
      const password = await refFor(call, tabId, "Password");

      // ============= 1. ten calls and one three-step batch: thirteen frames =============
      const perAction: number[] = [];
      const timed = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const at = Date.now();
        const answer = await call(tool, args);
        perAction.push(Date.now() - at);
        return answer;
      };

      const clicked = (await timed("click", { tabId, target: { ref: safe } })) as {
        recording?: RecordingAnswer;
      };
      // FR-101/FR-102 ride back on the action's own answer, so an agent never has to ask.
      expect(clicked.recording).toMatchObject({ state: "recording", frames: 2, full: false });

      await timed("type", { tabId, target: { ref: nickname }, text: "recorded run" });
      // FR-106: what goes into a password field is `••••` on the frame, never the characters.
      await timed("type", { tabId, target: { ref: password }, text: "not-in-the-gif" });
      await timed("key", { tabId, key: "Tab" });
      await timed("scroll", { tabId, direction: "down", amount: "small" });
      await timed("hover", { tabId, target: { ref: safe } });
      await timed("screenshot", { tabId });
      await timed("scroll", { tabId, direction: "up", amount: "small" });
      await timed("click", { tabId, target: { ref: safe } });
      await timed("key", { tabId, key: "Tab" });

      const batched = (await timed("browser_batch", {
        tabId,
        steps: [
          { tool: "key", args: { key: "Tab" } },
          { tool: "key", args: { key: "Tab" } },
          { tool: "click", args: { target: { ref: safe } } },
        ],
      })) as { results: Array<{ outcome: string }> };
      expect(batched.results.map((step) => step.outcome)).toEqual(["ok", "ok", "ok"]);

      const standing = (await call("gif_recorder", { action: "start" })) as RecordingAnswer;
      // A second start is the state the agent already wanted, not a refusal (FR-100).
      expect(standing).toMatchObject({ alreadyRecording: true, frames: 14 });
      expect(standing.skipped, `${standing.skipped} frames could not be captured`).toBe(0);

      // ============= 2. a name the grammar refuses never reaches the browser =============
      const refused = await live.callTool("gif_recorder", { action: "export", filename: "../x" });
      expect(refused.isError, refused.text).toBe(true);
      expect(refused.text).toMatch(/invalid/i);

      // ============= 3. export: the browser writes the file =============
      const geometry = await pageGeometry(extensionContext, `${SITE}/form`);
      const exportedAt = Date.now();
      const exported = (await call("gif_recorder", { action: "export", filename: "TC-1234" })) as ExportAnswer;
      const exportMs = Date.now() - exportedAt;
      expect(exported).toMatchObject({ frames: 14, skipped: 0 });
      // The name the agent asked for, as the browser wrote it: a download folder that already holds
      // `TC-1234.gif` from an earlier run gets `TC-1234 (1).gif` (FR-107's `uniquify`, and what the
      // S9 probe met), and the answer names the file that exists rather than the one requested.
      expect(exported.filename).toMatch(/^TC-1234( \(\d+\))?\.gif$/);
      expect(exported.bytes).toBeGreaterThan(0);
      expect(exported.width).toBeGreaterThan(0);
      expect(exported.height).toBeGreaterThan(0);

      // ============= 4. the file is this session's download, complete =============
      const listed = (await call("downloads_context")) as { downloads: DownloadRecord[] };
      const record = listed.downloads.find((entry) => entry.id === exported.downloadId);
      expect(record, `download ${exported.downloadId} is not in the session's list`).toBeTruthy();
      expect(record).toMatchObject({ state: "complete", attribution: "session" });
      // The saved *name* is the browser's to decide, and since 2cc72f6 the answer reports the one
      // that exists rather than the one asked for (FR-107). That is only the same string here
      // because `pairedSession` gave the browser its own download behaviour back: left as
      // Playwright found it, every download of an attached browser is renamed to a GUID in its
      // artifacts directory (measured 2026-09-13 in `agent-downloads`, and again 2026-09-19 here).
      const gif = decodeGif(new Uint8Array(readFileSync(record!.filename)));

      // eslint-disable-next-line no-console -- the numbers this gate exists to measure.
      console.log(
        `[T223] 14 frames: ${exported.bytes} bytes, export ${exportMs} ms, ` +
          `per recorded action ${Math.round(perAction.reduce((sum, ms) => sum + ms, 0) / perAction.length)} ms ` +
          `(${perAction.join("/")}), canvas ${gif.width}x${gif.height}`,
      );

      // ============= 5. what is in the file =============
      expect(gif.frames).toHaveLength(14);
      expect(gif.frames.map((frame) => frame.delayMs)).toEqual([...Array(13).fill(800), 2800]);
      expect(gif.width).toBeGreaterThan(0);
      expect(gif.height).toBeGreaterThan(0);
      // Forever, as FR-104 asks.
      expect(gif.loopCount).toBe(0);

      // A label box on two frames well apart; the initial frame carries none.
      for (const index of [5, 12]) {
        expect(labelPixels(gif, index), `frame ${index} carries no label box`).toBeGreaterThan(200);
      }

      // The ring, where the click actually landed. The scale is the canvas over the *viewport*
      // (R-136): with `devicePixelRatio` in its place this assertion is the one that goes red.
      const scale = gif.width / geometry.viewportWidth;
      const ring = ringNear(gif, 1, geometry.safeButton, scale);
      expect(
        ring,
        `no accent ring within ${RING_TOLERANCE_PX} px of the click at ${JSON.stringify(geometry.safeButton)} ` +
          `scaled by ${scale}`,
      ).toBe(true);

      // The watermark, bottom-left of every frame.
      const watermark = nonBackgroundPixelsIn(gif.frames[0]!, gif.width, {
        x: 0,
        y: gif.height - 48,
        width: 260,
        height: 48,
      });
      expect(watermark, "no watermark box bottom-left of the initial frame").toBeGreaterThan(200);

      // ============= 6. the card says what it wrote (FR-108, FR-109) =============
      // The card names the file that exists, which is the one the answer named (uniquified or not).
      await panel.waitForText(ui("agent.session.recordingExported").replace("{filename}", exported.filename), 15_000);

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("keeps every frame the offscreen document already had when the worker was killed", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("gif_recorder", { action: "start" });

      // Six frames in (the initial one plus five actions), then the worker goes.
      for (let action = 0; action < 5; action += 1) {
        await call("key", { tabId, key: "Tab" });
      }
      expect(((await call("gif_recorder", { action: "start" })) as RecordingAnswer).frames).toBe(6);

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
      // honesty, not the recording's (see `agent-panel-multi`).
      await expect
        .poll(async () => (await live!.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);

      // The state came back out of `chrome.storage.session`, and the frames never left the document.
      expect(((await call("gif_recorder", { action: "start" })) as RecordingAnswer).frames).toBe(6);
      for (let action = 0; action < 4; action += 1) {
        await call("key", { tabId, key: "Tab" });
      }

      const exported = (await call("gif_recorder", { action: "export" })) as ExportAnswer;
      expect(exported.frames).toBe(10);
      expect(exported.filename).toMatch(/^agent-recording-\d{8}-\d{6}( \(\d+\))?\.gif$/);
      const listed = (await call("downloads_context")) as { downloads: DownloadRecord[] };
      const record = listed.downloads.find((entry) => entry.id === exported.downloadId);
      expect(decodeGif(new Uint8Array(readFileSync(record!.filename))).frames).toHaveLength(10);

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  test("stops at two hundred frames and says so on every later answer", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(900_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("gif_recorder", { action: "start" });

      // 205 actions over the initial frame: the first 199 fill the recording, and the rest are
      // answered normally with `recording.full` on them (FR-102).
      const fullFlags: boolean[] = [];
      for (let action = 0; action < 205; action += 1) {
        const answer = (await call("key", { tabId, key: "Tab" })) as { recording?: RecordingAnswer };
        fullFlags.push(answer.recording?.full === true);
      }

      expect(fullFlags.slice(198).every((full) => full)).toBe(true);
      const state = (await call("gif_recorder", { action: "stop" })) as RecordingAnswer;
      expect(state).toMatchObject({ state: "stopped", frames: 200, full: true });

      const capExportAt = Date.now();
      const exported = (await call("gif_recorder", { action: "export", filename: "TC-cap" })) as ExportAnswer;
      console.log(`[T223] 200-frame export ${Date.now() - capExportAt} ms, ${exported.bytes} bytes`);
      expect(exported.frames).toBe(200);
      const listed = (await call("downloads_context")) as { downloads: DownloadRecord[] };
      const record = listed.downloads.find((entry) => entry.id === exported.downloadId);
      expect(decodeGif(new Uint8Array(readFileSync(record!.filename))).frames).toHaveLength(200);

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  /**
   * FR-100's `download-failed`: the frames are the expensive part of a recording, so a file the
   * browser would not write must leave them where they are and let the agent ask again.
   *
   * The browser is told to refuse downloads for the length of one export (`Browser.setDownloadBehavior
   * "deny"`) - the only honest way found to make a real browser refuse a blob URL it minted itself,
   * and the same lever this file uses to undo Playwright's renaming. The unit test covers the
   * bookkeeping (`recorder.test.ts`); this covers a browser actually saying no.
   */
  test("keeps the frames when the browser refuses the file", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    const cdp = await extensionContext.newCDPSession(ownerPage);
    try {
      const tabId = ((await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("gif_recorder", { action: "start" });
      for (let action = 0; action < 3; action += 1) {
        await call("key", { tabId, key: "Tab" });
      }

      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
      const refused = await live.callTool("gif_recorder", { action: "export", filename: "TC-refused" });
      expect(refused.isError, refused.text).toBe(true);
      expect(refused.text).toMatch(/download-failed/i);

      // Nothing was lost: the recording is exactly what it was, and the next export writes it.
      expect(((await call("gif_recorder", { action: "start" })) as RecordingAnswer).frames).toBe(4);
      await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
      const exported = (await call("gif_recorder", { action: "export", filename: "TC-retry" })) as ExportAnswer;
      expect(exported.frames).toBe(4);
      expect(exported.filename).toMatch(/^TC-retry( \(\d+\))?\.gif$/);

      await call("tabs_close", { tabId });
    } finally {
      await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      await live?.close();
      live = undefined;
    }
  });
});

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
  ).toContain("offscreen");

  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await letTheBrowserNameTheFile(extensionContext, ownerPage);
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
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

/**
 * Puts the browser back on its own download behaviour for this run.
 *
 * Playwright names every download of a browser it attached to itself and drops it in its artifacts
 * directory under a GUID (`Browser.setDownloadBehavior` "allowAndName"). FR-107 is about the file a
 * tester finds in their download folder under the name the agent asked for, so the journey asks the
 * browser to behave as the owner's does - otherwise this gate can only prove that *some* file was
 * written, which is what it was reduced to when the recorder started reporting the saved name.
 */
async function letTheBrowserNameTheFile(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await cdp.detach();
}

/** The page's own geometry, for the scale the overlays were drawn at and the point of the click. */
async function pageGeometry(
  context: BrowserContext,
  url: string,
): Promise<{ viewportWidth: number; safeButton: { x: number; y: number } }> {
  const page = context.pages().find((candidate) => candidate.url().startsWith(url));
  expect(page, `no page open at ${url}`).toBeTruthy();
  return page!.evaluate(() => {
    const button = document.querySelector("#safe-button");
    const box = button?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      safeButton: {
        x: (box?.left ?? 0) + (box?.width ?? 0) / 2,
        y: (box?.top ?? 0) + (box?.height ?? 0) / 2,
      },
    };
  });
}

/** How much of the top-left quarter of a frame is drawn on: the label box lives there or by the point. */
function labelPixels(gif: DecodedGif, index: number): number {
  const frame = gif.frames[index];
  expect(frame, `frame ${index} is missing`).toBeTruthy();
  return nonBackgroundPixelsIn(frame!, gif.width, {
    x: 0,
    y: 0,
    width: Math.floor(gif.width / 2),
    height: Math.floor(gif.height / 2),
  });
}

/** Whether the accent ring is drawn within tolerance of the scaled point. */
function ringNear(
  gif: DecodedGif,
  index: number,
  point: { x: number; y: number },
  scale: number,
): boolean {
  const frame = gif.frames[index];
  if (!frame) return false;
  const centreX = Math.round(point.x * scale);
  const centreY = Math.round(point.y * scale);
  // The ring is drawn at radius 11·s around the point; a sweep of the ring's own band, within the
  // tolerance, is what "the ring is at the click" means in pixels.
  const radius = 11 * scale;
  for (let angle = 0; angle < 360; angle += 5) {
    for (let drift = -RING_TOLERANCE_PX; drift <= RING_TOLERANCE_PX; drift += 1) {
      const at = radius + drift;
      const x = Math.round(centreX + at * Math.cos((angle * Math.PI) / 180));
      const y = Math.round(centreY + at * Math.sin((angle * Math.PI) / 180));
      const [red, green, blue] = sampleColorAt(frame, gif.width, x, y);
      if (
        Math.abs(red - ACCENT[0]) <= 24 &&
        Math.abs(green - ACCENT[1]) <= 24 &&
        Math.abs(blue - ACCENT[2]) <= 24
      ) {
        return true;
      }
    }
  }
  return false;
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
