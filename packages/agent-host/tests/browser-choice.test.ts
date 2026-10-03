import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  AGENT_BROWSER_CHOICE_BOUND_MS,
  AGENT_LINK_PROTOCOL,
  ATTENTION_SENTENCES,
  BROWSER_CHOICE_FEATURE,
  type AgentBrowserKind,
} from "@hallpass/contracts";
import { listenAndPublish, type FrameChannel } from "../src/bridge-link.js";
import { browserRecordPath, writeBrowserRecord } from "../src/browser-record.js";
import {
  BROWSER_CHOICE_HINTS,
  BROWSER_CHOICE_PROGRESS_MESSAGE,
  BROWSER_CHOICE_SLACK_MS,
} from "../src/browser-choice-coordinator.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 018/S5 (T508, FR-274, R-273, R-279) - the in-browser choice, coordinated by the requesting
 * session's server against stand-in relays that each publish their own `browsers/<id>.json`.
 *
 * The frames each relay received are the evidence: a browser that cannot show the card is sent
 * nothing, a choice travels on its own choose-only link under a derived session id, and the
 * session's own link is never replaced by it. Spawns the built `dist/mcp-server.js`.
 */

/** What a stand-in worker does with a choice card: answer it, leave it, or drop its link. */
type ChoiceScript = {
  decision: "confirm" | "decline" | "ignore" | "drop";
  afterMs?: number;
  /** The worker's side panel is closed: it ticks `prompt-waiting{kind:"browser-choice"}` on the choose link. */
  panelClosed?: boolean;
};

type FakeBrowser = {
  readonly browserId: string;
  readonly frames: unknown[];
  readonly hellos: Array<{ sessionId: string; intent?: string }>;
  readonly choiceRequests: Array<{ sessionId: string; requestId: string; agentName: string; boundMs: number }>;
  readonly withdraws: Array<{ sessionId: string; requestId: string }>;
  readonly controlTypes: string[];
  readonly toolCalls: string[];
  /** The session ids whose sockets this relay saw close. */
  readonly closedSessions: string[];
  close(): Promise<void>;
};

