import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONVERSATION_AGENTS,
  type ConversationAccepts,
  type ConversationAgent,
  type ConversationAgentAvailability,
  type ConversationAgentNote,
  type ConversationError,
  type ConversationMode,
} from "@hallpass/contracts";
import { hostDataDirectory } from "../host-paths.js";
import { HERMES_AGENT_MODES, launchSettings, writeLaunchFiles } from "./agent-launch-settings.js";
import { CODEX_SHIM_COMMAND, CODEX_SHIM_ENV, codexAdapterModesAsMeasured } from "./codex-strict.js";
import { redact, withoutEnvironmentValues } from "./redact.js";
import { runCommand } from "./run-command.js";

/**
 * Finding the owner's coding agent and what speaks ACP to it (019/T530, T531, T534; R-314, R-315,
 * R-322; 021 R-345, R-348). An agent is obtained one of three ways (`AgentKind`):
 *
 * - `adapter` (Claude Code, Codex): the owner has the CLI; the broker installs the slim ACP adapter
 *   beside it (install.ts) and starts the adapter with the CLI's absolute path in an environment
 *   variable, so the adapter does not need its own bundled copy;
 * - `installed` (Hermes): the owner installed a program that speaks ACP itself; the broker only finds
 *   it, checks its exact version and starts it;
 * - `fetched` (DeepSeek): an ACP package the broker fetches into the agent folder from the manifest and
 *   lockfile Hallpass ships, like an adapter, and starts under its own node.
 *
 * Everything that touches the machine (running a command, reading a file) goes through `AgentPorts`
 * so the tests decide what "the machine" holds.
 */

export type AgentKind = "adapter" | "installed" | "fetched";

/**
 * R-316 / R-351: what a panel mode is for one agent. `agentMode` is the agent's own mode id, set with
 * `session/set_mode` (for a launch-time agent, after `session/new`); absent when the agent has none.
 * `atLaunch` means the mode is fixed when the agent starts (environment and settings layer,
 * agent-launch-settings.ts), so changing it restarts the agent.
 */
export type AgentModeSetting = { agentMode?: string; atLaunch: boolean };

type DescriptionCommon = {
  /** What the owner sees in sentences. */
  label: string;
  /**
   * The version Hallpass was tested with (R-315): the CLI's (adapter; later ones are accepted), the
   * program's (installed; required exactly), or the package's (fetched; pinned exactly).
   */
  tested: string;
  modes: Readonly<Record<ConversationMode, AgentModeSetting>>;
  /**
   * D-021-16 (R-359): the agent keeps the mode its session was created with, whatever a later launch
   * says, so the mode is chosen with the start and never changed (`CONVERSATION_MODE_FIXED_AGENTS`).
   */
  modeFixedOnceStarted: boolean;
  /** How a stopped conversation continues (R-352): with replay (`session/load`) or without (`session/resume`). */
  continueWith: "session/load" | "session/resume";
  /** 023 R-365: the agent can be given MCP servers - Hallpass's browser tools among them. */
  takesBrowserTools: boolean;
  /**
   * 023 R-365: the agent starts its MCP servers before it answers `session/new` / `session/load`, so
   * a run whose `hallpass` server never greeted within 10 s of that did not take the tools (Hermes).
   */
  checksBrowserTools: boolean;
  /**
   * 023 R-369: where the name of the variable the agent reads its key from is found - Hermes: its home's
   * `config.yaml`, `model.key_env` / `model.api_key_env` (user-environment.ts). Absent: not looked for.
   */
  keyNameSource?: "hermes-config";
};

export type AdapterDescription = DescriptionCommon & {
  kind: "adapter";
  /** npm package name of the ACP adapter, as in `agents/<agent>/package.json`. */
  package: string;
  version: string;
  /** The CLI file `where.exe` is asked for. */
  cliFile: string;
  /** How long its `npm ci` may take (R-346). */
  installTimeoutMs: number;
  /** Its `npm ci` command line (R-314, R-357). */
  npmCiArgs: readonly string[];
};

