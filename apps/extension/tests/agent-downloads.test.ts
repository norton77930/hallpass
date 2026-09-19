import { describe, expect, it } from "vitest";
import type { AgentDownloadRecord, AgentNativeRequest } from "@hallpass/contracts";
import { createAgentDownloadTools } from "../src/service-worker/agent-tools/downloads.js";

/**
 * 005/T181 — `downloads_context` (US2, FR-079).
 *
 * A read of the session's own ring and nothing else: no lease, no tab, no page. The runner's
 * whole job is to answer in the contract's shape from what the observer kept for *this* session.
 */

const RECORD: AgentDownloadRecord = {
  id: 12,
  filename: "C:\\Users\\owner\\Downloads\\report.csv",
  url: "https://example.test/report.csv",
  state: "complete",
  startedAt: "2026-09-13T10:00:00.000Z",
  endedAt: "2026-09-13T10:00:01.000Z",
  bytesReceived: 1024,
  totalBytes: 1024,
  danger: false,
  attribution: "session",
};

function request(sessionId: string, args: Record<string, unknown> = {}): AgentNativeRequest {
  return { callId: "call-1", sessionId, tool: "downloads_context", args } as AgentNativeRequest;
}

describe("T181 downloads_context", () => {
  it("lists the session's ring, and only the session's, without a lease", async () => {
    const rings: Record<string, AgentDownloadRecord[]> = { "session-a": [RECORD] };
    const runner = createAgentDownloadTools({ list: async (sessionId) => rings[sessionId] ?? [] });

    expect(runner.handles("downloads_context")).toBe(true);
    expect(runner.handles("tabs_context")).toBe(false);
    await expect(runner.run(request("session-a"))).resolves.toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { downloads: [RECORD] },
    });
    await expect(runner.run(request("session-b"))).resolves.toEqual({
      callId: "call-1",
      outcome: "ok",
      result: { downloads: [] },
    });
  });

  it("refuses arguments the contract does not admit", async () => {
    const runner = createAgentDownloadTools({ list: async () => [] });

    await expect(runner.run(request("session-a", { tabId: 7 }))).resolves.toEqual({
      callId: "call-1",
      outcome: "failed",
      reason: "invalid-arguments",
    });
  });
});
