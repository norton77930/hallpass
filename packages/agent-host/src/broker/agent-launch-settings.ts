import { win32 } from "node:path";
import { CONVERSATION_MODES, type ConversationAgent, type ConversationMode } from "@hallpass/contracts";

/**
 * 021 launch-time modes (R-347, R-349, R-350, R-351): what Hallpass sets when it starts an agent whose
 * panel mode cannot be changed over ACP alone - Hermes' tool set and DeepSeek's sandbox are fixed when
 * the agent starts. `launchSettings` is pure (mode in, environment, agent mode and files out);
 * `writeLaunchFiles` is the only part that touches the disk.
 *
 * - Hermes: a Hallpass-owned managed settings layer, `<data>\agents\hermes\managed\<mode>\config.yaml`,
 *   named by `HERMES_MANAGED_DIR`. It has administrator-override meaning in Hermes, so it holds over
 *   the owner's own settings without writing them. Strict switches the command, code-running,
 *   helper-agent and saved-login tools off and uses Hermes' `default` mode (asks before edits);
 *   agent-review keeps only saved logins off and uses `accept_edits`. Never `dont_ask`.
 * - DeepSeek: `DSH_PERMISSION_MODE` read-only (strict) or workspace-write (agent-review), always set
 *   because its `acp` profile alone defaults to workspace-write; never `danger-full-access`.
 *   `DSH_TELEMETRY_MODE=DISABLED` at every launch.
 * - Claude Code, Codex: nothing - their modes are agent modes set over ACP (R-316).
 *
 * Hallpass sets no key, endpoint or model for any agent: each reads its own configuration.
 */

export const HERMES_MANAGED_ENV = "HERMES_MANAGED_DIR";

/**
 * R-347: the Hermes toolsets the managed layer switches off, per panel mode. R-363 / D-023-1: the
 * saved-logins tool lives in group `browser` (Hermes has no per-tool switch and silently skips an unknown
 * group name), so the whole group goes; the owner's browser is reached through Hallpass's own tools.
 */
export const HERMES_DISABLED_TOOLSETS: Readonly<Record<ConversationMode, readonly string[]>> = {
  strict: ["terminal", "code_execution", "delegation", "browser"],
  "agent-review": ["browser"],
};

/** R-347: Hermes' own mode under each panel mode, set after `session/new`. */
export const HERMES_AGENT_MODES: Readonly<Record<ConversationMode, string>> = {
  strict: "default",
  "agent-review": "accept_edits",
};

/** R-349: DeepSeek's permission mode under each panel mode. */
export const DSH_PERMISSION_MODES: Readonly<Record<ConversationMode, string>> = {
  strict: "read-only",
  "agent-review": "workspace-write",
};

export type LaunchFile = { path: string; text: string };

export type LaunchSettings = {
  /** Added to the environment the agent starts with. */
  env: Record<string, string>;
  /** The agent's own mode to set after `session/new`, when it has one for this panel mode. */
  agentMode?: string;
  /** Files written before the launch, each replaced whole with fixed content. */
  files: LaunchFile[];
};

/** `<data>\agents\hermes\managed\<mode>`: the folder `HERMES_MANAGED_DIR` names. */
export function hermesManagedDirectory(dataDir: string, mode: ConversationMode): string {
  return win32.join(dataDir, "agents", "hermes", "managed", mode);
}

/** The managed layer's fixed content for a mode. */
export function hermesManagedConfig(mode: ConversationMode): string {
  return `agent:\n  disabled_toolsets: [${HERMES_DISABLED_TOOLSETS[mode].join(", ")}]\n`;
}

export function launchSettings(agent: ConversationAgent, mode: ConversationMode, dataDir: string): LaunchSettings {
  // The type says this already; a value cast past it must not reach an agent as a mode.
  if (!(CONVERSATION_MODES as readonly string[]).includes(mode)) throw new Error(`not a panel mode: ${String(mode)}`);
  switch (agent) {
    case "hermes": {
      const directory = hermesManagedDirectory(dataDir, mode);
      return {
        env: { [HERMES_MANAGED_ENV]: directory },
        agentMode: HERMES_AGENT_MODES[mode],
        files: [{ path: win32.join(directory, "config.yaml"), text: hermesManagedConfig(mode) }],
      };
    }
    case "deepseek":
      return { env: { DSH_PERMISSION_MODE: DSH_PERMISSION_MODES[mode], DSH_TELEMETRY_MODE: "DISABLED" }, files: [] };
    case "claude-code":
    case "codex":
      return { env: {}, files: [] };
  }
}

export type LaunchFilePorts = {
  readText(path: string): Promise<string>;
  /** Replace the file whole, creating its folder. */
  writeText(path: string, text: string): Promise<void>;
};

/**
 * Write each file whose content is not already the fixed one; leave a right one alone, since another
 * broker's agent may be reading it right now. A failed write that still leaves the right content
 * (another broker won the same write) is no failure; any other failure stops the launch.
 */
export async function writeLaunchFiles(files: readonly LaunchFile[], fs: LaunchFilePorts): Promise<void> {
  for (const file of files) {
    const current = () => fs.readText(file.path).catch(() => undefined);
    if ((await current()) === file.text) continue;
    try {
      await fs.writeText(file.path, file.text);
    } catch (error) {
      if ((await current()) !== file.text) throw error;
    }
  }
}
