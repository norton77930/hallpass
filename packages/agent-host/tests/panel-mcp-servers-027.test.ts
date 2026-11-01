import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelMcpServer } from "@hallpass/contracts";
import {
  PANEL_MCP_FILE,
  checkLaunch,
  checkPanelMcpServer,
  codexSkippedNames,
  readPanelMcpServers,
  removePanelMcpServer,
  savePanelMcpServer,
  sessionServersFor,
} from "../src/broker/panel-mcp-servers.js";
import { makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 027 T843-T845 - the extra MCP servers' list file (R-417, R-418), the session entries an agent run is
 * handed (R-419, R-420) and the Check (R-421).
 */

const TINY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tiny-mcp-server.mjs");
let dataDir: string;

beforeEach(async () => {
  dataDir = await makeTempDir("hallpass-mcp-");
});

afterEach(async () => {
  await removeDir(dataDir);
});

const server = (extra: Partial<PanelMcpServer> = {}): PanelMcpServer => ({
  name: "github",
  command: "npx",
  args: ["-y", "server-github"],
  variables: ["GITHUB_TOKEN"],
  agents: ["claude-code", "codex", "hermes"],
  ...extra,
});

describe("027 the list file", () => {
  it("R-417: no file is an empty list; a saved server is read back", async () => {
    expect(await readPanelMcpServers(dataDir)).toEqual({ servers: [] });
    expect(await savePanelMcpServer(dataDir, server())).toEqual({ ok: true });
    expect(await readPanelMcpServers(dataDir)).toEqual({ servers: [server()] });
    expect(await readdir(dataDir)).toEqual([PANEL_MCP_FILE]);
  });

  it("R-417: a file that is not a valid list is unreadable, and nothing overwrites it", async () => {
    await writeFile(join(dataDir, PANEL_MCP_FILE), "{ not json", "utf8");
    expect(await readPanelMcpServers(dataDir)).toEqual({ servers: [], unreadable: true });
    expect(await savePanelMcpServer(dataDir, server())).toMatchObject({ ok: false, code: "mcp-server-refused" });
    expect(await readFile(join(dataDir, PANEL_MCP_FILE), "utf8")).toBe("{ not json");
    // A value that does not pass the schema is unreadable too (a hand-edited file).
    await writeFile(join(dataDir, PANEL_MCP_FILE), JSON.stringify({ servers: [{ ...server(), name: "hallpass" }] }), "utf8");
    expect((await readPanelMcpServers(dataDir)).unreadable).toBe(true);
  });

  it("R-418: a duplicate name (any case) is refused; an edit may rename; the list holds 10", async () => {
    await savePanelMcpServer(dataDir, server());
    expect(await savePanelMcpServer(dataDir, server({ name: "GitHub" }))).toMatchObject({ ok: false, code: "mcp-server-refused" });
    expect(await savePanelMcpServer(dataDir, server({ name: "gh", args: [] }), "github")).toEqual({ ok: true });
    expect((await readPanelMcpServers(dataDir)).servers.map((entry) => entry.name)).toEqual(["gh"]);
    expect(await savePanelMcpServer(dataDir, server({ name: "x" }), "missing")).toMatchObject({ ok: false, code: "not-found" });
    for (let at = 0; at < 9; at++) expect(await savePanelMcpServer(dataDir, server({ name: `s${at}` }))).toEqual({ ok: true });
    expect(await savePanelMcpServer(dataDir, server({ name: "eleventh" }))).toMatchObject({ ok: false, code: "mcp-server-refused" });
  });

  it("remove takes the server out; an unknown name is not-found", async () => {
    await savePanelMcpServer(dataDir, server());
    expect(await removePanelMcpServer(dataDir, "GITHUB")).toEqual({ ok: true });
    expect(await readPanelMcpServers(dataDir)).toEqual({ servers: [] });
    expect(await removePanelMcpServer(dataDir, "github")).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("027 the session entries", () => {
  const env = { GITHUB_TOKEN: "ghp-secret-123", OTHER: "x" };

  it("R-419: an agent gets the servers ticked for it, with the variables that are set and their values", () => {
    const list = [server(), server({ name: "db", agents: ["hermes"], variables: ["DB_URL"] })];
    expect(sessionServersFor("claude-code", list, env)).toEqual([
      { name: "github", command: "npx", args: ["-y", "server-github"], env: [{ name: "GITHUB_TOKEN", value: "ghp-secret-123" }] },
    ]);
    // DB_URL is not set: the server goes without it.
    expect(sessionServersFor("hermes", list, env).map((entry) => [entry.name, entry.env])).toEqual([
      ["github", [{ name: "GITHUB_TOKEN", value: "ghp-secret-123" }]],
      ["db", []],
    ]);
    expect(sessionServersFor("deepseek", list, env)).toEqual([]);
  });

  it("R-420: Codex skips a name its owner entry cannot be merged over (a URL server, or switched off)", () => {
    const toml = ['[mcp_servers.github]', 'url = "https://example.test/mcp"', "", "[mcp_servers.db]", 'command = "db"', ""].join("\n");
    const skipped = codexSkippedNames([server(), server({ name: "db" })], toml);
    expect([...skipped]).toEqual(["github"]);
    expect(sessionServersFor("codex", [server(), server({ name: "db" })], env, skipped).map((entry) => entry.name)).toEqual(["db"]);
    expect(sessionServersFor("claude-code", [server()], env, skipped).map((entry) => entry.name)).toEqual(["github"]);
  });
});

describe("027 Check", () => {
  const tiny = (variables: string[] = []) => server({ name: "tiny", command: process.execPath, args: [TINY], variables });

  it("R-421: on Windows the command goes through cmd.exe (npx is npx.cmd), quoted; a quote or percent sign is refused", () => {
    expect(checkLaunch("npx", ["-y", "@scope/server", "C:\\My Files\\db"], "win32", "C:\\Windows\\system32\\cmd.exe")).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      argv: ["/d", "/s", "/c", '"npx -y @scope/server "C:\\My Files\\db""'],
      verbatim: true,
    });
    expect(checkLaunch("npx", ["%PATH%"], "win32")).toHaveProperty("refused");
    expect(checkLaunch("npx", ['a"b'], "win32")).toHaveProperty("refused");
    expect(checkLaunch("node", ["a b"], "linux")).toEqual({ file: "node", argv: ["a b"], verbatim: false });
  });

  it("R-421: a working server lists its tools, and is stopped", async () => {
    const result = await checkPanelMcpServer(tiny(), process.env);
    expect(result).toEqual({ outcome: "works", tools: ["echo_back", "count_things"], toolCount: 2 });
  });

  it("R-421: a missing command fails with a reason", async () => {
    const result = await checkPanelMcpServer(server({ name: "nope", command: join(dataDir, "no-such-program"), args: [] }), process.env);
    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.detail.length).toBeGreaterThan(0);
  });

  it("R-421: a server that exits says why, without any variable's value", async () => {
    const result = await checkPanelMcpServer(tiny(["TINY_SECRET"]), { ...process.env, TINY_MCP_MODE: "exit", TINY_SECRET: "sk-tiny-987654" });
    expect(result.outcome).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("sk-tiny-987654");
    expect(result.outcome === "failed" && result.detail).toMatch(/could not log in|closed|exit/iu);
  });

  it("R-421: a server that never answers ends at the bound", async () => {
    const started = Date.now();
    const result = await checkPanelMcpServer(tiny(), { ...process.env, TINY_MCP_MODE: "hang" }, { boundMs: 1_500 });
    expect(result).toMatchObject({ outcome: "failed" });
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});
