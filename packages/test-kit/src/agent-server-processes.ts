/**
 * The agent-bridge servers already running on this machine (004/T167).
 *
 * Every Claude Code session with `hallpass` registered spawns its own `mcp-server.js`, and every
 * one of them dials the same relay and greets the same extension. To a packaged journey or an
 * acceptance probe that is a second agent it never started: a pairing prompt that names
 * `claude-code` instead of the test's own client, a session in the panel holding tabs the scenario
 * never opened. Measured on 2026-09-13, that is what the attach-mode family's moving reds were -
 * `agent-input` in one run, `agent-pairing` and `agent-actions` in the next, every one of them green
 * alone - and a run cannot tell that apart from a product defect from inside a single assertion.
 *
 * So the machine is asked before the run starts. The relay keeps no list a caller may read, and the
 * extension's own record of sessions fills only once the bridge connects, which the journey itself
 * does; a process listing is the one vantage that sees the other sessions' servers before anything
 * has been touched. It is a listing, not an authority: a server this scan cannot see (another user's
 * session, a container) still contaminates the run, and one it sees may be idle. That is why the
 * result is a refusal with the pids in it, not a filter.
 */

/** One agent-bridge server process. */
export type AgentServerProcess = { pid: number; parentPid: number };

/** The script the server is started from; the part of a command line that identifies it. */
export const AGENT_SERVER_SCRIPT = "mcp-server.js";

/**
 * Picks the agent-bridge servers out of a process listing of `pid parentPid commandLine` lines -
 * the shape both `ps -ax -o pid=,ppid=,command=` and the PowerShell projection below print.
 */
export function parseAgentServerProcesses(listing: string): AgentServerProcess[] {
  const found: AgentServerProcess[] = [];
  for (const line of listing.split(/\r?\n/)) {
    // Not `.`: a stray carriage return inside a Windows command line is not a line terminator here.
    const match = /^\s*(\d+)\s+(\d+)\s+([^\n]*)/.exec(line);
    if (!match) continue;
    const command = match[3] ?? "";
    if (!command.includes(AGENT_SERVER_SCRIPT)) continue;
    found.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return found;
}

/** The command that prints the listing `parseAgentServerProcesses` reads, for this platform. */
export function agentServerListingCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }",
      ],
    };
  }
  return { command: "ps", args: ["-ax", "-o", "pid=,ppid=,command="] };
}

/**
 * Lists the agent-bridge servers running on this machine. A listing that cannot be taken answers
 * empty: the check is a courtesy to the run, not a gate on the platform.
 */
export async function listAgentServerProcesses(
  run: (command: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentServerProcess[]> {
  const { command, args } = agentServerListingCommand(platform);
  const result = await run(command, args).catch(() => ({ ok: false, stdout: "" }));
  return result.ok ? parseAgentServerProcesses(result.stdout) : [];
}

/** The refusal a run prints when servers from other sessions are attached; `undefined` when none are. */
export function foreignAgentServersProblem(servers: readonly AgentServerProcess[]): string | undefined {
  if (servers.length === 0) return undefined;
  const pids = servers.map((server) => `${server.pid} (parent ${server.parentPid})`).join(", ");
  return (
    `${servers.length} agent-bridge server(s) from other sessions are already attached to this machine's ` +
    `relay - pid ${pids}. Each is a second agent in the panel (a pairing prompt this run never raised, ` +
    "tabs it never opened), which is what the attach-mode family's moving failures were (004/T167). " +
    "Close the other Claude Code sessions open in this project (or `claude mcp remove hallpass` " +
    "there) and re-run."
  );
}
