import { chromium, test as base, type BrowserContext } from "@playwright/test";
import { hostDataDirectory, readBridgeRecord } from "@hallpass/agent-host";
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  foreignAgentServersProblem,
  listAgentServerProcesses,
} from "../../../packages/test-kit/src/agent-server-processes.js";
import { TEST_EXTENSION_ID } from "../../../packages/test-kit/src/build-config.js";

/** The two things the packaged specs ask of the extension's service worker. */
export type PackagedWorker = {
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  url(): string;
  /** Resolves once the worker is gone. In CDP mode: once its target left the endpoint's list. */
  waitForEvent(event: "close"): Promise<unknown>;
};

type PackagedFixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
  /** 018/T512: the second attached browser; only a spec that asks for these needs `HALLPASS_CDP_ENDPOINTS`. */
  extensionContext2: BrowserContext;
  extensionWorker2: PackagedWorker;
};

/**
 * The one artefact this repository builds (009/T246). A launched browser is pointed at it, and an
 * attached browser is expected to be serving it: the owner loads `dist/agent` by hand, so that is
 * also the directory the freshness gate below reloads and compares against.
 */
const extensionPath = resolve("apps/extension/dist/agent");
const attachedExtensionPath = extensionPath;
const executablePath = process.env.HALLPASS_CHROME_PATH;
const locale = process.env.HALLPASS_LOCALE === "zh-TW" ? "zh-TW" : "en-US";
/**
 * T091 owner evidence on a branded Chrome that refuses command-line sideloading: the owner loads
 * `dist/agent` by hand through chrome://extensions and starts that Chrome with
 * `--remote-debugging-port`; the gate then attaches to it here instead of launching its own browser.
 * The browser decides its own UI language, so `HALLPASS_LOCALE` must match the `--lang` it was started
 * with - the panel copy the driver asserts comes from `chrome.i18n`, not from this process.
 */
/**
 * 018/T512: `HALLPASS_CDP_ENDPOINTS` is a comma-separated list of two attached browsers (for the
 * two-browser gate). The first is the one every fixture above already means; the second is reached
 * only through `extensionContext2` / `extensionWorker2`. With the list unset (or one entry) nothing
 * here differs from the single-endpoint gate.
 */
const cdpEndpointList = (process.env.HALLPASS_CDP_ENDPOINTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const cdpEndpoint = process.env.HALLPASS_CDP_ENDPOINT ?? cdpEndpointList[0];
/** The second attached browser's endpoint, or `undefined` for a run with one browser. */
export const secondCdpEndpoint: string | undefined = cdpEndpointList.length >= 2 ? cdpEndpointList[1] : undefined;
/** The first attached browser's endpoint (what `extensionContext` is attached to), if any. */
export const firstCdpEndpoint: string | undefined = cdpEndpoint;

type CdpTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };
type CdpEvaluation = { result?: { value?: unknown }; exceptionDetails?: unknown };

async function listTargets(endpoint: string): Promise<CdpTarget[]> {
  return (await (await fetch(`${endpoint}/json/list`)).json()) as CdpTarget[];
}

function findWorkerTarget(list: CdpTarget[]): CdpTarget | undefined {
  const prefix = `chrome-extension://${TEST_EXTENSION_ID}/`;
  return list.find((entry) => entry.type === "service_worker" && entry.url.startsWith(prefix));
}

/** One `Runtime.evaluate` over a target's own DevTools socket; the socket is opened and closed per call. */
async function evaluateOverSocket(
  socketUrl: string,
  expression: string,
  options: { awaitPromise: boolean; timeoutMs: number },
): Promise<CdpEvaluation> {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp-worker-socket-failed")), { once: true });
  });
  try {
    const reply = await new Promise<{ result?: CdpEvaluation; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp-worker-evaluation-timeout")), options.timeoutMs);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: CdpEvaluation; error?: unknown };
        if (message.id !== 1) return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: options.awaitPromise, returnByValue: true },
        }),
      );
    });
    if (reply.error) throw new Error(`cdp-worker-evaluation-failed:${JSON.stringify(reply.error)}`);
    return reply.result ?? {};
  } finally {
    socket.close();
  }
}

