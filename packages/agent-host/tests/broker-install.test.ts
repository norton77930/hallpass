import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ADAPTERS, AGENT_DESCRIPTIONS, adapterDirectory } from "../src/broker/agents.js";
import {
  NPM_CI_ARGS,
  cleanStaging,
  installAgent,
  shippedManifestsDirectory,
  type InstallPhase,
  type InstallPorts,
} from "../src/broker/install.js";
import { runCommand, type RunResult } from "../src/broker/run-command.js";

/**
 * 019/T532, T533 - the first-use install (R-314): `npm ci` against the lockfile Hallpass ships, in
 * a staging folder that becomes `agents\<agent>\<adapter version>` only when it worked.
 *
 * Most cases inject the command runner and stand in for npm by writing the tree a successful
 * `npm ci` would. Two cases run the real npm against a tarball served from the loopback interface
 * (no registry, no outside network): one that installs, one whose lockfile integrity is tampered.
 */

const SHIPPED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const AGENT = "claude-code" as const;
const ADAPTER = AGENT_ADAPTERS[AGENT];

let root: string;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hallpass-install-"));
  data = join(root, "data");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A minimal gzip-compressed ustar archive, so the real-npm cases need no tar program on the machine. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const list = (path: string) => readdir(path).catch(() => [] as string[]);

type Call = { file: string; args: string[]; cwd: string | undefined; staged: string[]; lock: string; timeoutMs: number | undefined };

/** What a successful `npm ci` leaves in the folder it ran in. */
async function writeAdapterTree(cwd: string, version: string = ADAPTER.version) {
  const dir = join(cwd, "node_modules", ...ADAPTER.package.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: ADAPTER.package, version, bin: "dist/index.js" }));
}

function ports(
  behave: (cwd: string, call: Call) => Promise<Partial<RunResult>> | Partial<RunResult>,
  extra: Partial<InstallPorts> = {},
): { ports: InstallPorts; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ports: {
      dataDir: data,
      manifestsDir: SHIPPED,
      nodePath: "C:\\no-such-node\\node.exe",
      randomSuffix: () => "abc123",
      run: async (file, args, options) => {
        const cwd = options?.cwd ?? "";
        const call: Call = {
          file,
          args: [...args],
          cwd: options?.cwd,
          staged: await list(cwd),
          lock: await readFile(join(cwd, "package-lock.json"), "utf8").catch(() => ""),
          timeoutMs: options?.timeoutMs,
        };
        calls.push(call);
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...(await behave(cwd, call)) };
      },
      ...extra,
    },
  };
}

const installedDir = () => adapterDirectory(data, AGENT);

