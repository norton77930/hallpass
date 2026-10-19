import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { ConversationAgent, ConversationAgentAvailability, ConversationError } from "@hallpass/contracts";
import { hostDataDirectory } from "../host-paths.js";
import { CODEX_SHIM_COMMAND, CODEX_SHIM_ENV, codexAdapterModesAsMeasured } from "./codex-strict.js";
import { redact } from "./redact.js";
import { runCommand } from "./run-command.js";

/**
 * Finding the owner's coding agent and the connector that speaks ACP to it (019/T530, T531, T534;
 * R-314, R-315, R-322). The broker never installs the agent's CLI - the owner has it already - but
 * it installs the slim adapter beside it (install.ts) and starts the adapter with the CLI's absolute
 * path in an environment variable, so the adapter does not need its own bundled copy.
 *
 * Everything that touches the machine (running a command, reading a file) goes through `AgentPorts`
 * so the tests decide what "the machine" holds.
 */

/** The CLI versions the connectors were tested with (R-315). Later versions are accepted; this is for the message. */
export const TESTED_AGENT_VERSIONS: Readonly<Record<ConversationAgent, string>> = {
  "claude-code": "2.1.302",
  codex: "0.163.0",
};

/** The adapters Hallpass pins (R-314) - the same names and versions as `agents/<agent>/package.json`. */
export const AGENT_ADAPTERS: Readonly<
  Record<
    ConversationAgent,
    {
      /** npm package name of the ACP adapter. */
      package: string;
      version: string;
      /** The CLI file `where.exe` is asked for. */
      cliFile: string;
      /** What the owner sees in sentences. */
      label: string;
    }
  >
> = {
  "claude-code": {
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.81.2",
    cliFile: "claude.exe",
    label: "Claude Code",
  },
  // Codex strict mode rests on this exact adapter (codex-strict.ts): a version bump means measuring
  // T573 again (does `read-only` still ask before every in-folder write through the shim?) and
  // updating `codexAdapterModesAsMeasured`; until then a launch refuses an adapter whose modes differ.
  codex: { package: "@agentclientprotocol/codex-acp", version: "1.13.1", cliFile: "codex.cmd", label: "Codex" },
};

export type ExecResult = { code: number | null; stdout: string; stderr: string };

export type AgentPorts = {
  /** `%LOCALAPPDATA%\hallpass`. */
  dataDir: string;
  env: { USERPROFILE?: string | undefined; APPDATA?: string | undefined };
  /** The node that runs the adapter: the broker's own (`process.execPath`). */
  nodePath: string;
  /** `codex-app-server-shim.js` beside the broker's entry (codex-strict.ts; SC-135). */
  codexShimEntry: string;
  fs: {
    exists(path: string): Promise<boolean>;
    readText(path: string): Promise<string>;
    /** Replace the file whole (write beside it, then rename), creating its folder. */
    writeText(path: string, text: string): Promise<void>;
  };
  /** Run `file args` to the end. May reject when the file cannot be started. */
  exec(file: string, args: string[]): Promise<ExecResult>;
};

/** The real machine. `codexShimEntry` is resolved by the broker's entry, beside itself in both layouts. */
export function defaultAgentPorts(codexShimEntry: string, env: NodeJS.ProcessEnv = process.env): AgentPorts {
  return {
    dataDir: hostDataDirectory(env),
    env: { USERPROFILE: env.USERPROFILE, APPDATA: env.APPDATA },
    nodePath: process.execPath,
    codexShimEntry,
    fs: {
      exists: (path) =>
        access(path).then(
          () => true,
          () => false,
        ),
      readText: (path) => readFile(path, "utf8"),
      writeText: async (path, text) => {
        await mkdir(win32.dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          await writeFile(temp, text, "utf8");
          await rename(temp, path);
        } finally {
          await rm(temp, { force: true }).catch(() => undefined);
        }
      },
    },
    exec: async (file, args) => {
      const { code, stdout, stderr } = await runCommand(file, args, { timeoutMs: 15_000 });
      return { code, stdout, stderr };
    },
  };
}

/** `<data>\agents\<agent>\<adapter version>` - where the pinned adapter's `npm ci` tree lives. */
export function adapterDirectory(dataDir: string, agent: ConversationAgent): string {
  return win32.join(dataDir, "agents", agent, AGENT_ADAPTERS[agent].version);
}

const adapterPackageDirectory = (dataDir: string, agent: ConversationAgent) =>
  win32.join(adapterDirectory(dataDir, agent), "node_modules", ...AGENT_ADAPTERS[agent].package.split("/"));

/** The first semver in a CLI's `--version` output (`2.1.302 (Claude Code)`, `codex-cli 0.162.1`). */
export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text)?.[0];
}

