/**
 * The environment check (004/T084, quickstart.md §1).
 *
 * The probe never launches a browser: it attaches to the one the owner is using, which is the only
 * way an acceptance run says anything about the owner's machine. That makes "is the right browser
 * there, with the right two extensions and an installed bridge" the first question of every run, and
 * the answer has to be specific - the owner's time is spent on whichever piece is missing, not on
 * discovering which one it was.
 *
 * Two kinds of answer, deliberately:
 *
 * - the endpoint itself is **fatal**. Without it there is nothing to check, and the message names
 *   the quickstart step that fixes it.
 * - everything else is a **named problem** in a list. The run can still produce a report with a
 *   filled table saying exactly what was missing, which is worth more than an aborted run.
 *
 * Every outside contact is a parameter, so the tests answer for the browser, the disk and `reg.exe`.
 */

/** The agent build's pinned id (`AGENT_HOST_ALLOWED_ORIGINS` in `packages/agent-host/src/install/manifest.ts`). */
import { foreignAgentServersProblem, listAgentServerProcesses } from "@hallpass/test-kit";

export const AGENT_EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";

/**
 * The reference extension - the baseline half of every parity scenario.
 *
 * Its store id belongs to a third party and is not ours to publish (009/FR-129), so it is an outside
 * contact like every other: the real deps read `HALLPASS_REFERENCE_EXTENSION_ID` and the tests pass
 * their own. Unset (`""`), the check says *that* rather than hunting the browser for an extension
 * nobody named - see `checkEnvironment`.
 */
export function referenceExtensionId(env: NodeJS.ProcessEnv = process.env): string {
  return env.HALLPASS_REFERENCE_EXTENSION_ID ?? "";
}

export type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type FetchLike = (url: string, init?: { method?: string }) => Promise<FetchResponse>;

/**
 * The probe's own pairing, as an outside contact like every other (004/T111c).
 *
 * The S0 run of 2026-09-09 answered `not-paired` on all four scenarios because a packaged journey had
 * run before it and ended by unpairing the agent. Nothing in the probe was wrong except this: it read
 * pairing state some other run happened to leave behind. So the check establishes what it needs.
 *
 * `establish` is a warm-up **agent session**, not a write, because of what B27 learned the hard way:
 * the CDP helper answers a pairing request that is already in flight, and with nothing pending there
 * is nothing for it to answer. The session raises the request; the accept lands on that request.
 *
 * The three calls are a parameter so the branches are pinned without a browser or a paid session -
 * a warm-up that ran when the pairing was already there would be the owner's money for nothing.
 */
export type PairingProbe = {
  /** This machine's stable agent id, or `undefined` when the bridge has never run. */
  agentId: () => Promise<string | undefined>;
  /** Whether the browser's durable record already holds an accepted pairing for that id. */
  isPaired: (agentId: string) => Promise<boolean>;
  /** Runs the warm-up session and accepts the request it raises. Answers, never throws. */
  establish: (agentId: string) => Promise<{ established: boolean; detail: string }>;
};

