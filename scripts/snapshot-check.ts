/**
 * `npm run snapshot:check` — what leaves this repository when it is published (009/FR-128, FR-129).
 *
 * The public snapshot is `git archive`, which honours the `export-ignore` attributes in
 * `.gitattributes`. This script produces that archive into a temp directory and then asks two
 * questions of it: does any *path* that must stay private appear, and does any *file* carry a
 * string that must never be published — the maintainer's account name and checkout path, the
 * store identifiers and build hash of the third-party extensions that were studied, and the
 * product's pre-release identifiers. Hits outside `scripts/snapshot-allowlist.txt` fail the run.
 *
 * The default ref is the *staged index* (`git write-tree`), i.e. exactly the tree the next commit
 * will carry, so the check sees work that is staged but not yet committed — including files that
 * were removed from the index with `git rm --cached` but still sit on disk. Pass a ref to look at
 * something else: `npm run snapshot:check HEAD`, `… main`, `… <sha>`.
 *
 * Three kinds of forbidden string, kept apart by how much they would disclose (security review
 * 2026-11-05 S9 - an earlier version held every private literal in this public file, split in halves
 * that a reader simply joined back together):
 *
 * - `FORBIDDEN_PATTERNS`, in this file: generic shapes that name nothing private (the product's
 *   pre-release identifiers).
 * - `FORBIDDEN_DIGESTS`, in this file: SHA-256 of a high-entropy literal (a store id, a build hash),
 *   matched against every long alphanumeric run of each line. A digest of such a literal gives
 *   nothing away; a digest of a *name* would be a dictionary lookup, so names do not go here.
 * - `scripts/snapshot-private-patterns.json`, export-ignored and read only when present: the
 *   maintainer's account name and checkout path, as `{ "patterns": [{ "label", "pattern", "flags"? }] }`.
 *   The public snapshot has no such file and loads none - which is the point - and the run says how
 *   many it loaded so a private checkout missing the file is noticed.
 *
 * The allow-list file is exempt from the pattern scan because it names what it allows.
 *
 * Run it in the private repository (where the export-ignore set does the work) and in the public
 * one (where the private set is simply absent and the scan keeps guarding future commits).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(import.meta.dirname, "..");

/** Paths (posix, relative to the archive root) that must not be in the snapshot. Glob-lite: `**` and `*`. */
export const FORBIDDEN_PATHS = [
  "docs/reference-*.md",
  "tests/acceptance/probe-004/reports/**",
  "tests/acceptance/probe-017/reports/**",
  ".claude/scheduled_tasks.lock",
  ".claude/settings*.json",
  ".claude/worktrees/**",
  "CLAUDE-CODE-HANDOFF.md",
  ".mcp.json",
  ".scratch/**",
  "tests/acceptance/*checkpoint*.md",
  "tests/acceptance/owner-remaining-runbook.md",
  "tests/acceptance/local-run-checklist.md",
  "tests/acceptance/evidence-index.md",
  "tests/acceptance/browser-matrix.md",
  "scripts/snapshot-private-patterns.json",
] as const;

/** Where the private patterns live; export-ignored, so the public snapshot never carries it. */
export const PRIVATE_PATTERNS_FILE = "scripts/snapshot-private-patterns.json";

const part = (...pieces: string[]): string => pieces.join("");

export type ForbiddenPattern = { label: string; pattern: RegExp };

/**
 * Generic shapes that must not appear in any published file and name nothing private themselves:
 * the product's pre-release identifiers. Built from parts only so this file does not match itself.
 */
export const FORBIDDEN_PATTERNS: ReadonlyArray<ForbiddenPattern> = [
  { label: "legacy identifier", pattern: new RegExp(part("\\bp", "oc\\b|@p", "oc/|p", "oc-|com\\.p", "oc\\.|PO", "C_")) },
];

export type ForbiddenDigest = { label: string; sha256: string };

/**
 * High-entropy literals, by digest: the store identifiers of the two reference extensions and the
 * build hash of the reference bundle (the clean-room notes deliberately name neither). A line is
 * lower-cased and every alphanumeric run of `DIGEST_RUN_MIN_CHARS` or more is hashed and looked up.
 */
