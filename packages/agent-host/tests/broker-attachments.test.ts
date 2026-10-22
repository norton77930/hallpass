import { mkdir, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENTS_FOLDER,
  ATTACHMENT_EXPIRY_MS,
  ATTACHMENT_IDLE_MS,
  AttachmentStore,
  sanitizeAttachmentName,
  type AttachmentFs,
  type AttachPiece,
} from "../src/broker/attachments.js";
import type { Clock, ClockTimer } from "../src/broker/conversation.js";
import { makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 022 T614 - the broker's per-conversation staging of attachments (R-337, R-339, R-340; SC-150,
 * SC-151). Pieces arrive in order with a declared size; pictures and the tab stay in memory, files
 * are staged as `.<id>.part` inside `<folder>\hallpass-attachments\` and get their final,
 * never-overwriting name only when the message is sent. Every folder here is a fresh temp folder.
 */

/** Time only `advance` moves; timers due inside the jump fire, in order. */
class ManualClock implements Clock {
  private at = 1_000_000;
  private readonly timers = new Set<{ due: number; fn: () => void }>();
  now(): number {
    return this.at;
  }
  setTimer(fn: () => void, ms: number): ClockTimer {
    const timer = { due: this.at + ms, fn };
    this.timers.add(timer);
    return { cancel: () => void this.timers.delete(timer) };
  }
  advance(ms: number): void {
    this.at += ms;
    for (const timer of [...this.timers].sort((a, b) => a.due - b.due)) {
      if (timer.due <= this.at && this.timers.delete(timer)) timer.fn();
    }
  }
}

const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString("base64");

let dir: string;
let folder: string;
let clock: ManualClock;
let store: AttachmentStore;

beforeEach(async () => {
  dir = await makeTempDir("hallpass-attach-");
  folder = join(dir, "project");
  await mkdir(folder);
  clock = new ManualClock();
  store = new AttachmentStore({ folder, clock });
});

afterEach(async () => {
  await store.clear().catch(() => undefined);
  await removeDir(dir);
});

const sub = async () => join(await realpath(folder), ATTACHMENTS_FOLDER);
const listSub = async () => readdir(await sub()).catch(() => [] as string[]);

const imagePiece = (id: string, bytes: Buffer, extra: Partial<AttachPiece> = {}): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final: true,
  kind: "image",
  name: `${id}.png`,
  size: bytes.length,
  mimeType: "image/png",
  thumbnail: "AAAA",
  data: b64(bytes),
  ...extra,
});

const fileFirst = (id: string, name: string, size: number, bytes: Buffer, final: boolean): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final,
  kind: "file",
  name,
  size,
  data: b64(bytes),
});

const later = (id: string, index: number, bytes: Buffer, final: boolean): AttachPiece => ({
  attachmentId: id,
  index,
  final,
  data: b64(bytes),
});

const tabPiece = (id: string, text: string, extra: Partial<AttachPiece> = {}): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final: true,
  kind: "tab",
  name: "A page",
  size: Buffer.byteLength(text, "utf8"),
  tab: { url: "https://example.test/a", title: "A page", cut: false },
  data: b64(Buffer.from(text, "utf8")),
  ...extra,
});

async function stageFile(id: string, name: string, content: Buffer): Promise<void> {
  const half = Math.floor(content.length / 2);
  expect(await store.receive(fileFirst(id, name, content.length, content.subarray(0, half), false))).toEqual({ ok: true });
  expect(await store.receive(later(id, 1, content.subarray(half), true))).toEqual({ ok: true });
}

const codeOf = (outcome: { ok: boolean; error?: { code: string } }) => (outcome.ok ? "ok" : outcome.error!.code);

describe("022 T614 staging and the final name", () => {
  it("keeps a picture in memory and hands it back whole at send", async () => {
    const bytes = Buffer.from("not really a png");
    expect(await store.receive(imagePiece("img1", bytes))).toEqual({ ok: true });
    const taken = await store.take(["img1"]);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value).toEqual([
      { kind: "image", id: "img1", name: "img1.png", size: bytes.length, mimeType: "image/png", data: b64(bytes), thumbnail: "AAAA" },
    ]);
    expect(await listSub()).toEqual([]);
  });

  it("keeps the tab's address, title and text", async () => {
    expect(await store.receive(tabPiece("tab1", "visible words", { tab: { url: "https://example.test/a", title: "A page", cut: true } }))).toEqual({
      ok: true,
    });
    const taken = await store.take(["tab1"]);
    expect(taken.ok && taken.value[0]).toMatchObject({ kind: "tab", url: "https://example.test/a", title: "A page", text: "visible words", cut: true });
  });

  it("stages a file as a hidden part, never under its final name, then moves it byte for byte at send", async () => {
    const content = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 256));
    await stageFile("f1", "data.csv", content);
    expect(await listSub()).toEqual([".f1.part"]);

    const taken = await store.take(["f1"]);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    const placed = taken.value[0]!;
    expect(placed).toMatchObject({ kind: "file", name: "data.csv", size: 5000, path: join(await sub(), "data.csv") });
    expect(await readFile(join(await sub(), "data.csv"))).toEqual(content);
    expect(await listSub()).toEqual(["data.csv"]);
  });

  it("never replaces an existing file: the next copy is ' (2)', then ' (3)', and the old one is unchanged", async () => {
    await mkdir(await sub(), { recursive: true });
    await writeFile(join(await sub(), "data.csv"), "old");
    await stageFile("f1", "data.csv", Buffer.from("new one"));
    const first = await store.take(["f1"]);
    expect(first.ok && first.value[0]).toMatchObject({ name: "data (2).csv" });
    await stageFile("f2", "DATA.csv", Buffer.from("newer"));
    const second = await store.take(["f2"]);
    expect(second.ok && second.value[0]).toMatchObject({ name: "DATA (3).csv" });
    expect(await readFile(join(await sub(), "data.csv"), "utf8")).toBe("old");
    expect(await readFile(join(await sub(), "data (2).csv"), "utf8")).toBe("new one");
  });

  it("copies with an exclusive create when the folder cannot take a hard link", async () => {
    const fs: Partial<AttachmentFs> = {
      link: async () => {
        throw Object.assign(new Error("not supported"), { code: "EPERM" });
      },
    };
    store = new AttachmentStore({ folder, clock, fs });
    await mkdir(await sub(), { recursive: true });
    await writeFile(join(await sub(), "a.txt"), "old");
    await stageFile("f1", "a.txt", Buffer.from("copied"));
    const taken = await store.take(["f1"]);
    expect(taken.ok && taken.value[0]).toMatchObject({ name: "a (2).txt" });
    expect(await readFile(join(await sub(), "a (2).txt"), "utf8")).toBe("copied");
    expect((await listSub()).sort()).toEqual(["a (2).txt", "a.txt"]);
  });

  it("discard removes the files a send placed but could not send", async () => {
    await stageFile("f1", "x.txt", Buffer.from("x"));
    const taken = await store.take(["f1"]);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    await store.discard(taken.value);
    expect(await listSub()).toEqual([]);
  });
});

describe("022 T614 piece order and declared size", () => {
  it("refuses a skipped piece and drops the attachment with its part", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(later("f1", 2, Buffer.from("def"), false)))).toBe("attachment-order");
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.receive(later("f1", 1, Buffer.from("def"), false)))).toBe("attachment-unknown");
  });

  it("refuses a later piece of an attachment it never saw, and a first piece twice", async () => {
    expect(codeOf(await store.receive(later("nope", 1, Buffer.from("x"), true)))).toBe("attachment-unknown");
    expect(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false)))).toBe("attachment-order");
  });

  it("refuses a piece after the final one", async () => {
    expect(await store.receive(imagePiece("img1", Buffer.from("abc")))).toEqual({ ok: true });
    expect(codeOf(await store.receive(later("img1", 1, Buffer.from("x"), true)))).toBe("attachment-order");
  });

  it("refuses more bytes than declared, and a final piece short of it", async () => {
    expect(codeOf(await store.receive(fileFirst("f1", "a.bin", 2, Buffer.from("abc"), false)))).toBe("attachment-too-large");
    expect(await listSub()).toEqual([]);
    expect(await store.receive(fileFirst("f2", "b.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(later("f2", 1, Buffer.from("de"), true)))).toBe("attachment-incomplete");
    expect(await listSub()).toEqual([]);
  });

  it("refuses to send an attachment whose last piece has not come, and drops what was staged", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(await store.receive(imagePiece("img1", Buffer.from("abc")))).toEqual({ ok: true });
    expect(codeOf(await store.take(["img1", "f1"]))).toBe("attachment-incomplete");
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.take(["img1"]))).toBe("attachment-unknown");
  });

  it("refuses an id it never staged", async () => {
    expect(codeOf(await store.take(["ghost"]))).toBe("attachment-unknown");
  });
});

describe("022 T614 limits (R-340)", () => {
  it("at most 5 images, 5 files and 1 tab", async () => {
    for (let n = 0; n < 5; n++) expect(await store.receive(imagePiece(`i${n}`, Buffer.from("x")))).toEqual({ ok: true });
    expect(codeOf(await store.receive(imagePiece("i5", Buffer.from("x"))))).toBe("attachment-too-many");
    for (let n = 0; n < 5; n++) expect(await store.receive(fileFirst(`f${n}`, `f${n}.txt`, 1, Buffer.from("x"), true))).toEqual({ ok: true });
    expect(codeOf(await store.receive(fileFirst("f5", "f5.txt", 1, Buffer.from("x"), true)))).toBe("attachment-too-many");
    expect(await store.receive(tabPiece("t0", "x"))).toEqual({ ok: true });
    expect(codeOf(await store.receive(tabPiece("t1", "x")))).toBe("attachment-too-many");
  });

  it("refuses a file over 25 MB before anything is written, and files over 25 MB together", async () => {
    expect(codeOf(await store.receive(fileFirst("big", "big.bin", 25 * 1024 * 1024 + 1, Buffer.from("x"), false)))).toBe(
      "attachment-too-large",
    );
    expect(await listSub()).toEqual([]);
    expect(await store.receive(fileFirst("f1", "a.bin", 20 * 1024 * 1024, Buffer.from("x"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(fileFirst("f2", "b.bin", 6 * 1024 * 1024, Buffer.from("x"), false)))).toBe("attachment-too-large");
    expect(await listSub()).toEqual([".f1.part"]);
  });

  it("refuses a picture over 700 000 base64 characters, and a type that is not a picture", async () => {
    expect(codeOf(await store.receive(imagePiece("i1", Buffer.from("x"), { size: 525_001 })))).toBe("attachment-too-large");
    expect(codeOf(await store.receive(imagePiece("i2", Buffer.from("x"), { mimeType: "image/bmp" })))).toBe("attachment-type");
    const { mimeType: _mime, ...noType } = imagePiece("i3", Buffer.from("x"));
    expect(codeOf(await store.receive(noType))).toBe("attachment-type");
  });

  it("refuses tab text over 50 000 characters, and a tab without its address", async () => {
    expect(codeOf(await store.receive(tabPiece("t1", "x".repeat(50_001))))).toBe("attachment-too-large");
    const { tab: _tab, ...noTab } = tabPiece("t2", "x");
    expect(codeOf(await store.receive(noTab))).toBe("attachment-type");
  });
});

describe("022 T614 names and containment (R-339, SC-151)", () => {
  it.each([
    ["..\\..\\x", "x"],
    ["../../x.txt", "x.txt"],
    ["C:\\x", "x"],
    ["con", "_con"],
    ["CON.txt", "_CON.txt"],
    ["lpt1", "_lpt1"],
    ["a:b", "a_b"],
    ['a<b>c|d?e*f"g', "a_b_c_d_e_f_g"],
    ["tab\there", "tab_here"],
    ["trailing. . ", "trailing"],
    ["..", "attachment"],
    ["", "attachment"],
    ["report.pdf", "report.pdf"],
  ])("%j is saved as %j", (raw, expected) => {
    expect(sanitizeAttachmentName(raw)).toBe(expected);
  });

  it("keeps a 300-character name to 120 characters with its extension", () => {
    const name = sanitizeAttachmentName(`${"n".repeat(296)}.csv`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".csv")).toBe(true);
  });

  it.each(["..\\..\\evil.txt", "C:\\evil.txt", "con", "a:b", "x".repeat(300)])("a file named %j lands inside hallpass-attachments", async (name) => {
    await stageFile("f1", name, Buffer.from("x"));
    const taken = await store.take(["f1"]);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    const path = (taken.value[0] as { path: string }).path;
    expect(dirname(path)).toBe(await sub());
    expect(await readFile(path, "utf8")).toBe("x");
  });

  it("refuses to write when hallpass-attachments leads outside the folder", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(folder, ATTACHMENTS_FOLDER), "junction");
    expect(codeOf(await store.receive(fileFirst("f1", "a.txt", 1, Buffer.from("x"), true)))).toBe("attachment-write-failed");
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("022 T614 cleanup (R-340)", () => {
  it("cancel drops the staged data and its part; an unknown id is fine", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    await store.cancel("f1");
    await store.cancel("never");
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.receive(later("f1", 1, Buffer.from("x"), true)))).toBe("attachment-unknown");
  });

  it("drops an unfinished attachment after 120 s without a piece", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    clock.advance(ATTACHMENT_IDLE_MS - 1);
    await store.settled();
    expect(await listSub()).toEqual([".f1.part"]);
    expect(await store.receive(later("f1", 1, Buffer.from("de"), false))).toEqual({ ok: true });
    clock.advance(ATTACHMENT_IDLE_MS - 1);
    await store.settled();
    expect(await listSub()).toEqual([".f1.part"]);
    clock.advance(1);
    await store.settled();
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.receive(later("f1", 2, Buffer.from("x"), true)))).toBe("attachment-unknown");
  });

  it("drops a finished, unsent attachment after 10 minutes", async () => {
    await stageFile("f1", "a.bin", Buffer.from("abc"));
    clock.advance(ATTACHMENT_EXPIRY_MS);
    await store.settled();
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.take(["f1"]))).toBe("attachment-unknown");
  });

  it("clear drops everything (the conversation stopped, exited or was removed)", async () => {
    await stageFile("f1", "a.bin", Buffer.from("abc"));
    expect(await store.receive(fileFirst("f2", "b.bin", 10, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(await store.receive(imagePiece("img1", Buffer.from("abc")))).toEqual({ ok: true });
    await store.clear();
    expect(await listSub()).toEqual([]);
    expect(codeOf(await store.take(["img1"]))).toBe("attachment-unknown");
  });

  it("a refused piece leaves no part behind", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 4, Buffer.from("ab"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(later("f1", 1, Buffer.from("cde"), true)))).toBe("attachment-too-large");
    expect(await listSub()).toEqual([]);
  });
});

describe("022 T614 the folder is gone", () => {
  it("refuses a file but still takes pictures and the tab", async () => {
    await rm(folder, { recursive: true, force: true });
    expect(codeOf(await store.receive(fileFirst("f1", "a.txt", 1, Buffer.from("x"), true)))).toBe("attachment-folder-gone");
    expect(await store.receive(imagePiece("img1", Buffer.from("x")))).toEqual({ ok: true });
    expect(await store.receive(tabPiece("t1", "x"))).toEqual({ ok: true });
    const taken = await store.take(["img1", "t1"]);
    expect(taken.ok).toBe(true);
  });

  it("refuses the send when the folder went away after the file was staged", async () => {
    await stageFile("f1", "a.txt", Buffer.from("x"));
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    expect(codeOf(await store.take(["f1"]))).toBe("attachment-folder-gone");
  });
});

describe("022 T618 review fixes in the store", () => {
  it("a first piece again for an id it holds is refused without dropping what it holds", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 6, Buffer.from("abc"), false))).toEqual({ ok: true });
    expect(codeOf(await store.receive(fileFirst("f1", "a.bin", 6, Buffer.from("abc"), false)))).toBe("attachment-order");
    expect(await listSub()).toEqual([".f1.part"]);
    expect(await store.receive(later("f1", 1, Buffer.from("def"), true))).toEqual({ ok: true });
    const taken = await store.take(["f1"]);
    expect(taken.ok && (await readFile((taken.value[0] as { path: string }).path, "utf8"))).toBe("abcdef");
  });

  it("a refused send drops only what it named, not every staged attachment", async () => {
    expect(await store.receive(imagePiece("img1", Buffer.from("a")))).toEqual({ ok: true });
    expect(await store.receive(imagePiece("img2", Buffer.from("b")))).toEqual({ ok: true });
    expect(codeOf(await store.take(["img1", "ghost"]))).toBe("attachment-unknown");
    expect(codeOf(await store.take(["img1"]))).toBe("attachment-unknown");
    expect(codeOf(await store.take(["img2"]))).toBe("ok");
  });

  it("pieces and a send issued together run in order: the send takes its own, the other stays", async () => {
    const first = store.receive(imagePiece("a", Buffer.from("a")));
    const second = store.receive(imagePiece("b", Buffer.from("b")));
    const taken = store.take(["a"]);
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(codeOf(await taken)).toBe("ok");
    expect(store.count).toBe(1);
    clock.advance(ATTACHMENT_EXPIRY_MS);
    await store.settled();
    expect(store.count).toBe(0);
  });

  it("a piece queued before the idle timer fired keeps the attachment (the timer's drop sees the re-arm)", async () => {
    expect(await store.receive(fileFirst("f1", "a.bin", 9, Buffer.from("abc"), false))).toEqual({ ok: true });
    const piece = store.receive(later("f1", 1, Buffer.from("def"), false));
    clock.advance(ATTACHMENT_IDLE_MS);
    expect(await piece).toEqual({ ok: true });
    await store.settled();
    expect(await listSub()).toEqual([".f1.part"]);
    expect(await store.receive(later("f1", 2, Buffer.from("ghi"), true))).toEqual({ ok: true });
  });

  it("sweeps stale part files by age on first use, and touches nothing else", async () => {
    await mkdir(await sub(), { recursive: true });
    const old = new Date(Date.now() - ATTACHMENT_EXPIRY_MS - 60_000);
    const names = [".stale.part", ".fresh.part", "data.csv", ".stale.part.txt", ".bad name.part", ".part", "x.part"];
    for (const name of names) await writeFile(join(await sub(), name), "x");
    for (const name of names.filter((name) => name !== ".fresh.part")) await utimes(join(await sub(), name), old, old);
    expect(await store.receive(fileFirst("f1", "a.bin", 1, Buffer.from("x"), true))).toEqual({ ok: true });
    expect((await listSub()).sort()).toEqual(
      [".fresh.part", "data.csv", ".stale.part.txt", ".bad name.part", ".part", "x.part", ".f1.part"].sort(),
    );
  });

  it("retries removing the part after a hard link, and remembers it for clear when that fails again", async () => {
    let failures = 0;
    const fs: Partial<AttachmentFs> = {
      unlink: async (path) => {
        if (path.endsWith(".part") && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("in use"), { code: "EBUSY" });
        }
        await rm(path);
      },
    };
    store = new AttachmentStore({ folder, clock, fs });
    await stageFile("f1", "a.txt", Buffer.from("one"));
    failures = 1;
    expect(codeOf(await store.take(["f1"]))).toBe("ok");
    expect(await listSub()).toEqual(["a.txt"]);

    await stageFile("f2", "b.txt", Buffer.from("two"));
    failures = 2;
    expect(codeOf(await store.take(["f2"]))).toBe("ok");
    expect((await listSub()).sort()).toEqual([".f2.part", "a.txt", "b.txt"]);
    await store.clear();
    expect((await listSub()).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("a copy that fails part-way removes the name it was creating, and only that", async () => {
    const fs: Partial<AttachmentFs> = {
      link: async () => {
        throw Object.assign(new Error("not supported"), { code: "EPERM" });
      },
      copyExclusive: async (_source, target) => {
        await writeFile(target, "half", { flag: "wx" });
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    store = new AttachmentStore({ folder, clock, fs });
    await mkdir(await sub(), { recursive: true });
    await writeFile(join(await sub(), "a.txt"), "old");
    await stageFile("f1", "a.txt", Buffer.from("new"));
    expect(codeOf(await store.take(["f1"]))).toBe("attachment-write-failed");
    expect(await listSub()).toEqual(["a.txt"]);
    expect(await readFile(join(await sub(), "a.txt"), "utf8")).toBe("old");
  });
});
