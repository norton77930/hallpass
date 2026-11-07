import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestOf,
  FORBIDDEN_DIGESTS,
  FORBIDDEN_PATHS,
  isForbiddenPath,
  loadAllowList,
  loadPrivatePatterns,
  PRIVATE_PATTERNS_FILE,
  repoRoot,
  runSnapshotCheck,
  scanArchive,
} from "../../scripts/snapshot-check.js";

/**
 * 009/T248 — nothing private leaves the repository (FR-128, FR-129, R-148).
 *
 * The check archives the staged tree — what the next commit will carry — through `git archive`,
 * which honours `.gitattributes`' `export-ignore` set, then asks the archive whether any private
 * path survived and whether any file names the maintainer, the private checkout, a reference
 * extension or a legacy product identifier outside `scripts/snapshot-allowlist.txt`.
 */

/** One run for the whole file: a run archives and unpacks the tree, over a minute on a busy Windows machine. */
const report = runSnapshotCheck();

describe("T248 the snapshot carries nothing private", () => {
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
    expect(isForbiddenPath(PRIVATE_PATTERNS_FILE)).toBe(true);
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

/**
 * Security review 2026-11-05 S9 — the check must not itself publish what it keeps private.
 *
 * The script is a mandatory public file. It used to hold every private literal split in halves, which
 * only stopped it matching itself; a reader joined them. High-entropy literals are now digests, and
 * names live in an export-ignored file the public snapshot never carries.
 */
describe("S9 the public check discloses nothing it guards", () => {
  const source = readFileSync(resolve(repoRoot, "scripts/snapshot-check.ts"), "utf8");

  it("carries no store id or build hash, whole or in halves", () => {
    // A store id is 32 letters a-p; a build hash is 40 hex characters. Neither, nor a half of either,
    // appears as a quoted literal. The digests are 64 hex characters and carry digits, so they do not match.
    expect(source).not.toMatch(/"[a-p]{16,}"/);
    expect(source).not.toMatch(/"[0-9a-f]{20,40}"/);
    for (const { sha256 } of FORBIDDEN_DIGESTS) expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("catches a long run whose digest is listed, in any case", () => {
    const root = mkdtempSync(join(tmpdir(), "hallpass-digest-"));
    try {
      const token = "abcdefghijklmnopabcdefghijklmnop";
      writeFileSync(join(root, "note.md"), `see chrome-extension://${token.toUpperCase()}/ for the shape\n`, "utf8");
      writeFileSync(join(root, "clean.md"), "nothing here\n", "utf8");
      const report = scanArchive(root, [], { patterns: [], digests: [{ label: "fixture id", sha256: digestOf(token) }] });
      expect(report.patternHits).toEqual([{ path: "note.md", line: 1, label: "fixture id", excerpt: expect.stringContaining("chrome-extension://") }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the private patterns only from the export-ignored file, and refuses a malformed one", () => {
    const root = mkdtempSync(join(tmpdir(), "hallpass-private-patterns-"));
    try {
      expect(loadPrivatePatterns(root)).toEqual([]);
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, PRIVATE_PATTERNS_FILE), JSON.stringify({ patterns: [{ label: "account", pattern: "some\\.name", flags: "i" }] }), "utf8");
      const [loaded] = loadPrivatePatterns(root);
      expect(loaded?.label).toBe("account");
      expect(loaded?.pattern.test("C:/Users/SOME.NAME/x")).toBe(true);
      expect(loaded?.pattern.test("C:/Users/other/x")).toBe(false);
      writeFileSync(join(root, PRIVATE_PATTERNS_FILE), JSON.stringify({ patterns: [{ label: "" }] }), "utf8");
      expect(() => loadPrivatePatterns(root)).toThrow(/needs a non-empty/);
      writeFileSync(join(root, PRIVATE_PATTERNS_FILE), "{}", "utf8");
      expect(() => loadPrivatePatterns(root)).toThrow(/expected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the private file is in the export-ignore set and the run reports how many patterns it loaded", () => {
    const attributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
    expect(attributes).toContain(`${PRIVATE_PATTERNS_FILE} export-ignore`);
    expect(report.privatePatterns).toBe(loadPrivatePatterns(repoRoot).length);
  });
});
