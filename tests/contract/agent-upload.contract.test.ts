import { describe, expect, it } from "vitest";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 003/T060 — putting a file into a page (US7, FR-051).
 *
 * The shape says where the trust boundary is, and it is the point of this test. What the *agent*
 * sends is a list of paths; what reaches the *worker* is a list of bytes. Between them sits the
 * host, which is the owner's own process and the only thing here that may touch a disk: it decides
 * whether a path is inside a root the owner allowed, and only then reads it. So the worker's frame
 * has no field for a path at all - not "it must not carry one", but "it cannot".
 *
 * The bounds are the native frame's. A file this link cannot carry is refused before it is read
 * rather than after, because a refusal that had already read the file has already done the thing
 * the owner's allowed-roots rule exists to prevent.
 */

const TAB = 7;

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T060 agent file upload contracts", () => {
  it("takes paths from the agent and never from the worker's own frame", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; inputShape: Record<string, unknown> }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    const upload = descriptors.find((descriptor) => descriptor.name === "file_upload");
    expect(upload, "file_upload must be offered to the agent").toBeDefined();
    // The agent's side of the boundary: paths, because the agent is asking for the owner's files.
    expect(Object.keys(upload?.inputShape ?? {}).sort()).toEqual(["paths", "ref", "tabId"]);

    // The worker's side: bytes only. A path here would be a path the extension had resolved, which
    // is exactly the capability the host holds instead.
    const frame = args("file_upload");
    expectAccepted(
      frame,
      {
        tabId: TAB,
        ref: "tgt-1",
        files: [{ name: "receipt.png", type: "image/png", bytesBase64: "aGVsbG8=" }],
      },
      "one file as bytes",
    );
    expectRejected(
      frame,
      { tabId: TAB, ref: "tgt-1", paths: ["C:/allowed/receipt.png"] },
      "a path in the worker's frame",
    );
    expectRejected(frame, { tabId: TAB, files: [] }, "an upload naming no target");
    expectRejected(frame, { tabId: TAB, ref: "tgt-1", files: [] }, "an upload with no files");
  });

  it("bounds how many files and how much of them one call may carry", () => {
    const frame = args("file_upload");
    const file = (name: string) => ({ name, type: "text/plain", bytesBase64: "aGk=" });
    const maxFiles = contractExport<number>("AGENT_UPLOAD_MAX_FILES");
    expect(maxFiles).toBe(10);

    expectAccepted(
      frame,
      { tabId: TAB, ref: "tgt-1", files: Array.from({ length: maxFiles }, (_v, i) => file(`f${i}.txt`)) },
      "the largest allowed number of files",
    );
    expectRejected(
      frame,
      { tabId: TAB, ref: "tgt-1", files: Array.from({ length: maxFiles + 1 }, (_v, i) => file(`f${i}.txt`)) },
      "one file too many",
    );
    expectRejected(
      frame,
      {
        tabId: TAB,
        ref: "tgt-1",
        files: [{ name: "big.bin", type: "application/octet-stream", bytesBase64: "A".repeat(1_000_000) }],
      },
      "a file the native frame could not carry",
    );
    // The name is what the page will show; it is a file name and never a path.
    expectRejected(
      frame,
      { tabId: TAB, ref: "tgt-1", files: [{ name: "C:/secrets/id.png", type: "image/png", bytesBase64: "aGk=" }] },
      "a name that is really a path",
    );
  });

  it("answers with what the input is holding now, as the page reports it", () => {
    const result = contractSchema("agentUploadResultSchema");
    expectAccepted(result, { files: [{ name: "receipt.png", size: 1_024 }] }, "one file on the input");
    expectAccepted(result, { files: [] }, "an input the page left empty");
    expectRejected(
      result,
      { files: [{ name: "receipt.png", size: 1_024, path: "C:/allowed/receipt.png" }] },
      "a path handed back to the agent",
    );
    expectRejected(result, { files: [{ name: "receipt.png" }] }, "a file with no size");
  });

  it("carries the bytes to the page as its own closed runtime message", () => {
    const runtime = contractSchema("contentRuntimeMessageSchema");
    const base = {
      runtimeProtocolVersion: contractExport<number>("RUNTIME_PROTOCOL_VERSION"),
      messageId: "m-1",
      runtimeEpochId: "epoch-1",
      taskId: "task-1",
      operationId: "op-1",
      nonce: "0".repeat(32),
      expectedTabId: TAB,
      expectedDocumentEpoch: "doc-1",
    };
    expectAccepted(
      runtime,
      {
        ...base,
        type: "content.set-files",
        payload: {
          targetHandle: "tgt-1",
          files: [{ name: "receipt.png", type: "image/png", bytesBase64: "aGk=" }],
        },
      },
      "files for one target",
    );
    // The page is told which element, never which file on disk: the runtime has no business
    // knowing a path exists, and a page that could read one would be reading the owner's machine.
    expectRejected(
      runtime,
      {
        ...base,
        type: "content.set-files",
        payload: { targetHandle: "tgt-1", path: "C:/allowed/receipt.png" },
      },
      "a path sent to the page",
    );
    expectRejected(
      runtime,
      { ...base, type: "content.set-files", payload: { files: [] } },
      "files for no target",
    );
  });

  it("names the refusal the owner's allowed roots produce", () => {
    const response = contractSchema("agentNativeResponseSchema");
    expectAccepted(
      response,
      { callId: "call-1", outcome: "denied", reason: "upload-not-allowed" },
      "a path outside every allowed root",
    );
    expect(contractExport<readonly string[]>("AGENT_TOOL_OUTCOMES")).toContain("denied");
  });
});
