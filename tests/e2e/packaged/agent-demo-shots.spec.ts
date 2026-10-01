import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir, userInfo } from "node:os";
import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import {
  clickLabelled,
  copyFor,
  localeFromEnv,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/** The fixture page the owner's panel is opened beside; the agent itself works on a real site. */
const OWNER_SITE = "https://127.0.0.1:19443";
/**
 * A light real site: one search field, Enter submits. Wikipedia was the first choice, but there the
 * agent's reads went unanswered on most runs (2026-10-02, Chromium 151; see `searchBoxRef`).
 */
const SITE = "https://lite.duckduckgo.com";
const START = `${SITE}/lite/`;
const QUERY = "Grace Hopper";
/** The form posts, so the address stays put; the results page's title carries the query. */
const RESULTS_TITLE = QUERY;

/**
 * The README demo GIF, with the per-action consent card in view. Not a test of behaviour.
 *
 * The recording the product's own `gif_recorder` makes photographs the tab only, so the question the
 * owner is asked - the point of the product - never appears in it. So the recorder runs as usual
 * and its exported frames (watermark, step counter, action labels, drawn by the product) become the
 * page half, each paired with the real side panel photographed on its own CDP session, as
 * `agent-guide-shots.spec.ts` takes it. The recorder photographs after an action, never while a card
 * waits, so a card frame shows the page as it still is: the previous recorder frame. The pairs are
 * composed side by side into one GIF with ffmpeg.
 *
 * Never touch the agent tab through Playwright in attach mode: its screenshot hung past 7 min and the
 * next tool call went unanswered (measured 2026-10-02).
 *
 * Site mode for the real site is `ask`, so per `gate.ts` (`requiresGate`) the `type` and the `key`
 * each raise a card; `tabs_create`, the reads and an unforced `navigate`/`tabs_close` do not.
 *
 * Runs only when asked for (`HALLPASS_DEMO_SHOTS=1`), in attach mode. Writes under
 * `test-results/demo/`; copying the GIF into `docs/media/` is a reviewed, manual step.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);
const OUT = join(process.cwd(), "test-results", "demo");
const FRAMES = join(OUT, "frames");
const GIF_WIDTH = 1100;
/** Both halves are brought to this height before they are put side by side. */
const STACK_HEIGHT = 720;
const GIF_BUDGET_BYTES = 2 * 1024 * 1024;

/** `rec` is the index of the recorder's own frame shown as the page half. */
type Frame = { name: string; hold: number; rec: number };
const RECORDER = join(OUT, "recorder");
/** Frame 0 at `start`, then one per recorded action: `type`, `key` (agent-runtime `recordAfter`). */
const RECORDER_FRAMES = 3;

test.describe("README demo GIF", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT || !process.env.HALLPASS_DEMO_SHOTS,
    "the demo GIF is recorded on request only (HALLPASS_DEMO_SHOTS=1), in attach mode",
  );

  test("records an agent searching the web with the owner's consent cards beside the page", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    const frames: Frame[] = [];
    let tabId: number | undefined;

    const shoot = async (label: string, hold: number, rec: number): Promise<void> => {
      if (tabId === undefined) throw new Error("no agent tab to photograph");
      const name = `${String(frames.length).padStart(2, "0")}`;
      await showAndSettle(extensionWorker, tabId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await panel.sendToPanel("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Nothing naming this account is written, not even to test-results: fail before the picture.
      const visible = await panel.evaluatePanel(VISIBLE_TEXT);
      const leak = namesThisAccount(typeof visible === "string" ? visible : "");
      expect(
        leak,
        `frame ${name} (${label}): the panel shows ${JSON.stringify(leak)}; launch the browser with a neutral LOCALAPPDATA and retake`,
      ).toBeUndefined();
      const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
      const data = (shot.result as { data?: string } | undefined)?.data;
      expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
      await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] });
      writeFileSync(join(FRAMES, `${name}-panel.png`), Buffer.from(data ?? "", "base64"));
      // The page half is the recorder's frame `rec`, placed after the export (`pageHalves`).
      frames.push({ name, hold, rec });
      // eslint-disable-next-line no-console -- which frame is which, for the reviewer.
      console.log(`[demo] frame ${name} ${label} (${hold} s, recorder frame ${rec})`);
    };

    try {
      // 1. The agent opens the site. Tab tools never enter the gate; any card is answered anyway.
      const created = await answerCards(panel, client.callTool("tabs_create", { url: START }));
      expect(created.isError, `tabs_create failed: ${created.text}\nstderr:\n${client.stderr()}`).toBe(false);
      tabId = (created.json as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "ask");
      await showAndSettle(extensionWorker, tabId);
      // The product's recorder draws the watermark, the step counter and the action labels.
      await call("gif_recorder", { action: "start" });
      await shoot("opened", 1.5, 0);

      // 2. It types the query: an effect, so the owner is asked first. Nothing has happened to the
      //    page yet, so its half is still the recorder's opening frame.
      const box = await searchBoxRef(call, tabId);
      const typing = client.callTool("type", { tabId, target: { ref: box }, text: QUERY });
      await waitForQuestion(panel);
      await shoot("card: type", 2.5, 0);

      // 3. The owner allows it once.
      await panel.clickButton(ui("agent.allowOnce"));
      const typed = await typing;
      expect(typed.isError, `type failed: ${typed.text}\nstderr:\n${client.stderr()}`).toBe(false);
      await shoot("typed", 1.5, 1);

      // 4. It presses Enter: asked again.
      const pressing = client.callTool("key", { tabId, target: { ref: box }, key: "Enter" });
      await waitForQuestion(panel);
      await shoot("card: key", 2.5, 1);
      await panel.clickButton(ui("agent.allowOnce"));
      const pressed = await pressing;
      expect(pressed.isError, `key failed: ${pressed.text}\nstderr:\n${client.stderr()}`).toBe(false);

      // 5. The results are on screen; the panel shows the session and what it did.
      const openTab = tabId;
      await expect
        .poll(() => extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).title ?? "", openTab), {
          timeout: 30_000,
        })
        .toContain(RESULTS_TITLE);
      await showAndSettle(extensionWorker, tabId);
      await expect
        .poll(() => panel.evaluatePanel(`document.querySelector('section[data-session-state="waiting"]') === null`), {
          timeout: 15_000,
        })
        .toBe(true);
      // The recorder's `key` frame already shows the results (the form answers within its settle).
      await shoot("result", 3, 2);

      const exported = (await call("gif_recorder", { action: "export", filename: "hallpass-demo" })) as {
        downloadId: number;
        frames: number;
      };
      const listed = (await call("downloads_context")) as {
        downloads: Array<{ id: number; filename: string; state: string }>;
      };
      const record = listed.downloads.find((entry) => entry.id === exported.downloadId);
      expect(record?.state, `recorder download ${exported.downloadId}: ${JSON.stringify(listed)}`).toBe("complete");
      pageHalves(frames, record!.filename);

      await call("tabs_close", { tabId });
      tabId = undefined;
      // The explicit `ask` row was this run's own; forget it so the owner's site list is as it was.
      // Tidying only: the browser is a private one, so a label that moved must not cost the picture.
      await clickLabelled(panel, ui("agent.siteRevoke").replace("{site}", SITE)).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- the row stays; say so.
        console.log(`[demo] site row left in place: ${String(error)}`);
      });
    } finally {
      // Removed by the browser rather than by the agent: a forced close is itself a gated effect.
      if (tabId !== undefined) {
        await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }

    writeFileSync(join(OUT, "frames.json"), `${JSON.stringify(frames, null, 2)}\n`);
    composeGif(frames);
  });
});

