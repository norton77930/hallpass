import { mkdir, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ADAPTERS, adapterLaunchSpec, type AgentPorts } from "../src/broker/agents.js";
import { createBrowserAccess } from "../src/broker/browser-token.js";
import { codexConfigPath, findOwnerHallpass } from "../src/broker/codex-config.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { CONVERSATION_IDLE_MS, ConversationPool } from "../src/broker/conversation.js";
import {
  TestClock,
  fakeAgentSpec,
  killLoggedPids,
  makeTempDir,
  readFakeLog,
  recorder,
  removeDir,
  requests,
  turnEnded,
  waitFor,
} from "./conversation-harness.js";

/**
 * 019/T565 (R-322, FR-305): the panel's `hallpass` entry next to the owner's own. Claude gets an
 * entry named exactly `hallpass`, so the session's replaces the owner's for that session. Codex's
 * adapter runs with `DISABLE_MCP_CONFIG_FILTERING=true` (else it drops a session server whose name
 * the owner's config has), its entry sets every field the adapter carries, and a new Codex
 * conversation's first input is `/rename <title>`, so the adapter starts no title thread with the
 * owner's own servers. An owner Codex entry that a command entry cannot be merged over (`url`, or
 * switched off) makes the panel's entry `hallpass_panel`, and its server says which set to use.
 * The agent is the fake ACP agent as a real stdio process.
 */

const SESSION = "broker-entry-session";
const BROWSER = "chrome-7f3a";
const LAUNCH = { command: "C:\\node\\node.exe", args: ["C:\\hallpass\\host\\mcp-server.js"] };

let dir: string;
let logPath: string;
let configPath: string;
let pools: ConversationPool[];

beforeEach(async () => {
  dir = await makeTempDir("hallpass-entry-");
  logPath = join(dir, "fake-acp.log");
  configPath = join(dir, "codex-home", "config.toml");
  pools = [];
});

afterEach(async () => {
  for (const pool of pools) await pool.shutdown().catch(() => undefined);
  await killLoggedPids(logPath);
  await removeDir(dir);
});

async function ownerCodexConfig(text: string): Promise<void> {
  await mkdir(join(dir, "codex-home"), { recursive: true });
  await writeFile(configPath, text, "utf8");
}

function setup() {
  const clock = new TestClock();
  const rec = recorder(clock);
  const grants: { conversationId: string; token: string | null }[] = [];
  const pool = new ConversationPool({
    dataDir: join(dir, "data"),
    browserRunId: "run-entry",
    brokerPid: process.pid,
    index: memoryConversationIndex(),
    folders: memoryFolderList(),
    clock,
    onEvent: rec.onEvent,
    resolveLaunch: async (agent) => ({
      ok: true,
      spec: fakeAgentSpec({
        FAKE_ACP_LOG: logPath,
        FAKE_ACP_STORE: join(dir, "fake-acp-store.json"),
        FAKE_ACP_SCENARIO: agent === "codex" ? "codex" : "claude",
      }),
      versions: { agent, tested: "1.0.0", found: "1.0.0" },
    }),
    browser: createBrowserAccess({
      sessionId: SESSION,
      browserId: BROWSER,
      launch: LAUNCH,
      codexConfigPath: configPath,
      send: (frame) => {
        const { conversationId, token } = frame as { conversationId: string; token: string | null };
        grants.push({ conversationId, token });
        return true;
      },
    }),
  });
  pools.push(pool);
  const start = async (agent: "claude-code" | "codex"): Promise<string> => {
    const started = await pool.start(agent, { kind: "scratch" });
    if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
    return started.value!.conversationId!;
  };
  const turn = async (conversationId: string, text: string): Promise<void> => {
    const from = rec.events.length;
    const result = await pool.send(conversationId, text);
    if (!result.ok) throw new Error(`send failed: ${result.error.code} ${result.error.detail}`);
    await waitFor(() => turnEnded(rec.events.slice(from), conversationId), `the turn "${text}" to end`);
  };
  const tokenOf = (conversationId: string) => grants.find((grant) => grant.conversationId === conversationId && grant.token !== null)!.token!;
  return { clock, rec, pool, start, turn, tokenOf };
}

