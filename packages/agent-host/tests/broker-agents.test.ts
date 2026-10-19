import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, resolve, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTERS,
  TESTED_AGENT_VERSIONS,
  adapterDirectory,
  adapterLaunchSpec,
  agentAvailability,
  classifyStartFailure,
  discoverCli,
  parseVersion,
  readCliVersion,
  type AgentPorts,
  type ExecResult,
} from "../src/broker/agents.js";
import { CODEX_SHIM_COMMAND } from "../src/broker/codex-strict.js";

/**
 * 019/T530, T531, T534 - finding the owner's coding agent, reading its version, saying what is
 * missing, and telling "the CLI is not usable" from "the CLI is a different version" when an
 * adapter fails to start (R-314, R-315, R-322).
 *
 * Every lookup goes through injected ports (exec, file system), so what these tests find depends on
 * the table below and not on what the developer's machine has installed.
 */

const DATA = "C:\\data\\hallpass";
const HOME = "C:\\Users\\someone";
const APPDATA = "C:\\Users\\someone\\AppData\\Roaming";
const CLAUDE_EXE = win32.join(HOME, ".local", "bin", "claude.exe");
const CODEX_CMD = win32.join(APPDATA, "npm", "codex.cmd");
/** Where the broker's shim entry is: beside broker.js, in a checkout whose path has a space and dots. */
const SHIM_ENTRY = win32.join("D:\\", "OSS", "Some Ext.v2", "packages", "agent-host", "dist", "codex-app-server-shim.js");
const SHIM_CMD = win32.join(DATA, "agents", "codex", "app-server-shim.cmd");

type Machine = {
  /** Files that exist: path -> content (empty string for a binary). */
  files?: Record<string, string>;
  /** `where.exe <name>` output, by name. */
  where?: Record<string, string[]>;
  /** `<path> --version` results, by path. */
  versions?: Record<string, ExecResult | "throws">;
};