/** One paired MCP session with the panel open beside the owner's tab. */
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
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${OWNER_SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });

  // The recorder's GIF goes through chrome.downloads to the profile's download folder (a CDP
  // download behaviour does not reach an extension's downloads - measured). Give the private profile
  // its own folder before launch, or the file lands in the account's Downloads; the run logs where.
  const cdp = await extensionContext.newCDPSession(ownerPage);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await cdp.detach();

  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);

  // The card is titled by the session's project folder (016): a neutral one, not this checkout's.
  const client = await startMcpClient({
    clientName: "Claude Code",
    roots: [{ uri: "file:///C:/work/my-app", name: "my-app" }],
  });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

/** Lets a call finish, answering "Allow once" to any question it raises on the way. */
async function answerCards(panel: SidePanelDriver, pending: Promise<ToolCallResult>): Promise<ToolCallResult> {
  let settled: ToolCallResult | undefined;
  let failure: unknown;
  let done = false;
  pending.then(
    (result) => {
      settled = result;
      done = true;
    },
    (error: unknown) => {
      failure = error;
      done = true;
    },
  );
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) {
    if ((await panel.panelText()).includes(ui("agent.promptTitle"))) {
      await panel.clickIfPresent(ui("agent.allowOnce"));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!done) throw new Error("call did not finish within 60 s");
  if (failure !== undefined) throw failure;
  return settled as ToolCallResult;
}

