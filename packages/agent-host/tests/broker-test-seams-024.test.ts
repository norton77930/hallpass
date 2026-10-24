import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_AGENTS, type ConversationAgent } from "@hallpass/contracts";
import {
  AGENT_DESCRIPTIONS,
  READINESS_EXEC_BOUND_MS,
  checkAgentReadiness,
  defaultAgentPorts,
  installPointerPath,
  isAdapterInstalled,
  type AgentPorts,
} from "../src/broker/agents.js";
import { INSTALL_CANCELLED_DETAIL, installAgent, type InstallEstimate } from "../src/broker/install.js";
import { readBrokerTestOverrides, testInstallRun } from "../src/broker/test-mode.js";
import { readTestMachine, testMachineCliPath, testMachinePorts, testMachineReadinessEnv, type TestMachine } from "../src/broker/test-machine.js";
import { FAKE_AGENT, REPO_ROOT, makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 024 T791 follow-up - the broker's test seams for the settings page's live gates (quickstart L2-L5,
 * L14), honoured only under `HALLPASS_TEST_MODE=1` as the 019 ones are (`test-mode.ts`):
 *
 * - `HALLPASS_BROKER_TEST_MACHINE`, the path of a JSON file read at every readiness check that says
 *   what "the machine" holds - which agent programs are there, what their `--version` prints (or that
 *   it hangs), whether Hermes' MCP component and Git Bash are there. The broker's real
 *   `checkAgentReadiness` then runs against it (`test-machine.ts`), with the pinned packages read from
 *   the real data folder; honoured only with the test agent, so the launches stay the fake's too;
 * - `HALLPASS_BROKER_TEST_INSTALL`, a JSON argv run in place of `npm ci`, in the install tree, with the
 *   install's own bound and cancel - `tests/harness/fake-acp-agent-install.ts --lockfile` grows the
 *   tree from its lockfile slowly, so progress, cancel and an interrupted download can be watched.
 *
 * Nothing here is imported by the broker from the tests: the fakes are programs named by argv.
 */

const INSTALL_SCRIPT = join(REPO_ROOT, "tests", "harness", "fake-acp-agent-install.ts");
const AGENT_ARGV = JSON.stringify(["node", "fake-acp-agent.js"]);

let dir: string;
let data: string;
let manifests: string;
beforeEach(async () => {
  dir = await makeTempDir("hallpass-seams-024-");
  data = join(dir, "data");
  manifests = join(dir, "manifests");
});
afterEach(async () => {
  await removeDir(dir);
});

describe("readBrokerTestOverrides: the 024 seams", () => {
  const MACHINE = "C:\\gate\\machine.json";
  const INSTALL = JSON.stringify(["node", "--experimental-strip-types", "fake-acp-agent-install.ts", "--lockfile"]);

  it("honours neither without HALLPASS_TEST_MODE=1", () => {
    for (const mode of [undefined, "", "0", "true"]) {
      const overrides = readBrokerTestOverrides({
        ...(mode === undefined ? {} : { HALLPASS_TEST_MODE: mode }),
        HALLPASS_BROKER_TEST_AGENT: AGENT_ARGV,
        HALLPASS_BROKER_TEST_MACHINE: MACHINE,
        HALLPASS_BROKER_TEST_INSTALL: INSTALL,
      });
      expect(overrides).toEqual({ codes: [] });
    }
  });

  it("reads the machine file's path and the install argv in test mode", () => {
    const overrides = readBrokerTestOverrides({
      HALLPASS_TEST_MODE: "1",
      HALLPASS_BROKER_TEST_AGENT: AGENT_ARGV,
      HALLPASS_BROKER_TEST_MACHINE: MACHINE,
      HALLPASS_BROKER_TEST_INSTALL: INSTALL,
    });
    expect(overrides.machineFile).toBe(MACHINE);
    expect(overrides.install).toEqual({ command: "node", args: ["--experimental-strip-types", "fake-acp-agent-install.ts", "--lockfile"] });
    expect(overrides.codes).toEqual(["broker.test-agent", "broker.test-machine", "broker.test-install"]);
  });

  it("ignores the machine without the test agent - a fake machine must not start real launches", () => {
    const overrides = readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_MACHINE: MACHINE });
    expect(overrides.machineFile).toBeUndefined();
    expect(overrides.codes).toEqual(["broker.test-machine-without-agent"]);
  });

  it("refuses a machine path that is not absolute and an install argv that is not one", () => {
    for (const raw of ["machine.json", ".\\machine.json", "C:machine.json"]) {
      expect(
        readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_AGENT: AGENT_ARGV, HALLPASS_BROKER_TEST_MACHINE: raw }).codes,
      ).toEqual(["broker.test-agent", "broker.test-machine-invalid"]);
    }
    for (const raw of ["not json", "[]", "[1]", '{"command":"x"}']) {
      expect(readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_AGENT: AGENT_ARGV, HALLPASS_BROKER_TEST_INSTALL: raw }).codes).toEqual([
        "broker.test-agent",
        "broker.test-install-invalid",
      ]);
    }
  });

  it("ignores the install argv without the test agent, as the machine is", () => {
    const overrides = readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_INSTALL: INSTALL });
    expect(overrides).toEqual({ codes: ["broker.test-install-without-agent"] });
  });
});

