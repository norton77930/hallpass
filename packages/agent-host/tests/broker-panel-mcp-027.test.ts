import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationOverviewFrameSchema, conversationResultFrameSchema, type PanelMcpServer } from "@hallpass/contracts";
import { createCommandHandler } from "../src/broker/commands.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { ConversationPool } from "../src/broker/conversation.js";
import type { FolderActions } from "../src/broker/folders.js";
import {
  PANEL_MCP_FILE,
  checkPanelMcpServer,
  codexSkippedNames,
  readPanelMcpServers,
  removePanelMcpServer,
  savePanelMcpServer,
} from "../src/broker/panel-mcp-servers.js";
import { makeTempDir, removeDir, waitFor } from "./conversation-harness.js";

/**
 * 027 T847 - the broker's part (contracts/frames.md, R-421, R-422): the overview carries the list with
 * each variable set or not and never a value; save, remove and check commands, with their refusals; a
 * check shows `checking`, then its result.
 */

const TINY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tiny-mcp-server.mjs");
const SECRET = "ghp-broker-secret-4242";
let dataDir: string;

beforeEach(async () => {
  dataDir = await makeTempDir("hallpass-mcp-broker-");
});

afterEach(async () => {
  await removeDir(dataDir);
});

const github: PanelMcpServer = { name: "github", command: "npx", args: ["-y", "server-github"], variables: ["GITHUB_TOKEN", "GITHUB_HOST"], agents: ["claude-code", "codex"] };
const tiny: PanelMcpServer = { name: "tiny", command: process.execPath, args: [TINY], variables: [], agents: ["hermes"] };

function handler(codexToml?: string) {
  const sent: Record<string, unknown>[] = [];
  const index = memoryConversationIndex();
  const folders = memoryFolderList();
  const env: Record<string, string | undefined> = { ...process.env, GITHUB_TOKEN: SECRET, GITHUB_HOST: undefined };
  const pool = new ConversationPool({
    dataDir: join(dataDir, "pool"),
    browserRunId: "run-mcp",
    index,
    folders,
    resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "none" } }),
    onEvent: () => undefined,
  });
  const commands = createCommandHandler({
    sessionId: "broker-mcp",
    send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
    pool,
    index,
    folders,
    consent: { read: async () => "granted", write: async () => undefined },
    folderActions: {} as FolderActions,
    availability: async (agent) => ({ agent, availability: "ready" }),
    install: async () => ({ ok: true, directory: "x" }),
    mcpServers: {
      env,
      read: () => readPanelMcpServers(dataDir),
      save: (server, previousName) => savePanelMcpServer(dataDir, server, previousName),
      remove: (name) => removePanelMcpServer(dataDir, name),
      check: (server) => checkPanelMcpServer(server, env),
      codexSkipped: async (servers) => codexSkippedNames(servers, codexToml),
    },
  });
  let counter = 0;
  const run = async (command: unknown) => {
    const commandId = `m-${++counter}`;
    await commands.handle({ type: "conversation-command", sessionId: "broker-mcp", commandId, command });
    return sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId);
  };
  const last = () => sent.filter((frame) => frame.type === "conversation-overview").at(-1) as Record<string, unknown> | undefined;
  const listed = () => (last()?.mcpServers as { servers: Array<Record<string, unknown>>; unreadable?: true } | undefined);
  return { commands, run, last, listed, pool, sent };
}

