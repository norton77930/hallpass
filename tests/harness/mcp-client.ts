import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Drives the MCP server exactly as Claude Code does: spawn `dist/mcp-server.js`, speak JSON-RPC
 * over its stdio, call a tool (T020).
 *
 * It exists so the host's surface can be proven without a browser at all, and so the packaged
 * journeys drive the *real* agent side rather than a stand-in: a harness that talked to the server
 * through anything but stdio would not be evidence that an agent can.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `HALLPASS_MCP_SERVER_ENTRY` points the harness at another build of the same server - the QA
 * package's bundled `host/mcp-server.js` (007/T203) - so the identical client drives both.
 */
export const MCP_SERVER_ENTRY =
  process.env.HALLPASS_MCP_SERVER_ENTRY ?? resolve(repoRoot, "packages/agent-host/dist/mcp-server.js");

export type ToolCallResult = {
  isError: boolean;
  /** The concatenated text blocks; tool results are JSON in a text block. */
  text: string;
  /** The parsed text, when it is JSON - which it is for every tool but `screenshot`. */
  json: unknown;
  /** Image blocks, as MCP carries them. `screenshot` is the one tool that answers with these. */
  images: Array<{ data: string; mimeType: string }>;
};

/** What a client asks for beyond the arguments; the progress hook is 004/R-112's evidence. */
export type ToolCallOptions = {
  /**
   * Called for every `notifications/progress` the server sends while this call is outstanding.
   *
   * Providing it is what makes the SDK put a `progressToken` on the request, which is what an MCP
   * server needs before it may report progress at all - so a test that wants to *see* the pairing
   * wait being reported has to ask for it exactly as a real client does.
   */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /**
   * How long this client waits for the call's answer, in milliseconds (011/T297).
   *
   * The SDK's own default is 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`), and that default is exactly
   * what R-161 set out to distinguish from Claude Code's bound, which is hours. A journey about a
   * question a person is given two minutes to answer has to say so, or the harness - not the
   * product - is what ends the call. Absent, the SDK's default stands, so every existing journey
   * keeps the client behaviour it was written against.
   */
  timeoutMs?: number;
  /** The SDK's `resetTimeoutOnProgress`: a progress notice restarts the bound above. */
  resetTimeoutOnProgress?: boolean;
};

export type McpHarnessClient = {
  callTool(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult>;
  listToolNames(): Promise<string[]>;
  /** Everything the server wrote to stderr so far - its stable codes, for a failure report. */
  stderr(): string;
  close(): Promise<void>;
};

export type StartMcpClientOptions = {
  /** The name the owner sees in the pairing prompt; it is the MCP client's own name. */
  clientName?: string;
  /**
   * Extra environment for the server process. Tests point `LOCALAPPDATA` at a temp directory so a
   * run never reads or writes the developer's real `bridge.json`.
   */
  env?: Record<string, string>;
  /** The server file to spawn; `MCP_SERVER_ENTRY` unless a test has a specific build to prove. */
  entry?: string;
  /**
   * The working directory the server is spawned in (016 FR-226, R-203). Absent, the SDK's default
   * stands - the test runner's own - which is what every caller written before 016 was proven against.
   */
  cwd?: string;
  /**
   * Roots this client advertises and answers `roots/list` with (016 R-203). Present, the client
   * declares the `roots` capability as Claude Code may; absent, it declares none, as before.
   */
  roots?: Array<{ uri: string; name?: string }>;
};

export async function startMcpClient(options: StartMcpClientOptions = {}): Promise<McpHarnessClient> {
  let stderrText = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.entry ?? MCP_SERVER_ENTRY],
    stderr: "pipe",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...(process.env as Record<string, string>),
      // 004/R-111: the server dials the relay and waits 5 s between attempts, which is the right
      // cadence for an agent waiting on a browser and far too long for a test that starts its relay
      // stand-in a moment later. A test may still set its own.
      // `DIAL_RETRY_ENV` in mcp-server.ts; spelled out here for the same reason the pairing bound is,
      // because that module starts a server the moment it is imported.
      HALLPASS_AGENT_DIAL_RETRY_MS: "100",
      ...options.env,
    },
  });
  const roots = options.roots;
  const client = new Client(
    { name: options.clientName ?? "claude-code", version: "0.0.0" },
    roots === undefined ? undefined : { capabilities: { roots: { listChanged: false } } },
  );
  if (roots !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((root) => ({ ...root })) }));
  }
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });

  return {
    async callTool(name, args = {}, options = {}) {
      /**
       * Assembled rather than written inline so that a call which asks for nothing still hands the
       * SDK `undefined` - the shape every journey written before 011 was proven against.
       */
      const requestOptions: RequestOptions = {
        ...(options.onProgress === undefined
          ? {}
          : {
              onprogress: (progress) =>
                options.onProgress?.({
                  progress: progress.progress,
                  ...(progress.total === undefined ? {} : { total: progress.total }),
                  ...(typeof progress.message === "string" ? { message: progress.message } : {}),
                }),
            }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.resetTimeoutOnProgress === undefined
          ? {}
          : { resetTimeoutOnProgress: options.resetTimeoutOnProgress }),
      };
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        Object.keys(requestOptions).length === 0 ? undefined : requestOptions,
      )) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      const text = (result.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const images = (result.content ?? [])
        .filter((block) => block.type === "image")
        .map((block) => ({ data: block.data ?? "", mimeType: block.mimeType ?? "" }));
      return { isError: result.isError === true, text, json, images };
    },
    async listToolNames() {
      const listed = (await client.listTools()) as { tools: Array<{ name: string }> };
      return listed.tools.map((tool) => tool.name);
    },
    stderr() {
      return stderrText;
    },
    async close() {
      await client.close();
    },
  };
}
