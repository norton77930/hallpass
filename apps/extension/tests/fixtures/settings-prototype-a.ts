import { settingsStateSchema, type SettingsState } from "@hallpass/contracts";

/**
 * 024: the data of prototype A (`.scratch/024/prototype/a.html`, its `S = {...}`) as a settings
 * projection, so the visual gates and the UI tests read the same picture.
 *
 * - Claude Code: ready, 2.1.4. Codex: its program is found, the helper is not (Needs a download).
 * - Hermes: ready, installed by the owner, two warnings (no MCP component; the key variable is set in
 *   Windows but this browser started before it was).
 * - DeepSeek: downloading, 42 %.
 * - Sites: github.com ask, docs.example.test follow-a-plan, localhost:5173 skip-checks.
 * - Paired outside agents: Claude Code from a terminal at 10:38 today, Codex CLI from an editor yesterday.
 * - Two upload folders, the side-panel-agent switch on, the browser named "Work Chrome", the helper
 *   connected with matching versions.
 *
 * The times follow `now`, because "10:38 today" and "yesterday" are relative; pass a fixed date for a
 * stable picture.
 */
export function prototypeAState(now: Date = new Date()): SettingsState {
  const at = (daysAgo: number, hour: number, minute: number): string =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute, 0, 0).toISOString();
  const checkedAt = at(0, 10, 41);
  const state: SettingsState = {
    bridge: "connected",
    versions: { extension: "0.16.0", host: "0.16.0", match: true },
    browsers: [
      { browserId: "browser-work", name: "Work Chrome", kind: "chrome", self: true },
      { browserId: "browser-edge", name: "Edge", kind: "edge", self: false },
    ],
    browser: { name: "Work Chrome", defaultName: "Chrome", kind: "chrome", others: 1 },
    paired: [
      { agentId: "agent-cc", displayName: "Claude Code", origin: "stdio:terminal", acceptedAt: at(0, 10, 38) },
      { agentId: "agent-cx", displayName: "Codex CLI", origin: "stdio:editor", acceptedAt: at(1, 16, 5) },
    ],
    sites: [
      { site: "https://github.com", mode: "ask", diagnosticsGranted: false },
      { site: "https://docs.example.test", mode: "follow-a-plan", diagnosticsGranted: false },
      { site: "http://localhost:5173", mode: "skip-checks", diagnosticsGranted: false },
    ],
    transitions: [],
    uploadRoots: {
      roots: ["D:\\Projects\\shared-assets", "D:\\Projects\\test-fixtures"],
      path: "C:\\Users\\example\\AppData\\Local\\hallpass\\config.json",
    },
    consent: "granted",
    agents: [
      {
        agent: "claude-code",
        availability: "ready",
        version: "2.1.4",
        accepts: { image: true, context: true },
        browserTools: "available",
        checkedAt,
      },
      {
        agent: "codex",
        availability: "needs-install",
        version: "0.48.0",
        accepts: { image: true, context: true },
        browserTools: "needs-helper",
        checkedAt,
      },
      {
        agent: "hermes",
        availability: "ready",
        version: "0.22.2",
        accepts: { image: true, context: false },
        browserTools: "missing-component",
        setupSteps: [
          { step: "git", found: true },
          { step: "hermes", found: true },
          { step: "mcp-component", found: false },
          { step: "key-variable", found: true },
          { step: "browser-restart", found: false },
        ],
        checkedAt,
      },
      {
        agent: "deepseek",
        availability: "needs-install",
        installing: "downloading",
        accepts: { image: false, context: true },
        browserTools: "not-supported",
        install: {
          phase: "downloading",
          percent: 42,
          etaSeconds: 191,
          startedAt: at(0, 10, 40),
          browserId: "browser-work",
        },
        checkedAt,
      },
    ],
    choices: {
      enabled: { "claude-code": true, codex: true, hermes: true, deepseek: true },
      default: "claude-code",
    },
  };
  return settingsStateSchema.parse(state);
}

/** What "Show last lines" reads for each agent in the prototype (already scrubbed: no keys, no user paths). */
export const PROTOTYPE_A_OUTPUT: Record<string, string[]> = {
  "claude-code": [
    "10:41:58 adapter starting",
    "10:41:58 found claude 2.1.4 at <user>\\AppData\\…\\claude.exe",
    "10:41:59 session handshake ok (protocol 1)",
    "10:41:59 mcp: hallpass tools attached (31 tools)",
    "10:42:03 model reachable, first token 812 ms",
    "10:42:03 auth: <redacted>",
  ],
  codex: [
    "10:42:10 adapter starting",
    "10:42:10 found codex 0.48.0 at <user>\\AppData\\…\\codex.exe",
    "10:42:10 helper not found in <hallpass-data>\\helpers",
    "10:42:10 stopped: helper download required (~40 MB)",
  ],
  hermes: [
    "10:42:15 found hermes 0.22.2 on PATH",
    "10:42:15 git 2.47.1 ok",
    "10:42:16 mcp: optional component not installed; browser tools off",
    "10:42:16 env: QWEN_3_8_API_KEY not visible to this process",
    "10:42:17 model qwen3-8b reachable (412 ms)",
    "10:42:17 key: <redacted>",
  ],
  deepseek: [
    "10:40:02 download started (package 1 of 3)",
    "10:41:30 package 1 of 3 verified",
    "10:42:20 package 2 of 3: 42 %",
  ],
};