export type InstalledDescription = DescriptionCommon & {
  kind: "installed";
  /** The program `where.exe` is asked for. */
  cliFile: string;
  /** Its ACP command line after the program (R-345). */
  launchArgs: readonly string[];
  /** R-355: what it is expected to accept before its first start; the start's own answer wins. */
  expectedAccepts: ConversationAccepts;
};

export type FetchedDescription = DescriptionCommon & {
  kind: "fetched";
  /** npm package name, as in `agents/<agent>/package.json`; pinned exactly. */
  package: string;
  version: string;
  /** After the package's bin entry, run by the broker's node (R-345). */
  launchArgs: readonly string[];
  installTimeoutMs: number;
  /** Its `npm ci` command line (R-357). */
  npmCiArgs: readonly string[];
  expectedAccepts: ConversationAccepts;
  /** Always said beside its state. */
  notes: readonly ConversationAgentNote[];
};

export type AgentDescription = AdapterDescription | InstalledDescription | FetchedDescription;

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * R-314 / R-315: an adapter's `npm ci` leaves out its optional dependencies - the adapter's bundled CLI,
 * since the owner's own CLI is used. No install script runs either way.
 */
export const ADAPTER_NPM_CI_ARGS = ["ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"] as const;

/**
 * R-357: a fetched agent keeps its optional dependencies - DeepSeek's platform native bindings are
 * optionalDependencies, and without them it cannot boot ("No usable native binding found").
 */
export const FETCHED_NPM_CI_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] as const;

/**
 * The agents (data-model "Agent description"), in contract order. Claude Code and Codex are exactly
 * the 019 pins; every mode maps to something the owner can see in the panel, and no mode maps to an
 * agent's full-access mode (Codex `agent-full-access`, Hermes `dont_ask`, DeepSeek
 * `danger-full-access`).
 */
export const AGENT_DESCRIPTIONS = {
  "claude-code": {
    kind: "adapter",
    label: "Claude Code",
    tested: "2.1.302",
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.81.2",
    cliFile: "claude.exe",
    installTimeoutMs: TEN_MINUTES,
    npmCiArgs: ADAPTER_NPM_CI_ARGS,
    modes: { strict: { agentMode: "default", atLaunch: false }, "agent-review": { agentMode: "auto", atLaunch: false } },
    modeFixedOnceStarted: false,
    continueWith: "session/load",
    takesBrowserTools: true,
    checksBrowserTools: false,
  },
  // Codex strict mode rests on this exact adapter (codex-strict.ts): a version bump means measuring
  // T573 again (does `read-only` still ask before every in-folder write through the shim?) and
  // updating `codexAdapterModesAsMeasured`; until then a launch refuses an adapter whose modes differ.
  codex: {
    kind: "adapter",
    label: "Codex",
    tested: "0.163.0",
    package: "@agentclientprotocol/codex-acp",
    version: "1.13.1",
    cliFile: "codex.cmd",
    installTimeoutMs: TEN_MINUTES,
    npmCiArgs: ADAPTER_NPM_CI_ARGS,
    modes: { strict: { agentMode: "read-only", atLaunch: false }, "agent-review": { agentMode: "agent", atLaunch: false } },
    modeFixedOnceStarted: false,
    continueWith: "session/load",
    takesBrowserTools: true,
    checksBrowserTools: false,
  },
  // R-347: strict is Hermes' `default` mode under a managed layer that switches its command,
  // code-running, helper-agent and saved-login tools off; never `dont_ask`.
  hermes: {
    kind: "installed",
    label: "Hermes",
    tested: "0.22.2",
    cliFile: "hermes",
    launchArgs: ["acp"],
    modes: {
      strict: { agentMode: HERMES_AGENT_MODES.strict, atLaunch: true },
      "agent-review": { agentMode: HERMES_AGENT_MODES["agent-review"], atLaunch: true },
    },
    // Restarted into the new mode's launch settings, and its session takes the mode set after the load.
    modeFixedOnceStarted: false,
    continueWith: "session/load",
    expectedAccepts: { image: true, context: false },
    takesBrowserTools: true,
    checksBrowserTools: true,
    keyNameSource: "hermes-config",
  },
  // R-346, R-349: 611 packages measured at 9-13 minutes, so a longer bound; its permission mode is an
  // environment variable fixed at start (no ACP modes), never `danger-full-access`.
  deepseek: {
    kind: "fetched",
    label: "DeepSeek",
    tested: "0.2.1-rc.2",
    package: "@deepseek-ai/dsh",
    version: "0.2.1-rc.2",
    launchArgs: ["--profile", "acp"],
    installTimeoutMs: 30 * 60 * 1000,
    npmCiArgs: FETCHED_NPM_CI_ARGS,
    modes: { strict: { atLaunch: true }, "agent-review": { atLaunch: true } },
    // D-021-16 (R-359): its session keeps the permission mode of its `session/new`; a resumed session
    // ignores the launch environment, so a restart cannot change it.
    modeFixedOnceStarted: true,
    continueWith: "session/resume",
    // 023 R-365: it takes no MCP servers, so the browser tools never reach it.
    takesBrowserTools: false,
    checksBrowserTools: false,
    expectedAccepts: { image: true, context: false },
    notes: ["pre-release"],
  },
} as const satisfies Readonly<Record<ConversationAgent, AgentDescription>>;