/** One command on the browser-level DevTools socket (target management lives there). */
async function browserSend(endpoint: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp-browser-socket-failed")), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp-browser-command-timeout:${method}`)), 10_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(`cdp-browser-command-failed:${method}:${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

/**
 * A DevTools socket that outlives one command, because reading the running code needs both an event
 * (`Debugger.scriptParsed`) and several commands on the same target. The single-command helpers
 * above stay as they are: everything else on this endpoint is one shot.
 */
async function openSocket(
  socketUrl: string,
): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onEvent: (method: string, handler: (params: Record<string, unknown>) => void) => void;
  close: () => void;
}> {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((ready, failed) => {
    socket.addEventListener("open", () => ready(), { once: true });
    socket.addEventListener("error", () => failed(new Error("cdp-worker-socket-failed")), { once: true });
  });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: unknown;
    };
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method) handlers.get(message.method)?.(message.params ?? {});
  });
  let nextId = 0;
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = (nextId += 1);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp-command-timeout:${method}`));
        }, 15_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    onEvent: (method, handler) => handlers.set(method, handler),
    close: () => socket.close(),
  };
}

/** The extension-origin scripts the running worker actually parsed, keyed by their path in the build. */
async function readRunningWorkerScripts(socketUrl: string): Promise<Map<string, string>> {
  const prefix = `chrome-extension://${TEST_EXTENSION_ID}/`;
  const socket = await openSocket(socketUrl);
  try {
    const ids = new Map<string, string>();
    // The listener goes on before `Debugger.enable`: scripts are announced once, at enable time, so
    // registering afterwards silently yields none of them.
    socket.onEvent("Debugger.scriptParsed", (params) => {
      const url = String(params["url"] ?? "");
      if (url.startsWith(prefix)) ids.set(url.slice(prefix.length), String(params["scriptId"]));
    });
    await socket.send("Debugger.enable");
    const deadline = Date.now() + 10_000;
    while (!ids.has("service-worker.js") && Date.now() < deadline) {
      await new Promise((wait) => setTimeout(wait, 250));
    }
    const sources = new Map<string, string>();
    for (const [path, scriptId] of ids) {
      const result = await socket.send("Debugger.getScriptSource", { scriptId });
      sources.set(path, String(result["scriptSource"] ?? ""));
    }
    return sources;
  } finally {
    socket.close();
  }
}

/**
 * 004/T098b - refuse to run a packaged journey against a bundle older than `dist/agent`.
 *
 * An unpacked extension keeps serving the resources it was loaded with, and the per-test reset only
 * closes the worker target, so a rebuilt bundle does not reach the browser on its own: twice on
 * 2026-09-09 a red journey turned out to be a stale bundle, each time costing a diagnosis.
 * `Extensions.loadUnpacked` with the same path reloads it in place, and the check that follows is
 * the honest one - every extension-origin script the worker is running, byte-compared with the file
 * it was built from. Launched mode loads the directory itself on every start and needs none of this.
 */
