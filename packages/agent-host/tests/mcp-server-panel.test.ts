import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentControlFrameSchema,
  agentLinkFrameSchema,
  agentNativeRequestSchema,
  AGENT_LINK_PROTOCOL,
  type AgentBrowserKind,
  type AgentNativeRequest,
} from "@hallpass/contracts";
import { listenAndPublish, type FrameChannel } from "../src/bridge-link.js";
import { browserRecordPath, writeBrowserRecord } from "../src/browser-record.js";
import { MCP_SERVER_ENTRY, startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 019/T551 (R-321, R-322, FR-305): the mcp-server the broker starts for a panel conversation.
 *
 * With `HALLPASS_PANEL_TOKEN`, `HALLPASS_PANEL_BROWSER` and `HALLPASS_PANEL_CONVERSATION` the server
 * is that conversation's: agent id `panel:<conversationId>` (never the shared per-user id), the one
 * browser the broker named and no other, no remembered choice read or written and no choice card,
 * the token in its greeting and nowhere else - and one line in its instructions. Spawns the built
 * `dist/mcp-server.js`, as `browser-routing.test.ts` does; two stand-in relays publish their records.
 */

type Greeting = { sessionId: string; agentId: string; panelToken?: string };

type FakeBrowser = {
  readonly browserId: string;
  readonly frames: unknown[];
  readonly hellos: Greeting[];
  readonly requests: AgentNativeRequest[];
  readonly controlTypes: string[];
  close(): Promise<void>;
};

async function startFakeBrowser(options: {
  dataDir: string;
  browserId: string;
  kind: AgentBrowserKind;
  /** How the worker answers pair requests, in order; the last answer repeats. */
  pairing: Array<"accept" | "refuse">;
}): Promise<FakeBrowser> {
  const env = { LOCALAPPDATA: options.dataDir };
  const token = randomBytes(32).toString("hex");
  const browser: FakeBrowser = {
    browserId: options.browserId,
    frames: [],
    hellos: [],
    requests: [],
    controlTypes: [],
    close: async () => undefined,
  };
  let pairs = 0;
  const relay = await listenAndPublish(
    {
      onFrame(channel: FrameChannel, value: unknown) {
        browser.frames.push(value);
        const link = agentLinkFrameSchema.safeParse(value);
        if (link.success && link.data.type === "hello") {
          if (link.data.token !== token) {
            void channel.close();
            return;
          }
          browser.hellos.push({
            sessionId: link.data.sessionId,
            agentId: link.data.agentId,
            ...(link.data.panelToken === undefined ? {} : { panelToken: link.data.panelToken }),
          });
          channel.send({ type: "hello-ack", relayPid: process.pid });
          return;
        }
        const request = agentNativeRequestSchema.safeParse(value);
        if (request.success) {
          browser.requests.push(request.data);
          channel.send({ callId: request.data.callId, outcome: "ok", result: [{ tabId: 7, url: "https://a.test/" }] });
          return;
        }
        const control = agentControlFrameSchema.safeParse(value);
        if (!control.success) return;
        browser.controlTypes.push(control.data.type);
        if (control.data.type === "pair-request") {
          const answer = options.pairing[Math.min(pairs, options.pairing.length - 1)];
          pairs += 1;
          channel.send({
            type: "pair-result",
            agentId: control.data.agentId,
            sessionId: control.data.sessionId,
            accepted: answer === "accept",
          });
        }
      },
      onClose() {},
    },
    { env, token, publishOnListen: false },
  );
  await writeBrowserRecord(
    {
      browserId: options.browserId,
      kind: options.kind,
      legacy: false,
      features: ["browser-choice"],
      relayPid: process.pid,
      port: relay.port,
      token,
      startedAt: "2026-10-19T08:00:00.000Z",
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

const AGENT_ID = "a".repeat(32);
const CONVERSATION = "conv-0123456789abcdef";
const PANEL_TOKEN = randomBytes(32).toString("base64url");
const INSTRUCTIONS_LINE = "You were started from the Hallpass side panel; the user's current tab is in your tab group.";

describe("019 T551 the panel conversation's mcp-server", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  const browsers: FakeBrowser[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-"));
    await mkdir(join(dataDir, "hallpass", "choices"), { recursive: true });
    // The owner's own agent id, and its remembered browser: neither may reach a panel server.
    await writeFile(join(dataDir, "hallpass", "agent-id"), `${AGENT_ID}\n`, "utf8");
    await writeFile(
      join(dataDir, "hallpass", "choices", `${AGENT_ID}.json`),
      JSON.stringify({ browserId: "browser-chrome", chosenAt: "2026-10-19T07:00:00.000Z" }),
    );
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    for (const browser of browsers.splice(0)) await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function twoBrowsers(pairing: Array<"accept" | "refuse"> = ["accept"]) {
    const chrome = await startFakeBrowser({ dataDir, browserId: "browser-chrome", kind: "chrome", pairing: ["accept"] });
    const edge = await startFakeBrowser({ dataDir, browserId: "browser-edge", kind: "edge", pairing });
    browsers.push(chrome, edge);
    return { chrome, edge };
  }

  const panelEnv = (extra: Record<string, string> = {}) => ({
    LOCALAPPDATA: dataDir,
    HALLPASS_PANEL_TOKEN: PANEL_TOKEN,
    HALLPASS_PANEL_BROWSER: "browser-edge",
    HALLPASS_PANEL_CONVERSATION: CONVERSATION,
    ...extra,
  });

  it("greets only the broker's browser, as the conversation, with the token - whatever the owner's agent remembers", async () => {
    const { chrome, edge } = await twoBrowsers();
    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });

    const result = await client.callTool("tabs_context");

    expect(result.isError, result.text).toBe(false);
    expect(edge.hellos).toEqual([expect.objectContaining({ agentId: `panel:${CONVERSATION}`, panelToken: PANEL_TOKEN })]);
    expect(edge.controlTypes).toEqual(["pair-request"]);
    expect(edge.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
    expect(chrome.frames).toEqual([]);
    // No remembered choice written for the panel id (or anything else).
    expect(await readdir(join(dataDir, "hallpass", "choices"))).toEqual([`${AGENT_ID}.json`]);
  });

  it("refuses to change or ask about its browser, and raises no choice card", async () => {
    const { chrome, edge } = await twoBrowsers();
    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });

    const selected = await client.callTool("select_browser", { browserId: "browser-chrome" });
    const asked = await client.callTool("request_browser_choice");

    expect(selected.isError).toBe(true);
    expect(selected.json).toMatchObject({ outcome: "denied", reason: "panel-browser-fixed" });
    expect(asked.json).toMatchObject({ outcome: "denied", reason: "panel-browser-fixed" });
    expect(chrome.frames).toEqual([]);
    expect(edge.hellos.every((hello) => hello.agentId === `panel:${CONVERSATION}`)).toBe(true);
    expect(edge.controlTypes).not.toContain("browser-choice-request");
    expect(await readdir(join(dataDir, "hallpass", "choices"))).toEqual([`${AGENT_ID}.json`]);
  });

  it("says where it was started from in its instructions; an ordinary server does not", async () => {
    await twoBrowsers();
    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });
    expect(client.instructions()).toContain(INSTRUCTIONS_LINE);
    await client.close();

    client = await startMcpClient({ clientName: "claude-code", env: { LOCALAPPDATA: dataDir } });
    expect(client.instructions() ?? "").not.toContain("side panel");
  });

  it("T566 (R-322): under the fallback name it says which browser tools to use; under `hallpass` it says nothing of it", async () => {
    await twoBrowsers();
    client = await startMcpClient({ clientName: "codex", env: panelEnv({ HALLPASS_PANEL_SERVER_NAME: "hallpass_panel" }) });
    const instructions = client.instructions() ?? "";
    expect(instructions).toContain(INSTRUCTIONS_LINE);
    expect(instructions).toContain(
      'Use only the browser tools of the "hallpass_panel" server. A server named "hallpass" from your own settings is a separate connection to this browser: do not use it.',
    );
    await client.close();

    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });
    expect(client.instructions()).not.toContain("hallpass_panel");
  });

  it("answers a refusal as not-admitted and asks again on the next call, never as a sticky unpair", async () => {
    const { edge } = await twoBrowsers(["refuse", "accept"]);
    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });

    const refused = await client.callTool("tabs_context");
    const admitted = await client.callTool("tabs_context");

    expect(refused.json).toMatchObject({ outcome: "denied", reason: "not-admitted" });
    expect((refused.json as { hint?: string }).hint).toMatch(/side panel/u);
    expect(admitted.isError, admitted.text).toBe(false);
    expect(edge.controlTypes.filter((type) => type === "pair-request")).toHaveLength(2);
  });

  it("never writes the token to its log", async () => {
    await twoBrowsers(["refuse", "accept"]);
    client = await startMcpClient({ clientName: "claude-code", env: panelEnv() });
    await client.callTool("tabs_context");
    await client.callTool("tabs_context");
    await client.callTool("select_browser", { browserId: "browser-chrome" });

    await waitForCondition(() => client!.stderr().includes("agent.panel"), "the panel mode's own log codes");
    expect(client.stderr()).not.toContain(PANEL_TOKEN);
  });

  it("will not start with half a panel environment, rather than run as the owner's own agent", async () => {
    const child = spawn(process.execPath, [MCP_SERVER_ENTRY], {
      env: { ...(process.env as Record<string, string>), LOCALAPPDATA: dataDir, HALLPASS_PANEL_TOKEN: PANEL_TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(code).not.toBe(0);
    expect(stderr).toContain("agent.panel.env-refused");
    expect(stderr).not.toContain(PANEL_TOKEN);
  });
});