/** The question card is up and its session is shown waiting on the owner. */
async function waitForQuestion(panel: SidePanelDriver): Promise<void> {
  await panel.waitForText(ui("agent.promptTitle"), 20_000);
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector('section[data-session-state="waiting"]') !== null`), {
      timeout: 15_000,
    })
    .toBe(true);
}

/**
 * Brings the agent tab to the front and waits until it has loaded, through the worker only.
 * Measured: once Playwright touched the agent tab (bringToFront, waitForLoadState, screenshot), its
 * screenshot never answered and the next `find` timed out with `no-answer`; the sibling shot specs
 * never touch an agent tab through Playwright either.
 */
async function showAndSettle(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate((id: number) => chrome.tabs.update(id, { active: true }), tabId);
  await expect
    .poll(() => worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).status ?? "", tabId), {
      timeout: 30_000,
      message: `tab ${tabId} did not finish loading`,
    })
    .toBe("complete");
}

/**
 * The page's search field, from the interactive read.
 *
 * On Wikipedia (2026-10-02, Chromium 151) `find` answered `not-readable`, `page-not-responding` or
 * `no-answer`, and `read_page` answered once and then `no-answer`/`not-actionable`, while the
 * fixture-page reads gate passed on the same browser - a product follow-up, not something this
 * picture should depend on.
 */
async function searchBoxRef(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
): Promise<string> {
  const read = (await call("read_page", { tabId, filter: "interactive" })) as {
    nodes: Array<{ ref: string; role?: string; name?: string }>;
  };
  const fields = read.nodes.filter((node) => ["searchbox", "combobox", "textbox"].includes(node.role ?? ""));
  // eslint-disable-next-line no-console -- what the page offered, if the site changes its layout.
  console.log(`[demo] search fields: ${JSON.stringify(fields)}`);
  const field = fields.at(-1);
  expect(field?.ref, "the start page offered no search field").toBeTruthy();
  return field!.ref;
}

async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
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

/** The text of every text node with a box inside the panel's viewport: what the picture can show. */
const VISIBLE_TEXT =
  `(()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const out=[];let n;` +
  `while((n=w.nextNode())){const r=document.createRange();r.selectNodeContents(n);` +
  `for(const b of r.getClientRects()){if(b.width>0&&b.bottom>0&&b.top<innerHeight&&b.right>0&&b.left<innerWidth){out.push(n.textContent);break}}}` +
  `return out.join('\\n')})()`;

/**
 * The first needle `text` contains that names this machine's account: the home directory, the folder
 * holding the home directories, or the account name. Case-insensitive, both slash styles. A
 * LOCALAPPDATA under the home directory is caught by the first; a neutral one (a `subst` drive) may
 * show. As `agent-panel-shots.spec.ts` guards the pictures that reach `docs/media`.
 */
function namesThisAccount(text: string): string | undefined {
  const haystack = text.toLowerCase();
  const needles = [homedir(), `${dirname(homedir())}${sep}`, userInfo().username]
    .map((needle) => needle.trim().toLowerCase())
    .filter((needle) => needle.length > 1)
    .flatMap((needle) => [needle, needle.replaceAll("\\", "/")]);
  return needles.find((needle) => haystack.includes(needle));
}

/**
 * Splits the recorder's exported GIF into its frames and puts frame `rec` in as each frame's page
 * half. Needs ffmpeg; without it the run cannot make the picture and says so.
 */
function pageHalves(frames: readonly Frame[], recorderGif: string): void {
  const ffmpeg = process.env.HALLPASS_FFMPEG ?? "ffmpeg";
  mkdirSync(RECORDER, { recursive: true });
  copyFileSync(recorderGif, join(RECORDER, "recorder.gif"));
  // eslint-disable-next-line no-console -- the recorder's own file stays where the browser put it.
  console.log(`[demo] recorder GIF downloaded to ${recorderGif}`);
  run(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    join("recorder", "recorder.gif"),
    "-fps_mode",
    "passthrough",
    "-start_number",
    "0",
    join("recorder", "%02d.png"),
  ]);
  const split = readdirSync(RECORDER).filter((file) => /^\d{2}\.png$/.test(file)).length;
  expect(split, `the recorder's GIF has ${split} frames, the journey expects ${RECORDER_FRAMES}`).toBe(RECORDER_FRAMES);
  for (const frame of frames) {
    copyFileSync(join(RECORDER, `${String(frame.rec).padStart(2, "0")}.png`), join(FRAMES, `${frame.name}-page.png`));
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function run(ffmpeg: string, args: string[]): void {
  const result = spawnSync(ffmpeg, args, { cwd: OUT, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  }
}

/**
 * Page left, panel right, both at one height, scaled and padded to one fixed size so the concat
 * demuxer sees identical frames; then one palette for the whole GIF, each still kept for its hold.
 */
function composeGif(frames: readonly Frame[]): void {
  const ffmpeg = process.env.HALLPASS_FFMPEG ?? "ffmpeg";
  const probe = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    // eslint-disable-next-line no-console -- the frames are still there to compose by hand.
    console.log(`[demo] ffmpeg not runnable (${ffmpeg}); frames kept in ${FRAMES}, no GIF composed`);
    return;
  }
  const first = frames[0];
  if (!first) throw new Error("no frames to compose");

  const page = pngSize(join(FRAMES, `${first.name}-page.png`));
  const side = pngSize(join(FRAMES, `${first.name}-panel.png`));
  const stackedWidth = (page.width * STACK_HEIGHT) / page.height + (side.width * STACK_HEIGHT) / side.height;
  const height = 2 * Math.round((GIF_WIDTH * STACK_HEIGHT) / stackedWidth / 2);

  const list: string[] = [];
  for (const frame of frames) {
    const composite = `${frame.name}.png`;
    run(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-i",
      join("frames", `${frame.name}-page.png`),
      "-i",
      join("frames", `${frame.name}-panel.png`),
      "-filter_complex",
      `[0:v]scale=-2:${STACK_HEIGHT}:flags=lanczos[p];[1:v]scale=-2:${STACK_HEIGHT}:flags=lanczos[s];` +
        `[p][s]hstack=inputs=2,scale=${GIF_WIDTH}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${GIF_WIDTH}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`,
      "-frames:v",
      "1",
      composite,
    ]);
    list.push(`file '${composite}'`, `duration ${frame.hold}`);
  }
  // The concat demuxer drops the last entry's duration unless the file is listed once more.
  list.push(`file '${frames[frames.length - 1]!.name}.png'`);
  writeFileSync(join(OUT, "frames.txt"), `${list.join("\n")}\n`);

  const encode = (timing: string[]): void =>
    run(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "frames.txt",
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[pal];" +
        "[b][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      ...timing,
      "-loop",
      "0",
      "demo.gif",
    ]);
  try {
    encode(["-fps_mode", "vfr"]);
  } catch {
    // ffmpeg older than 5.1 spells variable frame timing the old way.
    encode(["-vsync", "vfr"]);
  }

  const bytes = statSync(join(OUT, "demo.gif")).size;
  // eslint-disable-next-line no-console -- the reviewer's numbers.
  console.log(
    `[demo] demo.gif ${GIF_WIDTH}x${height}, ${frames.length} frames, ${(bytes / 1024).toFixed(0)} KiB` +
      (bytes > GIF_BUDGET_BYTES ? " - OVER the 2 MB budget" : ""),
  );
}
