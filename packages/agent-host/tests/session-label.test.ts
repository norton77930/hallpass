import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstFileRoot, ROOTS_TIMEOUT_ENV } from "../src/mcp-server.js";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { MCP_SERVER_ENTRY, startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

type RootsAnswer = { roots: Array<{ uri: string; name?: string }> };

/**
 * A client that advertises `roots` and answers `roots/list` however the case says - refusing, or
 * never at all - which the shared harness, answering with a fixed list, cannot. Spawns the same
 * built server the same way.
 */
async function startRootsClient(options: {
  cwd: string;
  env: Record<string, string>;
  answer: () => Promise<RootsAnswer>;
}): Promise<{ stderr(): string; close(): Promise<void> }> {
  let stderrText = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_ENTRY],
    stderr: "pipe",
    cwd: options.cwd,
    env: { ...(process.env as Record<string, string>), HALLPASS_AGENT_DIAL_RETRY_MS: "100", ...options.env },
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  const client = new Client({ name: "claude-code", version: "0.0.0" }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, options.answer);
  await client.connect(transport);
  return { stderr: () => stderrText, close: () => client.close() };
}

/**
 * 016 T433 - the session label, host side (FR-226, R-203, R-204, contracts/session-label.md).
 *
 * The built `dist/mcp-server.js` is spawned with a working directory of the test's choosing and,
 * where a case needs it, a client that advertises `roots`; the fake worker records every link frame
 * after the greeting. So what is asserted is what the real server puts on the wire: the last folder
 * name, once per `hello-ack`, and never in its own log.
 */
describe("016 session label", () => {
  let dataDir = "";
  let scratch = "";
  let project = "";
  let client: McpHarnessClient | undefined;
  let rootsClient: { stderr(): string; close(): Promise<void> } | undefined;
  let worker: FakeAgentWorker | undefined;

  const TABS = {
    tabs_context: { callId: "", outcome: "ok" as const, result: [{ tabId: 3, url: "https://a.test/" }] },
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-"));
    scratch = await mkdtemp(join(tmpdir(), "hallpass-label-"));
    project = join(scratch, "shop-frontend");
    await mkdir(project);
  });

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    await rootsClient?.close();
    worker = undefined;
    client = undefined;
    rootsClient = undefined;
    await rm(dataDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  function labels(from: FakeAgentWorker): unknown[] {
    return from.linkFrames.filter((frame) => frame.type === "session-label");
  }

  /** A call round-trips after the attach, so a label sent on that attach has arrived by its end. */
  async function settleAfterAttach(): Promise<void> {
    await expect(client!.callTool("tabs_context")).resolves.toMatchObject({ isError: false });
  }

  it("labels the session with the last segment of the server's working directory", async () => {
    client = await startMcpClient({ cwd: project, env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    const hello = await worker.waitForHello();
    await settleAfterAttach();

    expect(labels(worker)).toEqual([{ type: "session-label", sessionId: hello.sessionId, label: "shop-frontend" }]);
  });

  it("sends no label for the home directory", async () => {
    client = await startMcpClient({ cwd: homedir(), env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    await worker.waitForHello();
    await settleAfterAttach();

    expect(labels(worker)).toEqual([]);
  });

  it("sends no label for a drive root", async () => {
    client = await startMcpClient({ cwd: parse(tmpdir()).root, env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    await worker.waitForHello();
    await settleAfterAttach();

    expect(labels(worker)).toEqual([]);
  });

  it("prefers the first file:// root when the client advertises roots", async () => {
    client = await startMcpClient({
      cwd: project,
      // `file://` only: the SDK's `RootSchema` refuses any other scheme, failing the whole answer.
      roots: [
        { uri: pathToFileURL(join(scratch, "checkout-service")).href, name: "service" },
        { uri: pathToFileURL(join(scratch, "second-root")).href },
      ],
      env: { LOCALAPPDATA: dataDir },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    const hello = await worker.waitForHello();
    await worker.waitForLinkFrame("session-label");
    await settleAfterAttach();

    expect(labels(worker)).toEqual([{ type: "session-label", sessionId: hello.sessionId, label: "checkout-service" }]);
  });

  it("tries the next file:// root when one names no local path (T444 F4)", () => {
    const second = join(scratch, "second-root");

    // An encoded separator is a URL `fileURLToPath` refuses on every platform.
    expect(firstFileRoot([{ uri: "file:///C:/bad%2Fpath" }, { uri: pathToFileURL(second).href }])).toBe(
      fileURLToPath(pathToFileURL(second).href),
    );
    expect(firstFileRoot([{ uri: "file:///C:/bad%2Fpath" }])).toBeUndefined();
  });

  it("falls back to the working directory, with a code, when the client refuses roots/list", async () => {
    rootsClient = await startRootsClient({
      cwd: project,
      env: { LOCALAPPDATA: dataDir },
      answer: async () => {
        throw new Error("roots are private");
      },
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    const hello = await worker.waitForHello();
    await worker.waitForLinkFrame("session-label");

    expect(labels(worker)).toEqual([{ type: "session-label", sessionId: hello.sessionId, label: "shop-frontend" }]);
    expect(rootsClient.stderr()).toContain("agent.session.roots-unavailable");
  });

  it("falls back to the working directory when the client never answers roots/list", async () => {
    rootsClient = await startRootsClient({
      cwd: project,
      // The product's bound is 5 s; the SDK's own default, which stood before, is 60 s.
      env: { LOCALAPPDATA: dataDir, [ROOTS_TIMEOUT_ENV]: "300" },
      answer: () => new Promise<RootsAnswer>(() => {}),
    });
    worker = await startFakeAgentWorker({ env: { LOCALAPPDATA: dataDir }, answers: TABS });
    const hello = await worker.waitForHello();
    await worker.waitForLinkFrame("session-label", 4_000);

    expect(labels(worker)).toEqual([{ type: "session-label", sessionId: hello.sessionId, label: "shop-frontend" }]);
    expect(rootsClient.stderr()).toContain("agent.session.roots-unavailable");
  });

  it("sends the label again after a re-greeting, and never writes the path or label to stderr", async () => {
    client = await startMcpClient({ cwd: project, env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      answers: {
        // The owner pressed Stop: the host greets again under the same id (006 FR-087).
        tabs_context: ({ callId }) =>
          worker!.hellos.length < 2
            ? { callId, outcome: "denied", reason: "session-ended" }
            : { callId, outcome: "ok", result: [{ tabId: 12, url: "https://example.test/" }] },
      },
    });
    const hello = await worker.waitForHello();
    await settleAfterAttach();

    expect(worker.hellos).toHaveLength(2);
    const frame = { type: "session-label", sessionId: hello.sessionId, label: "shop-frontend" };
    expect(labels(worker)).toEqual([frame, frame]);
    expect(client.stderr()).not.toContain("shop-frontend");
    expect(client.stderr()).not.toContain(scratch);
  });
});
