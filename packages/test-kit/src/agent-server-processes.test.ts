import { describe, expect, it } from "vitest";
import {
  agentServerListingCommand,
  foreignAgentServersProblem,
  listAgentServerProcesses,
  parseAgentServerProcesses,
} from "./agent-server-processes.js";

describe("agent-server process listing (004/T167)", () => {
  it("picks the bridge servers out of a pid/ppid/command listing and ignores everything else", () => {
    const listing = [
      String.raw`75160 65348 node "D:\repo\packages\agent-host\dist\mcp-server.js"`,
      "3284 33404 node npx-cli.js -y @playwright/mcp@latest",
      "73048 17192 node D:/repo/packages/agent-host/dist/mcp-server.js",
      "85484 91636 node D:/repo/packages/agent-host/dist/native-host.js chrome-extension://x/",
      "",
      "not a process line",
    ].join("\r\n");
    expect(parseAgentServerProcesses(listing)).toEqual([
      { pid: 75160, parentPid: 65348 },
      { pid: 73048, parentPid: 17192 },
    ]);
  });

  it("names a platform command that prints that shape", () => {
    expect(agentServerListingCommand("win32").command).toBe("powershell");
    expect(agentServerListingCommand("linux")).toEqual({ command: "ps", args: ["-ax", "-o", "pid=,ppid=,command="] });
  });

  it("answers empty when the listing cannot be taken, and with the servers when it can", async () => {
    expect(await listAgentServerProcesses(async () => ({ ok: false, stdout: "" }), "linux")).toEqual([]);
    expect(
      await listAgentServerProcesses(async () => {
        throw new Error("no ps");
      }, "linux"),
    ).toEqual([]);
    expect(
      await listAgentServerProcesses(async () => ({ ok: true, stdout: "1 2 node mcp-server.js\n" }), "linux"),
    ).toEqual([{ pid: 1, parentPid: 2 }]);
  });

  it("turns a non-empty listing into one refusal that names the pids, and none into nothing", () => {
    expect(foreignAgentServersProblem([])).toBeUndefined();
    const problem = foreignAgentServersProblem([{ pid: 75160, parentPid: 65348 }]);
    expect(problem).toContain("75160 (parent 65348)");
    expect(problem).toContain("claude mcp remove hallpass");
  });
});