async function assertAttachedBuildIsCurrent(endpoint: string): Promise<void> {
  let reloadError: string | undefined;
  try {
    await browserSend(endpoint, "Extensions.loadUnpacked", { path: attachedExtensionPath });
  } catch (error) {
    reloadError = error instanceof Error ? error.message : String(error);
  }
  const wake = (await browserSend(endpoint, "Target.createTarget", {
    url: `chrome-extension://${TEST_EXTENSION_ID}/manifest.json`,
  })) as { targetId?: string };
  let worker: CdpTarget | undefined;
  const deadline = Date.now() + 20_000;
  while (!worker && Date.now() < deadline) {
    worker = findWorkerTarget(await listTargets(endpoint));
    if (!worker) await new Promise((wait) => setTimeout(wait, 250));
  }
  if (wake.targetId) {
    await browserSend(endpoint, "Target.closeTarget", { targetId: wake.targetId }).catch(() => undefined);
  }
  const rebuild = `rebuild with \`npm run build:extension:agent\` and re-run; the browser is serving an older bundle`;
  if (!worker?.webSocketDebuggerUrl) {
    throw new Error(
      `attached-build-unreadable: no service worker target for ${TEST_EXTENSION_ID} - load ` +
        `${attachedExtensionPath} in the attached browser${reloadError ? ` (reload failed: ${reloadError})` : ""}`,
    );
  }
  const running = await readRunningWorkerScripts(worker.webSocketDebuggerUrl);
  if (!running.has("service-worker.js")) {
    throw new Error(`attached-build-unreadable: the running worker announced no service-worker.js; ${rebuild}`);
  }
  const differs: string[] = [];
  for (const [path, source] of running) {
    const onDisk = await readFile(resolve(attachedExtensionPath, path), "utf8").catch(() => undefined);
    if (onDisk !== source) differs.push(path);
  }
  if (differs.length > 0) {
    throw new Error(
      `stale-extension-build: the attached browser is running code that differs from ` +
        `${attachedExtensionPath} (${differs.join(", ")}); ${rebuild}` +
        (reloadError ? `. The CDP reload also failed: ${reloadError}` : ""),
    );
  }
}

/**
 * 004/T167 - refuse to run the attach-mode gate while another session's agent-bridge server is on
 * this machine.
 *
 * Every Claude Code session with `hallpass` registered has its own `mcp-server.js` attached to
 * the same relay and greeting the same extension, and the per-test reset below clears the pairing
 * it had - so it asks again, in the panel, ahead of the journey's own client. That is one more
 * agent than any journey expects: `agent-pairing` reads a prompt naming `claude-code` where it
 * expects its own, `agent-input`'s panel lists a session it never started. Measured 2026-09-13,
 * the family's moving reds were exactly this, and every one of them passed alone. The process
 * listing is the one vantage that sees those servers before the extension has been touched.
 *
 * `HALLPASS_FOREIGN_AGENT_SERVERS=allow` skips the refusal, for exactly one situation: the browser under
 * test *and this runner* were started with the same private `LOCALAPPDATA`, so the browser's native
 * host publishes its own relay record there, this run's `mcp-server.js` dials that record, and the
 * other sessions' servers - dialing the machine's usual record - never reach either. The listing
 * cannot see which record a server dials, which is why this is an explicit word from the runner
 * and not an inference; the one part of it that can be checked is checked: the runner's
 * `LOCALAPPDATA` must not be the user's default one.
 */
