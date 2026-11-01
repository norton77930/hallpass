import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run publish:snapshot -- <public checkout> [--push]` — one release into the public repository
 * (009/FR-128, as practised since 0.3.0: development stays in the private repository, the public one
 * takes one commit per release).
 *
 * In order, stopping at the first failure:
 * 1. the private checkout has no uncommitted change (the snapshot is `HEAD`, nothing else);
 * 2. `npm run snapshot:check` passes on `HEAD`;
 * 3. the host and extension versions agree, and give the release name `Hallpass <version>`;
 * 4. the public checkout is a clean `main`, fast-forwarded to its remote;
 * 5. its tracked files are replaced by `git archive HEAD` of the private one and exactly those files
 *    are staged (untracked and ignored files there, such as `node_modules` or a stray note, are left
 *    alone and never published), committed as `Hallpass <version>` and tagged `v<version>`;
 * 6. with `--push` only: `main` and the tag are pushed. Without it the commands are printed.
 *
 * The public checkout's path is an argument (or HALLPASS_PUBLIC_CHECKOUT): a local path must never be
 * written into a tracked file (the snapshot check fails on it).
 *
 * This file imports nothing from the repository itself: it runs under `--experimental-strip-types`,
 * which cannot resolve a sibling `.ts` through a `.js` specifier.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PublishOptions {
  privateRoot: string;
  publicRoot: string;
  push: boolean;
  /** Runs the snapshot check on the private checkout; throws when it fails. Tests replace it. */
  check?: (privateRoot: string) => void;
  log?: (line: string) => void;
}

export type PublishOutcome = { published: true; version: string; commit: string } | { published: false; version: string; reason: "unchanged" };

export class PublishRefused extends Error {}

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** bsdtar on Windows (the Git Bash `tar` mangles paths), as `snapshot-check.ts` does. */
function systemTar(): string {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(tar) ? tar : "tar";
}

/** The release version: the host's SERVER_VERSION, which a contract test pins to the extension's. */
export function releaseVersion(privateRoot: string): string {
  const read = (path: string, name: string): string => {
    const match = new RegExp(`export const ${name} = "([^"]+)"`).exec(readFileSync(join(privateRoot, path), "utf8"));
    if (match === null) throw new PublishRefused(`${name} not found in ${path}`);
    return match[1]!;
  };
  const host = read("packages/agent-host/src/tool-offering.ts", "SERVER_VERSION");
  const extension = read("apps/extension/src/build-config.ts", "AGENT_EXTENSION_VERSION");
  if (host !== extension) throw new PublishRefused(`host ${host} and extension ${extension} disagree`);
  return host;
}

function runSnapshotCheck(privateRoot: string): void {
  execFileSync(process.execPath, ["--experimental-strip-types", join(privateRoot, "scripts", "snapshot-check.ts"), "HEAD"], {
    cwd: privateRoot,
    stdio: "inherit",
  });
}

/**
 * The extracted files carry no exec bit on Windows (tar cannot set it, core.filemode is false), so the
 * public index takes each regular file's mode from the private HEAD: 100755 or 100644, wherever the
 * public index differs (a file that lost its bit privately loses it publicly). Only files that were
 * staged are touched; symlinks and other modes are left alone.
 *
 * The entries go through `update-index --index-info`, with the blob the add just staged, and not through
 * `--chmod`: `--chmod` re-hashes the path from the work tree on Linux, without the add's
 * `core.autocrlf=input`, and would commit a CRLF file as CRLF. `--index-info` never reads the work tree,
 * so the add's LF normalisation stands.
 */
function mirrorFileModes(privateRoot: string, publicRoot: string, staged: ReadonlySet<string>): void {
  const privateModes = new Map<string, string>();
  for (const entry of git(privateRoot, ["ls-tree", "-r", "-z", "HEAD"]).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const mode = entry.slice(0, entry.indexOf(" "));
    if (mode === "100755" || mode === "100644") privateModes.set(entry.slice(tab + 1), mode);
  }
  // `git()` trims, which would eat a leading/trailing byte of the NUL-separated list: read it raw.
  const publicIndex = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: publicRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let infos = "";
  for (const entry of publicIndex.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const wanted = privateModes.get(path);
    if (!staged.has(path) || wanted === undefined || mode === wanted) continue;
    if (mode !== "100755" && mode !== "100644") continue;
    infos += `${wanted} ${sha}\t${path}\0`;
  }
  if (infos === "") return;
  execFileSync("git", ["update-index", "-z", "--index-info"], { cwd: publicRoot, input: infos, stdio: ["pipe", "pipe", "pipe"] });
}

