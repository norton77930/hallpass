import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PANEL_MCP_SERVERS_MAX, panelMcpServerSchema, type ConversationAgent, type PanelMcpServer } from "@hallpass/contracts";
import { cannotMergeOver, findOwnerEntry } from "./codex-config.js";
import { killTreeAsync } from "./run-command.js";

/**
 * 027 (issue #21): the owner's extra MCP servers for side-panel conversations - the list file every
 * browser's broker on this computer shares (R-417), what an agent run is handed (R-419, R-420) and the
 * settings page's Check (R-421). Only variable names are kept; a value is read from the environment
 * when a run starts or a check runs, handed to that program, and never written, framed or logged.
 */

export const PANEL_MCP_FILE = "panel-mcp-servers.json";
/** R-421: how long a Check may take before the server is stopped and the check fails. */
export const PANEL_MCP_CHECK_BOUND_MS = 30_000;
const TOOLS_SHOWN = 50;
const DETAIL_MAX = 300;

const listFileSchema = z.strictObject({ servers: z.array(panelMcpServerSchema).max(PANEL_MCP_SERVERS_MAX) });

export type PanelMcpListRead = { servers: PanelMcpServer[]; unreadable?: true };
export type PanelMcpOutcome = { ok: true } | { ok: false; code: "mcp-server-refused" | "not-found"; detail: string };

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** R-417: the list; no file is an empty list; a file that cannot be read or is not a valid list is `unreadable`. */
export async function readPanelMcpServers(dataDir: string): Promise<PanelMcpListRead> {
  let text: string;
  try {
    text = await readFile(join(dataDir, PANEL_MCP_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return { servers: [] };
    return { servers: [], unreadable: true };
  }
  try {
    return { servers: listFileSchema.parse(JSON.parse(text)).servers };
  } catch {
    return { servers: [], unreadable: true };
  }
}

/** Temp file, then rename: a failed write leaves the previous list. */
async function writeList(dataDir: string, servers: PanelMcpServer[]): Promise<void> {
  const target = join(dataDir, PANEL_MCP_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const UNREADABLE: PanelMcpOutcome = {
  ok: false,
  code: "mcp-server-refused",
  detail: "The list of extra servers could not be read; remove or fix panel-mcp-servers.json in Hallpass's data folder first.",
};

/** R-418 (FR-425, FR-431): add a server, or replace `previousName` with it (which may rename it). */
export async function savePanelMcpServer(dataDir: string, server: PanelMcpServer, previousName?: string): Promise<PanelMcpOutcome> {
  const parsed = panelMcpServerSchema.safeParse(server);
  if (!parsed.success) return { ok: false, code: "mcp-server-refused", detail: "That server's name, command, arguments or variables are not valid." };
  const list = await readPanelMcpServers(dataDir);
  if (list.unreadable === true) return UNREADABLE;
  const at = previousName === undefined ? -1 : list.servers.findIndex((entry) => sameName(entry.name, previousName));
  if (previousName !== undefined && at < 0) return { ok: false, code: "not-found", detail: `There is no extra server named ${previousName}.` };
  if (list.servers.some((entry, index) => index !== at && sameName(entry.name, parsed.data.name))) {
    return { ok: false, code: "mcp-server-refused", detail: `There is already an extra server named ${parsed.data.name}.` };
  }
  if (at < 0 && list.servers.length >= PANEL_MCP_SERVERS_MAX) {
    return { ok: false, code: "mcp-server-refused", detail: `At most ${PANEL_MCP_SERVERS_MAX} extra servers can be added.` };
  }
  const servers = at < 0 ? [...list.servers, parsed.data] : list.servers.map((entry, index) => (index === at ? parsed.data : entry));
  await writeList(dataDir, servers);
  return { ok: true };
}

export async function removePanelMcpServer(dataDir: string, name: string): Promise<PanelMcpOutcome> {
  const list = await readPanelMcpServers(dataDir);
  if (list.unreadable === true) return UNREADABLE;
  const servers = list.servers.filter((entry) => !sameName(entry.name, name));
  if (servers.length === list.servers.length) return { ok: false, code: "not-found", detail: `There is no extra server named ${name}.` };
  await writeList(dataDir, servers);
  return { ok: true };
}

/** R-420: the servers Codex is not handed - its owner's entry of that name cannot be merged over. */
export function codexSkippedNames(servers: readonly PanelMcpServer[], codexToml: string | undefined): Set<string> {
  if (codexToml === undefined) return new Set();
  return new Set(servers.filter((entry) => cannotMergeOver(findOwnerEntry(codexToml, entry.name))).map((entry) => entry.name));
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The named variables that are set, with their values - only ever handed to the program itself. */
const variablesOf = (server: PanelMcpServer, env: Environment): acp.EnvVariable[] =>
  server.variables.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [{ name, value }];
  });

/**
 * R-419 (FR-426): what an agent run is handed besides the browser entry - each server ticked for this
 * agent, as a stdio entry with its set variables. DeepSeek is never ticked; Codex leaves out `codexSkipped`.
 */
export function sessionServersFor(
  agent: ConversationAgent,
  servers: readonly PanelMcpServer[],
  env: Environment,
  codexSkipped: ReadonlySet<string> = new Set(),
): acp.McpServerStdio[] {
  return servers
    .filter((entry) => (entry.agents as readonly string[]).includes(agent) && !(agent === "codex" && codexSkipped.has(entry.name)))
    .map((entry) => ({ name: entry.name, command: entry.command, args: [...entry.args], env: variablesOf(entry, env) }));
}

export type PanelMcpCheckResult = { outcome: "works"; tools: string[]; toolCount: number } | { outcome: "failed"; detail: string };

/** The reason in one short line, with every named variable's value said as its name. */
function reasonOf(error: unknown, stderr: string, server: PanelMcpServer, env: Environment): string {
  const lastLine = stderr.trim().split(/\r?\n/u).at(-1)?.trim();
  const message = error instanceof Error ? error.message : String(error);
  let text = lastLine !== undefined && lastLine !== "" ? `${message} (${lastLine})` : message;
  for (const name of server.variables) {
    const value = env[name];
    if (value !== undefined && value.length >= 3) text = text.split(value).join(`<${name}>`);
  }
  text = text.replace(/\s+/gu, " ").trim();
  return (text === "" ? "The server did not start." : text).slice(0, DETAIL_MAX);
}

const UNSAFE_FOR_CMD = /["%\r\n\0]/u;

/**
 * R-421: how the Check starts the command. On Windows through `cmd.exe /d /s /c`, which finds a bare name
 * as an agent's shell would (`npx` is `npx.cmd`); because cmd.exe parses that line, a quote, a percent sign
 * or a line break is refused rather than escaped, as `run-command.ts` does for a batch file.
 */
export function checkLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): { file: string; argv: string[]; verbatim: boolean } | { refused: string } {
  if (platform !== "win32") return { file: command, argv: [...args], verbatim: false };
  if ([command, ...args].some((part) => UNSAFE_FOR_CMD.test(part))) {
    return { refused: "Hallpass does not run a command or argument with a quote, a percent sign or a line break." };
  }
  const quote = (part: string): string => (/[\s&|<>^()]/u.test(part) || part === "" ? `"${part}"` : part);
  return { file: comSpec ?? "cmd.exe", argv: ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], verbatim: true };
}

/** The MCP client's side of a child's stdio: one JSON message per line, as the SDK frames them. */
class ChildStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  private closed = false;

  constructor(private readonly child: ChildProcess) {}

  async start(): Promise<void> {
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    // A command that cannot be started says so in `error`, and may never `close`: either ends the link.
    this.child.once("error", (error) => {
      this.onerror?.(error);
      this.end();
    });
    this.child.once("close", () => this.end());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("The server's connection is closed.");
    this.child.stdin?.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * R-421 (D-027-2, FR-432): start the server as a run would - same command, arguments and variables (on
 * Windows through cmd.exe, so `npx` works) - list its tools through the MCP SDK's client, close it, and
 * end its process tree. Bounded; never leaves the program running.
 */
export async function checkPanelMcpServer(
  server: PanelMcpServer,
  env: Environment,
  options: { boundMs?: number } = {},
): Promise<PanelMcpCheckResult> {
  const launch = checkLaunch(server.command, server.args);
  if ("refused" in launch) return { outcome: "failed", detail: launch.refused };
  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.argv, {
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
  } catch (error) {
    return { outcome: "failed", detail: reasonOf(error, "", server, env) };
  }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  // A command that cannot start reports it here before any listener of the transport exists.
  child.on("error", () => undefined);
  const transport = new ChildStdioTransport(child);
  const client = new Client({ name: "hallpass-check", version: "0.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The server did not answer within ${Math.round((options.boundMs ?? PANEL_MCP_CHECK_BOUND_MS) / 1000)} s.`)), options.boundMs ?? PANEL_MCP_CHECK_BOUND_MS);
  });
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      bound,
    ]);
    const names = listed.tools.map((tool) => tool.name.slice(0, 128));
    return { outcome: "works", tools: names.slice(0, TOOLS_SHOWN), toolCount: names.length };
  } catch (error) {
    // Give the program a moment to say why on stderr before it is read.
    await new Promise((done) => setTimeout(done, 100));
    return { outcome: "failed", detail: reasonOf(error, stderr, server, env) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    // cmd.exe and an `npx` leave children behind the first process: the whole tree goes (taskkill /T on
    // Windows); elsewhere the process itself is ended.
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") await killTreeAsync(child.pid).catch(() => false);
      else child.kill("SIGTERM");
    }
  }
}