async function assertNoForeignAgentServers(): Promise<void> {
  if (process.env.HALLPASS_FOREIGN_AGENT_SERVERS === "allow") {
    const usual = resolve(process.env.USERPROFILE ?? "", "AppData", "Local").toLowerCase();
    const runnerLocal = resolve(process.env.LOCALAPPDATA ?? usual).toLowerCase();
    if (runnerLocal === usual) {
      throw new Error(
        "foreign-agent-servers: HALLPASS_FOREIGN_AGENT_SERVERS=allow is only for a run whose LOCALAPPDATA is a " +
          "private directory shared with the browser under test; this runner's is the user's default one.",
      );
    }
    return;
  }
  const execFileAsync = promisify(execFile);
  const servers = await listAgentServerProcesses(async (command, args) => {
    try {
      const { stdout } = await execFileAsync(command, [...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  });
  const problem = foreignAgentServersProblem(servers);
  if (problem !== undefined) throw new Error(`foreign-agent-servers: ${problem}`);
}

/**
 * 004/T169 - do not hand a test a worker whose bridge is still being fought over.
 *
 * The reset above closes the worker target and the wake-up starts a fresh instance, and for a few
 * seconds the relay record changes hands between the hosts those instances opened (the relay log
 * shows two or three `relay.superseded` inside every test's first seconds). Usually the losers are
 * gone before the test's first call; when one is not, the host serving that call is superseded
 * mid-flight and the family goes red on whichever spec was calling - `call-unconfirmed`, a pairing
 * prompt dropped. The record is published by whichever relay currently owns the bridge, and the
 * worker records which relay greeted it, so "stable" is checkable: the record's pid unchanged for
 * two seconds, and equal to the pid this worker was last greeted by. Bounded; a bridge that will
 * not settle is reported, not waited on forever.
 */
async function awaitStableBridge(worker: PackagedWorker): Promise<void> {
  const deadline = Date.now() + 12_000;
  let stableSince: number | undefined;
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const record = await readBridgeRecord().catch(() => undefined);
    const pid = record?.relayPid;
    if (pid !== undefined && pid === lastPid) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 2_000) {
        const greeted = await worker
          .evaluate(async () => {
            const raw = await chrome.storage.session.get(["agentBridgeGreetings"]);
            const ring = (raw.agentBridgeGreetings ?? []) as Array<{ relay?: number }>;
            return ring[ring.length - 1]?.relay;
          })
          .catch(() => undefined);
        if (greeted === pid) return;
      }
    } else {
      stableSince = undefined;
      lastPid = pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`[bridge-unstable] record pid ${lastPid ?? "none"} did not settle within the bound; running anyway`);
}

/** The worker's own record of native-port drops (`agentBridgeDisconnects`, 004/T169), to the test log. */
async function printBridgeDisconnects(endpoint: string): Promise<void> {
  try {
    // Every worker target of this extension, not the first: two instances alive at once is the
    // very thing being looked for, and each would answer from its own view of the ring.
    const prefix = `chrome-extension://${TEST_EXTENSION_ID}/`;
    const workers = (await listTargets(endpoint)).filter(
      (target) => target.type === "service_worker" && target.url.startsWith(prefix),
    );
    console.log(`[bridge-workers] ${workers.length}: ${workers.map((w) => w.id).join(", ")}`);
    for (const worker of workers) {
      if (!worker.webSocketDebuggerUrl) continue;
      const evaluation = await evaluateOverSocket(
        worker.webSocketDebuggerUrl,
        `chrome.storage.session.get(["agentBridgeDisconnects", "agentBridgeGreetings"]).then((raw) => JSON.stringify({ greeted: raw.agentBridgeGreetings ?? [], dropped: raw.agentBridgeDisconnects ?? [] }))`,
        { awaitPromise: true, timeoutMs: 5_000 },
      );
      const value = evaluation.result?.value;
      if (typeof value === "string") console.log(`[bridge-disconnects] ${worker.id} ${value}`);
    }
  } catch {
    // A worker that is already gone has nothing to say; the log line is a courtesy, not a gate.
  }
}

/** One check per endpoint per gate process: the build cannot change under a run that is already going. */
const attachedBuildChecks = new Map<string, Promise<void>>();
let foreignServersCheck: Promise<void> | undefined;

async function assertAttachedEndpointReady(endpoint: string): Promise<void> {
  foreignServersCheck ??= assertNoForeignAgentServers();
  await foreignServersCheck;
  let check = attachedBuildChecks.get(endpoint);
  if (!check) {
    check = assertAttachedBuildIsCurrent(endpoint);
    attachedBuildChecks.set(endpoint, check);
  }
  await check;
}

/**
 * The launched gate gives every test a fresh profile. An attached browser keeps its state, so each
 * test starts by putting it back to the launched gate's starting point: one blank tab and nothing
 * else open, the extension's stored state cleared, every extension page (the side panel included)
 * closed, and the worker itself terminated so the next connection starts it with empty memory.
 * Termination goes through `Target.closeTarget` on the DevTools socket rather than
 * `chrome.runtime.reload()`: a reload unloads an extension that was loaded from the command line or
 * over CDP and does not bring it back, so it cannot be validated on a launched browser, whereas
 * closing the worker target behaves the same wherever the extension came from.
 */
async function resetAttachedBrowser(context: BrowserContext, endpoint: string): Promise<void> {
  const keep = await context.newPage();
  await keep.goto("about:blank");
  for (const page of context.pages()) {
    if (page !== keep) await page.close().catch(() => undefined);
  }
  const prefix = `chrome-extension://${TEST_EXTENSION_ID}/`;
  const worker = findWorkerTarget(await listTargets(endpoint));
  if (worker?.webSocketDebuggerUrl) {
    await evaluateOverSocket(
      worker.webSocketDebuggerUrl,
      "Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()])",
      { awaitPromise: true, timeoutMs: 10_000 },
    ).catch(() => undefined);
  }
  for (const target of await listTargets(endpoint)) {
    if (target.url.startsWith(prefix)) {
      await browserSend(endpoint, "Target.closeTarget", { targetId: target.id }).catch(() => undefined);
    }
  }
  /**
   * 004/T169, for the record: closing the worker target detaches it and closes its native port but
   * does not stop its JavaScript. The retired instance's bridge sees the drop, arms its 5 s re-open,
   * and five (then fifteen) seconds into the *next* test calls `connectNative` again - Chrome spawns
   * a host for it, with no owner that will ever read a frame. That host used to take the relay
   * record and drain the one serving the new test's call (`call-unconfirmed`, a pairing prompt
   * dropped, on whichever spec was mid-call). It is exactly what the relay's ack gate now exists
   * for - a host nobody acknowledges never publishes - so this reset deliberately keeps producing
   * the condition: every family run is a check that the gate holds.
   */
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await listTargets(endpoint)).some((target) => target.url.startsWith(prefix))) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const page of context.pages()) {
    if (page !== keep) await page.close().catch(() => undefined);
  }
  if (secondCdpEndpoint) {
    // 018/T512: a two-browser gate counts tabs per browser, so it starts from one blank tab. Pages
    // the attachment does not list (another window's tabs, an agent's leftovers) go by their target.
    const session = await context.newCDPSession(keep);
    const keepId = ((await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } }).targetInfo
      .targetId;
    await session.detach().catch(() => undefined);
    for (const target of await listTargets(endpoint)) {
      if (target.type === "page" && target.id !== keepId && !target.url.startsWith(prefix)) {
        await browserSend(endpoint, "Target.closeTarget", { targetId: target.id }).catch(() => undefined);
      }
    }
  }
}

