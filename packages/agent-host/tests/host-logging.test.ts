import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dialRelay, encodeFrame, FrameDecoder, type RelayDial } from "../src/index.js";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 003/T067 — the two host processes log stable codes, never what the page said.
 *
 * The redaction rule the remote path proves with the test proxy (`contracts/README` §2, SC-025)
 * applies to the agent path too, and the agent path's only files on disk are these logs: the MCP
 * server's stderr, which the agent's own client captures, and `relay.log`, which is written under
 * `%LOCALAPPDATA%` and outlives the browser. Both carry every frame the feature moves, so a logger
 * that wrote what it forwarded would leave page text, typed secrets and query strings in a file
 * nobody consented to.
 *
 * The frames below therefore carry the kinds of content this repository treats as page-derived - a
 * title, a URL with a query, and text the owner typed - and the assertion is that none of it
 * appears in either log, while the codes that make the logs useful still do. The positive half
 * matters as much as the negative one: a log that captured nothing at all would pass a
 * "contains no secrets" check by being empty.
 */

const PAGE_TITLE = "Ordinary review page";
const PAGE_QUERY_URL = "https://127.0.0.1:19443/form?token=zqx-sentinel-query-value";
const TYPED_TEXT = "zqx-sentinel-typed-secret";
const PAGE_TEXT = "Sign in to the review workspace";

const SENTINELS = [PAGE_TITLE, "zqx-sentinel-query-value", TYPED_TEXT, PAGE_TEXT];

const RELAY_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "native-host.js",
);

function expectNoPageContent(label: string, logged: string): void {
  for (const sentinel of SENTINELS) {
    expect(logged.includes(sentinel), `${label} leaked ${JSON.stringify(sentinel)}:\n${logged}`).toBe(
      false,
    );
  }
}

describe("T067 host logging carries codes, not content", () => {
  let client: McpHarnessClient | undefined;
  let worker: FakeAgentWorker | undefined;
  let relay: ChildProcessWithoutNullStreams | undefined;
  let dial: RelayDial | undefined;
  let dataDir = "";

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    await dial?.stop();
    relay?.kill();
    worker = undefined;
    client = undefined;
    relay = undefined;
    dial = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = "";
    }
  });

  it("keeps the MCP server's stderr to codes while a call carries page content both ways", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-log-"));
    client = await startMcpClient({ clientName: "Claude Code", env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        // The answer is as page-derived as the request: a navigation reports where it landed, and
        // a read hands back the page's own words.
        navigate: { callId: "", outcome: "ok", result: { url: PAGE_QUERY_URL, title: PAGE_TITLE } },
        type: { callId: "", outcome: "ok", result: { typed: TYPED_TEXT } },
        get_page_text: { callId: "", outcome: "ok", result: { text: PAGE_TEXT } },
      },
    });

    // The server dials the relay now (004/R-111), so a call made before it is attached would be
    // answered `bridge-lost` and never reach the worker at all. The greeting is the sign that the
    // link is up (004 FR-059a: connecting raises no pairing prompt any more).
    await worker.waitForHello();

    await client.callTool("navigate", { tabId: 12, url: PAGE_QUERY_URL });
    await client.callTool("type", { tabId: 12, target: { ref: "tgt-1" }, text: TYPED_TEXT });
    await client.callTool("get_page_text", { tabId: 12 });

    const logged = client.stderr();
    // The log did its job: the outcome of each call is there to be read.
    expect(logged).toContain("agent.call.completed ok");
    expect(logged).toContain("agent.mcp.initialized");
    expectNoPageContent("mcp-server stderr", logged);
  });

  it("keeps the relay's log file and stderr to codes while frames pass in both directions", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-log-"));

    // The relay is the listener now (004/R-111): Chrome spawns it, it publishes the port, and a
    // stand-in for the MCP server dials in. It interprets nothing it forwards, so the stand-in only
    // has to speak the link's framing and greet.
    let relayStderr = "";
    const toChrome: Buffer[] = [];
    relay = spawn(process.execPath, [RELAY_ENTRY], {
      env: { ...process.env, LOCALAPPDATA: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    relay.stderr.on("data", (chunk: Buffer) => {
      relayStderr += chunk.toString("utf8");
    });
    // Chrome's side of the port answers `relay-started` (004/T169, protocol 2): the relay publishes
    // its record only once it knows it has an owner.
    const started = new FrameDecoder();
    relay.stdout.on("data", (chunk: Buffer) => {
      toChrome.push(chunk);
      for (const frame of started.push(new Uint8Array(chunk))) {
        const link = frame as { type?: unknown; relayPid?: number };
        if (link.type === "relay-started" && typeof link.relayPid === "number") {
          relay?.stdin.write(encodeFrame({ type: "relay-ack", relayPid: link.relayPid }));
        }
      }
    });

    const fromChrome: unknown[] = [];
    dial = dialRelay({
      hello: { sessionId: "session-log", agentId: "agent-log", displayName: "Agent" },
      onFrame: (value) => fromChrome.push(value),
      env: { LOCALAPPDATA: dataDir },
      retryMs: 100,
    });
    await dial.attached;

    // server → Chrome: a call whose arguments are the owner's own typing.
    dial.send({
      callId: "c1",
      sessionId: "session-log",
      tool: "type",
      tabId: 12,
      args: { target: { ref: "tgt-1" }, text: TYPED_TEXT },
    });
    await waitFor(() => Buffer.concat(toChrome).toString("utf8").includes("c1"), "the relay to forward the call");

    // Chrome → server: an answer carrying the page's title, URL and text.
    relay.stdin.write(
      Buffer.from(
        encodeFrame({
          callId: "c1",
          outcome: "ok",
          result: { url: PAGE_QUERY_URL, title: PAGE_TITLE, text: PAGE_TEXT },
        }),
      ),
    );
    await waitFor(() => fromChrome.length > 0, "the relay to route the answer back");

    const relayLog = await readFile(join(dataDir, "hallpass", "relay.log"), "utf8");
    // Both directions are traceable, which is what makes the file worth keeping at all.
    expect(relayLog).toContain("relay.started");
    expect(relayLog).toContain("relay.to-server");
    expect(relayLog).toContain("relay.to-chrome");
    expectNoPageContent("relay.log", relayLog);
    expectNoPageContent("relay stderr", relayStderr);
    // The frames themselves did travel - the relay forwarded content it never logged, both ways.
    expect(Buffer.concat(toChrome).toString("utf8")).toContain(TYPED_TEXT);
    expect(JSON.stringify(fromChrome)).toContain(PAGE_TITLE);
  });
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((tick) => setTimeout(tick, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
