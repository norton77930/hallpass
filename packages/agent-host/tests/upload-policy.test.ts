import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readUploadConfig,
  resolveUploadFiles,
  uploadConfigPath,
  UPLOAD_CONFIG_TEMPLATE,
} from "../src/upload-policy.js";

/**
 * 003/T062 — the owner's allowed roots (US7, FR-051).
 *
 * This is the only place in the feature that touches a file system, and it is in the *host* - the
 * owner's own process - rather than in the extension. So this test is about one question: which
 * paths may be read at all. Everything else follows from it, including the shape of the refusal:
 * a path outside the roots is refused *before* it is opened, because a refusal that has already
 * read the file has already done the thing the roots exist to prevent.
 *
 * The default is nothing. An installation the owner has not configured allows no upload at all,
 * which is why the installer writes an empty list rather than leaving the file absent and letting
 * the code decide what "unconfigured" means.
 */

let dataDir: string;
let root: string;
let outside: string;

beforeEach(async () => {
  // Resolved: an `outside-roots` refusal now names the files it is about, as `realpath` answers
  // them, and Windows hands out a temp directory under the short 8.3 spelling of the profile.
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "hallpass-upload-")));
  root = join(dataDir, "allowed");
  outside = join(dataDir, "private");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "receipt.txt"), "hello");
  await writeFile(join(outside, "diary.txt"), "not for the agent");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("T062 upload policy", () => {
  it("allows nothing until the owner has configured a root", async () => {
    const config = await readUploadConfig({ LOCALAPPDATA: dataDir });
    expect(config.uploadRoots).toEqual([]);

    const refused = await resolveUploadFiles([join(root, "receipt.txt")], config);
    expect(refused).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      // 014/T372: which files, so the owner can be asked about them (FR-193).
      outside: [{ path: join(root, "receipt.txt"), directory: root }],
    });
  });

  it("writes a config the owner can read and edit, with an empty list and a note", async () => {
    expect(uploadConfigPath({ LOCALAPPDATA: dataDir })).toBe(join(dataDir, "hallpass", "config.json"));
    const template = JSON.parse(UPLOAD_CONFIG_TEMPLATE) as Record<string, unknown>;
    expect(template.uploadRoots).toEqual([]);
    // A note in the file itself: the owner meets this list in a text editor, not in these docs.
    expect(Object.keys(template).some((key) => key !== "uploadRoots")).toBe(true);
  });

  it("reads a file inside a root and refuses one outside every root, before opening it", async () => {
    const config = { uploadRoots: [root] };

    const allowed = await resolveUploadFiles([join(root, "receipt.txt")], config);
    expect(allowed).toEqual({
      ok: true,
      files: [{ name: "receipt.txt", type: "text/plain", bytesBase64: Buffer.from("hello").toString("base64") }],
    });

    const refused = await resolveUploadFiles([join(outside, "diary.txt")], config);
    expect(refused).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      outside: [{ path: join(outside, "diary.txt"), directory: outside }],
    });
  });

  it("refuses a path that walks out of a root, and a symlink that points out of one", async () => {
    const config = { uploadRoots: [root] };

    const walked = await resolveUploadFiles([join(root, "..", "private", "diary.txt")], config);
    expect(walked).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      // The path as it resolves, which is the one the owner would be shown and the host would read.
      outside: [{ path: join(outside, "diary.txt"), directory: outside }],
    });

    let linked = true;
    try {
      await symlink(join(outside, "diary.txt"), join(root, "shortcut.txt"));
    } catch {
      // Windows refuses symlinks without developer mode or elevation. The rule is still enforced by
      // `realpath` below; this half of the case simply cannot be staged on such a machine.
      linked = false;
    }
    if (linked) {
      // The link is inside the root; what it points at is not, and that is what is being read.
      expect(await resolveUploadFiles([join(root, "shortcut.txt")], config)).toEqual({
        ok: false,
        reason: "upload-not-allowed",
        code: "outside-roots",
        outside: [{ path: join(outside, "diary.txt"), directory: outside }],
      });
    }
  });

  it("refuses more files than one call may carry, and a file the frame could not hold", async () => {
    const config = { uploadRoots: [root] };
    const many: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const path = join(root, `f${index}.txt`);
      await writeFile(path, "x");
      many.push(path);
    }
    expect(await resolveUploadFiles(many, config)).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "too-many-files",
    });

    const big = join(root, "big.bin");
    await writeFile(big, Buffer.alloc(600_000));
    expect(await resolveUploadFiles([big], config)).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "too-large",
    });
  });

  /**
   * C4 — the bound that matters is the one the *worker* checks, and the worker sees base64. Three
   * files that fit comfortably as bytes do not fit once encoded, and a host that measured the bytes
   * would read all three, put them in a frame, and have the extension refuse the frame it built -
   * having already done the reading the bound existed to prevent.
   */
  it("measures what the frame will actually carry, which is the encoded size", async () => {
    const config = { uploadRoots: [root] };
    // 3 x 175_000 bytes: 525_000 bytes, which is inside the byte-shaped bound, but 700_008 base64
    // characters, which is not inside the one the contract declares.
    const overEncoded: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const path = join(root, `chunk-${index}.bin`);
      await writeFile(path, Buffer.alloc(175_000));
      overEncoded.push(path);
    }
    expect(await resolveUploadFiles(overEncoded, config)).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "too-large",
    });

    // Exactly at the bound, which is allowed: 525_000 bytes encode to 700_000 characters.
    const exact = join(root, "exact.bin");
    await writeFile(exact, Buffer.alloc(525_000));
    const allowed = await resolveUploadFiles([exact], config);
    expect(allowed.ok).toBe(true);
  });

  /**
   * C7 — two ways a root check can be wrong on Windows, both about string comparison standing in
   * for a path comparison: a sibling directory whose name merely starts with the root's, and the
   * same directory spelled with different case.
   */
  it("does not mistake a sibling directory for a root, and accepts the root in any case", async () => {
    const sibling = `${root}-extra`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "sneaky.txt"), "not in the root");

    expect(await resolveUploadFiles([join(sibling, "sneaky.txt")], { uploadRoots: [root] })).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      outside: [{ path: join(sibling, "sneaky.txt"), directory: sibling }],
    });

    const shouted = await resolveUploadFiles([join(root, "receipt.txt")], {
      uploadRoots: [root.toUpperCase()],
    });
    // One directory, two spellings, on a file system that does not distinguish them.
    expect(shouted.ok).toBe(process.platform === "win32");
  });

  it("refuses a path that is not a file at all", async () => {
    const config = { uploadRoots: [root] };

    expect(await resolveUploadFiles([join(root, "missing.txt")], config)).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "not-a-file",
    });
    expect(await resolveUploadFiles([root], config)).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "not-a-file",
    });
  });

  /**
   * 014/T372 — the refusal the owner can be asked about (FR-193).
   *
   * `outside-roots` is the one code that is not final: it is the question "may this come from
   * here?", and the only party that can answer it is the owner. So it is surfaced to the caller
   * with the files it is about - resolved, with the directory the host would add - and every other
   * code stays exactly the flat refusal it was, because none of them has an answer.
   */
  it("names the files that are outside every root, with the directories a yes would add", async () => {
    const second = join(dataDir, "elsewhere");
    await mkdir(second, { recursive: true });
    await writeFile(join(second, "photo.png"), "x");

    const refused = await resolveUploadFiles(
      [join(outside, "diary.txt"), join(second, "photo.png")],
      { uploadRoots: [root] },
    );

    expect(refused).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      // Both of them, in the order they were named: one card, two paths (SC-105).
      outside: [
        { path: join(outside, "diary.txt"), directory: outside },
        { path: join(second, "photo.png"), directory: second },
      ],
    });
  });

  it("admits exactly the files named for this one call, and nothing else beside them", async () => {
    const config = { uploadRoots: [root] };
    const named = join(outside, "diary.txt");
    await writeFile(join(outside, "secret.txt"), "also not for the agent");

    const allowed = await resolveUploadFiles([named], config, { allowFiles: [named] });
    expect(allowed).toEqual({
      ok: true,
      files: [
        {
          name: "diary.txt",
          type: "text/plain",
          bytesBase64: Buffer.from("not for the agent").toString("base64"),
        },
      ],
    });

    // Its neighbour in the same directory is not admitted by the same answer: "once" is about the
    // files the owner read on the card, not about where they happened to live.
    const neighbour = await resolveUploadFiles([join(outside, "secret.txt")], config, {
      allowFiles: [named],
    });
    expect(neighbour).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "outside-roots",
      outside: [{ path: join(outside, "secret.txt"), directory: outside }],
    });
  });

  it("compares the allowed files by real path, and still applies every other rule to them", async () => {
    const config = { uploadRoots: [] as string[] };
    const named = join(outside, "diary.txt");

    // The same file, spelled as a walk: one file, and the walk is what the agent may well send.
    const walked = join(outside, "..", "private", "diary.txt");
    expect((await resolveUploadFiles([walked], config, { allowFiles: [named] })).ok).toBe(true);

    // Allowed by the owner is not allowed past the size bound: their answer was about where the
    // file is, and the bound is about what the frame can carry.
    const big = join(outside, "big.bin");
    await writeFile(big, Buffer.alloc(600_000));
    expect(await resolveUploadFiles([big], config, { allowFiles: [big] })).toEqual({
      ok: false,
      reason: "upload-not-allowed",
      code: "too-large",
    });
  });
});