describe("the test machine (HALLPASS_BROKER_TEST_MACHINE) under the real readiness check", () => {
  /** The real ports, with a profile folder that holds a real-looking claude.exe the machine must not see. */
  async function realPorts(): Promise<AgentPorts> {
    const profile = join(dir, "profile");
    await mkdir(join(profile, ".local", "bin"), { recursive: true });
    await writeFile(join(profile, ".local", "bin", "claude.exe"), "", "utf8");
    await writeFile(join(profile, ".local", "bin", "hermes.exe"), "", "utf8");
    const ports = defaultAgentPorts(join(dir, "codex-app-server-shim.js"), { LOCALAPPDATA: dir, USERPROFILE: profile, ProgramFiles: join(dir, "pf") });
    return { ...ports, dataDir: data };
  }

  /** The pinned package of an adapter or fetched agent, as an install leaves it (0.15.0 layout: no pointer). */
  async function installPinned(agent: ConversationAgent): Promise<void> {
    const description = AGENT_DESCRIPTIONS[agent];
    if (description.kind === "installed") throw new Error("not fetched");
    const folder = join(data, "agents", agent, description.version, "node_modules", ...description.package.split("/"));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: description.package, version: description.version }), "utf8");
  }

  const check = async (agent: ConversationAgent, machine: TestMachine) => {
    const ports = testMachinePorts(await realPorts(), machine);
    return (await checkAgentReadiness(agent, ports, { env: testMachineReadinessEnv({}, data) })).availability;
  };

  it("an agent the machine does not list is not installed, whatever the real profile holds", async () => {
    const machine: TestMachine = { agents: {} };
    for (const agent of ["claude-code", "codex", "hermes"] as const) {
      expect(await check(agent, machine)).toMatchObject({ agent, availability: "missing" });
    }
  });

  it("four agents in four states: ready, needs the helper, ready with Hermes' component missing, not downloaded", async () => {
    await installPinned("claude-code");
    const machine: TestMachine = {
      gitBash: true,
      agents: {
        "claude-code": { version: "2.1.302 (Claude Code)" },
        codex: { version: "codex-cli 0.163.0" },
        hermes: { version: "Hermes Agent v0.22.2", mcpComponent: false },
      },
    };
    const [claude, codex, hermes, deepseek] = await Promise.all(CONVERSATION_AGENTS.map((agent) => check(agent, machine)));
    expect(claude).toMatchObject({ availability: "ready", version: "2.1.302", browserTools: "available" });
    expect(codex).toMatchObject({ availability: "needs-install", version: "0.163.0", browserTools: "needs-helper" });
    expect(hermes).toMatchObject({ availability: "ready", version: "0.22.2", browserTools: "missing-component" });
    expect(hermes?.notes).toBeUndefined();
    expect(hermes?.setupSteps).toEqual([
      { step: "git", found: true },
      { step: "hermes", found: true },
      { step: "mcp-component", found: false },
      { step: "key-variable", found: true },
      { step: "browser-restart", found: true },
    ]);
    expect(deepseek).toMatchObject({ availability: "needs-install", browserTools: "not-supported" });
  });

  it("Hermes with its component and without Git Bash: tools available, the git note and step", async () => {
    const hermes = await check("hermes", { gitBash: false, agents: { hermes: { version: "0.22.2", mcpComponent: true } } });
    expect(hermes).toMatchObject({ availability: "ready", browserTools: "available", notes: ["git-missing"] });
    expect(hermes.setupSteps?.find((step) => step.step === "git")).toEqual({ step: "git", found: false });
  });

  it("a version problem: Hermes at another version, and a program whose --version prints nothing", async () => {
    expect(await check("hermes", { agents: { hermes: { version: "0.21.0" } } })).toMatchObject({
      availability: "version-problem",
      version: "0.21.0",
    });
    expect(await check("codex", { agents: { codex: {} } })).toMatchObject({ availability: "version-problem" });
  });

  it("a program argv is really run for --version, with the entry's environment", async () => {
    const script = join(dir, "version.mjs");
    await writeFile(script, 'if (process.argv.includes("--version")) console.log(process.env.SEAM_VERSION);\n', "utf8");
    const status = await check("codex", { agents: { codex: { program: [process.execPath, script], env: { SEAM_VERSION: "codex-cli 0.170.1" } } } });
    expect(status).toMatchObject({ availability: "needs-install", version: "0.170.1" });
  });

  it(
    "one hung --version (the fake agent's FAKE_ACP_VERSION_HANG) holds only its own row, ended at the 5 s bound",
    async () => {
      await installPinned("claude-code");
      const machine: TestMachine = {
        agents: {
          "claude-code": { version: "2.1.302" },
          codex: { program: [process.execPath, "--experimental-strip-types", FAKE_AGENT], env: { FAKE_ACP_VERSION_HANG: "1" } },
          hermes: { hang: true },
        },
      };
      const started = Date.now();
      const timed = CONVERSATION_AGENTS.map(async (agent) => {
        const availability = await check(agent, machine);
        return { availability, ms: Date.now() - started };
      });
      const [claude, codex, hermes, deepseek] = await Promise.all(timed);
      expect(claude!.availability.availability).toBe("ready");
      expect(claude!.ms).toBeLessThan(READINESS_EXEC_BOUND_MS);
      expect(deepseek!.ms).toBeLessThan(READINESS_EXEC_BOUND_MS);
      for (const hung of [codex!, hermes!]) {
        expect(hung.availability).toMatchObject({ availability: "version-problem" });
        expect(hung.availability.detail).toContain(`within ${READINESS_EXEC_BOUND_MS / 1000} s`);
        expect(hung.ms).toBeLessThan(READINESS_EXEC_BOUND_MS + 2_000);
      }
    },
    20_000,
  );

  it("names a program path inside the data folder that cmd.exe could take, never the owner's profile", () => {
    for (const agent of ["claude-code", "codex", "hermes"] as const) {
      const path = testMachineCliPath(data, agent);
      expect(path.startsWith(`${data}${win32.sep}`)).toBe(true);
      expect(path).not.toMatch(/["%\r\n]/u);
    }
  });

  it("reads the machine file at each call: a missing or malformed one is no machine", async () => {
    const path = join(dir, "machine.json");
    expect(await readTestMachine(path)).toBeUndefined();
    await writeFile(path, "{ not json", "utf8");
    expect(await readTestMachine(path)).toBeUndefined();
    await writeFile(path, JSON.stringify({ agents: { claude: { version: "1.0.0" } } }), "utf8");
    expect(await readTestMachine(path), "an agent the contract does not name").toBeUndefined();
    await writeFile(path, JSON.stringify({ agents: { hermes: { version: "0.22.2", extra: true } } }), "utf8");
    expect(await readTestMachine(path), "an undeclared field").toBeUndefined();
    await writeFile(path, JSON.stringify({ gitBash: false, agents: { hermes: { version: "0.22.2" } } }), "utf8");
    expect(await readTestMachine(path)).toEqual({ gitBash: false, agents: { hermes: { version: "0.22.2" } } });
  });
});

