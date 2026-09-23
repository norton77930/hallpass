import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUploadConfigStore } from "../src/upload-config-store.js";
import { readUploadConfig, uploadConfigPath } from "../src/upload-policy.js";

/**
 * 014/T370 — the one writer of `config.json` (FR-194, contracts/upload-directory.md).
 *
 * The list of directories an upload may come from grows by exactly one route: the owner answering
 * "from now on" on a card the host raised about a file it is already holding. This module is that
 * route's only hands on the file, and the whole point of it being one module is that two processes
 * write here - the server on an `always`, the relay on a revoke - and both have to leave a file the
 * *reader* (`readUploadConfig`, fail-closed) can still parse.
 *
 * So the properties under test are about the file rather than about the list: a candidate is
 * validated before anything is written, a write lands whole or not at all, and a file that was
 * already unreadable is not made wider by being rewritten.
 */

let dataDir = "";
let env: { LOCALAPPDATA: string };
let configPath = "";
let docs = "";
let pictures = "";

beforeEach(async () => {
  // Resolved, because the store stores what `realpath` answers: Windows hands out a temp directory
  // under the short 8.3 spelling of the profile, and a test comparing the two spellings would be
  // testing the operating system rather than the list.
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "hallpass-roots-")));
  env = { LOCALAPPDATA: dataDir };
  configPath = uploadConfigPath(env);
  docs = join(dataDir, "docs");
  pictures = join(dataDir, "pictures");
  await mkdir(docs, { recursive: true });
  await mkdir(pictures, { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<void> {
  await mkdir(join(dataDir, "hallpass"), { recursive: true });
  await writeFile(configPath, content, "utf8");
}

describe("T370 upload config store", () => {
  it("adds the first directory to a file that is not there yet, and says where it lives", async () => {
    const store = createUploadConfigStore(env);

    const change = await store.add([docs]);

    expect(change.written).toBe(true);
    expect(change.refused).toEqual([]);
    expect(change.listing.roots).toEqual([docs]);
    expect(change.listing.path).toBe(configPath);
    expect(change.listing.malformed).toBeUndefined();
    // The file itself, read by the part of the host that decides uploads - not by this module.
    expect(await readUploadConfig(env)).toEqual({ uploadRoots: [docs] });
  });

  it("merges into what is already there and de-duplicates by real path", async () => {
    await writeConfig(JSON.stringify({ "//": "the owner's note", uploadRoots: [docs] }));
    const store = createUploadConfigStore(env);

    const added = await store.add([pictures]);
    expect(added.listing.roots).toEqual([docs, pictures]);

    // The same directory, spelled as a walk through its sibling: one directory, one entry.
    const again = await store.add([join(pictures, "..", "pictures")]);
    expect(again.written).toBe(false);
    expect(again.listing.roots).toEqual([docs, pictures]);

    // The owner's own note survives a write this module made.
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(raw["//"]).toBe("the owner's note");
  });

  it("removes one directory and leaves the rest", async () => {
    await writeConfig(JSON.stringify({ uploadRoots: [docs, pictures] }));
    const store = createUploadConfigStore(env);

    const change = await store.remove(pictures);

    expect(change.written).toBe(true);
    expect(change.listing.roots).toEqual([docs]);
    expect((await readUploadConfig(env)).uploadRoots).toEqual([docs]);

    // A directory that is not on the list is not an error; the answer is simply the list.
    const noop = await store.remove(pictures);
    expect(noop.written).toBe(false);
    expect(noop.listing.roots).toEqual([docs]);
  });

  it("refuses a relative path, a directory that is not there, and a file - and writes nothing", async () => {
    await writeConfig(JSON.stringify({ uploadRoots: [docs] }));
    const file = join(dataDir, "receipt.txt");
    await writeFile(file, "hello", "utf8");
    const store = createUploadConfigStore(env);

    const relative = await store.add(["docs"]);
    expect(relative.written).toBe(false);
    expect(relative.refused).toEqual([{ candidate: "docs", reason: "not-absolute" }]);

    const missing = join(dataDir, "nowhere");
    const absent = await store.add([missing]);
    expect(absent.written).toBe(false);
    expect(absent.refused).toEqual([{ candidate: missing, reason: "not-a-directory" }]);

    const notADirectory = await store.add([file]);
    expect(notADirectory.written).toBe(false);
    expect(notADirectory.refused).toEqual([{ candidate: file, reason: "not-a-directory" }]);

    expect((await readUploadConfig(env)).uploadRoots).toEqual([docs]);
  });

  it("treats a malformed file as an empty list and says so", async () => {
    await writeConfig("{ this is not json");
    const store = createUploadConfigStore(env);

    const listing = await store.list();
    expect(listing.roots).toEqual([]);
    expect(listing.malformed).toBe(true);

    // And an add over it starts from the empty list rather than refusing the owner's answer.
    const change = await store.add([docs]);
    expect(change.written).toBe(true);
    expect(change.listing.roots).toEqual([docs]);
  });

  /**
   * 014/T384 (S3 review F4) — a file nobody could read is still the owner's document.
   *
   * An unreadable `config.json` is treated as an empty list, which is the fail-closed reading and
   * is right. What was wrong was what happened next: the first "from now on" wrote a fresh document
   * straight over it, so ten directories the owner had hand-edited into invalid JSON were gone with
   * no copy and no word - and the answer said the list was fine, which by then it was.
   */
  it("keeps the unreadable file beside the new one, and says it did", async () => {
    await writeConfig("{ this is not json");
    const store = createUploadConfigStore(env);

    const change = await store.add([docs]);

    expect(change.written).toBe(true);
    expect(change.listing.roots).toEqual([docs]);
    // Both facts survive the write: the file they had could not be read, and it is still there.
    expect(change.listing.malformed).toBe(true);
    expect(change.listing.preserved).toBe("config.json.invalid");
    expect(await readFile(`${configPath}.invalid`, "utf8")).toBe("{ this is not json");
    // And the list the reader uses is the new one.
    expect((await readUploadConfig(env)).uploadRoots).toEqual([docs]);

    // The copy is a standing fact about the owner's machine, so the plain listing says so too -
    // that is the row the panel is built from, and the relay answers it from a different process.
    expect((await store.list()).preserved).toBe("config.json.invalid");
    expect((await store.list()).malformed).toBeUndefined();
  });

  it("keeps one copy: a second unreadable file replaces the first", async () => {
    await writeConfig("{ the first one");
    const store = createUploadConfigStore(env);
    await store.add([docs]);

    await writeConfig("[ the second one");
    const second = await store.add([pictures]);

    expect(second.listing.preserved).toBe("config.json.invalid");
    expect(await readFile(`${configPath}.invalid`, "utf8")).toBe("[ the second one");
    // The second document was read as empty, as the reader reads it: the list starts again.
    expect((await readUploadConfig(env)).uploadRoots).toEqual([pictures]);
    // And a readable file is never moved aside.
    const third = await store.add([docs]);
    expect(third.listing.preserved).toBeUndefined();
    expect(await readFile(`${configPath}.invalid`, "utf8")).toBe("[ the second one");
  });

  /**
   * 014/T384 (S3 review F5) — the temp file is not shared.
   *
   * `config.json.tmp` was one name for every writer: several `mcp-server` processes and the relay
   * all write this file, and two of them in flight at once wrote the *same* temp file - so a rename
   * could publish half of one document and half of another. For a fail-closed reader that means
   * "no directories at all" and an upload refused for no reason the owner could see. Two stores in
   * one process are the version of that race a test can run, and the document is made large enough
   * that the two writes genuinely overlap.
   */
  it("gives every write its own temp file, so nothing partial is ever published", async () => {
    // A document big enough that a write takes long enough to overlap another (and an unknown key
    // is the owner's, so the store carries it through every write).
    await writeConfig(JSON.stringify({ "//": "x".repeat(2_000_000), uploadRoots: [docs] }));
    const first = createUploadConfigStore(env);
    const second = createUploadConfigStore(env);
    const music = join(dataDir, "music");
    await mkdir(music, { recursive: true });

    let polling = true;
    const seenEmpty: string[] = [];
    const temps = new Set<string>();
    const watcher = (async () => {
      while (polling) {
        const config = await readUploadConfig(env).catch(() => ({ uploadRoots: [] }));
        // The file on disk always names at least the directory it started with. An empty list here
        // is the reader meeting a document that was half-written.
        if (config.uploadRoots.length === 0) seenEmpty.push(new Date().toISOString());
        for (const name of await readdir(join(dataDir, "hallpass")).catch(() => [])) {
          if (name.endsWith(".tmp")) temps.add(name);
        }
      }
    })();

    await Promise.all([first.add([pictures]), second.add([music])]);
    polling = false;
    await watcher;

    expect(seenEmpty).toEqual([]);
    // Two writes in flight are two files: one name for both is the bug, whatever the timing did.
    expect([...temps].length).toBeGreaterThan(1);
    expect([...temps].every((name) => /^config\.json\.\d+\.\d+\.tmp$/u.test(name)), temps.toString()).toBe(true);
  });

  it("leaves the file whole when the write cannot be made", async () => {
    await writeConfig(JSON.stringify({ uploadRoots: [docs] }));
    // A handle Windows will not let anything be renamed over: the rename fails with the file the
    // reader is using still whole, which is the property the temp-file-and-rename exists for. (It
    // used to be a directory in the temp file's place, which since S3 review F5 is not one name.)
    const held = await open(configPath, "r");
    const store = createUploadConfigStore(env);

    try {
      const change = await store.add([pictures]);

      expect(change.written).toBe(false);
      expect(change.refused).toEqual([{ candidate: pictures, reason: "write-failed" }]);
      // The file the host reads is exactly what it was - not empty, not half a document.
      expect((await readUploadConfig(env)).uploadRoots).toEqual([docs]);
      // And nothing was left behind beside it: this store's own temp file is swept.
      const beside = await readdir(join(dataDir, "hallpass"));
      expect(beside.sort()).toEqual(["config.json"]);
    } finally {
      await held.close();
    }
  });
});
