import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  AGENT_LINK_PROTOCOL,
  BROWSER_REFUSAL_HINTS,
  type AgentBrowserKind,
  type AgentNativeRequest,
  type AgentNativeResponse,
} from "@hallpass/contracts";
import { listenAndPublish, type FrameChannel } from "../src/bridge-link.js";
import { browserRecordPath, writeBrowserRecord } from "../src/browser-record.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 018/S4b (T505, FR-271, FR-272, FR-275 - FR-277, D-018-8, D-018-12 - D-018-14, R-272, R-278) - the
 * routing that decides in which browser a call runs, proven against two stand-in relays that each
 * publish their own `browsers/<browserId>.json`, as a 0.11.0 relay does.
 *
 * Routing is an authorization boundary (D-018-9): the frames each relay *received* are the evidence,
 * so every refusal here is asserted as "nothing reached any relay", not only as the answer's words.
 * Spawns the built `dist/mcp-server.js`, as `mcp-server.test.ts` does.
 */

type FakeBrowser = {
  readonly browserId: string;
  /** Every frame the server sent this relay, greeting included, in order. */
  readonly frames: unknown[];
  readonly hellos: Array<{ sessionId: string }>;
  readonly requests: AgentNativeRequest[];
  readonly controlTypes: string[];
  /** How many server sockets this relay saw close. */
  closes: number;
  send(frame: unknown): void;
  /** The record goes, then the listener: a browser exiting, or its worker recycling. */
  close(): Promise<void>;
};

type ScriptedAnswer = Omit<AgentNativeResponse, "callId"> | "hang";

