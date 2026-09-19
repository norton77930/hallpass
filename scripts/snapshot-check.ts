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
 * The forbidden strings are assembled from parts so this file does not match itself, and the
 * allow-list file is exempt from the pattern scan because it names what it allows.
 *
 * Run it in the private repository (where the export-ignore set does the work) and in the public
 * one (where the private set is simply absent and the scan keeps guarding future commits).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(import.meta.dirname, "..");

/** Paths (posix, relative to the archive root) that must not be in the snapshot. Glob-lite: `**` and `*`. */
export const FORBIDDEN_PATHS = [
  "docs/reference-*.md",
  "tests/acceptance/probe-004/reports/**",
  ".specify/**",
  ".claude/**",
  ".agents/**",
  "CLAUDE-CODE-HANDOFF.md",
  ".mcp.json",
  ".scratch/**",
  "tests/acceptance/*checkpoint*.md",
  "tests/acceptance/owner-remaining-runbook.md",
  "tests/acceptance/local-run-checklist.md",
  "tests/acceptance/evidence-index.md",
  "tests/acceptance/browser-matrix.md",
] as const;

const part = (...pieces: string[]): string => pieces.join("");

/** Strings that must not appear in any published file. Built from parts (see the header). */
export const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "maintainer account name", pattern: new RegExp(part("NORTON", "\\.", "DENG"), "i") },
  /** The 8.3 short form Windows gives the account (`…~1.DEN` in `%TEMP%`) names it just as well. */
  { label: "maintainer account name (8.3)", pattern: new RegExp(part("NORT", "ON[~.]"), "i") },
  { label: "maintainer home path", pattern: new RegExp(part("Users[\\\\/]+", "NORTON"), "i") },
  { label: "private checkout path", pattern: new RegExp(part("OSS[\\\\/]+", "Chorme", "[ %]"), "i") },
  { label: "private checkout folder", pattern: new RegExp(part("Chor", "me Extension")) },
  { label: "reference extension id (a)", pattern: new RegExp(part("fcoeoabgfenejglb", "ffodgkkbkcdhcgfn")) },
  { label: "reference extension id (b)", pattern: new RegExp(part("hehggadaopoacecd", "llhhajmbjkdcmajg")) },
  { label: "reference bundle build hash", pattern: new RegExp(part("5715ccdf21171a4f", "05bd164ff384f78deade3568")) },
  { label: "legacy identifier", pattern: new RegExp(part("\\bp", "oc\\b|@p", "oc/|p", "oc-|com\\.p", "oc\\.|PO", "C_")) },
];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".txt",
  ".ps1", ".cmd", ".toml", ".xml", ".svg", "", ".gitattributes", ".gitignore", ".editorconfig",
  ".npmrc", ".nvmrc",
]);

export type Hit = { path: string; line: number; label: string; excerpt: string };

export type SnapshotReport = {
  archivedFiles: number;
  forbiddenPaths: string[];
  patternHits: Hit[];
  allowed: number;
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

export function scanArchive(archiveRoot: string, allow: Array<{ path: string; contains: string }>): SnapshotReport {
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
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (!pattern.test(text)) continue;
        // Label-aware: the quoted text must itself carry what this pattern looks for, so an entry
        // written for a legacy identifier cannot cover a maintainer path that lands on the same line.
        const isAllowed = allow.some((entry) => entry.path === rel && text.includes(entry.contains) && pattern.test(entry.contains));
        if (isAllowed) allowed += 1;
        else patternHits.push({ path: rel, line: index + 1, label, excerpt: text.trim().slice(0, 120) });
      }
    });
  }
  return { archivedFiles: files.length, forbiddenPaths, patternHits, allowed };
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
    return scanArchive(tree, loadAllowList(repoRoot));
  } finally {
    rmSync(resolve(tree, ".."), { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = runSnapshotCheck(process.argv[2]);
  process.stdout.write(`snapshot: ${report.archivedFiles} files, ${report.forbiddenPaths.length} forbidden paths, ${report.patternHits.length} pattern hits (${report.allowed} allowed)\n`);
  for (const path of report.forbiddenPaths) process.stdout.write(`  PATH ${path}\n`);
  for (const hit of report.patternHits) process.stdout.write(`  ${hit.label}: ${hit.path}:${hit.line}: ${hit.excerpt}\n`);
  process.exitCode = report.forbiddenPaths.length === 0 && report.patternHits.length === 0 ? 0 : 1;
}