/** The 019 name of the table, kept for the callers that only need an agent's `label`. */
export const AGENT_ADAPTERS = AGENT_DESCRIPTIONS;

const describeAgent = (agent: ConversationAgent): AgentDescription => AGENT_DESCRIPTIONS[agent];

/** The versions each agent was tested with (R-315, R-345); for the messages. */
export const TESTED_AGENT_VERSIONS: Readonly<Record<ConversationAgent, string>> = Object.fromEntries(
  CONVERSATION_AGENTS.map((agent) => [agent, AGENT_DESCRIPTIONS[agent].tested]),
) as Record<ConversationAgent, string>;

/** The npm package an agent's folder holds (adapter, fetched); undefined for an installed program. */
export function packagePin(agent: ConversationAgent): { package: string; version: string } | undefined {
  const description = describeAgent(agent);
  return description.kind === "installed" ? undefined : { package: description.package, version: description.version };
}

export type ExecResult = { code: number | null; stdout: string; stderr: string };

export type AgentPorts = {
  /** `%LOCALAPPDATA%\hallpass`. */
  dataDir: string;
  env: {
    USERPROFILE?: string | undefined;
    APPDATA?: string | undefined;
    /** Where Git for Windows usually is (R-348). */
    ProgramFiles?: string | undefined;
    /** cmd.exe, for an agent program that is a batch file. */
    ComSpec?: string | undefined;
  };
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
    env: { USERPROFILE: env.USERPROFILE, APPDATA: env.APPDATA, ProgramFiles: env.ProgramFiles, ComSpec: env.ComSpec },
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

function requirePackage(agent: ConversationAgent): { package: string; version: string } {
  const pin = packagePin(agent);
  if (pin === undefined) throw new Error(`${describeAgent(agent).label} is not fetched by Hallpass`);
  return pin;
}

/**
 * `<data>\agents\<agent>\<package version>` - where 0.15.0 and earlier put the pinned package's
 * `npm ci` tree (an adapter or a fetched agent), renamed into place whole, so complete. A newer
 * install stays where its `npm ci` ran and `installPointerPath` names it (R-362);
 * `installedAdapterDirectory` says which one is the install. An installed program has none: this
 * throws for it.
 */
export function adapterDirectory(dataDir: string, agent: ConversationAgent): string {
  return win32.join(dataDir, "agents", agent, requirePackage(agent).version);
}

/** The folder an install's `npm ci` runs in, and stays in: `agents\<agent>\.install-<broker pid>-<random>`. */
export const INSTALL_TREE_PREFIX = ".install-";
const INSTALL_TREE_NAME = /^\.install-\d+-[0-9a-z]+$/u;

/**
 * R-362: `<data>\agents\<agent>\<package version>.installed.json` = `{"folder":".install-<pid>-<random>"}`.
 * Created whole, and only once the tree it names was verified, so a tree it names is complete.
 */
export function installPointerPath(dataDir: string, agent: ConversationAgent): string {
  return win32.join(dataDir, "agents", agent, `${requirePackage(agent).version}.installed.json`);
}

/** The tree folder a pointer names, or undefined: a bare `.install-*` name, so nothing outside the agent folder. */
export function parseInstallPointer(text: string): string | undefined {
  try {
    const folder: unknown = (JSON.parse(text) as { folder?: unknown } | null)?.folder;
    return typeof folder === "string" && INSTALL_TREE_NAME.test(folder) ? folder : undefined;
  } catch {
    return undefined;
  }
}

/** R-362 (L3): how many times a read the file system refused is tried, and how far apart. */
export type ReadRetry = { attempts: number; delayMs: number };
/** Under a second in all: a real-time file scanner looks at a file this small in far less. */
export const READ_RETRY: ReadRetry = { attempts: 5, delayMs: 250 };

/** R-362 (L3): a file of the install that is there but could not be read - not a missing or damaged one. */
export class UnreadableInstallFileError extends Error {}

const NOT_FOUND = new Set(["ENOENT", "ENOTDIR"]);

/**
 * R-362 (L3): a small file of the install (the pointer, the pinned package.json), or undefined when it
 * is not there. Only not-found says "not there": any other refusal of the file system (EBUSY, EPERM,
 * EACCES - a real-time file scanner holding it open) says nothing about the install, so the read is
 * tried again and, if it still fails, throws `UnreadableInstallFileError` - never read as absent,
 * which would start a download or replace a good pointer. An error with no errno code did not come
 * from the file system and reads as not there. The message names the file, not its path.
 */
export async function readInstallFile(
  readText: (path: string) => Promise<string>,
  path: string,
  retry: ReadRetry = READ_RETRY,
): Promise<string | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readText(path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || NOT_FOUND.has(code)) return undefined;
      if (attempt >= retry.attempts) {
        throw new UnreadableInstallFileError(`${win32.basename(path)} could not be read (${code}); another program may be holding it open`);
      }
      await delay(retry.delayMs);
    }
  }
}