async function startFakeBrowser(options: {
  dataDir: string;
  browserId: string;
  kind: AgentBrowserKind;
  startedAt: string;
  pairing?: "accept" | "ignore";
  answers?: Partial<Record<string, ScriptedAnswer>>;
}): Promise<FakeBrowser> {
  const env = { LOCALAPPDATA: options.dataDir };
  const token = randomBytes(32).toString("hex");
  const attached: FrameChannel[] = [];
  const browser: FakeBrowser = {
    browserId: options.browserId,
    frames: [],
    hellos: [],
    requests: [],
    controlTypes: [],
    closes: 0,
    send(frame) {
      attached.at(-1)?.send(frame);
    },
    close: async () => undefined,
  };
  const relay = await listenAndPublish(
    {
      onFrame(channel, value) {
        browser.frames.push(value);
        const link = agentLinkFrameSchema.safeParse(value);
        if (link.success && link.data.type === "hello") {
          if (link.data.token !== token) {
            void channel.close();
            return;
          }
          attached.push(channel);
          browser.hellos.push({ sessionId: link.data.sessionId });
          channel.send({ type: "hello-ack", relayPid: process.pid });
          return;
        }
        const request = agentNativeRequestSchema.safeParse(value);
        if (request.success) {
          browser.requests.push(request.data);
          const scripted = options.answers?.[request.data.tool];
          if (scripted === "hang") return;
          channel.send(
            scripted === undefined
              ? { callId: request.data.callId, outcome: "failed", reason: "no-script" }
              : { ...scripted, callId: request.data.callId },
          );
          return;
        }
        const control = agentControlFrameSchema.safeParse(value);
        if (!control.success) return;
        browser.controlTypes.push(control.data.type);
        if (control.data.type === "pair-request" && (options.pairing ?? "accept") === "accept") {
          channel.send({
            type: "pair-result",
            agentId: control.data.agentId,
            sessionId: control.data.sessionId,
            accepted: true,
          });
        }
      },
      onClose(channel) {
        // Greeted sockets only, as the relay's multiplexer counts them: a server's liveness probe
        // (T515 m4) connects and leaves without a word, and that is no session ending.
        const index = attached.indexOf(channel);
        if (index < 0) return;
        browser.closes += 1;
        attached.splice(index, 1);
      },
    },
    // A 0.11.0 relay serves through its own record only (S2); `bridge.json` is never written here,
    // so the legacy entry of R-277a cannot stand in for either browser.
    { env, token, publishOnListen: false },
  );
  await writeBrowserRecord(
    {
      browserId: options.browserId,
      kind: options.kind,
      legacy: false,
      features: [],
      relayPid: process.pid,
      port: relay.port,
      token,
      startedAt: options.startedAt,
      protocol: AGENT_LINK_PROTOCOL,
    },
    env,
  );
  browser.close = async () => {
    await rm(browserRecordPath(options.browserId, env), { force: true });
    await relay.close();
  };
  return browser;
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME = { browserId: "browser-chrome", name: "Chrome", kind: "chrome" } as const;
const EDGE = { browserId: "browser-edge", name: "Edge", kind: "edge" } as const;
const AGENT_ID = "a".repeat(32);
const TABS_A = { outcome: "ok" as const, result: [{ tabId: 41, url: "https://a.test/" }] };

describe("018 S4b every call runs only in the session's browser", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  const browsers: FakeBrowser[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-"));
    // A known agent id, so a test can write that agent's remembered choice before the server starts.
    await mkdir(join(dataDir, "hallpass"), { recursive: true });
    await writeFile(join(dataDir, "hallpass", "agent-id"), `${AGENT_ID}\n`, "utf8");
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    for (const browser of browsers.splice(0)) await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function chrome(options: { pairing?: "accept" | "ignore"; answers?: Partial<Record<string, ScriptedAnswer>> } = {}): Promise<FakeBrowser> {
    const browser = await startFakeBrowser({ dataDir, ...CHROME, startedAt: "2026-10-03T08:00:00.000Z", ...options });
    browsers.push(browser);
    return browser;
  }

  async function edge(options: { pairing?: "accept" | "ignore"; answers?: Partial<Record<string, ScriptedAnswer>> } = {}): Promise<FakeBrowser> {
    const browser = await startFakeBrowser({ dataDir, ...EDGE, startedAt: "2026-10-03T09:00:00.000Z", ...options });
    browsers.push(browser);
    return browser;
  }

  async function forget(browser: FakeBrowser): Promise<void> {
    browsers.splice(browsers.indexOf(browser), 1);
    await browser.close();
  }

  function start(env: Record<string, string> = {}): Promise<McpHarnessClient> {
    return startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir, ...env } });
  }

  it("dials the one connected browser at initialize, and its first call needs no new step (SC-131)", async () => {
    const a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start();

    // Greeted before any call: the dial is made at initialize, as in 0.10.0.
    await waitForCondition(() => a.hellos.length === 1, "the greeting at initialize");
    const result = await client.callTool("tabs_context");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual(TABS_A.result);
    expect(a.controlTypes).toEqual(["pair-request"]);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
  });

  it("refuses with browser-not-chosen and sends nothing to either browser when two are connected and none chosen", async () => {
    const a = await chrome();
    const b = await edge();
    client = await start();
    await pause(400);

    const result = await client.callTool("tabs_context");

    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      outcome: "denied",
      reason: "browser-not-chosen",
      refusal: { reason: "browser-not-chosen", browsers: [CHROME, EDGE] },
      hint: BROWSER_REFUSAL_HINTS.notChosen,
    });
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
  });

  it("refuses when the remembered browser is offline, even with exactly one other connected (D-018-13)", async () => {
    await mkdir(join(dataDir, "hallpass", "choices"), { recursive: true });
    await writeFile(
      join(dataDir, "hallpass", "choices", `${AGENT_ID}.json`),
      JSON.stringify({ browserId: "browser-gone", chosenAt: "2026-10-03T07:00:00.000Z" }),
    );
    const a = await chrome();
    client = await start();
    await pause(400);

    const result = await client.callTool("tabs_context");

    expect(result.json).toEqual({
      outcome: "denied",
      reason: "browser-not-chosen",
      refusal: { reason: "browser-not-chosen", browsers: [CHROME] },
      hint: BROWSER_REFUSAL_HINTS.notChosen,
    });
    expect(a.frames).toEqual([]);
  });

  it("sends every call, a batch and the session's end to the selected browser alone; the other sees no greeting", async () => {
    const a = await chrome({
      answers: {
        tabs_context: TABS_A,
        browser_batch: { outcome: "ok", result: { results: [{ index: 0, outcome: "ok" }] } },
      },
    });
    const b = await edge();
    client = await start();

    const selected = await client.callTool("select_browser", { browserId: CHROME.browserId });
    expect(selected.json).toEqual(CHROME);
    const listed = await client.callTool("tabs_context");
    const batch = await client.callTool("browser_batch", {
      tabId: 41,
      steps: [{ tool: "click", args: { target: { ref: "btn-1" } } }],
    });
    const sessionId = a.hellos[0]?.sessionId;
    await client.close();
    client = undefined;
    await waitForCondition(() => a.closes > 0, "the session's socket to close");

    expect(listed.isError, listed.text).toBe(false);
    expect(batch.isError, batch.text).toBe(false);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context", "browser_batch"]);
    expect(a.frames).toContainEqual({ type: "stop", sessionId });
    expect(b.frames).toEqual([]);
  });

  it("re-resolves before the first call: a second browser appearing drops the idle link and the call is refused", async () => {
    const a = await chrome();
    client = await start();
    await waitForCondition(() => a.hellos.length === 1, "the greeting at initialize");

    const b = await edge();
    // Not bound yet (D-018-12): the idle link to the one-time only browser is closed, which only
    // removes an idle session card there.
    await waitForCondition(() => a.closes === 1, "the idle link to close");
    const result = await client.callTool("tabs_context");

    expect((result.json as { reason: string }).reason).toBe("browser-not-chosen");
    // The session's end, which takes its idle card down - and no pairing request, no call.
    expect(a.controlTypes).toEqual(["stop"]);
    expect(a.requests).toEqual([]);
    expect(b.frames).toEqual([]);
  });

  it("keeps the browser of the first forwarded call when a second appears afterwards (D-018-12)", async () => {
    const a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start();
    expect((await client.callTool("tabs_context")).isError).toBe(false);

    const b = await edge();
    await pause(400);
    const again = await client.callTool("tabs_context");

    expect(again.isError, again.text).toBe(false);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context", "tabs_context"]);
    expect(a.closes).toBe(0);
    expect(b.frames).toEqual([]);
  });

  it("does not refuse while the bound browser's worker recycles inside the attach bound (FR-277)", async () => {
    let a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start({ HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "4000" });
    expect((await client.callTool("tabs_context")).isError).toBe(false);

    await forget(a);
    const pending = client.callTool("tabs_context");
    await pause(500);
    a = await chrome({ answers: { tabs_context: TABS_A } });

    const result = await pending;
    expect(result.isError, result.text).toBe(false);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
  });

  it("refuses browser-disconnected beyond the attach bound even with exactly one other connected, sending it nothing", async () => {
    const a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start({ HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "600" });
    expect((await client.callTool("tabs_context")).isError).toBe(false);
    const b = await edge();

    await forget(a);
    await pause(900);
    const result = await client.callTool("tabs_context");

    expect(result.json).toEqual({
      outcome: "denied",
      reason: "browser-disconnected",
      refusal: { reason: "browser-disconnected", browser: CHROME, browsers: [EDGE] },
      hint: BROWSER_REFUSAL_HINTS.disconnected("Chrome"),
    });
    expect(b.frames).toEqual([]);
  });

  it("switches A to B: the running call finishes on A, A's link closes after it, B asks for pairing and the pictures are gone", async () => {
    const PICTURE = "iVBORw0KGgoAAAANSUhEUg==";
    const a = await chrome({
      answers: {
        screenshot: { outcome: "ok", result: { mimeType: "image/png", data: PICTURE, cropped: false } },
        get_page_text: "hang",
      },
    });
    const b = await edge();
    client = await start();
    await client.callTool("select_browser", { browserId: CHROME.browserId });
    const shot = await client.callTool("screenshot", { tabId: 3 });
    const { imageId } = shot.json as { imageId: string };

    const running = client.callTool("get_page_text", { tabId: 3 });
    await waitForCondition(() => a.requests.some((request) => request.tool === "get_page_text"), "the call to reach A");
    const switched = await client.callTool("select_browser", { browserId: EDGE.browserId });
    expect(switched.json).toEqual(EDGE);
    await pause(300);
    // Still carrying a call: A's link is not closed under it.
    expect(a.closes).toBe(0);

    const callId = a.requests.find((request) => request.tool === "get_page_text")!.callId;
    a.send({ callId, outcome: "ok", result: { tabId: 3, text: "from A" } });
    const answered = await running;
    expect(answered.isError, answered.text).toBe(false);
    expect(answered.json).toEqual({ tabId: 3, text: "from A" });
    await waitForCondition(() => a.closes === 1, "A's link to close once drained");

    const refused = await client.callTool("upload_image", { tabId: 3, imageId, ref: "tgt-1" });
    expect((refused.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
    // FR-275, D-018-14: B is a browser this session was never paired in, so it asks.
    expect(b.controlTypes).toEqual(["pair-request"]);
    expect(b.requests).toEqual([]);
    expect(a.requests.map((request) => request.tool)).toEqual(["screenshot", "get_page_text"]);
  });

  it("refuses in B a picture A answered after the switch, sending B no upload (T507 M1)", async () => {
    const PICTURE = "iVBORw0KGgoAAAANSUhEUg==";
    const a = await chrome({ answers: { screenshot: "hang" } });
    const b = await edge();
    client = await start();
    await client.callTool("select_browser", { browserId: CHROME.browserId });

    const shooting = client.callTool("screenshot", { tabId: 3 });
    await waitForCondition(() => a.requests.some((request) => request.tool === "screenshot"), "the screenshot to reach A");
    await client.callTool("select_browser", { browserId: EDGE.browserId });
    const callId = a.requests.find((request) => request.tool === "screenshot")!.callId;
    a.send({ callId, outcome: "ok", result: { mimeType: "image/png", data: PICTURE, cropped: false } });
    const shot = await shooting;
    const { imageId } = shot.json as { imageId: string };

    const refused = await client.callTool("upload_image", { tabId: 3, imageId, ref: "tgt-1" });

    expect(refused.isError).toBe(true);
    expect((refused.json as { reason: string }).reason).toMatch(/^unknown-image-id/u);
    expect(b.requests).toEqual([]);
  });

  it("refuses in B a tab id A handed out from a tabs_context step inside a batch (T507 m2)", async () => {
    const a = await chrome({
      answers: {
        browser_batch: {
          outcome: "ok",
          result: { results: [{ index: 0, outcome: "ok", result: [{ tabId: 55, url: "https://a.test/" }] }] },
        },
      },
    });
    const b = await edge();
    client = await start();
    await client.callTool("select_browser", { browserId: CHROME.browserId });
    const batch = await client.callTool("browser_batch", { tabId: 7, steps: [{ tool: "tabs_context", args: {} }] });
    expect(batch.isError, batch.text).toBe(false);
    await client.callTool("select_browser", { browserId: EDGE.browserId });

    const result = await client.callTool("get_page_text", { tabId: 55 });

    expect(result.json).toEqual({ outcome: "stale", reason: "tab-gone" });
    expect(a.requests.map((request) => request.tool)).toEqual(["browser_batch"]);
    expect(b.controlTypes).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it("refuses in B a tab id A reported as opened by a click (observed.newTabs, T507 m2)", async () => {
    const a = await chrome({
      answers: {
        click: {
          outcome: "ok",
          result: { observed: { newTabs: [{ tabId: 66, url: "https://a.test/popup", held: false }] } },
        },
      },
    });
    const b = await edge();
    client = await start();
    await client.callTool("select_browser", { browserId: CHROME.browserId });
    const clicked = await client.callTool("click", { tabId: 7, target: { ref: "btn-1" } });
    expect(clicked.isError, clicked.text).toBe(false);
    await client.callTool("select_browser", { browserId: EDGE.browserId });

    const result = await client.callTool("get_page_text", { tabId: 66 });

    expect(result.json).toEqual({ outcome: "stale", reason: "tab-gone" });
    expect(a.requests.map((request) => request.tool)).toEqual(["click"]);
    expect(b.controlTypes).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it("waits out the bound browser's recycle with another browser connected, sending that one nothing", async () => {
    let a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start({ HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "4000" });
    expect((await client.callTool("tabs_context")).isError).toBe(false);
    const b = await edge();

    await forget(a);
    const pending = client.callTool("tabs_context");
    await pause(500);
    a = await chrome({ answers: { tabs_context: TABS_A } });

    const result = await pending;
    expect(result.isError, result.text).toBe(false);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
    expect(b.frames).toEqual([]);
  });

  it("binds two concurrent first calls to the same one browser", async () => {
    const a = await chrome({ answers: { tabs_context: TABS_A } });
    client = await start();

    const [first, second] = await Promise.all([client.callTool("tabs_context"), client.callTool("tabs_context")]);
    const b = await edge();
    await pause(400);
    const third = await client.callTool("tabs_context");

    for (const result of [first, second, third]) expect(result.isError, result.text).toBe(false);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context", "tabs_context", "tabs_context"]);
    expect(a.controlTypes).toEqual(["pair-request"]);
    expect(b.frames).toEqual([]);
  });

  it("refuses a tab id issued by A once the session is on B, before any pairing or call frame (FR-276)", async () => {
    const a = await chrome({ answers: { tabs_context: TABS_A } });
    const b = await edge();
    client = await start();
    await client.callTool("select_browser", { browserId: CHROME.browserId });
    expect((await client.callTool("tabs_context")).isError).toBe(false);
    await client.callTool("select_browser", { browserId: EDGE.browserId });

    const result = await client.callTool("get_page_text", { tabId: 41 });

    expect(result.json).toEqual({ outcome: "stale", reason: "tab-gone" });
    expect(b.controlTypes).toEqual([]);
    expect(b.requests).toEqual([]);
    expect(a.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
  });
});
