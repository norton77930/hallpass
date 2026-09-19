import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 005/T180 — download reporting (US2, FR-077..FR-079).
 *
 * Three shapes are pinned here. A download record carries exactly what the browser's own record
 * carries - id, saved path, source, state, times, bytes, danger - plus which sessions it was
 * attributed to; nothing from any page is expressible in it (FR-080). `downloads_context` takes no
 * arguments and answers at most twenty records. And `wait` gains one condition that is about the
 * browser rather than about an element: `download-complete` takes no `ref`, and a met one may carry
 * the download it ended on.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

const RECORD = {
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

describe("T180 agent download contracts", () => {
  it("carries the browser's record of a download and who it was attributed to", () => {
    const record = contractSchema("agentDownloadRecordSchema");
    expectAccepted(record, RECORD, "a complete download");
    // The name is not known until the browser decides it (edge case): an empty string is a fact.
    expectAccepted(record, { ...RECORD, filename: "", state: "in_progress", endedAt: undefined }, "an unnamed download");
    expectAccepted(record, { ...RECORD, attribution: "shared" }, "a download two sessions hold");
    for (const state of ["in_progress", "complete", "failed", "canceled"]) {
      expectAccepted(record, { ...RECORD, state }, `state ${state}`);
    }
    expectRejected(record, { ...RECORD, state: "interrupted" }, "the browser's own word for a failure");
    expectRejected(record, { ...RECORD, attribution: "owner" }, "an attribution nobody declared");
    expectRejected(record, { ...RECORD, referrer: "https://page.test/" }, "a field the browser record has but we do not carry");
    expectRejected(record, { ...RECORD, danger: "file" }, "danger as the browser's enum rather than a flag");
    expectRejected(record, { ...RECORD, bytesReceived: -1 }, "negative bytes");
  });

  it("lists at most twenty records, newest first, from no arguments", () => {
    const listing = args("downloads_context");
    expectAccepted(listing, {}, "no arguments");
    expectRejected(listing, { tabId: TAB }, "a tab: listing needs no lease");

    const result = contractSchema("agentDownloadsContextResultSchema");
    expectAccepted(result, { downloads: [] }, "an empty listing");
    expectAccepted(result, { downloads: Array.from({ length: 20 }, () => RECORD) }, "the bound");
    expectRejected(result, { downloads: Array.from({ length: 21 }, () => RECORD) }, "past the bound");
    expectRejected(result, { downloads: [RECORD], extra: 1 }, "a listing with an extra field");
  });

  it("waits for a download to complete without a ref, and refuses one with a ref", () => {
    const wait = args("wait");
    expectAccepted(wait, { tabId: TAB, condition: "download-complete", maxMs: 15_000 }, "download-complete");
    expectRejected(
      wait,
      { tabId: TAB, condition: "download-complete", ref: "tgt-1", maxMs: 15_000 },
      "download-complete with a ref: it is about the browser, not an element",
    );
    expectRejected(wait, { tabId: TAB, condition: "download-complete" }, "download-complete with no bound");

    const conditions = contractExport<readonly string[]>("AGENT_WAIT_CONDITIONS");
    expect(conditions).toContain("download-complete");
    // The archived remote path's list is untouched (FR-075): the condition is the agent's alone.
    expect(contractExport<readonly string[]>("WAIT_CONDITIONS")).not.toContain("download-complete");
  });

  it("answers a met download wait with the download it ended on", () => {
    const result = contractSchema("agentWaitResultSchema");
    const download = { id: 12, filename: RECORD.filename, url: RECORD.url, state: "complete" };
    expectAccepted(result, { outcome: "condition-met", waitedMs: 640, download }, "a met download wait");
    expectAccepted(result, { outcome: "condition-met", waitedMs: 640 }, "a met element wait, unchanged");
    for (const state of ["failed", "canceled"]) {
      expectAccepted(result, { outcome: "condition-met", waitedMs: 1, download: { ...download, state } }, state);
    }
    expectRejected(
      result,
      { outcome: "condition-met", waitedMs: 1, download: { ...download, state: "in_progress" } },
      "a download that is not over",
    );
    expectRejected(
      result,
      { outcome: "condition-met", waitedMs: 1, download: { ...download, bytesReceived: 1 } },
      "a field the wait's answer does not carry",
    );
  });

  it("offers downloads_context to the agent from the same table the worker parses", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>("AGENT_TOOL_DESCRIPTORS");
    const listing = descriptors.find((descriptor) => descriptor.name === "downloads_context");
    expect(listing, "downloads_context must be offered").toBeDefined();
    const wait = descriptors.find((descriptor) => descriptor.name === "wait");
    expect(wait?.description).toContain("download-complete");
    // A read, never an effect: nothing on any page changes because a download was listed.
    expect(contractExport<readonly string[]>("AGENT_EFFECT_TOOL_NAMES")).not.toContain("downloads_context");
  });
});