/**
 * R-362: the tree the pointer names when there is one, else the 0.15.0 folder - the one place to look.
 * A pointer that is there but cannot be read throws (L3): it is not passed over for the 0.15.0 folder,
 * which may hold an older install, so launch fails saying so instead of starting something else.
 */
export async function installedAdapterDirectory(
  dataDir: string,
  agent: ConversationAgent,
  readText: (path: string) => Promise<string>,
  retry: ReadRetry = READ_RETRY,
): Promise<string> {
  const text = await readInstallFile(readText, installPointerPath(dataDir, agent), retry);
  const folder = text === undefined ? undefined : parseInstallPointer(text);
  return folder === undefined ? adapterDirectory(dataDir, agent) : win32.join(dataDir, "agents", agent, folder);
}

const adapterPackageDirectory = async (agent: ConversationAgent, ports: AgentPorts) =>
  win32.join(
    await installedAdapterDirectory(ports.dataDir, agent, (path) => ports.fs.readText(path)),
    "node_modules",
    ...requirePackage(agent).package.split("/"),
  );

/** The first semver in a CLI's `--version` output (`2.1.302 (Claude Code)`, `codex-cli 0.162.1`). */
export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text)?.[0];
}

/** A path later handed to cmd.exe must not carry a quote or a percent sign (run-command.ts). */
const shellSafe = (path: string) => !/["%\r\n\0]/.test(path);

/** Where the program usually is when it is not on the PATH (R-315, R-345). */
function knownLocations(agent: ConversationAgent, env: AgentPorts["env"]): string[] {
  const userBin = (file: string) => (env.USERPROFILE ? [win32.join(env.USERPROFILE, ".local", "bin", file)] : []);
  switch (agent) {
    case "claude-code":
      return userBin("claude.exe");
    case "codex":
      return env.APPDATA ? [win32.join(env.APPDATA, "npm", "codex.cmd")] : [];
    case "hermes":
      return userBin("hermes.exe");
    case "deepseek":
      return [];
  }
}

/** `where.exe <name>`, the lines it printed; none when it fails or cannot run. */
async function whereAll(name: string, ports: AgentPorts): Promise<string[]> {
  try {
    const where = await ports.exec("where.exe", [name]);
    if (where.code === 0) return where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    // where.exe missing or blocked: the known locations are the only route left.
  }
  return [];
}

/**
 * The absolute path of the owner's CLI or program: `where.exe` on the PATH first, then the known
 * per-user locations (R-315, R-345). Undefined means it is not installed as far as the broker can
 * tell - and always for a fetched agent, which has no program of the owner's.
 */
export async function discoverCli(agent: ConversationAgent, ports: AgentPorts): Promise<string | undefined> {
  const description = describeAgent(agent);
  if (description.kind === "fetched") return undefined;
  const found = await whereAll(description.cliFile, ports);
  for (const candidate of [...found, ...knownLocations(agent, ports.env)]) {
    if (shellSafe(candidate) && (await ports.fs.exists(candidate))) return candidate;
  }
  return undefined;
}

/** A bash that is Git for Windows' own (`...\Git\bin\bash.exe`, `...\Git\usr\bin\bash.exe`), not WSL's launcher. */
const GIT_BASH = /\\Git\\(?:usr\\)?bin\\bash\.exe$/i;

/**
 * R-348: whether Git Bash is on this machine - Hermes' command tool needs it. A `bash` on the PATH
 * counts only inside a Git install; otherwise `%ProgramFiles%\Git\bin\bash.exe`.
 */
export async function findGitBash(ports: AgentPorts): Promise<string | undefined> {
  const fallback = ports.env.ProgramFiles ? [win32.join(ports.env.ProgramFiles, "Git", "bin", "bash.exe")] : [];
  for (const candidate of [...(await whereAll("bash", ports)).filter((line) => GIT_BASH.test(line)), ...fallback]) {
    if (await ports.fs.exists(candidate)) return candidate;
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

/**
 * The pinned package's package.json and the folder it was read from (the one launch then uses).
 * A pointer held open throws (R-362, L3), so launch says why instead of "not installed".
 */
async function readAdapterManifest(
  agent: ConversationAgent,
  ports: AgentPorts,
): Promise<{ packageDir: string; manifest: { name?: unknown; version?: unknown; bin?: unknown } } | undefined> {
  if (packagePin(agent) === undefined) return undefined;
  try {
    const packageDir = await adapterPackageDirectory(agent, ports);
    const manifest: unknown = JSON.parse(await ports.fs.readText(win32.join(packageDir, "package.json")));
    return manifest && typeof manifest === "object" ? { packageDir, manifest: manifest as Record<string, unknown> } : undefined;
  } catch (error) {
    if (error instanceof UnreadableInstallFileError) throw error;
    return undefined;
  }
}

/**
 * Installed = the pinned package's own package.json is there, at the pinned version (data-model).
 * A pointer held open is not installed for now; the install then fails saying why and downloads nothing (R-362, L3).
 */
export async function isAdapterInstalled(agent: ConversationAgent, ports: AgentPorts): Promise<boolean> {
  const pin = packagePin(agent);
  if (pin === undefined) return false;
  const read = await readAdapterManifest(agent, ports).catch(() => undefined);
  return read?.manifest.version === pin.version;
}

export type AgentStatus = {
  availability: ConversationAgentAvailability;
  /** Present whenever the CLI or program was found. Never sent to the panel. */
  cliPath?: string;
};

/**
 * missing (no CLI) | version-problem (found, but `--version` gives nothing usable) | needs-install
 * (the pinned adapter is not there) | ready. A CLI newer than the tested one is still ready: there
 * is no hard range, a start failure is what says "different version" (classifyStartFailure).
 *
 * 021: an installed program (Hermes) must be exactly the tested version - another one is a version
 * problem naming both - and needs nothing downloaded; without Git Bash it stays ready with the
 * `git-missing` note (R-348). A fetched agent (DeepSeek) has no program to find: it needs the
 * download until its pinned package is in the agent folder, and always carries its notes.
 */
export async function agentAvailability(agent: ConversationAgent, ports: AgentPorts): Promise<AgentStatus> {
  const description = describeAgent(agent);
  if (description.kind === "fetched") {
    const installed = await isAdapterInstalled(agent, ports);
    return {
      availability: {
        agent,
        availability: installed ? "ready" : "needs-install",
        ...(installed ? { version: description.version } : {}),
        ...(description.notes.length > 0 ? { notes: [...description.notes] } : {}),
      },
    };
  }
  const cliPath = await discoverCli(agent, ports);
  if (!cliPath) return { availability: { agent, availability: "missing" } };
  const version = await readCliVersion(cliPath, ports);
  if (!version) {
    return {
      availability: {
        agent,
        availability: "version-problem",
        detail: `${description.label} was found, but \`--version\` did not print a version number.`,
      },
      cliPath,
    };
  }
  if (description.kind === "installed") {
    if (version !== description.tested) {
      return {
        availability: {
          agent,
          availability: "version-problem",
          version,
          detail: `Hallpass works with ${description.label} ${description.tested}; this computer has ${description.label} ${version}.`,
        },
        cliPath,
      };
    }
    const gitMissing = (await findGitBash(ports)) === undefined;
    return { availability: { agent, availability: "ready", version, ...(gitMissing ? { notes: ["git-missing"] } : {}) }, cliPath };
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
  /**
   * The arguments are one command line already quoted for cmd.exe (a batch-file program, as
   * run-command.ts starts one): spawn them with `windowsVerbatimArguments`.
   */
  windowsVerbatimArguments?: true;
};

const isBatch = (file: string) => /\.(cmd|bat)$/i.test(file);

/**
 * A program's own command line: the program itself, or - for a `.cmd` / `.bat`, which Node refuses
 * to spawn without a shell since 20.12 (CVE-2024-27980) - `cmd.exe /d /s /c "<file> <args>"` with
 * verbatim arguments, exactly as run-command.ts builds it. `discoverCli` already refused a path with a
 * quote, a percent sign or a line break, and the arguments are fixed ones.
 */
function programLaunch(file: string, args: readonly string[], env: Record<string, string>, ports: AgentPorts): AdapterLaunchSpec {
  if (!isBatch(file)) return { command: file, args: [...args], env };
  if ([file, ...args].some((part) => !shellSafe(part))) throw new Error("refusing to pass a quote, percent sign or line break to cmd.exe");
  const quote = (part: string) => (/[\s&|<>^()]/.test(part) ? `"${part}"` : part);
  return {
    command: ports.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${[file, ...args].map(quote).join(" ")}"`],
    env,
    windowsVerbatimArguments: true,
  };
}

/**
 * How to start an agent in a panel mode (default strict).
 *
 * - An adapter (Claude Code, Codex): the broker's node on the adapter's `bin` entry, with the CLI's
 *   absolute path in `CLAUDE_CODE_EXECUTABLE` (R-315). Codex also gets
 *   `DISABLE_MCP_CONFIG_FILTERING=true`, so the session's `hallpass` entry wins over the owner's own
 *   (R-322), and its `CODEX_PATH` is Hallpass's app-server shim, never the CLI itself: the shim starts
 *   the CLI and makes strict mode's turns read-only (codex-strict.ts; D-019-12, R-317, SC-135). Their
 *   modes are agent modes, so the mode does not change the spec.
 * - Hermes: `hermes acp` itself, after the mode's managed layer is written, with `HERMES_MANAGED_DIR`
 *   naming it (agent-launch-settings.ts; R-347).
 * - DeepSeek: the broker's node on the fetched package's `bin` entry with `--profile acp`, and the
 *   mode's permission mode and telemetry off in the environment (R-349, R-350).
 */
export async function adapterLaunchSpec(
  agent: ConversationAgent,
  cliPath: string | undefined,
  ports: AgentPorts,
  mode: ConversationMode = "strict",
): Promise<AdapterLaunchSpec> {
  const description = describeAgent(agent);
  const settings = launchSettings(agent, mode, ports.dataDir);
  if (description.kind === "installed") {
    if (cliPath === undefined) throw new Error(`${description.label} was not found`);
    await writeLaunchFiles(settings.files, ports.fs);
    return programLaunch(cliPath, description.launchArgs, { ...settings.env }, ports);
  }
  if (description.kind === "adapter" && cliPath === undefined) throw new Error(`${description.label} was not found`);
  const read = await readAdapterManifest(agent, ports);
  if (!read) {
    throw new Error(`the ${description.label} ${description.kind === "adapter" ? "adapter" : "package"} is not installed`);
  }
  const { manifest, packageDir } = read;
  const unscoped = requirePackage(agent).package.split("/").pop();
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
  const entry = win32.resolve(packageDir, bin);
  if (!entry.toLowerCase().startsWith(`${packageDir.toLowerCase()}${win32.sep}`)) {
    throw new Error("the adapter's bin entry points outside the adapter folder");
  }
  if (description.kind === "fetched") {
    await writeLaunchFiles(settings.files, ports.fs);
    return { command: ports.nodePath, args: [entry, ...description.launchArgs], env: { ...settings.env } };
  }
  if (cliPath === undefined) throw new Error(`${description.label} was not found`);
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
 * `agent-missing`; a refusal from another version than the tested one is `agent-version` - "tested
 * with X, found Y" - and one from the tested version itself is no version problem (R-358): it is the
 * start failure `agent-exited`, "<agent> <version> could not start". Each carries the agent's own
 * words, redacted (R-326) and kept within the contract's 600 characters.
 * `env` (T692, SC-161): the environment the agent ran with; no value of it is said.
 * `connectorMismatch`: the failure itself shows the connector does not fit (the modes it offers
 * differ), so it is `agent-version` whatever the version.
 */
export function classifyStartFailure(
  step: "initialize" | "session/new",
  error: unknown,
  versions: StartFailureVersions,
  env: Readonly<Record<string, string | undefined>> = {},
  connectorMismatch = false,
): ConversationError {
  const label = AGENT_ADAPTERS[versions.agent].label;
  // Classified by the agent's own words; shown without any value of its environment.
  const raw = errorText(error);
  const said = redact(withoutEnvironmentValues(raw, env)).replace(/\s+/g, " ").trim();
  const missing = versions.found === undefined || MISSING_EXECUTABLE.test(raw);
  const versionProblem = connectorMismatch || versions.found !== versions.tested;
  const header = missing
    ? versions.found === undefined
      ? `${label} was not found (tested with ${label} ${versions.tested}).`
      : `${label} ${versions.found} could not be used by the connector (tested with ${versions.tested}).`
    : versionProblem
      ? `Tested with ${label} ${versions.tested}, found ${versions.found}.`
      : `${label} ${versions.found} could not start.`;
  const room = DETAIL_MAX - header.length - ` The agent said (${step}): `.length;
  const body = said
    ? ` The agent said (${step}): ${said.length > room ? `${said.slice(0, Math.max(room - 3, 0))}...` : said}`
    : ` The agent gave no reason at ${step}.`;
  const code = missing ? "agent-missing" : versionProblem ? "agent-version" : "agent-exited";
  return { code, detail: `${header}${body}`.slice(0, DETAIL_MAX) };
}