async function startFakeBrowser(options: {
  dataDir: string;
  browserId: string;
  kind: AgentBrowserKind;
  startedAt: string;
  capable: boolean;
  choice?: ChoiceScript;
}): Promise<FakeBrowser> {
  const env = { LOCALAPPDATA: options.dataDir };
  const token = randomBytes(32).toString("hex");
  const sessionOf = new Map<FrameChannel, string>();
  const browser: FakeBrowser = {
    browserId: options.browserId,
    frames: [],
    hellos: [],
    choiceRequests: [],
    withdraws: [],
    controlTypes: [],
    toolCalls: [],
    closedSessions: [],
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
          sessionOf.set(channel, link.data.sessionId);
          browser.hellos.push({
            sessionId: link.data.sessionId,
            ...(link.data.intent === undefined ? {} : { intent: link.data.intent }),
          });
          channel.send({ type: "hello-ack", relayPid: process.pid });
          return;
        }
        if (link.success && link.data.type === "browser-choice-request") {
          const request = link.data;
          browser.choiceRequests.push({
            sessionId: request.sessionId,
            requestId: request.requestId,
            agentName: request.agentName,
            boundMs: request.boundMs,
          });
          const script = options.choice ?? { decision: "ignore" };
          if (script.panelClosed === true) {
            channel.send({
              type: "prompt-waiting",
              sessionId: request.sessionId,
              kind: "browser-choice",
              panelConnected: false,
              waitedMs: 0,
              boundMs: request.boundMs,
            });
          }
          if (script.decision === "ignore") return;
          setTimeout(() => {
            if (script.decision === "drop") {
              void channel.close();
              return;
            }
            channel.send({
              type: "browser-choice-result",
              sessionId: request.sessionId,
              requestId: request.requestId,
              decision: script.decision,
            });
          }, script.afterMs ?? 0);
          return;
        }
        if (link.success && link.data.type === "browser-choice-withdraw") {
          browser.withdraws.push({ sessionId: link.data.sessionId, requestId: link.data.requestId });
          return;
        }
        const request = agentNativeRequestSchema.safeParse(value);
        if (request.success) {
          browser.toolCalls.push(request.data.tool);
          channel.send({ callId: request.data.callId, outcome: "ok", result: [] });
          return;
        }
        const control = agentControlFrameSchema.safeParse(value);
        if (!control.success) return;
        browser.controlTypes.push(control.data.type);
        if (control.data.type === "pair-request") {
          channel.send({
            type: "pair-result",
            agentId: control.data.agentId,
            sessionId: control.data.sessionId,
            accepted: true,
          });
        }
      },
      onClose(channel) {
        const sessionId = sessionOf.get(channel);
        if (sessionId !== undefined) browser.closedSessions.push(sessionId);
      },
    },
    { env, token, publishOnListen: false },
  );
  await writeBrowserRecord(
    {
      browserId: options.browserId,
      kind: options.kind,
      legacy: false,
      features: options.capable ? [BROWSER_CHOICE_FEATURE] : [],
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
const AGENT_ID = "b".repeat(32);

describe("018 S5 request_browser_choice", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  const browsers: FakeBrowser[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-"));
    await mkdir(join(dataDir, "hallpass"), { recursive: true });
    await writeFile(join(dataDir, "hallpass", "agent-id"), `${AGENT_ID}\n`, "utf8");
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    for (const browser of browsers.splice(0)) await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function chrome(capable: boolean, choice?: ChoiceScript): Promise<FakeBrowser> {
    const browser = await startFakeBrowser({
      dataDir,
      ...CHROME,
      startedAt: "2026-10-03T08:00:00.000Z",
      capable,
      ...(choice === undefined ? {} : { choice }),
    });
    browsers.push(browser);
    return browser;
  }

  async function edge(capable: boolean, choice?: ChoiceScript): Promise<FakeBrowser> {
    const browser = await startFakeBrowser({
      dataDir,
      ...EDGE,
      startedAt: "2026-10-03T09:00:00.000Z",
      capable,
      ...(choice === undefined ? {} : { choice }),
    });
    browsers.push(browser);
    return browser;
  }

  function start(env: Record<string, string> = {}): Promise<McpHarnessClient> {
    return startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir, ...env } });
  }

  async function remembered(): Promise<string | undefined> {
    try {
      const text = await readFile(join(dataDir, "hallpass", "choices", `${AGENT_ID}.json`), "utf8");
      return (JSON.parse(text) as { browserId: string }).browserId;
    } catch {
      return undefined;
    }
  }

  async function current(): Promise<string | undefined> {
    const listed = (await client!.callTool("list_browsers")).json as {
      browsers: Array<{ browserId: string; current: boolean }>;
    };
    return listed.browsers.find((browser) => browser.current)?.browserId;
  }

  it("asks only the browsers that advertised the card, on a choose link under a derived id, and selects the confirmer", async () => {
    const a = await chrome(true, { decision: "confirm" });
    const b = await edge(false);
    client = await start();
    await pause(300);

    const result = await client.callTool("request_browser_choice");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual(CHROME);
    expect(b.frames).toEqual([]);
    const [hello] = a.hellos;
    expect(hello?.intent).toBe("choose");
    expect(a.choiceRequests).toEqual([
      {
        sessionId: hello!.sessionId,
        requestId: expect.any(String),
        agentName: "Claude Code",
        boundMs: AGENT_BROWSER_CHOICE_BOUND_MS,
      },
    ]);
    // Settled: the choose link is closed, which the relay reads as that link's session ending.
    await waitForCondition(() => a.closedSessions.includes(hello!.sessionId), "the choose link to close");
    expect(await remembered()).toBe(CHROME.browserId);
    expect(await current()).toBe(CHROME.browserId);
  });

  it("never replaces the session's own link: the choose link's id is derived and the bound link keeps its pairing", async () => {
    const a = await chrome(true, { decision: "confirm" });
    client = await start();
    expect((await client.callTool("tabs_context")).isError).toBe(false);
    const own = a.hellos[0]!.sessionId;

    const result = await client.callTool("request_browser_choice");
    expect(result.json).toEqual(CHROME);
    const choose = a.hellos.find((hello) => hello.intent === "choose")!;
    await waitForCondition(() => a.closedSessions.includes(choose.sessionId), "the choose link to close");
    const again = await client.callTool("tabs_context");

    expect(choose.sessionId).not.toBe(own);
    expect(choose.sessionId.startsWith(own)).toBe(true);
    expect(a.closedSessions).not.toContain(own);
    expect(again.isError, again.text).toBe(false);
    expect(a.controlTypes).toEqual(["pair-request"]);
    expect(a.toolCalls).toEqual(["tabs_context", "tabs_context"]);
  });

  it("settles on the first confirm and withdraws the other browser's card", async () => {
    const a = await chrome(true, { decision: "confirm", afterMs: 150 });
    const b = await edge(true, { decision: "ignore" });
    client = await start();
    await pause(300);

    const result = await client.callTool("request_browser_choice");

    expect(result.json).toEqual(CHROME);
    const edgeRequest = b.choiceRequests[0]!;
    await waitForCondition(() => b.closedSessions.includes(edgeRequest.sessionId), "the other choose link to close");
    expect(b.withdraws).toEqual([{ sessionId: edgeRequest.sessionId, requestId: edgeRequest.requestId }]);
    expect(a.withdraws).toEqual([]);
    expect(await remembered()).toBe(CHROME.browserId);
  });

  it("answers chosen:false when every browser declines, leaving the earlier choice standing", async () => {
    const a = await chrome(true, { decision: "decline" });
    const b = await edge(true, { decision: "decline", afterMs: 50 });
    client = await start();
    expect((await client.callTool("select_browser", { browserId: EDGE.browserId })).json).toEqual(EDGE);

    const result = await client.callTool("request_browser_choice");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual({ chosen: false });
    const chooseA = a.hellos.find((hello) => hello.intent === "choose")!;
    const chooseB = b.hellos.find((hello) => hello.intent === "choose")!;
    await waitForCondition(
      () => a.closedSessions.includes(chooseA.sessionId) && b.closedSessions.includes(chooseB.sessionId),
      "both choose links to close",
    );
    expect(await remembered()).toBe(EDGE.browserId);
    expect(await current()).toBe(EDGE.browserId);
  });

  it("answers chosen:false when the bound passes, withdrawing every card still up", async () => {
    const a = await chrome(true, { decision: "ignore" });
    const b = await edge(true, { decision: "ignore" });
    client = await start({ HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS: "400" });
    await pause(300);

    const result = await client.callTool("request_browser_choice");

    expect(result.json).toEqual({ chosen: false });
    expect(a.choiceRequests[0]?.boundMs).toBe(400);
    await waitForCondition(() => a.withdraws.length === 1 && b.withdraws.length === 1, "both cards withdrawn");
    expect(await remembered()).toBeUndefined();
  });

  // T515 m3 (US3 AS4): unanswered with the owner's panel closed, the agent is told to have it opened.
  it("adds the panel-closed sentence when the choice ends unanswered after the worker said its panel is closed", async () => {
    await chrome(true, { decision: "ignore", panelClosed: true });
    client = await start({ HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS: "400" });
    await pause(300);

    const result = await client.callTool("request_browser_choice");

    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual({ chosen: false, hint: ATTENTION_SENTENCES.consent });
  });

  it("answers at once with a hint when no connected browser can show the card, sending nothing", async () => {
    const a = await chrome(false);
    const b = await edge(false);
    client = await start();
    await pause(300);

    const started = Date.now();
    const result = await client.callTool("request_browser_choice");

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isError, result.text).toBe(false);
    expect(result.json).toEqual({ chosen: false, hint: BROWSER_CHOICE_HINTS.noneCapable });
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
  });

  it("counts a choice link that drops as that browser not answering", async () => {
    await chrome(true, { decision: "drop" });
    await edge(true, { decision: "decline", afterMs: 100 });
    client = await start({ HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS: "20000" });
    await pause(300);

    const started = Date.now();
    const result = await client.callTool("request_browser_choice");

    expect(result.json).toEqual({ chosen: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a client with a short request timeout alive with progress ticks while the card waits", async () => {
    await chrome(true, { decision: "ignore" });
    client = await start({
      HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS: "1500",
      HALLPASS_AGENT_PAIRING_PROGRESS_MS: "150",
    });
    await pause(300);
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];

    // 600 ms is far shorter than the 3.5 s wait: only the ticks, each restarting it, keep the call.
    const result = await client.callTool(
      "request_browser_choice",
      {},
      { onProgress: (update) => seen.push(update), timeoutMs: 600, resetTimeoutOnProgress: true },
    );

    expect(result.json).toEqual({ chosen: false });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((update) => update.message === BROWSER_CHOICE_PROGRESS_MESSAGE)).toBe(true);
    expect(seen[0]?.total).toBe(1500 + BROWSER_CHOICE_SLACK_MS);
  });

  it("does not hold the request open for a browser whose link never attaches once the others have answered", async () => {
    // A capable browser whose relay is published but answers nothing: its port is closed.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env = { LOCALAPPDATA: dataDir };
    await writeBrowserRecord(
      {
        browserId: "browser-brave",
        kind: "brave",
        legacy: false,
        features: [BROWSER_CHOICE_FEATURE],
        relayPid: process.pid,
        port: deadPort,
        token: randomBytes(32).toString("hex"),
        startedAt: "2026-10-03T10:00:00.000Z",
        protocol: AGENT_LINK_PROTOCOL,
      },
      env,
    );
    await chrome(true, { decision: "decline", afterMs: 50 });
    client = await start({
      HALLPASS_AGENT_BROWSER_CHOICE_BOUND_MS: "20000",
      HALLPASS_AGENT_ATTACH_TIMEOUT_MS: "800",
      HALLPASS_AGENT_DIAL_RETRY_MS: "100",
    });
    await pause(300);

    const started = Date.now();
    const result = await client.callTool("request_browser_choice");

    expect(result.json).toEqual({ chosen: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(browserRecordPath("browser-brave", env), { force: true });
  });

  it("supersedes an open request from the same session: the first answers chosen:false and its cards are withdrawn", async () => {
    const a = await chrome(true, { decision: "ignore" });
    client = await start();
    await pause(300);

    const first = client.callTool("request_browser_choice");
    await waitForCondition(() => a.choiceRequests.length === 1, "the first card");
    const second = client.callTool("request_browser_choice");

    expect((await first).json).toEqual({ chosen: false });
    await waitForCondition(() => a.choiceRequests.length === 2, "the second card");
    const [one, two] = a.choiceRequests;
    expect(a.withdraws).toContainEqual({ sessionId: one!.sessionId, requestId: one!.requestId });
    expect(two!.sessionId).not.toBe(one!.sessionId);
    expect(two!.requestId).not.toBe(one!.requestId);
    await client.close();
    client = undefined;
    await second.catch(() => undefined);
  });
});