export type EnvironmentDeps = {
  endpoint: string;
  fetch: FetchLike;
  pairing: PairingProbe;
  fileExists: (path: string) => Promise<boolean>;
  runCommand: (command: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;
  hostManifestPath: string;
  /** The parity baseline's extension id; `""` means the machine was never told which one it is. */
  referenceExtensionId: string;
  /**
   * `HALLPASS_FOREIGN_AGENT_SERVERS=allow` with a non-default `LOCALAPPDATA` (008/T237): the browser under
   * test and this runner share a private data dir, so other sessions' servers cannot reach it. The
   * attach gate's fixture honours the same word with the same check.
   */
  foreignServersAllowed?: boolean;
  mcpServerPath: string;
  registryKeys: readonly string[];
  /**
   * The agent-bridge servers other sessions already have running on this machine (004/T167).
   * Absent means the machine was not asked, which the table says rather than reporting "none".
   */
  agentServers?: () => Promise<readonly { pid: number; parentPid: number }[]>;
};

export type ProbeEnvironment = {
  endpoint: string;
  browserVersion: string;
  extensionBuild: string;
  referenceVersion: string;
  bridgeInstall: string;
  claudeVersion: string;
  /** Whether the probe's pairing was found already accepted or established by a warm-up (T111c). */
  pairing: string;
  /**
   * The agent-bridge servers from other sessions that were attached when the run started (T167).
   * Any at all is a refusal: each is a second agent the scenarios never started.
   */
  foreignAgentServers: string;
  /** One line per missing piece; empty means the machine is ready. */
  problems: string[];
};

type DevToolsTarget = { id?: unknown; title?: unknown; url?: unknown };

const QUICKSTART = "specs/004-reference-parity-bridge/quickstart.md §1";

function targetsOf(value: unknown): DevToolsTarget[] {
  return Array.isArray(value) ? (value as DevToolsTarget[]) : [];
}

function findExtension(targets: readonly DevToolsTarget[], id: string): DevToolsTarget | undefined {
  return targets.find((entry) => typeof entry.url === "string" && entry.url.startsWith(`chrome-extension://${id}/`));
}

async function listTargets(deps: EnvironmentDeps): Promise<DevToolsTarget[]> {
  const response = await deps.fetch(`${deps.endpoint}/json/list`);
  return response.ok ? targetsOf(await response.json()) : [];
}

/**
 * Wakes a sleeping extension and looks again.
 *
 * A service worker that has gone to sleep does not appear in `/json/list`, so "not listed" and "not
 * installed" look identical. Opening one of the extension's own pages starts it; the page is closed
 * again immediately so the check leaves the owner's browser as it found it.
 */
async function wakeAndRelist(deps: EnvironmentDeps, id: string): Promise<DevToolsTarget[]> {
  const opened = await deps.fetch(`${deps.endpoint}/json/new?chrome-extension://${id}/manifest.json`, { method: "PUT" });
  if (!opened.ok) {
    return [];
  }

  const target = (await opened.json()) as DevToolsTarget;
  const targets = await listTargets(deps);

  if (typeof target.id === "string") {
    await deps.fetch(`${deps.endpoint}/json/close/${target.id}`);
  }
  return targets;
}

async function describeExtension(
  deps: EnvironmentDeps,
  targets: DevToolsTarget[],
  id: string,
  label: string,
  problems: string[],
): Promise<{ description: string; targets: DevToolsTarget[] }> {
  let known = targets;
  let found = findExtension(known, id);

  if (found === undefined) {
    known = await wakeAndRelist(deps, id);
    found = findExtension(known, id);
  }

  if (found === undefined) {
    problems.push(`${label} extension ${id} is not loaded in the attached browser (${QUICKSTART}).`);
    return { description: `${id} (not loaded)`, targets: known };
  }

  const title = typeof found.title === "string" && found.title !== "" ? found.title : id;
  return { description: `${title} — ${id}`, targets: known };
}

/**
 * The baseline half of the table, and the one check that can be *unasked*: without an id there is no
 * extension to look for, so the probe says the id is missing instead of waking a tab at
 * `chrome-extension:///manifest.json` and reporting the baseline as not loaded.
 */
async function describeReference(
  deps: EnvironmentDeps,
  targets: DevToolsTarget[],
  problems: string[],
): Promise<{ description: string; targets: DevToolsTarget[] }> {
  if (deps.referenceExtensionId === "") {
    problems.push("reference extension id not configured (set HALLPASS_REFERENCE_EXTENSION_ID).");
    return { description: "not configured", targets };
  }
  return describeExtension(deps, targets, deps.referenceExtensionId, "reference", problems);
}

async function checkBridgeInstall(deps: EnvironmentDeps, problems: string[]): Promise<string> {
  const parts: string[] = [];

  if (await deps.fileExists(deps.hostManifestPath)) {
    parts.push("host manifest");
  } else {
    problems.push(`the native-messaging host manifest is missing at ${deps.hostManifestPath} (run npm run agent-host:install).`);
  }

  const registered: string[] = [];
  for (const key of deps.registryKeys) {
    const result = await deps.runCommand("reg.exe", ["query", key, "/ve"]);
    if (result.ok) {
      registered.push(key);
    }
  }
  if (registered.length > 0) {
    parts.push(`${registered.length}/${deps.registryKeys.length} HKCU keys`);
  } else {
    problems.push(`no NativeMessagingHosts registry key is registered (${deps.registryKeys.join(", ")}); run npm run agent-host:install.`);
  }

  if (await deps.fileExists(deps.mcpServerPath)) {
    parts.push("dist/mcp-server.js");
  } else {
    problems.push(`${deps.mcpServerPath} does not exist — the probe's .mcp.json points at it; run npm run build.`);
  }

  return parts.length === 0 ? "not installed" : parts.join(" + ");
}

/**
 * The pairing the run needs, found or made (004/T111c).
 *
 * Run last and only on an otherwise ready machine: a warm-up costs the owner a session, and on a
 * machine that is already missing an extension or the bridge it would only fail more slowly.
 *
 * A pairing that could not be established is a **problem**, not a note. Without it every scenario
 * answers `not-paired` - four paid sessions measuring the probe's own setup instead of the product.
 */
async function checkPairing(deps: EnvironmentDeps, problems: string[]): Promise<string> {
  if (problems.length > 0) {
    return "not checked (the machine is missing something else first)";
  }

  const agentId = await deps.pairing.agentId();
  if (agentId === undefined) {
    problems.push(
      "there is no agent-id file, so the probe cannot tell whether it is paired; the bridge has never run (run npm run agent-host:install, then one session).",
    );
    return "not checked (no agent-id file)";
  }

  if (await deps.pairing.isPaired(agentId)) {
    return `found — ${agentId} is already accepted`;
  }

  const outcome = await deps.pairing.establish(agentId);
  if (!outcome.established) {
    problems.push(`the agent ${agentId} is not paired and the warm-up session could not pair it (${outcome.detail}); every scenario would be refused not-paired.`);
    return `not established — ${outcome.detail}`;
  }
  return `established — ${agentId} paired by a warm-up session (${outcome.detail})`;
}

/** The environment record the report's table is built from. Throws only when the browser is absent. */
export async function checkEnvironment(deps: EnvironmentDeps): Promise<ProbeEnvironment> {
  const problems: string[] = [];

  let version: Record<string, unknown>;
  try {
    const response = await deps.fetch(`${deps.endpoint}/json/version`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    version = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `probe-004: no browser answered HALLPASS_CDP_ENDPOINT (${deps.endpoint}/json/version): ${reason}.`,
        `  Start Chrome from the remote-debugging shortcut in ${QUICKSTART} and leave it open;`,
        "  the probe attaches to the owner's browser, it never launches one.",
      ].join("\n"),
    );
  }

  const targets = await listTargets(deps);
  const agent = await describeExtension(deps, targets, AGENT_EXTENSION_ID, "agent build", problems);
  const reference = await describeReference(deps, agent.targets, problems);

  const bridgeInstall = await checkBridgeInstall(deps, problems);

  const cli = await deps.runCommand("claude", ["--version"]);
  if (!cli.ok) {
    problems.push("the `claude` CLI is not on PATH; the probe cannot start an agent session without it.");
  }

  const pairing = await checkPairing(deps, problems);

  const foreignAgentServers = await checkForeignAgentServers(deps, problems);

  return {
    endpoint: deps.endpoint,
    browserVersion: typeof version.Browser === "string" ? version.Browser : "unknown",
    extensionBuild: agent.description,
    referenceVersion: reference.description,
    bridgeInstall,
    claudeVersion: cli.ok ? cli.stdout.trim() : "not found",
    pairing,
    foreignAgentServers,
    problems,
  };
}