describe("027 the broker and the extra MCP servers", () => {
  it("save, then the overview lists it with each variable set or not - never a value", async () => {
    const { run, last, listed, pool, sent } = handler();
    try {
      const saved = await run({ type: "ui.conversation.mcp-server-save", payload: { server: github } });
      expect(saved).toMatchObject({ ok: true });
      await waitFor(() => listed()?.servers.length === 1, "the overview after the save");
      expect(listed()).toEqual({
        servers: [{ ...github, variables: [{ name: "GITHUB_TOKEN", set: true }, { name: "GITHUB_HOST", set: false }] }],
      });
      expect(conversationOverviewFrameSchema.safeParse(last()).success).toBe(true);
      expect(JSON.stringify(sent)).not.toContain(SECRET);
    } finally {
      await pool.shutdown();
    }
  });

  it("a duplicate is refused mcp-server-refused; remove and edit of an unknown name are not-found", async () => {
    const { run, pool } = handler();
    try {
      await run({ type: "ui.conversation.mcp-server-save", payload: { server: github } });
      const duplicate = await run({ type: "ui.conversation.mcp-server-save", payload: { server: { ...github, name: "GITHUB" } } });
      expect(duplicate).toMatchObject({ ok: false, error: { code: "mcp-server-refused" } });
      expect(conversationResultFrameSchema.safeParse(duplicate).success).toBe(true);
      expect(await run({ type: "ui.conversation.mcp-server-remove", payload: { name: "nope" } })).toMatchObject({ ok: false, error: { code: "not-found" } });
      expect(await run({ type: "ui.conversation.mcp-server-save", payload: { server: github, previousName: "nope" } })).toMatchObject({
        ok: false,
        error: { code: "not-found" },
      });
      expect(await run({ type: "ui.conversation.mcp-server-remove", payload: { name: "github" } })).toMatchObject({ ok: true });
    } finally {
      await pool.shutdown();
    }
  });

  it("check: checking at once, then the tools; editing the server drops the old result", async () => {
    const { run, listed, pool } = handler();
    try {
      await run({ type: "ui.conversation.mcp-server-save", payload: { server: tiny } });
      expect(await run({ type: "ui.conversation.mcp-server-check", payload: { name: "tiny" } })).toMatchObject({ ok: true });
      await waitFor(() => listed()?.servers[0]?.checking === true, "checking");
      await waitFor(() => listed()?.servers[0]?.check !== undefined, "the check's result", 20_000);
      expect(listed()?.servers[0]).toMatchObject({ check: { outcome: "works", tools: ["echo_back", "count_things"], toolCount: 2 } });
      expect(listed()?.servers[0]?.checking).toBeUndefined();

      await run({ type: "ui.conversation.mcp-server-save", payload: { server: { ...tiny, args: [TINY, "--other"] }, previousName: "tiny" } });
      await waitFor(() => listed()?.servers[0]?.check === undefined, "the edited server without the old result");
      expect(await run({ type: "ui.conversation.mcp-server-check", payload: { name: "missing" } })).toMatchObject({ ok: false, error: { code: "not-found" } });
    } finally {
      await pool.shutdown();
    }
  });

  /**
   * Security review 2026-11-05 S8 - the Check's failure detail is shown on the settings page, and it
   * carries the last line the owner's server wrote to stderr. Every other string the broker shows
   * passes `redact()`; this one replaced only the server's own named variables. A server that echoes
   * a credential it found elsewhere - a URL with a password, a vendor token - put it on the page.
   */
  it("S8: the check's detail is redacted like every other shown string", async () => {
    const leaky: PanelMcpServer = {
      name: "leaky",
      command: process.execPath,
      args: ["-e", "console.error('cannot reach https://user:s3cretPass1@example.com with token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123'); process.exit(1)"],
      variables: [],
      agents: ["hermes"],
    };
    const result = await checkPanelMcpServer(leaky, { ...process.env }, { boundMs: 10_000 });
    expect(result.outcome).toBe("failed");
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("s3cretPass1");
    expect(detail).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123");
    expect(detail).toContain("example.com");
  });

  it("R-420: a name the owner's Codex holds as a URL server is marked codexSkipped", async () => {
    const { run, listed, pool } = handler('[mcp_servers.github]\nurl = "https://example.test/mcp"\n');
    try {
      await run({ type: "ui.conversation.mcp-server-save", payload: { server: github } });
      await waitFor(() => listed()?.servers.length === 1, "the overview");
      expect(listed()?.servers[0]?.codexSkipped).toBe(true);
    } finally {
      await pool.shutdown();
    }
  });

  it("an unreadable list says so, and a save is refused", async () => {
    await writeFile(join(dataDir, PANEL_MCP_FILE), "{ broken", "utf8");
    const { commands, run, listed, pool } = handler();
    try {
      await commands.sendOverview();
      expect(listed()).toEqual({ servers: [], unreadable: true });
      expect(await run({ type: "ui.conversation.mcp-server-save", payload: { server: github } })).toMatchObject({ ok: false, error: { code: "mcp-server-refused" } });
    } finally {
      await pool.shutdown();
    }
  });
});