describe("the test install (HALLPASS_BROKER_TEST_INSTALL) in place of npm ci", () => {
  const CODEX = AGENT_DESCRIPTIONS.codex;
  const DEPENDENCIES = 11;

  async function writeManifests(): Promise<void> {
    const packages: Record<string, Record<string, unknown>> = {
      "": { name: "hallpass-agent-codex", dependencies: { [CODEX.package]: CODEX.version } },
      [`node_modules/${CODEX.package}`]: { version: CODEX.version },
    };
    for (let index = 1; index <= DEPENDENCIES; index += 1) packages[`node_modules/dep-${index}`] = { version: "1.0.0" };
    await mkdir(join(manifests, "codex"), { recursive: true });
    await writeFile(join(manifests, "codex", "package.json"), JSON.stringify(packages[""]), "utf8");
    await writeFile(join(manifests, "codex", "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }), "utf8");
  }

  const fakeInstall = (seconds: string) =>
    testInstallRun({ command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", INSTALL_SCRIPT, "--lockfile", seconds] });

  it(
    "grows the tree from the lockfile over time; the install verifies it and names it as installed",
    async () => {
      await writeManifests();
      const estimates: InstallEstimate[] = [];
      const result = await installAgent(
        "codex",
        { dataDir: data, manifestsDir: manifests, nodePath: process.execPath, run: fakeInstall("2"), estimateIntervalMs: 200 },
        undefined,
        { onEstimate: (estimate) => estimates.push(estimate) },
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.parse(await readFile(installPointerPath(data, "codex"), "utf8"))).toMatchObject({ folder: expect.stringMatching(/^\.install-/u) });
      const percents = estimates.map((estimate) => estimate.percent).filter((percent): percent is number => percent !== null);
      expect(percents.length, "no estimate between the first folder and the end").toBeGreaterThan(1);
      expect(Math.min(...percents)).toBeLessThan(Math.max(...percents));
      const ports = { ...defaultAgentPorts(join(dir, "shim.js")), dataDir: data };
      expect(await isAdapterInstalled("codex", ports)).toBe(true);
    },
    20_000,
  );

  it(
    "cancel ends the fake's process and removes its folder, as with npm",
    async () => {
      await writeManifests();
      const abort = new AbortController();
      const result = await installAgent(
        "codex",
        { dataDir: data, manifestsDir: manifests, nodePath: process.execPath, run: fakeInstall("30"), estimateIntervalMs: 200 },
        undefined,
        {
          signal: abort.signal,
          onEstimate: (estimate) => {
            if ((estimate.percent ?? 0) > 0) abort.abort();
          },
        },
      );
      expect(result).toEqual({ ok: false, error: { code: "install-failed", detail: INSTALL_CANCELLED_DETAIL } });
      const left = (await readdir(join(data, "agents", "codex"))).filter((name) => name.startsWith(".install-"));
      expect(left).toEqual([]);
      expect(existsSync(installPointerPath(data, "codex"))).toBe(false);
    },
    20_000,
  );

  it("runs its own argv in the install tree, whatever npm command it replaces, with the install's bound and signal", async () => {
    const seen: unknown[] = [];
    const run = testInstallRun({ command: "node", args: ["fake.ts", "--lockfile"] }, async (file, args, options) => {
      seen.push({ file, args, options });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    const signal = new AbortController().signal;
    await run("C:\\node\\npm.cmd", ["ci", "--ignore-scripts"], { cwd: "C:\\tree", timeoutMs: 600_000, signal });
    expect(seen).toEqual([{ file: "node", args: ["fake.ts", "--lockfile"], options: { cwd: "C:\\tree", timeoutMs: 600_000, signal } }]);
  });
});

it("keeps every seam module free of imports from the tests (the bundle carries no test tooling)", async () => {
  for (const file of ["test-mode.ts", "test-machine.ts"]) {
    const source = await readFile(resolve(REPO_ROOT, "packages", "agent-host", "src", "broker", file), "utf8");
    expect(source, file).not.toMatch(/from\s+["'][^"']*(tests|harness|test-kit)[^"']*["']/u);
  }
});
