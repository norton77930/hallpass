// Spec 031 T938 (R-462, R-463): does Page.captureScreenshot {fromSurface:true} on a tab that is NOT
// activated return a fresh picture, and do clicks/typing land in a minimized window's tab?
//
// A measurement, not product code. It launches Playwright's bundled Chromium (headed - occlusion is the
// point) with a private temp user-data-dir and speaks raw CDP over the browser websocket, the same
// protocol commands the extension would send through chrome.debugger. No extension is loaded.
//
//   node --experimental-strip-types tests/harness/capture-freshness-031.ts [out.json]
//
// Output: JSON summary on stdout and in out.json (default test-results/031-capture-freshness/<time>.json).
// Environment: CAPTURE_FRESHNESS_CHROMIUM=<path to chrome.exe> to use another build; CAPTURE_FRESHNESS_RUNS
// to change the 10 runs per state; CAPTURE_FRESHNESS_NO_SANDBOX=0 to drop --no-sandbox.
// It never uses a fixed debugging port (--remote-debugging-port=0, read from DevToolsActivePort).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";

const RUNS = Number(process.env.CAPTURE_FRESHNESS_RUNS ?? 10);
const CAPTURE_TIMEOUT_MS = 10_000;
const BOUNDS = { left: 60, top: 60, width: 900, height: 700 };

// ---------------------------------------------------------------- CDP client

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else p.resolve(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("websocket error")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------- PNG pixel sample

type Pixel = { width: number; height: number; r: number; g: number; b: number };

// Minimal decoder for what Chromium emits: 8-bit RGB/RGBA, non-interlaced. Returns the centre pixel.
function centrePixel(png: Buffer): Pixel {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth ${bitDepth} colour ${colorType} interlace ${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  let prev = Buffer.alloc(stride);
  const targetY = height >> 1;
  let line = Buffer.alloc(stride);
  for (let y = 0; y <= targetY; y++) {
    const base = y * (stride + 1);
    const ft = raw[base]!;
    line = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!;
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    prev = line;
  }
  const px = (width >> 1) * bpp;
  return { width, height, r: line[px]!, g: line[px + 1]!, b: line[px + 2]! };
}

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Rgb = [number, number, number];
const near = (p: Pixel, c: Rgb) => Math.abs(p.r - c[0]) <= 3 && Math.abs(p.g - c[1]) <= 3 && Math.abs(p.b - c[2]) <= 3;
const dist = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
function randomColour(avoid: Rgb): Rgb {
  for (;;) {
    const c: Rgb = [0, 0, 0].map(() => Math.floor(Math.random() * 256)) as Rgb;
    if (dist(c, avoid) > 200) return c;
  }
}
function stats(xs: number[]) {
  if (xs.length === 0) return { min: null, median: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[s.length >> 1], max: s[s.length - 1] };
}

const PAGE_HTML =
  "<!doctype html><title>t</title><body style='margin:0;background:rgb(255,255,255)'>" +
  "<div id=n style='position:absolute;top:0;left:0;font:80px monospace'>0</div></body>";
const PAGE_URL = "data:text/html," + encodeURIComponent(PAGE_HTML);

const CONTROLS_HTML =
  "<!doctype html><title>c</title><body style='margin:0;background:rgb(255,255,255)'>" +
  "<button id=b style='position:absolute;left:100px;top:100px;width:200px;height:100px' " +
  "onclick='window.__clicks=(window.__clicks||0)+1'>go</button>" +
  "<input id=i style='position:absolute;left:100px;top:300px;width:300px;height:40px'>" +
  "<script>window.__clicks=0;window.__keys='';" +
  "document.getElementById('i').addEventListener('keydown',e=>{window.__keys+=e.key});</script></body>";
const CONTROLS_URL = "data:text/html," + encodeURIComponent(CONTROLS_HTML);

type RunResult = {
  run: number;
  verdict: "fresh" | "stale" | "error";
  latencyMs: number | null;
  expected: Rgb;
  observed: Rgb | null;
  observedPrevious: boolean | null;
  image: string | null;
  error?: string;
};

async function measure(
  cdp: Cdp,
  sessionId: string,
  runs: number,
  captureTimeout = CAPTURE_TIMEOUT_MS,
): Promise<{ runs: RunResult[]; fresh: number; stale: number; error: number; latencyMs: ReturnType<typeof stats> }> {
  const results: RunResult[] = [];
  let previous: Rgb = [255, 255, 255];
  for (let i = 1; i <= runs; i++) {
    const colour = randomColour(previous);
    const r: RunResult = { run: i, verdict: "error", latencyMs: null, expected: colour, observed: null, observedPrevious: null, image: null };
    try {
      await cdp.send(
        "Runtime.evaluate",
        {
          expression: `document.body.style.background='rgb(${colour.join(",")})';document.getElementById('n').textContent='${i}';'ok'`,
        },
        sessionId,
      );
      await sleep(100 + Math.floor(Math.random() * 200));
      const t0 = performance.now();
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId, captureTimeout);
      r.latencyMs = Math.round(performance.now() - t0);
      const px = centrePixel(Buffer.from(shot.data, "base64"));
      r.observed = [px.r, px.g, px.b];
      r.image = `${px.width}x${px.height}`;
      r.observedPrevious = near(px, previous);
      r.verdict = near(px, colour) ? "fresh" : "stale";
    } catch (e) {
      r.error = (e as Error).message;
    }
    previous = colour;
    results.push(r);
  }
  return {
    runs: results,
    fresh: results.filter((r) => r.verdict === "fresh").length,
    stale: results.filter((r) => r.verdict === "stale").length,
    error: results.filter((r) => r.verdict === "error").length,
    latencyMs: stats(results.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number)),
  };
}