function ports(machine: Machine = {}): AgentPorts & { calls: string[]; writes: string[] } {
  const files: Record<string, string> = { [SHIM_ENTRY]: "", ...machine.files };
  const calls: string[] = [];
  const writes: string[] = [];
  return {
    calls,
    writes,
    dataDir: DATA,
    env: { USERPROFILE: HOME, APPDATA },
    nodePath: "C:\\node\\node.exe",
    codexShimEntry: SHIM_ENTRY,
    fs: {
      exists: async (path) => path in files,
      readText: async (path) => {
        if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return files[path]!;
      },
      writeText: async (path, text) => {
        writes.push(path);
        files[path] = text;
      },
    },
    exec: async (file, args) => {
      calls.push([file, ...args].join(" "));
      if (file === "where.exe") {
        const lines = machine.where?.[args[0]!];
        return lines ? { code: 0, stdout: `${lines.join("\r\n")}\r\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      const result = machine.versions?.[file];
      if (result === "throws" || !result) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      return result;
    },
  };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const adapterManifest = (agent: keyof typeof AGENT_ADAPTERS, extra: Record<string, unknown> = {}) => {
  const adapter = AGENT_ADAPTERS[agent];
  const dir = adapterDirectory(DATA, agent);
  return {
    [win32.join(dir, "node_modules", ...adapter.package.split("/"), "package.json")]: JSON.stringify({
      name: adapter.package,
      version: adapter.version,
      ...extra,
    }),
  };
};

/**
 * An installed Codex adapter whose code carries the measured modes (T573): a stand-in written for
 * these tests, not the adapter's own text - `codexAdapterModesAsMeasured` reads only the tuples.
 */
const MEASURED_CODEX_MODES = `
new Mode("read-only", "Ask", "d", "standard", "on-request", "user", { type: "workspaceWrite" });
new Mode("agent", "Auto", "d", "auto_review", "on-request", "auto_review", { type: "workspaceWrite" });
`;
const codexInstalled = (bin = "./bin/codex-acp.js", code = MEASURED_CODEX_MODES) => ({
  ...adapterManifest("codex", { bin }),
  [win32.join(adapterDirectory(DATA, "codex"), "node_modules", "@agentclientprotocol", "codex-acp", ...bin.split("/").slice(1))]: code,
});

describe("pinned versions (R-314, R-315)", () => {
  it("names the versions the connectors were tested with", () => {
    expect(TESTED_AGENT_VERSIONS).toEqual({ "claude-code": "2.1.302", codex: "0.163.0" });
    expect(AGENT_ADAPTERS["claude-code"]).toMatchObject({ package: "@agentclientprotocol/claude-agent-acp", version: "0.81.2" });
    expect(AGENT_ADAPTERS.codex).toMatchObject({ package: "@agentclientprotocol/codex-acp", version: "1.13.1" });
  });

  it("keeps the adapter pins in step with the manifests the package ships", async () => {
    const { readFileSync } = await import("node:fs");
    const here = dirname(fileURLToPath(import.meta.url));
    for (const agent of ["claude-code", "codex"] as const) {
      const manifest = JSON.parse(readFileSync(resolve(here, "..", "agents", agent, "package.json"), "utf8"));
      expect(manifest.dependencies).toEqual({ [AGENT_ADAPTERS[agent].package]: AGENT_ADAPTERS[agent].version });
    }
  });

  it("lays the adapter out under agents\\<agent>\\<adapter version>", () => {
    expect(adapterDirectory(DATA, "claude-code")).toBe(win32.join(DATA, "agents", "claude-code", "0.81.2"));
  });
});

describe("parseVersion", () => {
  it("takes the first semver in the output", () => {
    expect(parseVersion("2.1.302 (Claude Code)\n")).toBe("2.1.302");
    expect(parseVersion("codex-cli 0.162.1\n")).toBe("0.162.1");
    expect(parseVersion("claude 3.0.0-beta.2 (build 9.9.9)")).toBe("3.0.0-beta.2");
    expect(parseVersion("no version here")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("discoverCli (T530, R-315)", () => {
  it("prefers what where.exe finds on the PATH", async () => {
    const wherePath = "D:\\tools\\claude.exe";
    const p = ports({ files: { [wherePath]: "", [CLAUDE_EXE]: "" }, where: { "claude.exe": [wherePath] } });
    expect(await discoverCli("claude-code", p)).toBe(wherePath);
  });

  it("skips a where.exe line that does not exist and takes the next", async () => {
    const real = "D:\\real\\codex.cmd";
    const p = ports({ files: { [real]: "" }, where: { "codex.cmd": ["D:\\gone\\codex.cmd", real] } });
    expect(await discoverCli("codex", p)).toBe(real);
  });

  it("falls back to the known per-user locations", async () => {
    expect(await discoverCli("claude-code", ports({ files: { [CLAUDE_EXE]: "" } }))).toBe(CLAUDE_EXE);
    expect(await discoverCli("codex", ports({ files: { [CODEX_CMD]: "" } }))).toBe(CODEX_CMD);
  });

  it("reports nothing when neither route finds it", async () => {
    const p = ports();
    expect(await discoverCli("claude-code", p)).toBeUndefined();
    expect(p.calls).toEqual(["where.exe claude.exe"]);
  });

  it("survives where.exe itself failing to run", async () => {
    const p = ports({ files: { [CODEX_CMD]: "" } });
    const failing: AgentPorts = {
      ...p,
      exec: async () => {
        throw Object.assign(new Error("spawn where.exe ENOENT"), { code: "ENOENT" });
      },
    };
    expect(await discoverCli("codex", failing)).toBe(CODEX_CMD);
  });

  it("does not hand a path with a quote or a percent sign to a command shell", async () => {
    const p = ports({
      files: { 'D:\\x"y\\claude.exe': "", "D:\\100%\\claude.exe": "" },
      where: { "claude.exe": ['D:\\x"y\\claude.exe', "D:\\100%\\claude.exe"] },
    });
    expect(await discoverCli("claude-code", p)).toBeUndefined();
  });
});

describe("readCliVersion (T530)", () => {
  it("reads --version", async () => {
    const p = ports({ versions: { [CLAUDE_EXE]: ok("2.1.302 (Claude Code)\n") } });
    expect(await readCliVersion(CLAUDE_EXE, p)).toBe("2.1.302");
    expect(p.calls).toEqual([`${CLAUDE_EXE} --version`]);
  });

  it("reads the version from stderr too, and gives up on a failing or silent CLI", async () => {
    expect(
      await readCliVersion(CODEX_CMD, ports({ versions: { [CODEX_CMD]: { code: 0, stdout: "", stderr: "codex-cli 0.162.1" } } })),
    ).toBe("0.162.1");
    expect(await readCliVersion(CODEX_CMD, ports({ versions: { [CODEX_CMD]: { code: 1, stdout: "0.1.0", stderr: "" } } }))).toBeUndefined();
    expect(await readCliVersion(CODEX_CMD, ports({ versions: { [CODEX_CMD]: ok("hello") } }))).toBeUndefined();
    expect(await readCliVersion(CODEX_CMD, ports({ versions: { [CODEX_CMD]: "throws" } }))).toBeUndefined();
  });
});

describe("agentAvailability (T530, T531)", () => {
  it("is missing when the CLI cannot be found", async () => {
    expect(await agentAvailability("claude-code", ports())).toEqual({
      availability: { agent: "claude-code", availability: "missing" },
    });
  });

  it("needs the adapter installed when the CLI is there and the adapter is not", async () => {
    const p = ports({ files: { [CLAUDE_EXE]: "" }, versions: { [CLAUDE_EXE]: ok("2.1.302 (Claude Code)") } });
    expect(await agentAvailability("claude-code", p)).toEqual({
      availability: { agent: "claude-code", availability: "needs-install", version: "2.1.302" },
      cliPath: CLAUDE_EXE,
    });
  });

  it("is ready when the CLI is there and the pinned adapter is installed", async () => {
    const p = ports({
      files: { [CODEX_CMD]: "", ...adapterManifest("codex") },
      versions: { [CODEX_CMD]: ok("codex-cli 0.170.0") },
    });
    expect(await agentAvailability("codex", p)).toEqual({
      availability: { agent: "codex", availability: "ready", version: "0.170.0" },
      cliPath: CODEX_CMD,
    });
  });

  it("does not count an adapter folder whose package is another version as installed", async () => {
    const dir = adapterDirectory(DATA, "codex");
    const p = ports({
      files: {
        [CODEX_CMD]: "",
        [win32.join(dir, "node_modules", "@agentclientprotocol", "codex-acp", "package.json")]: JSON.stringify({
          name: "@agentclientprotocol/codex-acp",
          version: "1.0.0",
        }),
      },
      versions: { [CODEX_CMD]: ok("0.162.1") },
    });
    expect((await agentAvailability("codex", p)).availability.availability).toBe("needs-install");
  });

  it("is a version problem, with words, when the CLI is found but --version says nothing usable", async () => {
    const p = ports({ files: { [CLAUDE_EXE]: "" }, versions: { [CLAUDE_EXE]: "throws" } });
    const status = await agentAvailability("claude-code", p);
    expect(status.availability).toMatchObject({ agent: "claude-code", availability: "version-problem" });
    expect(status.availability.detail).toContain("--version");
    expect(status.availability.version).toBeUndefined();
    expect(status.cliPath).toBe(CLAUDE_EXE);
  });
});

describe("adapterLaunchSpec (T531, R-315, R-322)", () => {
  it("starts the adapter's bin entry under the broker's node with CLAUDE_CODE_EXECUTABLE set", async () => {
    const p = ports({ files: adapterManifest("claude-code", { bin: { "claude-agent-acp": "dist/index.js" } }) });
    const spec = await adapterLaunchSpec("claude-code", CLAUDE_EXE, p);
    expect(spec.command).toBe("C:\\node\\node.exe");
    expect(spec.args).toEqual([
      win32.join(adapterDirectory(DATA, "claude-code"), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"),
    ]);
    expect(spec.env).toEqual({ CLAUDE_CODE_EXECUTABLE: CLAUDE_EXE });
  });

  it("points CODEX_PATH at Hallpass's app-server shim and turns MCP config filtering off, with a string bin", async () => {
    const p = ports({ files: codexInstalled() });
    const spec = await adapterLaunchSpec("codex", CODEX_CMD, p);
    expect(spec.args[0]).toBe(
      win32.join(adapterDirectory(DATA, "codex"), "node_modules", "@agentclientprotocol", "codex-acp", "bin", "codex-acp.js"),
    );
    // SC-135: the adapter never starts the CLI itself; the shim does, with the paths as they are.
    expect(spec.env).toEqual({
      CODEX_PATH: SHIM_CMD,
      DISABLE_MCP_CONFIG_FILTERING: "true",
      HALLPASS_CODEX_NODE: "C:\\node\\node.exe",
      HALLPASS_CODEX_SHIM: SHIM_ENTRY,
      HALLPASS_CODEX_CLI: CODEX_CMD,
    });
    expect(await p.fs.readText(SHIM_CMD)).toBe(CODEX_SHIM_COMMAND);
  });

  it("writes the command file once and again only when it differs", async () => {
    const p = ports({ files: codexInstalled() });
    await adapterLaunchSpec("codex", CODEX_CMD, p);
    await adapterLaunchSpec("codex", CODEX_CMD, p);
    expect(p.writes).toEqual([SHIM_CMD]);
    // An older file (the raw CLI behind CODEX_PATH) is replaced, never trusted.
    await p.fs.writeText(SHIM_CMD, '@echo off\r\n"C:\\elsewhere\\codex.cmd" %*\r\n');
    await adapterLaunchSpec("codex", CODEX_CMD, p);
    expect(await p.fs.readText(SHIM_CMD)).toBe(CODEX_SHIM_COMMAND);
  });

  it("refuses to start Codex without the shim rather than hand the adapter the CLI itself", async () => {
    const p = ports({ files: codexInstalled() });
    await expect(adapterLaunchSpec("codex", CODEX_CMD, { ...p, codexShimEntry: "D:\\gone\\codex-app-server-shim.js" })).rejects.toThrow(
      /shim/,
    );
    expect(p.writes).toEqual([]);
  });

  it("refuses to start Codex when the installed adapter's modes are not the measured ones (T573)", async () => {
    // A changed adapter could send its strict turn as the agent mode's tuple, which the shim spares.
    const changed = MEASURED_CODEX_MODES.replace('"user"', '"auto_review"');
    const p = ports({ files: codexInstalled(undefined, changed) });
    await expect(adapterLaunchSpec("codex", CODEX_CMD, p)).rejects.toThrow(/strict mode was measured with \(codex-acp 1\.13\.1\)/);
    expect(p.writes).toEqual([]);
    await expect(adapterLaunchSpec("codex", CODEX_CMD, ports({ files: adapterManifest("codex", { bin: "./bin/codex-acp.js" }) }))).rejects.toThrow(
      /codex-acp 1\.13\.1/,
    );
  });

  it("writes no command file for Claude Code", async () => {
    const p = ports({ files: adapterManifest("claude-code", { bin: "dist/index.js" }) });
    await adapterLaunchSpec("claude-code", CLAUDE_EXE, p);
    expect(p.writes).toEqual([]);
  });

  it("refuses a manifest with no bin, or one that points outside the adapter folder", async () => {
    await expect(adapterLaunchSpec("codex", CODEX_CMD, ports({ files: adapterManifest("codex") }))).rejects.toThrow(/bin/);
    await expect(
      adapterLaunchSpec("codex", CODEX_CMD, ports({ files: adapterManifest("codex", { bin: "..\\..\\..\\evil.js" }) })),
    ).rejects.toThrow(/outside/);
  });
});

describe("classifyStartFailure (T534, R-315)", () => {
  const versions = { agent: "claude-code", tested: "2.1.302", found: "9.0.0" } as const;

  it("calls a failure with a CLI that was found a version problem and says tested versus found", () => {
    const error = classifyStartFailure("session/new", new Error("session failed: protocol changed"), versions);
    expect(error.code).toBe("agent-version");
    expect(error.detail).toContain("Claude Code");
    expect(error.detail).toContain("2.1.302");
    expect(error.detail).toContain("9.0.0");
    expect(error.detail).toContain("session failed: protocol changed");
  });

  it("calls it agent-missing when no CLI was found to hand the adapter", () => {
    const error = classifyStartFailure("initialize", new Error("boom"), { agent: "codex", tested: "0.162.1" });
    expect(error.code).toBe("agent-missing");
    expect(error.detail).toContain("Codex");
  });

  it("calls it agent-missing when the adapter itself says the executable is not there", () => {
    for (const message of [
      "native binary not found; set CLAUDE_CODE_EXECUTABLE",
      "Missing optional dependency @openai/codex-win32-x64",
    ]) {
      expect(classifyStartFailure("session/new", new Error(message), versions).code).toBe("agent-missing");
    }
  });

  it("reads message and data out of the error an ACP agent returns", () => {
    const error = classifyStartFailure("initialize", { code: -32603, message: "Internal error", data: { details: "bad flag" } }, versions);
    expect(error.detail).toContain("Internal error");
    expect(error.detail).toContain("bad flag");
  });

  it("redacts the agent's text and stays within 600 characters", () => {
    const error = classifyStartFailure(
      "initialize",
      new Error(`cannot reach https://bob:hunter2@proxy.example/ with token=abc123 ${"x".repeat(2000)}`),
      versions,
    );
    expect(error.detail).not.toMatch(/hunter2|abc123/);
    expect(error.detail.length).toBeLessThanOrEqual(600);
    expect(error.detail).toContain("2.1.302");
  });

  it("copes with a thrown string or nothing at all", () => {
    expect(classifyStartFailure("initialize", "plain string", versions).detail).toContain("plain string");
    expect(classifyStartFailure("initialize", undefined, versions).detail.length).toBeGreaterThan(0);
  });
});