describe("installAgent with an injected npm (T532, T533, R-314)", () => {
  it("runs npm ci in .staging-<pid>-<random> on the shipped manifest and lock, then renames to the adapter version", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    const phases: InstallPhase[] = [];
    const result = await installAgent(AGENT, p, (progress) => phases.push(progress.phase));

    expect(result).toEqual({ ok: true, directory: installedDir() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("npm.cmd");
    expect(calls[0]!.args).toEqual(["ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(NPM_CI_ARGS).toEqual(calls[0]!.args);
    expect(calls[0]!.cwd).toBe(join(data, "agents", AGENT, `.staging-${process.pid}-abc123`));
    expect(calls[0]!.staged.sort()).toEqual(["package-lock.json", "package.json"]);
    expect(calls[0]!.lock).toBe(await readFile(join(SHIPPED, AGENT, "package-lock.json"), "utf8"));

    expect(await exists(join(installedDir(), "node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"))).toBe(true);
    expect(await list(join(data, "agents", AGENT))).toEqual([ADAPTER.version]);
    expect(phases).toEqual(["preparing", "downloading", "finishing"]);
  });

  it("uses the npm.cmd next to the running node when there is one", async () => {
    const nodeDir = join(root, "nodejs");
    await mkdir(nodeDir);
    await writeFile(join(nodeDir, "npm.cmd"), "");
    const { ports: p, calls } = ports(
      async (cwd) => {
        await writeAdapterTree(cwd);
        return {};
      },
      { nodePath: join(nodeDir, "node.exe") },
    );
    await installAgent(AGENT, p);
    expect(calls[0]!.file).toBe(join(nodeDir, "npm.cmd"));
  });

  it("leaves no folder when npm exits non-zero, and reports npm's stderr tail redacted", async () => {
    const stderr = [
      "npm error code E500",
      "npm error fetch https://bob:hunter2@registry.example/pkg.tgz failed",
      "npm error token=abc123secret",
      "npm error a long tail ".repeat(60),
    ].join("\n");
    const { ports: p } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return { code: 1, stderr };
    });
    const result = await installAgent(AGENT, p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("install-failed");
    expect(result.error.detail).toContain("exit 1");
    expect(result.error.detail).not.toMatch(/hunter2|abc123secret/);
    expect(result.error.detail.length).toBeLessThanOrEqual(600);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("leaves no folder when the lockfile integrity does not match (npm's EINTEGRITY exit)", async () => {
    const { ports: p } = ports(() => ({
      code: 1,
      stderr: "npm error code EINTEGRITY\nnpm error sha512-AAAA... integrity checksum failed when using sha512",
    }));
    const result = await installAgent(AGENT, p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(result.ok ? "" : result.error.detail).toContain("EINTEGRITY");
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("leaves no folder when npm cannot be started or runs out of time", async () => {
    const cannotStart = ports(() => {
      throw new Error("spawn npm.cmd ENOENT");
    });
    const first = await installAgent(AGENT, cannotStart.ports);
    expect(first).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(first.ok ? "" : first.error.detail).toContain("ENOENT");

    const timedOut = ports(() => ({ code: null, timedOut: true }));
    const second = await installAgent(AGENT, timedOut.ports);
    expect(second).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(second.ok ? "" : second.error.detail).toMatch(/time/i);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("refuses a tree where the pinned adapter did not land, or landed at another version", async () => {
    const empty = ports(() => ({}));
    expect(await installAgent(AGENT, empty.ports)).toMatchObject({ ok: false, error: { code: "install-failed" } });

    const wrong = ports(async (cwd) => {
      await writeAdapterTree(cwd, "9.9.9");
      return {};
    });
    expect(await installAgent(AGENT, wrong.ports)).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("fails cleanly when the shipped lockfile is not where it should be", async () => {
    const { ports: p, calls } = ports(() => ({}), { manifestsDir: join(root, "nowhere") });
    const result = await installAgent(AGENT, p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(calls).toHaveLength(0);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("does nothing when the pinned adapter is already installed", async () => {
    await writeAdapterTree(installedDir());
    const { ports: p, calls } = ports(() => ({}));
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: installedDir() });
    expect(calls).toHaveLength(0);
  });

  it("replaces a half-written adapter folder that is not a valid install", async () => {
    await mkdir(join(installedDir(), "node_modules"), { recursive: true });
    await writeFile(join(installedDir(), "stale.txt"), "x");
    const { ports: p } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: installedDir() });
    expect(await exists(join(installedDir(), "stale.txt"))).toBe(false);
  });

  it("installs the Codex adapter the same way", async () => {
    const codex = AGENT_ADAPTERS.codex;
    const { ports: p, calls } = ports(async (cwd) => {
      const dir = join(cwd, "node_modules", ...codex.package.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: codex.package, version: codex.version }));
      return {};
    });
    expect(await installAgent("codex", p)).toEqual({ ok: true, directory: adapterDirectory(data, "codex") });
    expect(calls[0]!.cwd).toBe(join(data, "agents", "codex", `.staging-${process.pid}-abc123`));
  });
});

describe("installAgent per agent (021 T646, R-345, R-346)", () => {
  const DSH = AGENT_DESCRIPTIONS.deepseek;
  const writeDshTree = async (cwd: string) => {
    const dir = join(cwd, "node_modules", ...DSH.package.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: DSH.package, version: DSH.version, bin: { dsh: "lib/bin.js" } }));
  };

  it("bounds an adapter's npm ci at 10 minutes", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    await installAgent(AGENT, p);
    expect(calls[0]!.timeoutMs).toBe(10 * 60 * 1000);
  });

  it("fetches DeepSeek from its shipped manifest and lock with its optional platform bindings kept, bounded at 30 minutes", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeDshTree(cwd);
      return {};
    });
    expect(await installAgent("deepseek", p)).toEqual({ ok: true, directory: join(data, "agents", "deepseek", "0.2.1-rc.2") });
    expect(calls).toHaveLength(1);
    // R-357: dsh's native bindings are optionalDependencies; `--omit=optional` left it unable to boot.
    expect(calls[0]!.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(calls[0]!.timeoutMs).toBe(30 * 60 * 1000);
    expect(calls[0]!.lock).toBe(await readFile(join(SHIPPED, "deepseek", "package-lock.json"), "utf8"));
  });

  it("downloads nothing for Hermes, which the owner installs with its own installer", async () => {
    const { ports: p, calls } = ports(() => ({}));
    const result = await installAgent("hermes", p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(calls).toEqual([]);
    expect(await exists(join(data, "agents", "hermes"))).toBe(false);
  });
});

describe("shippedManifestsDirectory (S9: the package's flat host/ and the dev dist/)", () => {
  it("is the agents folder beside the broker's entry when there is one (host/broker.js + host/agents)", async () => {
    const host = join(root, "host");
    await mkdir(join(host, "agents", "codex"), { recursive: true });
    expect(shippedManifestsDirectory(host)).toBe(join(host, "agents"));
  });

  it("else the one beside the entry's folder (packages/agent-host/dist/broker.js + packages/agent-host/agents)", async () => {
    const dist = join(root, "agent-host", "dist");
    await mkdir(dist, { recursive: true });
    await mkdir(join(root, "agent-host", "agents"), { recursive: true });
    expect(shippedManifestsDirectory(dist)).toBe(join(root, "agent-host", "agents"));
  });
});

describe("cleanStaging (T532: at broker start)", () => {
  it("removes leftover .staging-* folders and nothing else", async () => {
    await mkdir(join(data, "agents", AGENT, ".staging-dead", "node_modules"), { recursive: true });
    await mkdir(join(data, "agents", AGENT, ".staging-beef"), { recursive: true });
    await mkdir(join(data, "agents", AGENT, ADAPTER.version, "node_modules"), { recursive: true });
    await mkdir(join(data, "agents", "codex", ".staging-1"), { recursive: true });
    await mkdir(join(data, "agents", "codex", "keep-me"), { recursive: true });
    await mkdir(join(data, "scratch", ".staging-user-folder"), { recursive: true });

    const removed = await cleanStaging(data);

    expect(removed.sort()).toEqual(
      [
        join(data, "agents", AGENT, ".staging-beef"),
        join(data, "agents", AGENT, ".staging-dead"),
        join(data, "agents", "codex", ".staging-1"),
      ].sort(),
    );
    expect(await list(join(data, "agents", AGENT))).toEqual([ADAPTER.version]);
    expect(await list(join(data, "agents", "codex"))).toEqual(["keep-me"]);
    expect(await exists(join(data, "scratch", ".staging-user-folder"))).toBe(true);
  });

  it("T572: leaves a download another live broker is still running, and removes a dead broker's", async () => {
    const otherBroker = 4_000_101;
    const deadBroker = 4_000_102;
    const self = 4_000_103;
    const alive = new Set([otherBroker, self]);
    await mkdir(join(data, "agents", AGENT, `.staging-${otherBroker}-aaa`), { recursive: true });
    await mkdir(join(data, "agents", AGENT, `.staging-${deadBroker}-bbb`), { recursive: true });
    // This broker's own pid on a leftover is an earlier process's that had it: nothing of this one's yet.
    await mkdir(join(data, "agents", "codex", `.staging-${self}-ccc`), { recursive: true });

    const removed = await cleanStaging(data, { isAlive: (pid) => alive.has(pid), selfPid: self });

    expect(removed.sort()).toEqual(
      [join(data, "agents", AGENT, `.staging-${deadBroker}-bbb`), join(data, "agents", "codex", `.staging-${self}-ccc`)].sort(),
    );
    expect(await list(join(data, "agents", AGENT))).toEqual([`.staging-${otherBroker}-aaa`]);
  });

  it("is quiet when there is no agents folder yet", async () => {
    expect(await cleanStaging(data)).toEqual([]);
  });
});

describe("installAgent with the real npm against a loopback tarball (T532)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  /** A one-package registry-free project: package.json + package-lock.json pointing at 127.0.0.1. */
  async function project(tamper: boolean): Promise<string> {
    const bytes = tarGz({
      "package/package.json": JSON.stringify({
        name: ADAPTER.package,
        version: ADAPTER.version,
        bin: { "claude-agent-acp": "index.js" },
      }),
      "package/index.js": "console.log('adapter');\n",
    });

    server = createServer((_request, response) => response.end(bytes));
    await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/adapter.tgz`;
    const integrity = `sha512-${createHash("sha512").update(tamper ? Buffer.concat([bytes, Buffer.from("x")]) : bytes).digest("base64")}`;

    const manifests = join(root, "manifests");
    await mkdir(join(manifests, AGENT), { recursive: true });
    await writeFile(
      join(manifests, AGENT, "package.json"),
      JSON.stringify({ name: "hallpass-agent-test", private: true, dependencies: { [ADAPTER.package]: url } }),
    );
    await writeFile(
      join(manifests, AGENT, "package-lock.json"),
      JSON.stringify({
        name: "hallpass-agent-test",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "hallpass-agent-test", dependencies: { [ADAPTER.package]: url } },
          [`node_modules/${ADAPTER.package}`]: {
            version: ADAPTER.version,
            resolved: url,
            integrity,
            bin: { "claude-agent-acp": "index.js" },
          },
        },
      }),
    );
    return manifests;
  }

  const real = (manifestsDir: string): InstallPorts => ({
    dataDir: data,
    manifestsDir,
    nodePath: process.execPath,
    // npm retries an integrity failure with back-off (tens of seconds); the test does not wait for that.
    run: (file, args, options) =>
      runCommand(file, args, { ...options, env: { ...process.env, npm_config_fetch_retries: "0" } }),
  });

  it("installs a package whose tarball matches the lockfile integrity", async () => {
    const phases: InstallPhase[] = [];
    const result = await installAgent(AGENT, real(await project(false)), (progress) => phases.push(progress.phase));
    expect(result).toEqual({ ok: true, directory: installedDir() });
    expect(await exists(join(installedDir(), "node_modules", "@agentclientprotocol", "claude-agent-acp", "index.js"))).toBe(true);
    expect(await list(join(data, "agents", AGENT))).toEqual([ADAPTER.version]);
    expect(phases).toEqual(["preparing", "downloading", "finishing"]);
  }, 90_000);

  it("leaves no folder, staging included, when the lockfile integrity is tampered", async () => {
    const result = await installAgent(AGENT, real(await project(true)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("install-failed");
    expect(result.error.detail).toMatch(/EINTEGRITY|integrity/i);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  }, 90_000);
});