async function evalJson(cdp: Cdp, sessionId: string, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 10_000);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const VIS = "JSON.stringify({visibility:document.visibilityState,hasFocus:document.hasFocus()})";

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const outArg = process.argv[2];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve(outArg ?? join("test-results", "031-capture-freshness", `${stamp}.json`));

  const exe = process.env.CAPTURE_FRESHNESS_CHROMIUM ?? chromium.executablePath();
  if (!existsSync(exe)) throw new Error(`browser executable not found: ${exe}`);
  const profile = mkdtempSync(join(tmpdir(), "hallpass-031-capture-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    `--window-position=${BOUNDS.left},${BOUNDS.top}`,
    `--window-size=${BOUNDS.width},${BOUNDS.height}`,
    "about:blank",
  ];
  if (process.env.CAPTURE_FRESHNESS_NO_SANDBOX !== "0") args.unshift("--no-sandbox");
  const child = spawn(exe, args, { stdio: "ignore", windowsHide: false });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  let cdp: Cdp | undefined;
  const summary: any = {
    task: "T938",
    startedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    executable: exe,
    runsPerState: RUNS,
    bounds: BOUNDS,
  };
  try {
    // DevToolsActivePort: line 1 = port, line 2 = browser websocket path.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    if (!existsSync(portFile)) throw new Error("browser did not publish DevToolsActivePort");
    await sleep(200);
    const [port, wsPath] = readFileSync(portFile, "utf8").split(/\r?\n/);
    cdp = await Connect(`ws://127.0.0.1:${port}${wsPath}`);

    const ver = await cdp.send("Browser.getVersion");
    summary.browser = { product: ver.product, userAgent: ver.userAgent, revision: ver.revision };

    const attach = async (targetId: string): Promise<string> =>
      (await cdp!.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const bounds = async (targetId: string, b: object) => {
      const { windowId } = await cdp!.send("Browser.getWindowForTarget", { targetId });
      await cdp!.send("Browser.setWindowBounds", { windowId, bounds: b });
      return windowId as number;
    };
    const pageTargets = async () =>
      (await cdp!.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");

    // Window A: tab A1 (the initial tab, active) and tab A2 (background).
    const a1 = (await pageTargets())[0].targetId as string;
    const winA = await bounds(a1, { ...BOUNDS, windowState: "normal" });
    const s1 = await attach(a1);
    await cdp.send("Page.enable", {}, s1);
    await cdp.send("Page.navigate", { url: PAGE_URL }, s1);
    await sleep(500);
    const a2 = (await cdp.send("Target.createTarget", { url: PAGE_URL, newWindow: false, background: true })).targetId as string;
    const winA2 = (await cdp.send("Browser.getWindowForTarget", { targetId: a2 })).windowId as number;
    const s2 = await attach(a2);
    await sleep(500);
    summary.setup = {
      windowA: winA,
      a2SameWindowAsA1: winA2 === winA,
      a1BeforeCover: JSON.parse(await evalJson(cdp, s1, VIS)),
      a2BeforeCover: JSON.parse(await evalJson(cdp, s2, VIS)),
    };

    summary.states = {};

    // b. background tab in a visible window (nothing covers window A yet).
    summary.states.backgroundTabVisibleWindow = {
      visibility: JSON.parse(await evalJson(cdp, s2, VIS)),
      ...(await measure(cdp, s2, RUNS)),
    };

    // Cover window A with window B at the same bounds, activated so it is on top.
    const bTarget = (await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true })).targetId as string;
    const winB = await bounds(bTarget, { ...BOUNDS, windowState: "normal" });
    await cdp.send("Target.activateTarget", { targetId: bTarget });
    await sleep(1500); // let native occlusion tracking settle
    summary.setup.windowB = winB;
    summary.setup.coverWindowsDiffer = winB !== winA;
    summary.setup.a1AfterCover = JSON.parse(await evalJson(cdp, s1, VIS));
    summary.setup.a2AfterCover = JSON.parse(await evalJson(cdp, s2, VIS));

    // a. active tab in a covered window.
    summary.states.activeTabCoveredWindow = {
      visibility: JSON.parse(await evalJson(cdp, s1, VIS)),
      ...(await measure(cdp, s1, RUNS)),
    };
    // c. background tab in a covered window.
    summary.states.backgroundTabCoveredWindow = {
      visibility: JSON.parse(await evalJson(cdp, s2, VIS)),
      ...(await measure(cdp, s2, RUNS)),
    };

    // Minimized window: controls page, control run first, then minimize.
    const mTarget = (await cdp.send("Target.createTarget", { url: CONTROLS_URL, newWindow: true })).targetId as string;
    const winM = await bounds(mTarget, { ...BOUNDS, windowState: "normal" });
    await cdp.send("Target.activateTarget", { targetId: mTarget });
    const sm = await attach(mTarget);
    await sleep(2000);

    const click = async (x: number, y: number) => {
      await cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sm, 10_000);
      await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sm, 10_000);
      await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sm, 10_000);
    };
    const readBack = async () =>
      JSON.parse(
        await evalJson(
          cdp!,
          sm,
          `JSON.stringify({clicks:window.__clicks,value:document.getElementById('i').value,keys:window.__keys,` +
            `active:document.activeElement&&document.activeElement.id,state:document.visibilityState})`,
        ),
      );
    const interact = async () => {
      const out: any = {};
      try {
        for (let n = 0; n < 3; n++) await click(200, 150); // button centre, 3 clicks
        out.afterClick = await readBack();
        await click(250, 320); // input centre -> focus
        await cdp!.send("Input.insertText", { text: "hello" }, sm, 10_000);
        await cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", text: "z", unmodifiedText: "z" }, sm, 10_000);
        await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z" }, sm, 10_000);
        out.afterType = await readBack();
      } catch (e) {
        out.error = (e as Error).message;
      }
      return out;
    };

    const control = await interact();
    await cdp.send("Runtime.evaluate", { expression: "document.getElementById('i').value='';window.__keys='';window.__clicks=0" }, sm);

    await cdp.send("Browser.setWindowBounds", { windowId: winM, bounds: { windowState: "minimized" } });
    await sleep(1500);
    const stateAfter = (await cdp.send("Browser.getWindowForTarget", { targetId: mTarget })).bounds;
    const minimizedInteraction = await interact();

    // Capture while minimized: change the page first, same method as the other states, 4 runs, 8 s bound.
    await cdp.send("Runtime.evaluate", { expression: "document.body.style.background='rgb(255,255,255)'" }, sm);
    const minimizedCapture = await measure(cdp, sm, Math.min(RUNS, 4), 8_000);
    summary.minimized = {
      windowState: stateAfter.windowState,
      visibility: JSON.parse(await evalJson(cdp, sm, VIS)),
      controlNormalWindow: control,
      interactionMinimized: minimizedInteraction,
      capture: minimizedCapture,
    };
  } catch (e) {
    summary.fatal = (e as Error).stack ?? String(e);
    process.exitCode = 1;
  } finally {
    try {
      await cdp?.send("Browser.close", {}, undefined, 3_000);
    } catch {
      /* closing drops the socket */
    }
    cdp?.close();
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    if (!exited && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* temp dir left behind is harmless */
    }
  }
  summary.finishedAt = new Date().toISOString();
  const text = JSON.stringify(summary, null, 2);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text + "\n");
  process.stdout.write(text + "\n");
  process.stderr.write(`written ${outPath}\n`);
}

const Connect = (url: string) => Cdp.connect(url);

await main();