describe("classifyStartFailure against the fake agent (T534)", () => {
  const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "harness", "fake-acp-agent.ts");
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  });

  function connect(env: Record<string, string>) {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", AGENT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    children.push(child);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    return new acp.ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {} }), stream);
  }

  const versions = { agent: "codex", tested: "0.162.1", found: "0.200.0" } as const;

  it("a failure at initialize becomes agent-version with the agent's own words", async () => {
    const connection = connect({ FAKE_ACP_FAIL_AT: "initialize", FAKE_ACP_FAIL_MESSAGE: "unsupported config at C:\\x password=hunter2" });
    const failure = await connection
      .initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeDefined();
    const error = classifyStartFailure("initialize", failure, versions);
    expect(error.code).toBe("agent-version");
    expect(error.detail).toMatch(/0\.162\.1.*0\.200\.0/);
    expect(error.detail).toContain("unsupported config");
    expect(error.detail).not.toContain("hunter2");
  }, 30_000);

  it("a failure at session/new becomes agent-version, and agent-missing without a found CLI", async () => {
    const connection = connect({ FAKE_ACP_FAIL_AT: "new" });
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const failure = await connection
      .newSession({ cwd: process.cwd(), mcpServers: [] })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeDefined();
    expect(classifyStartFailure("session/new", failure, versions).code).toBe("agent-version");
    expect(classifyStartFailure("session/new", failure, { agent: "codex", tested: "0.162.1" }).code).toBe("agent-missing");
  }, 30_000);
});