export const FORBIDDEN_DIGESTS: ReadonlyArray<ForbiddenDigest> = [
  { label: "reference extension id (a)", sha256: "34e72c1bdcbb0cd044b7367f6c8c2cc0e9e069396efb333f923d8de9ed87f32e" },
  { label: "reference extension id (b)", sha256: "035f38b3a933fb3e4559e412617f55cf14f80ebf613e2e6282b09842a111cd0b" },
  { label: "reference bundle build hash", sha256: "fd26aa68471f355864a8dfbc5b6b014db174f2112713e67981fba5e2b8bdf37a" },
];

/** The shortest run worth hashing: a store id is 32 characters, a build hash 40. */
export const DIGEST_RUN_MIN_CHARS = 32;

const DIGEST_RUN = /[a-z0-9]{32,}/g;

export function digestOf(token: string): string {
  return createHash("sha256").update(token.toLowerCase()).digest("hex");
}

/** The digest labels a line trips, if any. */
export function digestHits(line: string, digests: ReadonlyArray<ForbiddenDigest> = FORBIDDEN_DIGESTS): string[] {
  const hits: string[] = [];
  for (const run of line.toLowerCase().match(DIGEST_RUN) ?? []) {
    const digest = digestOf(run);
    for (const entry of digests) if (entry.sha256 === digest && !hits.includes(entry.label)) hits.push(entry.label);
  }
  return hits;
}

/**
 * The private patterns, from the export-ignored file when it is there; none when it is not.
 *
 * A file that is present but not of the shape is an error, never "no patterns": a maintainer who
 * wrote the file meant it to be read, and a silent empty set is the one failure this check exists to
 * prevent.
 */
export function loadPrivatePatterns(root: string): ForbiddenPattern[] {
  const file = resolve(root, PRIVATE_PATTERNS_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { patterns?: unknown };
  if (!parsed || !Array.isArray(parsed.patterns)) {
    throw new Error(`${PRIVATE_PATTERNS_FILE}: expected { "patterns": [{ "label", "pattern", "flags"? }] }`);
  }
  return parsed.patterns.map((entry: unknown, index: number) => {
    const { label, pattern, flags } = (entry ?? {}) as { label?: unknown; pattern?: unknown; flags?: unknown };
    if (typeof label !== "string" || label === "" || typeof pattern !== "string" || pattern === "") {
      throw new Error(`${PRIVATE_PATTERNS_FILE}: pattern ${index} needs a non-empty "label" and "pattern"`);
    }
    return { label, pattern: new RegExp(pattern, typeof flags === "string" ? flags : "") };
  });
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".txt",
  ".ps1", ".psm1", ".cmd", ".sh", ".bash", ".zsh", ".toml", ".xml", ".svg", "", ".gitattributes", ".gitignore", ".editorconfig",
  ".npmrc", ".nvmrc",
]);

export type Hit = { path: string; line: number; label: string; excerpt: string };