type Entry = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
const serversOf = (line: { params?: Record<string, unknown> } | undefined) => line?.params?.servers as Entry[];
const promptsOf = async () => requests(await readFakeLog(logPath), "session/prompt").map((line) => line.params?.text);

const identityEnv = (token: string, conversationId: string) => [
  { name: "HALLPASS_PANEL_TOKEN", value: token },
  { name: "HALLPASS_PANEL_BROWSER", value: BROWSER },
  { name: "HALLPASS_PANEL_CONVERSATION", value: conversationId },
];

describe("T565 Claude", () => {
  it("gets an entry named exactly `hallpass`, every field the adapter takes set", async () => {
    await ownerCodexConfig('[mcp_servers.hallpass]\nurl = "http://127.0.0.1:9/mcp"\n');
    const h = setup();
    const id = await h.start("claude-code");

    const [created] = requests(await readFakeLog(logPath), "session/new");
    expect(serversOf(created)).toEqual([{ name: "hallpass", ...LAUNCH, env: identityEnv(h.tokenOf(id), id) }]);
    // Claude's first input is the owner's own: no rename (its adapter starts no title thread).
    await h.turn(id, "hello there");
    expect(await promptsOf()).toEqual(["hello there"]);
  });
});

describe("T565 Codex", () => {
  it("its adapter starts with DISABLE_MCP_CONFIG_FILTERING=true", async () => {
    const data = "C:\\Users\\someone\\AppData\\Local\\hallpass";
    const ports: AgentPorts = {
      dataDir: data,
      env: {},
      nodePath: "C:\\node\\node.exe",
      codexShimEntry: "C:\\host\\codex-app-server-shim.js",
      fs: {
        exists: async () => true,
        readText: async (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ name: AGENT_ADAPTERS.codex.package, version: AGENT_ADAPTERS.codex.version, bin: "dist/index.js" })
            : // A stand-in for the adapter's entry with the modes T573 measured (agents.ts checks them).
              'm("read-only", "a", "b", "c", "on-request", "user", { type: "workspaceWrite" });\n' +
              'm("agent", "a", "b", "c", "on-request", "auto_review", { type: "workspaceWrite" });\n',
        writeText: async () => undefined,
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const spec = await adapterLaunchSpec("codex", "C:\\npm\\codex.cmd", ports);
    expect(spec.env.DISABLE_MCP_CONFIG_FILTERING).toBe("true");
  });

  it("gets `hallpass` with command, args and env explicit when the owner's config has no `hallpass`, or one a command entry merges over", async () => {
    await ownerCodexConfig('[mcp_servers.hallpass]\ncommand = "node"\nargs = ["C:\\\\old\\\\mcp-server.js"]\n[mcp_servers.other]\nurl = "http://x"\n');
    const h = setup();
    const id = await h.start("codex");
    const [created] = requests(await readFakeLog(logPath), "session/new");
    expect(serversOf(created)).toEqual([{ name: "hallpass", ...LAUNCH, env: identityEnv(h.tokenOf(id), id) }]);
  });

  it("sends `/rename <title>` as a new conversation's first input, before the owner's first message, and shows nothing of it", async () => {
    const h = setup();
    const id = await h.start("codex");
    const from = h.rec.events.length;

    await h.turn(id, "  Find the cheapest flight\nto Taipei next week");
    await h.turn(id, "and the hotel");

    // The title is the list's: the first line of the first message, trimmed (data-model).
    expect(await promptsOf()).toEqual(["/rename Find the cheapest flight", "  Find the cheapest flight\nto Taipei next week", "and the hotel"]);
    const shownText = h.rec.events
      .slice(from)
      .flatMap((entry) => (entry.event.type === "text" ? [entry.event.text] : []))
      .join("");
    expect(shownText).not.toContain("renamed:");
    expect(shownText).toContain("echo:");
  });

  it("does not rename a resumed conversation (the adapter starts no title thread for a loaded one)", async () => {
    const h = setup();
    const id = await h.start("codex");
    await h.turn(id, "first");
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    await h.turn(id, "second");
    expect(await promptsOf()).toEqual(["/rename first", "first", "second"]);
  });

  it("a conversation stopped before its first message is not renamed on resume either", async () => {
    const h = setup();
    const id = await h.start("codex");
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    await h.turn(id, "late first");
    expect(await promptsOf()).toEqual(["late first"]);
  });

  for (const [label, config] of [
    ["a `url` entry", '[mcp_servers.hallpass]\nurl = "http://127.0.0.1:9/mcp"\n'],
    ["an entry switched off", '[mcp_servers.hallpass]\ncommand = "node"\nenabled = false\n'],
  ] as const) {
    it(`names its entry \`hallpass_panel\` and tells its server so when the owner's config has ${label}`, async () => {
      await ownerCodexConfig(config);
      const h = setup();
      const id = await h.start("codex");
      const [created] = requests(await readFakeLog(logPath), "session/new");
      expect(serversOf(created)).toEqual([
        {
          name: "hallpass_panel",
          ...LAUNCH,
          env: [...identityEnv(h.tokenOf(id), id), { name: "HALLPASS_PANEL_SERVER_NAME", value: "hallpass_panel" }],
        },
      ]);
    });
  }
});

describe("T565 reading the owner's Codex config", () => {
  it("is CODEX_HOME's config.toml, else the profile's .codex", () => {
    expect(codexConfigPath({ CODEX_HOME: "D:\\codex", USERPROFILE: "C:\\Users\\a" })).toBe(win32.join("D:\\codex", "config.toml"));
    expect(codexConfigPath({ USERPROFILE: "C:\\Users\\a" })).toBe(win32.join("C:\\Users\\a", ".codex", "config.toml"));
    expect(codexConfigPath({})).toBeUndefined();
  });

  it("finds the owner's `hallpass` entry in each way TOML can write it, and only that entry's own keys", () => {
    const keys = (text: string) => {
      const found = findOwnerHallpass(text);
      return found === undefined ? undefined : { keys: [...found.keys].sort(), enabled: found.enabled };
    };
    expect(keys('model = "x"\n[mcp_servers.other]\nurl = "http://x"\n')).toBeUndefined();
    expect(keys('[mcp_servers.hallpass]\nurl = "http://x" # a comment\n')).toEqual({ keys: ["url"], enabled: undefined });
    expect(keys('[ mcp_servers . "hallpass" ]\ncommand = "node"\nenabled = false\n')).toEqual({ keys: ["command", "enabled"], enabled: false });
    expect(keys('[mcp_servers]\nhallpass = { url = "http://x", enabled = true }\n')).toEqual({ keys: ["enabled", "url"], enabled: true });
    expect(keys('mcp_servers.hallpass.url = "http://x"\n[other]\nurl = "y"\n')).toEqual({ keys: ["url"], enabled: undefined });
    // A key inside the entry's own `env` table is an environment variable, not the entry's.
    expect(keys('[mcp_servers.hallpass]\ncommand = "node"\n[mcp_servers.hallpass.env]\nurl = "not a transport"\n')).toEqual({
      keys: ["command", "env"],
      enabled: undefined,
    });
    // `#` inside a string is not a comment; a commented-out line is nothing.
    expect(keys('[mcp_servers.hallpass]\ncommand = "C:\\\\#odd\\\\node.exe"\n# url = "http://x"\n')).toEqual({ keys: ["command"], enabled: undefined });
  });
});
