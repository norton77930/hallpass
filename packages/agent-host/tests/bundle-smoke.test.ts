import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeAgentWorker, type FakeAgentWorker } from "../../../tests/harness/fake-agent-worker.js";
import { startMcpClient, type McpHarnessClient } from "../../../tests/harness/mcp-client.js";

/**
 * 007/T203 — the QA package's bundled `host/mcp-server.js` behaves as the unbundled one (FR-095).
 *
 * It is the `mcp-server.test.ts` pairing round trip run against the bundle instead of `dist/`:
 * the same stdio client on one side, the same fake relay on the other. `npm run package` runs it
 * with `HALLPASS_HOST_BUNDLE` pointing at the file it just bundled and fails the package on red; in an
 * ordinary `npm test` there is no bundle and the test skips, because a checkout is not a package.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundlePath = process.env.HALLPASS_HOST_BUNDLE ?? resolve(repoRoot, "release/stage/host/mcp-server.js");
const bundlePresent = existsSync(bundlePath);

describe.skipIf(!bundlePresent)("T203 bundled mcp-server", () => {
  let dataDir = "";
  let client: McpHarnessClient | undefined;
  let worker: FakeAgentWorker | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-bundle-"));
  });

  afterEach(async () => {
    await worker?.close();
    await client?.close();
    worker = undefined;
    client = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("initializes, pairs, and carries tabs_context through the fake worker from the bundle", async () => {
    client = await startMcpClient({ clientName: "QA Client", entry: bundlePath, env: { LOCALAPPDATA: dataDir } });
    worker = await startFakeAgentWorker({
      env: { LOCALAPPDATA: dataDir },
      pairing: "accept",
      answers: {
        tabs_context: { callId: "", outcome: "ok", result: [{ tabId: 12, url: "https://example.test/" }] },
      },
    });

    const names = await client.listToolNames();
    expect(names).toContain("tabs_context");

    // 004 FR-059a: the call is what raises the pairing request, not the connect.
    const result = await client.callTool("tabs_context");
    const pairRequest = await worker.waitForControlFrame("pair-request");
    expect(pairRequest).toMatchObject({ type: "pair-request", displayName: "QA Client", origin: "stdio:local" });
    expect(result.isError).toBe(false);
    expect(result.json).toEqual([{ tabId: 12, url: "https://example.test/" }]);
    expect(worker.requests.map((request) => request.tool)).toEqual(["tabs_context"]);
  });
});
