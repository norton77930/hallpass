import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublishRefused, publishSnapshot } from "../../scripts/publish-snapshot.js";

/**
 * `npm run publish:snapshot` (009/FR-128 as practised): the public checkout's tracked files become
 * `git archive HEAD` of the private one - `export-ignore` honoured, files gone from the private tree
 * gone from the public one, untracked files left alone - in one `Hallpass <version>` commit and tag.
 * Two throwaway repositories stand in for the checkouts; nothing is pushed.
 */

let root: string;
let privateRoot: string;
let publicRoot: string;
const quiet = () => undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function write(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const versions = (host: string, extension = host) => ({
  "packages/agent-host/src/tool-offering.ts": `export const SERVER_VERSION = "${host}";\n`,
  "apps/extension/src/build-config.ts": `export const AGENT_EXTENSION_VERSION = "${extension}";\n`,
});

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

const publish = (push = false) => publishSnapshot({ privateRoot, publicRoot, push, check: quiet, log: quiet });

/** Each test spawns a dozen or more git processes; on a busy Windows machine that passes 15 s. */
const SLOW_GIT_MS = 120_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hallpass-publish-test-"));
  privateRoot = join(root, "private");
  publicRoot = join(root, "public");
  for (const dir of [privateRoot, publicRoot]) {
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
  }
  write(privateRoot, {
    ...versions("1.2.3"),
    ".gitattributes": "notes-private.md export-ignore\n",
    "README.md": "new\n",
    "notes-private.md": "private\n",
    // Stored with CRLF, as some files of a Windows checkout are.
    "windows.txt": "one\r\ntwo\r\n",
  });
  git(privateRoot, "config", "core.autocrlf", "false");
  commitAll(privateRoot, "work");
  write(publicRoot, { "README.md": "old\n", "removed-since.md": "gone in the next release\n" });
  commitAll(publicRoot, "Hallpass 1.2.2");
  write(publicRoot, { "node_modules/kept.js": "untracked\n", "stray-note.md": "untracked, not ignored\n" });
  // The test identity is passed per command; the script's own commit needs one from the environment.
  git(publicRoot, "config", "user.name", "Test");
  git(publicRoot, "config", "user.email", "test@example.invalid");
  git(publicRoot, "config", "commit.gpgsign", "false");
  git(publicRoot, "config", "tag.gpgsign", "false");
}, SLOW_GIT_MS);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publish:snapshot", { timeout: SLOW_GIT_MS }, () => {
  it("one Hallpass <version> commit and tag: the archive of HEAD, export-ignore honoured, removals carried, untracked files kept", () => {
    const outcome = publish();
    expect(outcome).toMatchObject({ published: true, version: "1.2.3" });
    expect(git(publicRoot, "log", "-1", "--format=%s")).toBe("Hallpass 1.2.3");
    expect(git(publicRoot, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(publicRoot, "tag", "--list")).toBe("v1.2.3");
    expect(git(publicRoot, "ls-files").split("\n").sort()).toEqual([
      ".gitattributes",
      "README.md",
      "apps/extension/src/build-config.ts",
      "packages/agent-host/src/tool-offering.ts",
      "windows.txt",
    ]);
    // The public tree holds LF whatever the machine's own setting.
    expect(git(publicRoot, "show", "HEAD:windows.txt")).toBe("one\ntwo");
    expect(existsSync(join(publicRoot, "notes-private.md"))).toBe(false);
    expect(existsSync(join(publicRoot, "removed-since.md"))).toBe(false);
    expect(existsSync(join(publicRoot, "node_modules", "kept.js"))).toBe(true);
    // A stray untracked file stays where it is and is not published.
    expect(git(publicRoot, "status", "--porcelain")).toBe("?? node_modules/\n?? stray-note.md");
  });

  it("mirrors the private file modes: 100755 stays executable and a file no longer executable privately loses the bit", () => {
    // --chmod in the index works whatever core.filemode says, as on a Windows checkout; where
    // core.filemode is true (POSIX) the work tree must carry the same bit or the checkout is dirty.
    write(privateRoot, { "scripts/run.sh": "#!/bin/sh\n", "scripts/plain.sh": "#!/bin/sh\n", "scripts/was-exec.sh": "#!/bin/sh\n" });
    chmodSync(join(privateRoot, "scripts/run.sh"), 0o755);
    git(privateRoot, "add", "-A");
    git(privateRoot, "update-index", "--chmod=+x", "scripts/run.sh");
    git(privateRoot, "commit", "-q", "-m", "scripts");
    write(publicRoot, { "scripts/was-exec.sh": "#!/bin/sh\n" });
    chmodSync(join(publicRoot, "scripts/was-exec.sh"), 0o755);
    git(publicRoot, "add", "-A");
    git(publicRoot, "update-index", "--chmod=+x", "scripts/was-exec.sh");
    git(publicRoot, "commit", "-q", "-m", "earlier release");

    publish();
    const modes = (cwd: string) =>
      Object.fromEntries(git(cwd, "ls-tree", "-r", "HEAD").split("\n").map((line) => [line.split("\t")[1], line.split(" ")[0]]));
    expect(modes(privateRoot)["scripts/run.sh"]).toBe("100755");
    expect(modes(publicRoot)).toMatchObject({ "scripts/run.sh": "100755", "scripts/plain.sh": "100644", "scripts/was-exec.sh": "100644", "README.md": "100644" });
  });

  it("refuses an uncommitted private change, a failed snapshot check, disagreeing versions, a dirty public checkout and an existing tag", () => {
    write(privateRoot, { "README.md": "edited\n" });
    expect(publish).toThrow(/uncommitted changes/u);
    git(privateRoot, "checkout", "--", "README.md");

    expect(() =>
      publishSnapshot({ privateRoot, publicRoot, push: false, log: quiet, check: () => { throw new Error("snapshot: 1 pattern hits"); } }),
    ).toThrow(/pattern hits/u);

    write(privateRoot, versions("1.2.3", "1.2.4"));
    commitAll(privateRoot, "skew");
    expect(publish).toThrow(PublishRefused);
    write(privateRoot, versions("1.2.3"));
    commitAll(privateRoot, "agree");

    write(publicRoot, { "README.md": "edited in public\n" });
    expect(publish).toThrow(/public checkout has uncommitted changes/u);
    git(publicRoot, "checkout", "--", "README.md");

    git(publicRoot, "tag", "v1.2.3");
    expect(publish).toThrow(/already has v1\.2\.3/u);
    // Nothing was committed by any refusal.
    expect(git(publicRoot, "rev-list", "--count", "HEAD")).toBe("1");
  });
});
