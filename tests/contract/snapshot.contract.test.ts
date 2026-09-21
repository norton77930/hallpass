import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_PATHS, isForbiddenPath, loadAllowList, repoRoot, runSnapshotCheck } from "../../scripts/snapshot-check.js";

/**
 * 009/T248 — nothing private leaves the repository (FR-128, FR-129, R-148).
 *
 * The check archives the staged tree — what the next commit will carry — through `git archive`,
 * which honours `.gitattributes`' `export-ignore` set, then asks the archive whether any private
 * path survived and whether any file names the maintainer, the private checkout, a reference
 * extension or a legacy product identifier outside `scripts/snapshot-allowlist.txt`.
 */

describe("T248 the snapshot carries nothing private", () => {
  const report = runSnapshotCheck();

  it("excludes every private path from the archive", () => {
    expect(report.archivedFiles).toBeGreaterThan(0);
    expect(report.forbiddenPaths, `private paths in the archive:\n${report.forbiddenPaths.join("\n")}`).toEqual([]);
  });

  it("carries no forbidden string outside the allow-list", () => {
    const listed = report.patternHits.map((hit) => `${hit.label}: ${hit.path}:${hit.line}: ${hit.excerpt}`).join("\n");
    expect(report.patternHits, `forbidden strings in the archive:\n${listed}`).toEqual([]);
  });
});

describe("T248 the path rule reads the private set", () => {
  it("matches the private paths", () => {
    expect(isForbiddenPath("docs/reference-anything.md")).toBe(true);
    expect(isForbiddenPath("tests/acceptance/probe-004/reports/run-1.json")).toBe(true);
    expect(isForbiddenPath(".claude/scheduled_tasks.lock")).toBe(true);
    expect(isForbiddenPath(".claude/settings.local.json")).toBe(true);
    expect(isForbiddenPath(".claude/worktrees/x/package.json")).toBe(true);
    expect(isForbiddenPath(".mcp.json")).toBe(true);
    expect(isForbiddenPath("tests/acceptance/us1-checkpoint.md")).toBe(true);
  });

  it("leaves the published paths alone", () => {
    expect(isForbiddenPath("docs/design-notes.md")).toBe(false);
    expect(isForbiddenPath("tests/acceptance/probe-004/scenarios.test.ts")).toBe(false);
    expect(isForbiddenPath("scripts/snapshot-check.ts")).toBe(false);
    expect(isForbiddenPath("package.json")).toBe(false);
    // R-149 (owner, 2026-09-21): the speckit tooling ships so the workflow runs in the public repository.
    expect(isForbiddenPath(".specify/memory/constitution.md")).toBe(false);
    expect(isForbiddenPath(".claude/skills/speckit-plan/SKILL.md")).toBe(false);
    expect(isForbiddenPath(".agents/skills/speckit-plan/SKILL.md")).toBe(false);
  });
});

describe("T248 the allow-list is file-and-substring, never a wildcard", () => {
  const entries = loadAllowList(repoRoot);

  it("parses every entry into a path and a substring", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.path, `${entry.path} is a concrete file path`).not.toMatch(/[*?]/);
      expect(entry.contains.length, `${entry.path} names the text it allows`).toBeGreaterThan(0);
    }
  });

  it("refuses an entry that names no text, because that is a wildcard by another name", () => {
    const roots: string[] = [];
    const write = (body: string): string => {
      const root = mkdtempSync(join(tmpdir(), "hallpass-allowlist-"));
      roots.push(root);
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts/snapshot-allowlist.txt"), body, "utf8");
      return root;
    };
    try {
      expect(() => loadAllowList(write("# reason\nsome/file.md\n"))).toThrow(/not <path>::<substring>/);
      expect(() => loadAllowList(write("some/file.md::\n"))).toThrow(/not <path>::<substring>/);
      expect(loadAllowList(write("# reason\nsome/file.md::a legacy name\n"))).toEqual([{ path: "some/file.md", contains: "a legacy name" }]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T248 the attributes file and the script name the same private set", () => {
  /**
   * Two lists, one truth: `git archive` obeys `.gitattributes` and the script decides what counts as
   * a leak. If they drift, the archive silently carries something the check no longer looks for.
   * `.gitattributes` travels with the snapshot (the public repository archives with the same rules),
   * so a self-exclusion line, if one is ever added, is not counted.
   */
  it("keeps `.gitattributes`' export-ignore set equal to FORBIDDEN_PATHS", () => {
    const exported = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith("export-ignore"))
      .map((line) => line.slice(0, -"export-ignore".length).trim())
      .filter((path) => path !== ".gitattributes");

    expect([...exported].sort()).toEqual([...FORBIDDEN_PATHS].sort());
  });
});
