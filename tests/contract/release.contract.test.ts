import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_MANIFEST_FILES,
  checksumLine,
  KOFFI_PACKAGE_FILES,
  KOFFI_WIN32_X64_NODE_SHA256,
  repoRoot,
  stageHostRuntime,
} from "../../scripts/package.js";

/**
 * Issue #38 - the release zip is built by a workflow, not on a laptop, and a download can be checked.
 *
 * Until now `npm run package` ran wherever the maintainer ran it, copied `koffi.node` from whatever
 * `node_modules` held, and the zip went up by hand with nothing beside it to compare against. Three
 * facts are pinned here: the tag-triggered workflow exists with the least permissions that can
 * publish a release and attest it; the native binary the zip carries is the one the lockfile named,
 * by digest, or nothing is packaged; and a checksum file is written beside the zip.
 */

const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

describe("#38 the release workflow", () => {
  const workflow = read(".github/workflows/release.yml");
  const steps = [...workflow.matchAll(/^\s*-?\s*run: +\|?\s*(.+?)\s*$/gm)].map((match) => match[1] ?? "");

  it("runs on a version tag, on Windows, and nowhere else", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*- +["']?v\*/);
    expect(workflow).not.toMatch(/pull_request/);
    expect(workflow).toMatch(/runs-on: +windows-latest/);
  });

  it("asks for exactly the permissions a release with provenance needs", () => {
    expect(workflow).toMatch(/permissions:\s*\n(?:\s+\S+: +\S+\n)*\s+contents: +write/);
    expect(workflow).toMatch(/id-token: +write/);
    expect(workflow).toMatch(/attestations: +write/);
    // Nothing wider: no `write-all`, no packages, no pull requests.
    expect(workflow).not.toMatch(/write-all|packages: +write|pull-requests: +write/);
  });

  it("builds through the same gates CI runs, packages, checks the tag against the version, attests and uploads", () => {
    for (const command of ["npm ci", "npm run typecheck", "npm test", "npm run package"]) {
      expect(steps.some((step) => step.startsWith(command)), `no step runs ${command}`).toBe(true);
    }
    expect(workflow).toContain("VERSION");
    expect(workflow).toMatch(/actions\/attest-build-provenance@/);
    expect(workflow).toMatch(/gh release create/);
    expect(workflow).toMatch(/\.sha256/);
    // The zip and its checksum, from the one `release/` directory the package script writes.
    expect(workflow).toMatch(/release\/hallpass-/);
  });

  it("uses no secret beyond the workflow's own token", () => {
    expect(workflow.match(/secrets\.[A-Z_]+/g) ?? []).toEqual(expect.arrayContaining([]));
    for (const name of workflow.match(/secrets\.([A-Z_]+)/g) ?? []) expect(name).toBe("secrets.GITHUB_TOKEN");
  });
});

describe("#38 CI and dependency hygiene", () => {
  it("CI holds a read-only token", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^permissions:\s*\n\s+contents: +read/m);
  });

  it("Dependabot watches npm and the actions, and leaves the pinned adapter manifests alone", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toMatch(/package-ecosystem: +["']?npm/);
    expect(dependabot).toMatch(/package-ecosystem: +["']?github-actions/);
    // The adapter lockfiles under packages/agent-host/agents are what the broker installs for the
    // owner; a bot must not move them (019 R-314).
    expect(dependabot).not.toMatch(/directory: .*agents/);
  });
});

describe("#38 the native binary is the one the lockfile named", () => {
  it("pins the digest of koffi's win32-x64 binary, matching the lockfile's version", () => {
    expect(KOFFI_WIN32_X64_NODE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string }> };
    expect(lock.packages["node_modules/@koromix/koffi-win32-x64"]?.version).toBe("3.3.6");
  });

  it("refuses to stage a koffi.node whose digest is not the pinned one, and stages the right one", () => {
    const root = mkdtempSync(join(tmpdir(), "hallpass-stage-"));
    try {
      const nodeModules = join(root, "node_modules");
      for (const file of KOFFI_PACKAGE_FILES) {
        const target = join(nodeModules, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.endsWith(".node") ? "not the binary" : "// stand-in");
      }
      const agents = join(root, "agents");
      for (const agent of ["claude-code", "codex", "deepseek"]) {
        for (const file of AGENT_MANIFEST_FILES) {
          mkdirSync(join(agents, agent), { recursive: true });
          writeFileSync(join(agents, agent, file), "{}");
        }
      }
      const hostDir = join(root, "host");
      expect(() => stageHostRuntime(hostDir, { nodeModules, agents })).toThrow(/koffi\.node.*digest/u);
      expect(existsSync(join(hostDir, "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node"))).toBe(false);

      // A binary with the pinned digest stages; the digest is checked, not the name.
      const genuine = Buffer.from("the binary the lockfile named");
      const pinned = createHash("sha256").update(genuine).digest("hex");
      writeFileSync(join(nodeModules, "@koromix/koffi-win32-x64/win32_x64/koffi.node"), genuine);
      const staged = stageHostRuntime(hostDir, { nodeModules, agents, koffiNodeSha256: pinned });
      expect(staged).toContain("node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a checksum line in the sha256sum format, naming the zip by its base name alone", () => {
    const root = mkdtempSync(join(tmpdir(), "hallpass-sum-"));
    try {
      const zip = join(root, "hallpass-9.9.9.zip");
      writeFileSync(zip, "zip bytes");
      const line = checksumLine(zip);
      expect(line).toBe(`${createHash("sha256").update("zip bytes").digest("hex")}  hallpass-9.9.9.zip\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