/**
 * Refuses the run while another session's agent-bridge server is attached to this machine's relay
 * (004/T167): the probe's `claude -p` sessions are meant to be the only agents the extension sees,
 * and a foreign one shows up as a pairing prompt the probe never raised and a session holding
 * tabs no scenario opened - the shape of the S1/S2 ids that flipped between runs even alone.
 */
async function checkForeignAgentServers(deps: EnvironmentDeps, problems: string[]): Promise<string> {
  if (!deps.agentServers) return "not checked";
  if (deps.foreignServersAllowed) return "allowed by the runner (private LOCALAPPDATA shared with the browser)";
  const servers = await deps.agentServers();
  const problem = foreignAgentServersProblem(servers);
  if (problem === undefined) return "none";
  problems.push(problem);
  return `${servers.length} attached — pid ${servers.map((server) => server.pid).join(", ")}`;
}

/** The real dependencies: loopback HTTP, the disk, and `reg.exe` / `claude` on PATH. */
export async function realEnvironmentDeps(
  endpoint: string,
  repositoryRoot: string,
  pairing: PairingProbe,
): Promise<EnvironmentDeps> {
  const { access } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const { hostManifestPath } = await import("@hallpass/agent-host");
  // The registry keys are not on the package's export map, so the built module is loaded by path
  // rather than copied here: two hand-written lists of registry keys is how the installer and the
  // check end up disagreeing about what "installed" means.
  const { pathToFileURL } = await import("node:url");
  const windows = (await import(
    pathToFileURL(join(repositoryRoot, "packages", "agent-host", "dist", "install", "windows.js")).href
  )) as { NATIVE_MESSAGING_REGISTRY_KEYS: readonly string[] };

  const execFileAsync = promisify(execFile);
  const runCommand: EnvironmentDeps["runCommand"] = async (command, args) => {
    try {
      // No `shell: true`: it would concatenate these arguments into a command line (DEP0190) and
      // the registry keys contain backslashes. `reg.exe` and `claude` are both found on PATH.
      const { stdout } = await execFileAsync(command, [...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, stdout: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    endpoint,
    pairing,
    fetch: async (url, init) => {
      const response = await fetch(url, { method: init?.method ?? "GET" });
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
        text: () => response.text(),
      };
    },
    fileExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    runCommand,
    referenceExtensionId: referenceExtensionId(),
    agentServers: () => listAgentServerProcesses(runCommand),
    hostManifestPath: hostManifestPath(
      // The registry points Chrome at the manifest under the machine's usual LOCALAPPDATA even when
      // this runner was started with a private one; look where Chrome looks.
      foreignServersAllowed() ? { ...process.env, LOCALAPPDATA: usualLocalAppData() } : process.env,
    ),
    foreignServersAllowed: foreignServersAllowed(),
    mcpServerPath: join(repositoryRoot, "packages", "agent-host", "dist", "mcp-server.js"),
    registryKeys: windows.NATIVE_MESSAGING_REGISTRY_KEYS,
  };
}

function usualLocalAppData(): string {
  return `${process.env.USERPROFILE ?? ""}\\AppData\\Local`;
}

function foreignServersAllowed(): boolean {
  if (process.env.HALLPASS_FOREIGN_AGENT_SERVERS !== "allow") return false;
  const runnerLocal = (process.env.LOCALAPPDATA ?? usualLocalAppData()).replace(/\//g, "\\").toLowerCase();
  return runnerLocal !== usualLocalAppData().toLowerCase();
}