/** A path later handed to cmd.exe must not carry a quote or a percent sign (run-command.ts). */
const shellSafe = (path: string) => !/["%\r\n\0]/.test(path);

/** Where the CLI usually is when it is not on the PATH. */
function knownLocations(agent: ConversationAgent, env: AgentPorts["env"]): string[] {
  if (agent === "claude-code") return env.USERPROFILE ? [win32.join(env.USERPROFILE, ".local", "bin", "claude.exe")] : [];
  return env.APPDATA ? [win32.join(env.APPDATA, "npm", "codex.cmd")] : [];
}

/**
 * The absolute path of the owner's CLI: `where.exe` on the PATH first, then the known per-user
 * locations (R-315). Undefined means the CLI is not installed as far as the broker can tell.
 */
export async function discoverCli(agent: ConversationAgent, ports: AgentPorts): Promise<string | undefined> {
  const found: string[] = [];
  try {
    const where = await ports.exec("where.exe", [AGENT_ADAPTERS[agent].cliFile]);
    if (where.code === 0) found.push(...where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch {
    // where.exe missing or blocked: the known locations are the only route left.
  }
  for (const candidate of [...found, ...knownLocations(agent, ports.env)]) {
    if (shellSafe(candidate) && (await ports.fs.exists(candidate))) return candidate;
  }
  return undefined;
}

/** `<cli> --version`, parsed; undefined when it fails, times out or prints nothing like a version. */
export async function readCliVersion(cliPath: string, ports: AgentPorts): Promise<string | undefined> {
  try {
    const result = await ports.exec(cliPath, ["--version"]);
    if (result.code !== 0) return undefined;
    return parseVersion(result.stdout) ?? parseVersion(result.stderr);
  } catch {
    return undefined;
  }
}

async function readAdapterManifest(
  agent: ConversationAgent,
  ports: AgentPorts,
): Promise<{ name?: unknown; version?: unknown; bin?: unknown } | undefined> {
  try {
    const manifest: unknown = JSON.parse(
      await ports.fs.readText(win32.join(adapterPackageDirectory(ports.dataDir, agent), "package.json")),
    );
    return manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Installed = the pinned adapter's own package.json is there, at the pinned version (data-model). */
export async function isAdapterInstalled(agent: ConversationAgent, ports: AgentPorts): Promise<boolean> {
  const manifest = await readAdapterManifest(agent, ports);
  return manifest?.version === AGENT_ADAPTERS[agent].version;
}

export type AgentStatus = {
  availability: ConversationAgentAvailability;
  /** Present whenever the CLI was found. Never sent to the panel. */
  cliPath?: string;
};

/**
 * missing (no CLI) | version-problem (found, but `--version` gives nothing usable) | needs-install
 * (the pinned adapter is not there) | ready. A CLI newer than the tested one is still ready: there
 * is no hard range, a start failure is what says "different version" (classifyStartFailure).
 */
export async function agentAvailability(agent: ConversationAgent, ports: AgentPorts): Promise<AgentStatus> {
  const cliPath = await discoverCli(agent, ports);
  if (!cliPath) return { availability: { agent, availability: "missing" } };
  const version = await readCliVersion(cliPath, ports);
  if (!version) {
    return {
      availability: {
        agent,
        availability: "version-problem",
        detail: `${AGENT_ADAPTERS[agent].label} was found, but \`--version\` did not print a version number.`,
      },
      cliPath,
    };
  }
  const installed = await isAdapterInstalled(agent, ports);
  return { availability: { agent, availability: installed ? "ready" : "needs-install", version }, cliPath };
}

/** `<data>\agents\codex\app-server-shim.cmd` - what `CODEX_PATH` names (codex-strict.ts). */
export function codexShimCommandPath(dataDir: string): string {
  return win32.join(dataDir, "agents", "codex", "app-server-shim.cmd");
}

/**
 * The command file is the same on every machine, so it is written when it is missing or differs and
 * otherwise left alone: another broker may be running it right now. A failed write that leaves the
 * right content (another broker won the same write) is no failure.
 */
async function ensureCodexShimCommand(ports: AgentPorts): Promise<string> {
  const path = codexShimCommandPath(ports.dataDir);
  const current = () => ports.fs.readText(path).catch(() => undefined);
  if ((await current()) === CODEX_SHIM_COMMAND) return path;
  try {
    await ports.fs.writeText(path, CODEX_SHIM_COMMAND);
  } catch (error) {
    if ((await current()) !== CODEX_SHIM_COMMAND) throw error;
  }
  return path;
}

export type AdapterLaunchSpec = {
  command: string;
  args: string[];
  /** Added to the environment the broker passes on - not the whole environment. */
  env: Record<string, string>;
};

/**
 * How to start the installed adapter: the broker's node on the adapter's `bin` entry, with the CLI's
 * absolute path in `CLAUDE_CODE_EXECUTABLE` (R-315). Codex also gets
 * `DISABLE_MCP_CONFIG_FILTERING=true`, so the session's `hallpass` entry wins over the owner's own
 * (R-322), and its `CODEX_PATH` is Hallpass's app-server shim, never the CLI itself: the shim starts
 * the CLI and makes strict mode's turns read-only (codex-strict.ts; D-019-12, R-317, SC-135).
 */
export async function adapterLaunchSpec(
  agent: ConversationAgent,
  cliPath: string,
  ports: AgentPorts,
): Promise<AdapterLaunchSpec> {
  const manifest = await readAdapterManifest(agent, ports);
  if (!manifest) throw new Error(`the ${AGENT_ADAPTERS[agent].label} adapter is not installed`);
  const unscoped = AGENT_ADAPTERS[agent].package.split("/").pop();
  const entries: [string, unknown][] =
    typeof manifest.bin === "string"
      ? [[unscoped ?? "", manifest.bin]]
      : manifest.bin && typeof manifest.bin === "object"
        ? Object.entries(manifest.bin as Record<string, unknown>)
        : [];
  // The bin named like the package if there is one, otherwise the first.
  const chosen = entries.find(([name]) => name === unscoped) ?? entries[0];
  const bin = typeof chosen?.[1] === "string" && chosen[1] ? chosen[1] : undefined;
  if (!bin) throw new Error("the adapter's package.json has no bin entry");
  const packageDir = adapterPackageDirectory(ports.dataDir, agent);
  const entry = win32.resolve(packageDir, bin);
  if (!entry.toLowerCase().startsWith(`${packageDir.toLowerCase()}${win32.sep}`)) {
    throw new Error("the adapter's bin entry points outside the adapter folder");
  }
  if (agent === "claude-code") return { command: ports.nodePath, args: [entry], env: { CLAUDE_CODE_EXECUTABLE: cliPath } };
  // No shim, no Codex: the CLI behind CODEX_PATH directly would run strict turns with a writable sandbox.
  if (!(await ports.fs.exists(ports.codexShimEntry))) throw new Error("the Codex app-server shim is missing beside the broker");
  // The shim spares the agent mode's tuple as measured (T573); an adapter with other modes is refused.
  const adapterCode = await ports.fs.readText(entry).catch(() => "");
  if (!codexAdapterModesAsMeasured(adapterCode)) {
    throw new Error(
      `the installed Codex connector's modes are not the ones Hallpass's strict mode was measured with ` +
        `(codex-acp ${AGENT_ADAPTERS.codex.version}); Codex is not started`,
    );
  }
  return {
    command: ports.nodePath,
    args: [entry],
    env: {
      CODEX_PATH: await ensureCodexShimCommand(ports),
      DISABLE_MCP_CONFIG_FILTERING: "true",
      [CODEX_SHIM_ENV.node]: ports.nodePath,
      [CODEX_SHIM_ENV.shim]: ports.codexShimEntry,
      [CODEX_SHIM_ENV.cli]: cliPath,
    },
  };
}

export type StartFailureVersions = {
  agent: ConversationAgent;
  tested: string;
  /** Absent when no CLI was found to hand the adapter. */
  found?: string;
};

/** What the adapters say when they were not given a usable executable (R-315 evidence). */
const MISSING_EXECUTABLE = /native binary not found|CLAUDE_CODE_EXECUTABLE|CODEX_PATH|missing optional dependency/i;

const DETAIL_MAX = 600;

/** The text of whatever a failed ACP request threw: an Error, a JSON-RPC error object or a string. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { message, data } = error as { message?: unknown; data?: unknown };
    const parts: string[] = [];
    if (typeof message === "string" && message) parts.push(message);
    if (typeof data === "string" && data) parts.push(data);
    else if (data && typeof data === "object") {
      const details = (data as { details?: unknown }).details;
      parts.push(typeof details === "string" ? details : safeJson(data));
    }
    if (parts.length > 0) return parts.join(": ");
  }
  return "";
}

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

/**
 * Map a failure at `initialize` or the first `session/new` to the error the panel shows (T534,
 * R-315). No CLI to hand the adapter, or the adapter saying it has no usable executable, is
 * `agent-missing`; any other refusal with a CLI in hand is `agent-version` - "tested with X, found Y"
 * plus the agent's own words, redacted (R-326) and kept within the contract's 600 characters.
 */
export function classifyStartFailure(
  step: "initialize" | "session/new",
  error: unknown,
  versions: StartFailureVersions,
): ConversationError {
  const label = AGENT_ADAPTERS[versions.agent].label;
  const said = redact(errorText(error)).replace(/\s+/g, " ").trim();
  const missing = versions.found === undefined || MISSING_EXECUTABLE.test(said);
  const header = missing
    ? versions.found === undefined
      ? `${label} was not found (tested with ${label} ${versions.tested}).`
      : `${label} ${versions.found} could not be used by the connector (tested with ${versions.tested}).`
    : `Tested with ${label} ${versions.tested}, found ${versions.found}.`;
  const room = DETAIL_MAX - header.length - ` The agent said (${step}): `.length;
  const body = said
    ? ` The agent said (${step}): ${said.length > room ? `${said.slice(0, Math.max(room - 3, 0))}...` : said}`
    : ` The agent gave no reason at ${step}.`;
  return { code: missing ? "agent-missing" : "agent-version", detail: `${header}${body}`.slice(0, DETAIL_MAX) };
}
