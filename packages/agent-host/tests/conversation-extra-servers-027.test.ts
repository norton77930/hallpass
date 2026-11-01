import { afterEach, describe, expect, it, vi } from "vitest";

// Every test here starts real fake-agent processes: seconds alone, far longer under the full parallel run.
vi.setConfig({ testTimeout: 60_000 });
import type * as acp from "@agentclientprotocol/sdk";
import { CONVERSATION_IDLE_MS } from "../src/broker/conversation.js";
import { poolHarness, fakeBrowserAccess, requests, waitFor, type FakeLogLine } from "./conversation-harness.js";

/**
 * 027 T846 (R-419): a side-panel run is handed the extra servers ticked for its agent, after the browser
 * entry, in every session request of the run; the list is read once per run, so a change reaches the
 * next run and not the running one; DeepSeek, which takes no MCP servers, is handed none.
 */

type Harness = Awaited<ReturnType<typeof poolHarness>>;
let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const servers = (line: FakeLogLine | undefined) => (line?.params?.servers ?? []) as Array<{ name: string; env?: unknown }>;
const entry = (name: string): acp.McpServerStdio => ({ name, command: "node", args: ["x.js"], env: [{ name: "GITHUB_TOKEN", value: "ghp-123" }] });

describe("027 extra servers in a side-panel run", () => {
  it("session/new carries the browser entry, then the extras; a mode reload keeps the run's list; the next run reads it again", async () => {
    let list = [entry("github")];
    const asked: string[] = [];
    h = await poolHarness({
      browser: fakeBrowserAccess().access,
      extraServers: async (agent: string) => {
        asked.push(agent);
        return list;
      },
    });
    const id = await h.start("claude-code");
    let log = await h.log();
    expect(servers(requests(log, "session/new")[0]).map((server) => server.name)).toEqual(["hallpass", "github"]);
    expect(servers(requests(log, "session/new")[0])[1]).toMatchObject({ name: "github", env: [{ name: "GITHUB_TOKEN", value: "ghp-123" }] });

    // A change while the run lives: Claude's mode switch loads the session again in the same run.
    list = [entry("github"), entry("db")];
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    log = await h.log();
    expect(servers(requests(log, "session/load")[0]).map((server) => server.name)).toEqual(["hallpass", "github"]);

    // The next run (after the idle stop) reads the list again.
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h!.pool.state(id) === "stopped", "the idle stop");
    await h.turn(id, "again");
    log = await h.log();
    expect(servers(requests(log, "session/load").at(-1)).map((server) => server.name)).toEqual(["hallpass", "github", "db"]);
    expect(asked).toEqual(["claude-code", "claude-code"]);
  });

  it("without a browser connection the extras still go; with no extras nothing changes", async () => {
    h = await poolHarness({ extraServers: async () => [entry("github")] });
    await h.start("codex");
    expect(servers(requests(await h.log(), "session/new")[0]).map((server) => server.name)).toEqual(["github"]);
  });

  it("DeepSeek takes no MCP servers: none is handed, whatever the list says", async () => {
    h = await poolHarness({ browser: fakeBrowserAccess().access, extraServers: async () => [entry("github")] });
    await h.start("deepseek");
    const log = await h.log();
    expect(servers(requests(log, "session/new")[0]).map((server) => server.name)).not.toContain("github");
  });

  it("a list that cannot be read starts the run without extras", async () => {
    h = await poolHarness({ extraServers: async () => Promise.reject(new Error("unreadable")) });
    await h.start("claude-code");
    expect(servers(requests(await h.log(), "session/new")[0])).toEqual([]);
  });
});