/**
 * Playwright does not surface an extension's service worker on a browser it merely attached to, so
 * in CDP mode the worker is reached directly: found through the endpoint's target list (opening a
 * panel page first, because an idle MV3 worker is not a target until something connects to it) and
 * evaluated over its own DevTools socket. The socket is a second client on the target, which Chrome
 * allows alongside Playwright's attachment.
 */
async function attachCdpWorker(context: BrowserContext, endpoint: string): Promise<PackagedWorker> {
  const wake = await context.newPage();
  const deadline = Date.now() + 15_000;
  // Right after the reset closed every extension target the first navigation can still be refused
  // (ERR_BLOCKED_BY_CLIENT); the wake-up navigation is retried until the extension answers.
  for (;;) {
    try {
      await wake.goto(`chrome-extension://${TEST_EXTENSION_ID}/side-panel.html?launcher=1`);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  let target: CdpTarget | undefined;
  while (!target && Date.now() < deadline) {
    target = findWorkerTarget(await listTargets(endpoint));
    if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await wake.close();
  if (!target?.webSocketDebuggerUrl) throw new Error("cdp-extension-worker-missing");
  const workerUrl = target.url;
  const socketUrl = target.webSocketDebuggerUrl;
  const targetId = target.id;
  return {
    url: () => workerUrl,
    waitForEvent: async () => {
      const closeDeadline = Date.now() + 30_000;
      while (Date.now() < closeDeadline) {
        if (!(await listTargets(endpoint)).some((entry) => entry.id === targetId)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("cdp-worker-close-timeout");
    },
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
      const evaluation = await evaluateOverSocket(
        socketUrl,
        `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (evaluation.exceptionDetails) {
        throw new Error(`cdp-worker-evaluation-threw:${JSON.stringify(evaluation.exceptionDetails)}`);
      }
      return evaluation.result?.value as R;
    },
  };
}

/** Attaches to one running browser for the length of a test, after putting it back to a clean start. */
async function withAttachedContext(endpoint: string, use: (context: BrowserContext) => Promise<void>): Promise<void> {
  // 018/T512: a two-browser test that closed this browser and could not start it again must not
  // take every later test with it; when the runner said how to start it, start it here.
  if (secondCdpEndpoint && !(await endpointAnswers(endpoint)) && relaunchProblem(endpoint) === undefined) {
    await launchBrowserProcess(endpoint);
  }
  await assertAttachedEndpointReady(endpoint);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error("cdp-default-context-missing");
  await resetAttachedBrowser(context, endpoint);
  try {
    await use(context);
  } finally {
    // 004/T169: what the worker recorded about its native port closing during this test, printed
    // before the next test's reset wipes it. The agent build has no console of its own, and the
    // family's intermittent reds are a port that closes while its host is still alive.
    await printBridgeDisconnects(endpoint);
    // The owner's browser stays open; only this attachment ends. (A browser the test itself closed
    // leaves a dead connection here, which has nothing left to end.)
    await browser.close().catch(() => undefined);
  }
}

export const test = base.extend<PackagedFixtures>({
  extensionContext: async ({}, use) => {
    if (cdpEndpoint) {
      await withAttachedContext(cdpEndpoint, use);
      return;
    }
    const context = await chromium.launchPersistentContext("", {
      ...(executablePath ? { executablePath } : { channel: "chromium" as const }),
      headless: true,
      locale,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--enable-unsafe-extension-debugging",
        "--disable-features=LocalNetworkAccessChecks",
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  extensionWorker: async ({ extensionContext }, use) => {
    if (cdpEndpoint) {
      const worker = await attachCdpWorker(extensionContext, cdpEndpoint);
      // With two browsers the legacy `bridge.json` belongs to at most one of them, so "stable" is
      // read from the per-browser records instead (018).
      await (secondCdpEndpoint ? awaitStableBrowserRecord(worker) : awaitStableBridge(worker));
      await use(worker);
      return;
    }
    const worker = extensionContext.serviceWorkers()[0] ??
      (await extensionContext.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => {
        const channel = process.env.HALLPASS_RELEASE_CHANNEL;
        throw new Error(channel ? `release-unpacked-load-blocked:${channel}` : "packaged-worker-missing");
      }));
    await use(worker);
  },
  extensionId: async ({ extensionWorker }, use) => {
    const id = new URL(extensionWorker.url()).host;
    await use(id);
  },
  extensionContext2: async ({}, use) => {
    if (!secondCdpEndpoint) {
      throw new Error(
        "second-browser-missing: set HALLPASS_CDP_ENDPOINTS=<first endpoint>,<second endpoint> (two attached browsers)",
      );
    }
    await withAttachedContext(secondCdpEndpoint, use);
  },
  extensionWorker2: async ({ extensionContext2 }, use) => {
    if (!secondCdpEndpoint) throw new Error("second-browser-missing");
    const worker = await attachCdpWorker(extensionContext2, secondCdpEndpoint);
    await awaitStableBrowserRecord(worker);
    await use(worker);
  },
});

export { expect } from "@playwright/test";

/**
 * 014/T366, T368 — turn off the loopback exemption for this gate (contracts/transitions.md).
 *
 * Every fixture in this harness is served from `127.0.0.1`, which rule (a) exempts for the good
 * reason that a page on the owner's own machine is not a site they were handed to. So a gate about
 * transitions has to say "treat loopback as an ordinary site", and it says it in the worker's own
 * storage before the first held tab moves. The switch only ever makes the product ask about
 * *more* than it would in the owner's browser - it can widen prompting and never privilege - and
 * the branded-Chrome run on real sites is what proves rule (a) as shipped.
 */
export async function setTransitionTestSwitch(worker: PackagedWorker, on: boolean): Promise<void> {
  await worker.evaluate(async (enabled: boolean) => {
    if (enabled) {
      await chrome.storage.local.set({ agentTransitionsTestNoLoopbackExemption: true });
      return;
    }
    await chrome.storage.local.remove("agentTransitionsTestNoLoopbackExemption");
  }, on);
}

/* ---------------------------------------------------------------------------------------------
 * 018/T512 - what a two-browser gate needs beyond the fixtures above. Everything here reads the
 * host's own files under the shared `LOCALAPPDATA` (the runner's) or drives a browser's DevTools
 * endpoint; nothing imports a private module of the product.
 * ------------------------------------------------------------------------------------------- */

/** One browser's published record, reduced to what a gate can say about it. */
export type LiveBrowserRecord = { browserId: string; relayPid: number };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and this user may not signal it - still a running relay.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `hallpass\browsers\*.json` whose relay is still running: the browsers an agent could be offered. */
export async function readLiveBrowserRecords(): Promise<LiveBrowserRecord[]> {
  const directory = join(hostDataDirectory(), "browsers");
  const names = await readdir(directory).catch(() => [] as string[]);
  const live: LiveBrowserRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as {
        browserId?: unknown;
        relayPid?: unknown;
      };
      if (typeof parsed.browserId === "string" && typeof parsed.relayPid === "number" && processAlive(parsed.relayPid)) {
        live.push({ browserId: parsed.browserId, relayPid: parsed.relayPid });
      }
    } catch {
      // A record being rewritten (temp-then-rename) or not a record: not a browser right now.
    }
  }
  return live;
}

/** The remembered browser choices are per agent and outlive a test, so a gate clears them first. */
export async function clearBrowserChoices(): Promise<void> {
  await rm(join(hostDataDirectory(), "choices"), { recursive: true, force: true });
}

async function greetedRelayPid(worker: PackagedWorker): Promise<number | undefined> {
  return worker
    .evaluate(async () => {
      const raw = await chrome.storage.session.get(["agentBridgeGreetings"]);
      const ring = (raw.agentBridgeGreetings ?? []) as Array<{ relay?: number }>;
      return ring[ring.length - 1]?.relay;
    })
    .catch(() => undefined);
}

/**
 * The two-browser form of `awaitStableBridge`: the relay that last greeted this worker has a live
 * per-browser record, and has had it for two seconds. Bounded, and reported rather than waited on.
 */
async function awaitStableBrowserRecord(worker: PackagedWorker): Promise<void> {
  const deadline = Date.now() + 15_000;
  let stableSince: number | undefined;
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const pid = await greetedRelayPid(worker);
    const published = pid !== undefined && (await readLiveBrowserRecords()).some((record) => record.relayPid === pid);
    if (published && pid === lastPid) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 2_000) return;
    } else {
      stableSince = undefined;
    }
    lastPid = pid;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`[browser-record-unstable] relay ${lastPid ?? "none"} did not settle within the bound; running anyway`);
}

/** The browser id this worker's relay published under - how a gate maps "browser A" to an identifier. */
export async function browserIdOfWorker(worker: PackagedWorker, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await greetedRelayPid(worker);
    const record =
      pid === undefined ? undefined : (await readLiveBrowserRecords()).find((entry) => entry.relayPid === pid);
    if (record) return record.browserId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("browser-id-of-worker-missing: no live per-browser record for the relay that greeted this worker");
}

/**
 * "A browser goes away and comes back" for a gate that attached to it (018 US5, SC-131).
 *
 * Unloading the extension in place does not do: `runtime.reload()` on a CDP-loaded extension leaves
 * it unloaded and `Extensions.loadUnpacked` did not bring it back on Chromium 151 (measured
 * 2026-10-03). What does keep the profile - and so the browser's identity, which lives in the
 * extension's `storage.local` - is closing the whole browser through CDP and starting the same
 * executable again on the same `--user-data-dir` and port, with the extension loaded the way a
 * launched gate loads it (`--load-extension`). The runner says how in its environment:
 *
 *   HALLPASS_GATE_CHROME            the browser executable (the one the gate's browsers run)
 *   HALLPASS_GATE_PROFILE_<port>    that port's `--user-data-dir`   (e.g. HALLPASS_GATE_PROFILE_9223)
 *   HALLPASS_GATE_CHROME_ARGS       optional, space-separated extra flags (`--no-sandbox`, `--headless=new`,
 *                                   `--lang=en-US`, ...) so the relaunch matches the original launch
 *
 * The relaunched browser inherits the runner's environment, so it shares the runner's private
 * `LOCALAPPDATA` like the original did. It is started detached and left running for the next test.
 */
function relaunchSettings(
  endpoint: string,
): { executable: string; profile: string; port: string; extraArgs: string[] } | { problem: string } {
  const port = new URL(endpoint).port;
  const executable = process.env.HALLPASS_GATE_CHROME;
  const profile = process.env[`HALLPASS_GATE_PROFILE_${port}`];
  if (!executable) return { problem: "HALLPASS_GATE_CHROME (the browser executable) is not set" };
  if (!profile) return { problem: `HALLPASS_GATE_PROFILE_${port} (that browser's --user-data-dir) is not set` };
  const extraArgs = (process.env.HALLPASS_GATE_CHROME_ARGS ?? "").split(/\s+/u).filter((arg) => arg.length > 0);
  return { executable, profile, port, extraArgs };
}

/** `undefined` when a closed browser at `endpoint` can be started again; otherwise what is missing. */
export function relaunchProblem(endpoint: string | undefined): string | undefined {
  if (!endpoint) return "no endpoint";
  const settings = relaunchSettings(endpoint);
  return "problem" in settings ? settings.problem : undefined;
}

async function endpointAnswers(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** Starts the browser behind `endpoint` (see above) and resolves once its DevTools endpoint answers. */
async function launchBrowserProcess(endpoint: string): Promise<void> {
  const settings = relaunchSettings(endpoint);
  if ("problem" in settings) throw new Error(`browser-relaunch-unconfigured: ${settings.problem}`);
  // A profile lock the old process still holds makes a start hand off and exit; so, a few tries.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const child = spawn(
      settings.executable,
      [
        `--remote-debugging-port=${settings.port}`,
        `--user-data-dir=${settings.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=LocalNetworkAccessChecks",
        ...settings.extraArgs,
        "about:blank",
      ],
      { detached: true, stdio: "ignore", env: process.env },
    );
    child.unref();
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !exited) {
      if (await endpointAnswers(endpoint)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (await endpointAnswers(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`browser-relaunch-failed: ${endpoint} did not answer after three starts of ${settings.executable}`);
}

/** Closes the whole browser behind `endpoint` through CDP; resolves once its endpoint stops answering. */
export async function closeAttachedBrowser(endpoint: string): Promise<void> {
  // The browser may drop the socket before it answers; what matters is that the endpoint goes quiet.
  await browserSend(endpoint, "Browser.close", {}).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await endpointAnswers(endpoint))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`browser-close-failed: ${endpoint} still answers 30 s after Browser.close`);
}

/** A browser started again on its old profile, attached, with no reset (a reset would clear its identity). */
export type RelaunchedBrowser = {
  context: BrowserContext;
  worker: PackagedWorker;
  /** Ends this attachment only; the browser keeps running for the next test. */
  detach(): Promise<void>;
};

/**
 * Starts the browser closed by `closeAttachedBrowser` again, attaches to it, and returns its context
 * and a handle on the extension's new worker once its relay has published.
 */
export async function relaunchAttachedBrowser(endpoint: string): Promise<RelaunchedBrowser> {
  await launchBrowserProcess(endpoint);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error("cdp-default-context-missing");
  const worker = await attachCdpWorker(context, endpoint);
  await awaitStableBrowserRecord(worker);
  return { context, worker, detach: () => browser.close().catch(() => undefined) };
}