export type SnapshotReport = {
  archivedFiles: number;
  forbiddenPaths: string[];
  patternHits: Hit[];
  allowed: number;
  /** How many patterns came from the private file: 0 in the public snapshot, by design. */
  privatePatterns: number;
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("**")
    .map((segment) => segment.split("*").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function isForbiddenPath(posixPath: string): boolean {
  return FORBIDDEN_PATHS.some((glob) => globToRegExp(glob).test(posixPath));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? (base.startsWith(".") ? base : "") : base.slice(dot);
}

/**
 * `path::substring` per line; a hit is allowed when its path matches, its line contains the
 * substring, and the substring itself trips the very pattern that produced the hit.
 *
 * A line with no `::`, or with an empty path or substring, is refused rather than read as "allow
 * this whole file": an entry that names no text is a wildcard, and a wildcard cannot be audited.
 */
export function loadAllowList(root: string): Array<{ path: string; contains: string }> {
  const file = resolve(root, "scripts/snapshot-allowlist.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("::");
      const entry = { path: line.slice(0, at), contains: line.slice(at + 2) };
      if (at === -1 || entry.path === "" || entry.contains === "") {
        throw new Error(`snapshot allow-list: "${line}" is not <path>::<substring> with both parts filled in.`);
      }
      return entry;
    });
}

export function scanArchive(
  archiveRoot: string,
  allow: Array<{ path: string; contains: string }>,
  rules: { patterns?: ReadonlyArray<ForbiddenPattern>; privatePatterns?: ReadonlyArray<ForbiddenPattern>; digests?: ReadonlyArray<ForbiddenDigest> } = {},
): SnapshotReport {
  const privatePatterns = rules.privatePatterns ?? [];
  const patterns = [...(rules.patterns ?? FORBIDDEN_PATTERNS), ...privatePatterns];
  const digests = rules.digests ?? FORBIDDEN_DIGESTS;
  const files = walk(archiveRoot);
  const forbiddenPaths: string[] = [];
  const patternHits: Hit[] = [];
  let allowed = 0;
  for (const file of files) {
    const rel = relative(archiveRoot, file).split(sep).join("/");
    if (isForbiddenPath(rel)) forbiddenPaths.push(rel);
    if (rel === "scripts/snapshot-allowlist.txt") continue;
    if (!TEXT_EXTENSIONS.has(extensionOf(file))) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      // A digest hit has no allow-list: nothing published ever needs to spell one of these.
      for (const label of digestHits(text, digests)) patternHits.push({ path: rel, line: index + 1, label, excerpt: text.trim().slice(0, 120) });
      for (const { label, pattern } of patterns) {
        if (!pattern.test(text)) continue;
        // Label-aware: the quoted text must itself carry what this pattern looks for, so an entry
        // written for a legacy identifier cannot cover a maintainer path that lands on the same line.
        const isAllowed = allow.some((entry) => entry.path === rel && text.includes(entry.contains) && pattern.test(entry.contains));
        if (isAllowed) allowed += 1;
        else patternHits.push({ path: rel, line: index + 1, label, excerpt: text.trim().slice(0, 120) });
      }
    });
  }
  return { archivedFiles: files.length, forbiddenPaths, patternHits, allowed, privatePatterns: privatePatterns.length };
}

/** The tree the next commit will carry. `git archive` reads `.gitattributes` from the tree it archives. */
export function stagedTree(): string {
  return execFileSync("git", ["write-tree"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** bsdtar, the same one `tests/acceptance/upgrade-proof.mjs` uses; the Git Bash `tar` mangles paths. */
function systemTar(): string {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(tar) ? tar : "tar";
}

/** Produces the archive of `ref` into a fresh temp directory and returns its path. Caller removes it. */
export function produceArchive(ref: string = stagedTree()): string {
  const dir = mkdtempSync(join(tmpdir(), "hallpass-snapshot-"));
  try {
    const tarPath = join(dir, "snapshot.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", tarPath, ref], { cwd: repoRoot, stdio: "pipe" });
    const tree = join(dir, "tree");
    mkdirSync(tree, { recursive: true });
    execFileSync(systemTar(), ["-xf", tarPath, "-C", tree], { stdio: "pipe" });
    return tree;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function runSnapshotCheck(ref?: string): SnapshotReport {
  const tree = produceArchive(ref);
  try {
    return scanArchive(tree, loadAllowList(repoRoot), { privatePatterns: loadPrivatePatterns(repoRoot) });
  } finally {
    rmSync(resolve(tree, ".."), { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = runSnapshotCheck(process.argv[2]);
  process.stdout.write(
    `snapshot: ${report.archivedFiles} files, ${report.forbiddenPaths.length} forbidden paths, ${report.patternHits.length} pattern hits (${report.allowed} allowed), ${report.privatePatterns} private patterns loaded\n`,
  );
  for (const path of report.forbiddenPaths) process.stdout.write(`  PATH ${path}\n`);
  for (const hit of report.patternHits) process.stdout.write(`  ${hit.label}: ${hit.path}:${hit.line}: ${hit.excerpt}\n`);
  process.exitCode = report.forbiddenPaths.length === 0 && report.patternHits.length === 0 ? 0 : 1;
}