export function publishSnapshot(options: PublishOptions): PublishOutcome {
  const { privateRoot, publicRoot, push } = options;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (git(privateRoot, ["status", "--porcelain"]) !== "") throw new PublishRefused("the private checkout has uncommitted changes; commit or stash them first");
  (options.check ?? runSnapshotCheck)(privateRoot);
  const version = releaseVersion(privateRoot);
  const tag = `v${version}`;

  if (!existsSync(join(publicRoot, ".git"))) throw new PublishRefused(`${publicRoot} is not a git checkout`);
  if (git(publicRoot, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new PublishRefused("the public checkout has uncommitted changes");
  if (git(publicRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") throw new PublishRefused("the public checkout is not on main");
  if (git(publicRoot, ["tag", "--list", tag]) !== "") throw new PublishRefused(`the public checkout already has ${tag}`);
  if (git(publicRoot, ["remote"]) !== "") {
    git(publicRoot, ["fetch", "--quiet", "origin", "main"]);
    git(publicRoot, ["merge", "--ff-only", "--quiet", "origin/main"]);
  }

  const scratch = mkdtempSync(join(tmpdir(), "hallpass-publish-"));
  try {
    const tarPath = join(scratch, "snapshot.tar");
    git(privateRoot, ["archive", "--format=tar", "-o", tarPath, "HEAD"]);
    if (git(publicRoot, ["ls-files"]) !== "") git(publicRoot, ["rm", "-r", "-q", "--", "."]);
    mkdirSync(publicRoot, { recursive: true });
    execFileSync(systemTar(), ["-xf", tarPath, "-C", publicRoot], { stdio: "pipe" });
    // Exactly the archive's files are staged: a stray untracked file in the public checkout never is.
    const listed = execFileSync(systemTar(), ["-tf", tarPath], { encoding: "utf8" }).split(/\r?\n/u).filter((path) => path !== "" && !path.endsWith("/"));
    const pathspec = join(scratch, "files.txt");
    writeFileSync(pathspec, listed.join("\n"));
    // The public tree holds LF: the files a Windows checkout stores as CRLF are normalised on any machine.
    git(publicRoot, ["-c", "core.autocrlf=input", "-c", "core.safecrlf=false", "add", "--force", `--pathspec-from-file=${pathspec}`]);
    mirrorFileModes(privateRoot, publicRoot, new Set(listed));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const changed = git(publicRoot, ["diff", "--cached", "--name-only"]) !== "";
  if (changed) git(publicRoot, ["commit", "-q", "-m", `Hallpass ${version}`]);
  // The extracted files may differ from the commit only in line endings: the checkout ends on it.
  git(publicRoot, ["reset", "-q", "--hard", "HEAD"]);
  if (!changed) {
    log(`Hallpass ${version}: the public tree already matches; nothing to publish.`);
    return { published: false, version, reason: "unchanged" };
  }
  git(publicRoot, ["tag", tag]);
  const commit = git(publicRoot, ["rev-parse", "--short", "HEAD"]);
  log(`Hallpass ${version}: committed ${commit} and tagged ${tag} in the public checkout.`);

  if (push) {
    git(publicRoot, ["push", "origin", "main", tag]);
    log(`Pushed main and ${tag}.`);
  } else {
    log("Review it, then push:");
    log(`  git -C "${publicRoot}" push origin main ${tag}`);
  }
  log(`Release: npm run package, then  gh release create ${tag} release/hallpass-${version}.zip --repo <owner>/hallpass --title "Hallpass ${version}"`);
  return { published: true, version, commit };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const publicRoot = args.find((arg) => !arg.startsWith("--")) ?? process.env.HALLPASS_PUBLIC_CHECKOUT;
  if (publicRoot === undefined) {
    process.stderr.write("usage: npm run publish:snapshot -- <public checkout> [--push]   (or set HALLPASS_PUBLIC_CHECKOUT)\n");
    process.exit(2);
  }
  try {
    publishSnapshot({ privateRoot: repoRoot, publicRoot: resolve(publicRoot), push: args.includes("--push") });
  } catch (error) {
    process.stderr.write(`publish:snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
