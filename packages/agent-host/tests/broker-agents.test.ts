import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, resolve, win32 } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ADAPTERS,
  AGENT_DESCRIPTIONS,
  TESTED_AGENT_VERSIONS,
  adapterDirectory,
  adapterLaunchSpec,
  agentAvailability,
  classifyStartFailure,
  discoverCli,
  isAdapterInstalled,
  parseVersion,
  readCliVersion,
  type AgentPorts,
  type ExecResult,
} from "../src/broker/agents.js";
import { CONVERSATION_MODE_FIXED_AGENTS } from "@hallpass/contracts";
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
const PROGRAM_FILES = "C:\\Program Files";
const HERMES_EXE = win32.join(HOME, ".local", "bin", "hermes.exe");
/** Where Git for Windows puts the bash Hermes' command tool needs (R-348). */
const GIT_BASH = win32.join(PROGRAM_FILES, "Git", "bin", "bash.exe");
const DSH_MANIFEST = win32.join(DATA, "agents", "deepseek", "0.2.1-rc.2", "node_modules", "@deepseek-ai", "dsh", "package.json");
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
    env: { USERPROFILE: HOME, APPDATA, ProgramFiles: PROGRAM_FILES },
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
const adapterManifest = (agent: "claude-code" | "codex" | "deepseek", extra: Record<string, unknown> = {}) => {
  const adapter = AGENT_DESCRIPTIONS[agent];
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
    expect(TESTED_AGENT_VERSIONS).toEqual({ "claude-code": "2.1.302", codex: "0.163.0", hermes: "0.22.2", deepseek: "0.2.1-rc.2" });
    expect(AGENT_ADAPTERS["claude-code"]).toMatchObject({ package: "@agentclientprotocol/claude-agent-acp", version: "0.81.2" });
    expect(AGENT_ADAPTERS.codex).toMatchObject({ package: "@agentclientprotocol/codex-acp", version: "1.13.1" });
  });

  it("keeps the package pins in step with the manifests the package ships", async () => {
    const { readFileSync } = await import("node:fs");
    const here = dirname(fileURLToPath(import.meta.url));
    for (const agent of ["claude-code", "codex", "deepseek"] as const) {
      const manifest = JSON.parse(readFileSync(resolve(here, "..", "agents", agent, "package.json"), "utf8"));
      expect(manifest.dependencies).toEqual({ [AGENT_DESCRIPTIONS[agent].package]: AGENT_DESCRIPTIONS[agent].version });
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

describe("agent descriptions (021 T640, R-345, R-351, R-355)", () => {
  it("describes the four agents in contract order, with how each is obtained", () => {
    expect(Object.keys(AGENT_DESCRIPTIONS)).toEqual(["claude-code", "codex", "hermes", "deepseek"]);
    expect(Object.fromEntries(Object.entries(AGENT_DESCRIPTIONS).map(([agent, d]) => [agent, d.kind]))).toEqual({
      "claude-code": "adapter",
      codex: "adapter",
      hermes: "installed",
      deepseek: "fetched",
    });
    expect(AGENT_DESCRIPTIONS.hermes).toMatchObject({ label: "Hermes", cliFile: "hermes", tested: "0.22.2", launchArgs: ["acp"] });
    expect(AGENT_DESCRIPTIONS.deepseek).toMatchObject({
      label: "DeepSeek",
      package: "@deepseek-ai/dsh",
      version: "0.2.1-rc.2",
      launchArgs: ["--profile", "acp"],
    });
  });

  it("maps each panel mode to an agent mode or to launch settings, never to a full-access mode", () => {
    expect(Object.fromEntries(Object.entries(AGENT_DESCRIPTIONS).map(([agent, d]) => [agent, d.modes]))).toEqual({
      "claude-code": { strict: { agentMode: "default", atLaunch: false }, "agent-review": { agentMode: "auto", atLaunch: false } },
      codex: { strict: { agentMode: "read-only", atLaunch: false }, "agent-review": { agentMode: "agent", atLaunch: false } },
      hermes: { strict: { agentMode: "default", atLaunch: true }, "agent-review": { agentMode: "accept_edits", atLaunch: true } },
      deepseek: { strict: { atLaunch: true }, "agent-review": { atLaunch: true } },
    });
  });

  it("continues a DeepSeek session with session/resume and every other with session/load", () => {
    expect(Object.fromEntries(Object.entries(AGENT_DESCRIPTIONS).map(([agent, d]) => [agent, d.continueWith]))).toEqual({
      "claude-code": "session/load",
      codex: "session/load",
      hermes: "session/load",
      deepseek: "session/resume",
    });
  });

  it("D-021-16: only DeepSeek's mode is fixed once started, as the contract tells the panel", () => {
    const fixed = Object.entries(AGENT_DESCRIPTIONS).flatMap(([agent, d]) => (d.modeFixedOnceStarted ? [agent] : []));
    expect(fixed).toEqual(["deepseek"]);
    expect(fixed).toEqual([...CONVERSATION_MODE_FIXED_AGENTS]);
  });

  it("expects pictures and no page context from Hermes and DeepSeek before their first start", () => {
    expect(AGENT_DESCRIPTIONS.hermes.expectedAccepts).toEqual({ image: true, context: false });
    expect(AGENT_DESCRIPTIONS.deepseek.expectedAccepts).toEqual({ image: true, context: false });
    expect("expectedAccepts" in AGENT_DESCRIPTIONS["claude-code"]).toBe(false);
    expect("expectedAccepts" in AGENT_DESCRIPTIONS.codex).toBe(false);
  });
});

describe("Hermes: an installed ACP program (021 T640, R-345, R-348)", () => {
  const hermesAt = (path: string, version: string | "throws", extra: Machine = {}): Machine => ({
    ...extra,
    files: { [path]: "", ...extra.files },
    versions: { [path]: version === "throws" ? "throws" : ok(`Hermes Agent v${version}\n`), ...extra.versions },
  });
  const gitBash = { files: { [GIT_BASH]: "" } };

  it("is found by where.exe hermes first", async () => {
    const onPath = "D:\\tools\\hermes.exe";
    const p = ports({ files: { [onPath]: "", [HERMES_EXE]: "" }, where: { hermes: [onPath] } });
    expect(await discoverCli("hermes", p)).toBe(onPath);
    expect(p.calls).toEqual(["where.exe hermes"]);
  });

  it("falls back to %USERPROFILE%\\.local\\bin\\hermes.exe", async () => {
    expect(await discoverCli("hermes", ports({ files: { [HERMES_EXE]: "" } }))).toBe(HERMES_EXE);
  });

  it("is missing when neither route finds it", async () => {
    expect(await agentAvailability("hermes", ports(gitBash))).toEqual({ availability: { agent: "hermes", availability: "missing" } });
  });

  it("is ready at exactly 0.22.2 with Git Bash present, and needs no download", async () => {
    const p = ports(hermesAt(HERMES_EXE, "0.22.2", gitBash));
    expect(await agentAvailability("hermes", p)).toEqual({
      availability: { agent: "hermes", availability: "ready", version: "0.22.2" },
      cliPath: HERMES_EXE,
    });
  });

  it("is a version problem at 0.22.1, naming both versions", async () => {
    const status = await agentAvailability("hermes", ports(hermesAt(HERMES_EXE, "0.22.1", gitBash)));
    expect(status.availability).toMatchObject({ agent: "hermes", availability: "version-problem", version: "0.22.1" });
    expect(status.availability.detail).toContain("0.22.2");
    expect(status.availability.detail).toContain("0.22.1");
    expect(status.cliPath).toBe(HERMES_EXE);
  });

  it("is a version problem when --version says nothing usable", async () => {
    const status = await agentAvailability("hermes", ports(hermesAt(HERMES_EXE, "throws", gitBash)));
    expect(status.availability).toMatchObject({ agent: "hermes", availability: "version-problem" });
    expect(status.availability.version).toBeUndefined();
  });

  it("stays ready with the git-missing note when no Git Bash is found", async () => {
    const status = await agentAvailability("hermes", ports(hermesAt(HERMES_EXE, "0.22.2")));
    expect(status.availability).toEqual({ agent: "hermes", availability: "ready", version: "0.22.2", notes: ["git-missing"] });
  });

  it("takes a Git Bash that where.exe finds inside a Git install, and not another bash", async () => {
    const gitUsr = "D:\\Apps\\Git\\usr\\bin\\bash.exe";
    const found = await agentAvailability("hermes", ports(hermesAt(HERMES_EXE, "0.22.2", { files: { [gitUsr]: "" }, where: { bash: [gitUsr] } })));
    expect(found.availability.notes).toBeUndefined();
    // WSL's launcher is a bash.exe on the PATH, but not the Git Bash Hermes needs.
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const other = await agentAvailability("hermes", ports(hermesAt(HERMES_EXE, "0.22.2", { files: { [wsl]: "" }, where: { bash: [wsl] } })));
    expect(other.availability.notes).toEqual(["git-missing"]);
  });
});

describe("DeepSeek: a fetched ACP package (021 T640, R-345)", () => {
  it("needs the download until its package is in the agent folder, with the pre-release note, and looks for no CLI", async () => {
    const p = ports();
    expect(await agentAvailability("deepseek", p)).toEqual({
      availability: { agent: "deepseek", availability: "needs-install", notes: ["pre-release"] },
    });
    expect(p.calls).toEqual([]);
  });

  it("needs the download when the folder holds another version", async () => {
    const p = ports({ files: { [DSH_MANIFEST]: JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0" }) } });
    expect((await agentAvailability("deepseek", p)).availability.availability).toBe("needs-install");
  });

  it("is ready when the folder's package.json says 0.2.1-rc.2", async () => {
    const p = ports({ files: { [DSH_MANIFEST]: JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2" }) } });
    expect(await agentAvailability("deepseek", p)).toEqual({
      availability: { agent: "deepseek", availability: "ready", version: "0.2.1-rc.2", notes: ["pre-release"] },
    });
    expect(adapterDirectory(DATA, "deepseek")).toBe(win32.join(DATA, "agents", "deepseek", "0.2.1-rc.2"));
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

  it("021 R-362: starts from the tree the install pointer names, not from a <version> folder beside it", async () => {
    const tree = win32.join(DATA, "agents", "claude-code", ".install-4321-abc123");
    const pin = AGENT_DESCRIPTIONS["claude-code"];
    const p = ports({
      files: {
        // A 0.15.0 folder of another version is beside it and must not be what starts.
        ...adapterManifest("claude-code", { version: "0.0.1", bin: "dist/old.js" }),
        [win32.join(DATA, "agents", "claude-code", `${pin.version}.installed.json`)]: JSON.stringify({ folder: ".install-4321-abc123" }),
        [win32.join(tree, "node_modules", ...pin.package.split("/"), "package.json")]: JSON.stringify({
          name: pin.package,
          version: pin.version,
          bin: { "claude-agent-acp": "dist/index.js" },
        }),
      },
    });
    expect(await isAdapterInstalled("claude-code", p)).toBe(true);
    const spec = await adapterLaunchSpec("claude-code", CLAUDE_EXE, p);
    expect(spec.args).toEqual([win32.join(tree, "node_modules", ...pin.package.split("/"), "dist", "index.js")]);
  });

  it("021 R-362: a pointer that names anything but an .install-* folder is not followed", async () => {
    const pin = AGENT_DESCRIPTIONS["claude-code"];
    const p = ports({
      files: {
        [win32.join(DATA, "agents", "claude-code", `${pin.version}.installed.json`)]: JSON.stringify({ folder: "..\\..\\elsewhere" }),
        [win32.join(DATA, "elsewhere", "node_modules", ...pin.package.split("/"), "package.json")]: JSON.stringify({
          name: pin.package,
          version: pin.version,
          bin: "x.js",
        }),
      },
    });
    expect(await isAdapterInstalled("claude-code", p)).toBe(false);
  });

  it.each([
    ["an absolute path", (tree: string) => JSON.stringify({ folder: tree })],
    ["a separator", (tree: string) => JSON.stringify({ folder: `.\\${win32.basename(tree)}` })],
    ["a forward slash", (tree: string) => JSON.stringify({ folder: `./${win32.basename(tree)}` })],
    ["'..'", (tree: string) => JSON.stringify({ folder: `..\\claude-code\\${win32.basename(tree)}` })],
    ["junk", () => "not json {"],
    ["null", () => "null"],
    ["an array", (tree: string) => JSON.stringify([win32.basename(tree)])],
    ["a bare string", (tree: string) => JSON.stringify(win32.basename(tree))],
    ["a non-string folder", () => JSON.stringify({ folder: 42 })],
  ])("021 R-362: a pointer holding %s is not followed", async (_, content) => {
    const tree = win32.join(DATA, "agents", "claude-code", ".install-4321-abc123");
    const pin = AGENT_DESCRIPTIONS["claude-code"];
    const p = ports({
      files: {
        [win32.join(DATA, "agents", "claude-code", `${pin.version}.installed.json`)]: content(tree),
        [win32.join(tree, "node_modules", ...pin.package.split("/"), "package.json")]: JSON.stringify({
          name: pin.package,
          version: pin.version,
          bin: "dist/index.js",
        }),
      },
    });
    expect(await isAdapterInstalled("claude-code", p)).toBe(false);
    await expect(adapterLaunchSpec("claude-code", CLAUDE_EXE, p)).rejects.toThrow(/not installed/);
  });

  it("021 R-362 (L3): a pointer the file system will not let it read is not passed over for the 0.15.0 folder beside it", async () => {
    const pin = AGENT_DESCRIPTIONS["claude-code"];
    const pointer = win32.join(DATA, "agents", "claude-code", `${pin.version}.installed.json`);
    // A complete 0.15.0 install is beside the pointer, which a real-time file scanner holds open.
    const p = ports({ files: { ...adapterManifest("claude-code", { bin: "dist/index.js" }), [pointer]: "{}" } });
    const read = p.fs.readText;
    p.fs.readText = async (path) => {
      if (path === pointer) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return read(path);
    };
    expect(await isAdapterInstalled("claude-code", p)).toBe(false);
    await expect(adapterLaunchSpec("claude-code", CLAUDE_EXE, p)).rejects.toThrow(/EBUSY/);
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

describe("adapterLaunchSpec for Hermes and DeepSeek (021 T644, R-345, R-347, R-349)", () => {
  const HERMES_MANAGED = (mode: string) => win32.join(DATA, "agents", "hermes", "managed", mode);
  const DSH_DIR = win32.dirname(DSH_MANIFEST);
  const dshInstalled = (bin: unknown = { dsh: "lib/bin.js" }) => ({
    [DSH_MANIFEST]: JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2", bin }),
  });

  it("starts hermes acp itself with the strict managed layer, written before the launch", async () => {
    const p = ports({ files: { [HERMES_EXE]: "" } });
    expect(await adapterLaunchSpec("hermes", HERMES_EXE, p, "strict")).toEqual({
      command: HERMES_EXE,
      args: ["acp"],
      env: { HERMES_MANAGED_DIR: HERMES_MANAGED("strict") },
    });
    expect(p.writes).toEqual([win32.join(HERMES_MANAGED("strict"), "config.yaml")]);
    expect(await p.fs.readText(win32.join(HERMES_MANAGED("strict"), "config.yaml"))).toContain("terminal");
  });

  it("starts Hermes strict when no mode is named, and with the agent-review layer when it is", async () => {
    const p = ports({ files: { [HERMES_EXE]: "" } });
    expect((await adapterLaunchSpec("hermes", HERMES_EXE, p)).env).toEqual({ HERMES_MANAGED_DIR: HERMES_MANAGED("strict") });
    expect((await adapterLaunchSpec("hermes", HERMES_EXE, p, "agent-review")).env).toEqual({
      HERMES_MANAGED_DIR: HERMES_MANAGED("agent-review"),
    });
  });

  it("starts a .cmd Hermes through cmd.exe /d /s /c with verbatim arguments, as run-command.ts does", async () => {
    const shim = "D:\\My Tools\\hermes.cmd";
    const spec = await adapterLaunchSpec("hermes", shim, ports({ files: { [shim]: "" } }), "strict");
    expect(spec).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" acp"`],
      env: { HERMES_MANAGED_DIR: HERMES_MANAGED("strict") },
      windowsVerbatimArguments: true,
    });
    const withComSpec = { ...ports({ files: { [shim]: "" } }) };
    withComSpec.env = { ...withComSpec.env, ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    expect((await adapterLaunchSpec("hermes", shim, withComSpec)).command).toBe("C:\\Windows\\system32\\cmd.exe");
  });

  it("refuses to start Hermes without its program", async () => {
    await expect(adapterLaunchSpec("hermes", undefined, ports())).rejects.toThrow(/Hermes/);
  });

  it("starts DeepSeek's bin under the broker's node with --profile acp and its environment, writing nothing", async () => {
    const p = ports({ files: dshInstalled() });
    expect(await adapterLaunchSpec("deepseek", undefined, p, "strict")).toEqual({
      command: "C:\\node\\node.exe",
      args: [win32.join(DSH_DIR, "lib", "bin.js"), "--profile", "acp"],
      env: { DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" },
    });
    expect((await adapterLaunchSpec("deepseek", undefined, p, "agent-review")).env).toEqual({
      DSH_PERMISSION_MODE: "workspace-write",
      DSH_TELEMETRY_MODE: "DISABLED",
    });
    expect(p.writes).toEqual([]);
  });

  it("refuses DeepSeek when its package is missing or its bin points outside it", async () => {
    await expect(adapterLaunchSpec("deepseek", undefined, ports())).rejects.toThrow(/not installed/);
    await expect(adapterLaunchSpec("deepseek", undefined, ports({ files: dshInstalled({ dsh: "..\\..\\evil.js" }) }))).rejects.toThrow(
      /outside/,
    );
  });

  it("gives Claude Code and Codex the same spec in either mode", async () => {
    const claude = ports({ files: adapterManifest("claude-code", { bin: "dist/index.js" }) });
    expect(await adapterLaunchSpec("claude-code", CLAUDE_EXE, claude, "agent-review")).toEqual(
      await adapterLaunchSpec("claude-code", CLAUDE_EXE, claude, "strict"),
    );
    const codex = ports({ files: codexInstalled() });
    expect(await adapterLaunchSpec("codex", CODEX_CMD, codex, "agent-review")).toEqual(await adapterLaunchSpec("codex", CODEX_CMD, codex));
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
