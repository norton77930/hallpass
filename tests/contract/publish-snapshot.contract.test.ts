import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publish:snapshot", () => {
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
