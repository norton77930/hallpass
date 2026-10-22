import { constants } from "node:fs";
import { appendFile, copyFile, link, mkdir, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import {
  CONVERSATION_FILE_MAX_BYTES,
  CONVERSATION_FILES_TOTAL_MAX_BYTES,
  CONVERSATION_IMAGE_MAX_CHARS,
  CONVERSATION_IMAGE_MIME_TYPES,
  CONVERSATION_MAX_FILES,
  CONVERSATION_MAX_IMAGES,
  CONVERSATION_MAX_TABS,
  CONVERSATION_TAB_TEXT_MAX_CHARS,
  type ConversationAttachmentKind,
  type ConversationCommand,
  type ConversationError,
} from "@hallpass/contracts";
import type { Clock, ClockTimer } from "./conversation.js";

/**
 * 022 - one conversation's attachments on their way to the agent (R-337, R-339, R-340; SC-150,
 * SC-151; data-model "StagedAttachment").
 *
 * The panel sends each attachment as `ui.conversation.attach` pieces of at most 512 KiB, in order
 * from 0, the first saying what it is and its total size. Pictures and the tab's text stay here in
 * memory; a file's bytes go to `<folder>\hallpass-attachments\.<id>.part` (a part file - the leading
 * dot hides nothing on Windows, the name only says what it is), and only `take` - the send - gives
 * it its final name, by an exclusive create (a hard link, else a copy
 * that refuses an existing name), so no copy is ever visible half-written and no existing file is
 * ever replaced. This store is the authority on the limits; the panel's own checks are only early,
 * friendly refusals.
 *
 * No name from the panel decides a path: the final name is the sanitised last segment of the name
 * it gave, the folder is the conversation's own after `realpath`, and `hallpass-attachments` must
 * resolve to itself inside it (a junction leading elsewhere is refused).
 *
 * Staged data goes - part file included - on `cancel`, a refused piece (not a repeated first piece:
 * the attachment it repeats is still good), a refused or failed send (`take`, only what it named),
 * `clear` (the conversation stopped, exited or was removed), 120 s without a piece for an unfinished
 * attachment, and 10 minutes for a finished one that was never sent. Every operation runs one after
 * another, so the counts and the part files are never raced by two panel documents.
 *
 * T618: part files a broker left behind (it was killed mid-transfer) are swept on the store's first
 * use of the folder - only `.<id>.part` names, and only once older than the 10-minute expiry, since
 * another conversation in the same folder may be staging right now.
 */

export const ATTACHMENTS_FOLDER = "hallpass-attachments";
/** R-340: an unfinished attachment with no piece for this long is dropped. */
export const ATTACHMENT_IDLE_MS = 120_000;
/** R-340: a finished attachment that was never sent is dropped after this long. */
export const ATTACHMENT_EXPIRY_MS = 10 * 60_000;
/** R-339: the most characters a saved name has, ` (n)` included. */
export const ATTACHMENT_NAME_MAX_CHARS = 120;
/** R-339: ` (2)` ... ` (999)`; past that the send is refused rather than a name overwritten. */
const MAX_NAME_NUMBER = 999;
/** The raw bytes 700 000 base64 characters hold. */
const IMAGE_MAX_BYTES = (CONVERSATION_IMAGE_MAX_CHARS / 4) * 3;
/** 50 000 UTF-16 code units are at most 150 000 bytes of UTF-8. */
const TAB_MAX_BYTES = CONVERSATION_TAB_TEXT_MAX_CHARS * 3;
/** An extension longer than this is not kept apart when a long name is shortened. */
const EXTENSION_MAX_CHARS = 20;
/** T618: what a part file is called, and the only names the stale sweep ever removes. */
const PART_NAME = /^\.[A-Za-z0-9_-]{1,64}\.part$/u;
/** T618: the wait before the one retry of removing a part file another process briefly held. */
const PART_RETRY_MS = 50;

type AttachCommand = Extract<ConversationCommand, { type: "ui.conversation.attach" }>;
/** One `ui.conversation.attach` payload without its conversation (the pool routes by that). */
export type AttachPiece = Omit<AttachCommand["payload"], "conversationId">;

/** What a send hands the prompt and the owner's bubble, in the order the send named them. */
export type ReadyAttachment =
  | { kind: "image"; id: string; name: string; size: number; mimeType: string; data: string; thumbnail?: string }
  | { kind: "tab"; id: string; name: string; size: number; url: string; title: string; text: string; cut: boolean }
  | { kind: "file"; id: string; name: string; size: number; path: string };

export type AttachmentOutcome<T = undefined> = { ok: true; value?: T } | { ok: false; error: ConversationError };
/** What a send gets: every named attachment ready, or why not. */
export type TakeOutcome = { ok: true; value: ReadyAttachment[] } | { ok: false; error: ConversationError };

/** The file operations, injectable so a test can make a folder refuse hard links. */
export type AttachmentFs = {
  realpath: (path: string) => Promise<string>;
  mkdir: (path: string) => Promise<unknown>;
  writeExclusive: (path: string, data: Uint8Array) => Promise<void>;
  append: (path: string, data: Uint8Array) => Promise<void>;
  link: (existing: string, target: string) => Promise<void>;
  copyExclusive: (source: string, target: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  /** Last modification, in ms since the epoch (wall clock). */
  mtimeMs: (path: string) => Promise<number>;
};

const nodeFs: AttachmentFs = {
  realpath: (path) => realpath(path),
  mkdir: (path) => mkdir(path, { recursive: true }),
  writeExclusive: (path, data) => writeFile(path, data, { flag: "wx" }),
  append: (path, data) => appendFile(path, data),
  link: (existing, target) => link(existing, target),
  copyExclusive: (source, target) => copyFile(source, target, constants.COPYFILE_EXCL),
  unlink: (path) => unlink(path),
  readdir: (path) => readdir(path),
  mtimeMs: async (path) => (await stat(path)).mtimeMs,
};

export type AttachmentStoreOptions = {
  /** The conversation's folder (a project folder, or its scratch folder). */
  folder: string;
  clock: Clock;
  idleMs?: number;
  expiryMs?: number;
  fs?: Partial<AttachmentFs>;
  log?: (code: string, detail?: string) => void;
  /** Wall-clock now, compared with part files' modification times by the stale sweep. */
  wallNow?: () => number;
};

type Staged = {
  id: string;
  kind: ConversationAttachmentKind;
  name: string;
  declaredSize: number;
  received: number;
  nextIndex: number;
  complete: boolean;
  mimeType?: string;
  thumbnail?: string;
  tab?: { url: string; title: string; cut: boolean };
  /** Pictures and the tab: the bytes so far. */
  chunks: Buffer[];
  /** Files: the part file, until it is placed (or was never created). */
  partPath?: string | undefined;
  timer?: ClockTimer | undefined;
  /** T618: bumped by each `arm`, so a timer's queued drop yields to a piece that re-armed it. */
  armed: number;
};

const refuse = (code: ConversationError["code"], detail: string): { ok: false; error: ConversationError } => ({
  ok: false,
  error: { code, detail },
});

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" ? ((error as { code?: unknown }).code as string | undefined) : undefined;

/* ------------------------------------------------------------------------------------------- */
/* Names (R-339)                                                                                */
/* ------------------------------------------------------------------------------------------- */

/** What Windows refuses in a file name: `<>:"/\|?*` and control characters. */
const REFUSED_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
/** Device names, whatever follows the first dot; `COM¹` and kin are devices too. */
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;

const codePoints = (text: string) => Array.from(text);

/** `stem` and `.ext` of a name; a leading dot is part of the stem, a long "extension" is not one. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  const extension = name.slice(dot);
  if (codePoints(extension).length > EXTENSION_MAX_CHARS) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension };
}

/** `stem` + `suffix` + `extension` within the name bound, the stem giving way. */
function fit(stem: string, suffix: string, extension: string): string {
  const room = ATTACHMENT_NAME_MAX_CHARS - codePoints(suffix).length - codePoints(extension).length;
  const cut = codePoints(stem).slice(0, Math.max(room, 1)).join("").replace(TRAILING_DOTS_AND_SPACES, "");
  return `${cut === "" ? "attachment" : cut}${suffix}${extension}`;
}

/**
 * R-339: the name a file is saved under. The last path segment of what the panel gave, refused
 * characters replaced with `_`, trailing dots and spaces trimmed, a device name prefixed with `_`,
 * at most 120 characters (the extension kept); nothing left becomes `attachment`.
 */
export function sanitizeAttachmentName(raw: string): string {
  const last = raw.split(/[\\/]/u).at(-1) ?? "";
  const name = last.replace(REFUSED_CHARACTERS, "_").replace(TRAILING_DOTS_AND_SPACES, "");
  if (name === "") return "attachment";
  const device = DEVICE_NAME.test((name.split(".")[0] ?? "").trimEnd());
  const { stem, extension } = splitExtension(device ? `_${name}` : name);
  return fit(stem, "", extension);
}

/** `data (2).csv` for `data.csv`, within the name bound. */
function numberedName(name: string, n: number): string {
  const { stem, extension } = splitExtension(name);
  return fit(stem, ` (${n})`, extension);
}

/* ------------------------------------------------------------------------------------------- */
/* The store                                                                                    */
/* ------------------------------------------------------------------------------------------- */

export class AttachmentStore {
  private readonly staged = new Map<string, Staged>();
  private readonly fs: AttachmentFs;
  private readonly idleMs: number;
  private readonly expiryMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** T618: the stale sweep runs once per store, on its first use of the folder. */
  private swept = false;
  /** T618: part files already placed under their final name whose removal failed; retried later. */
  private readonly leftovers = new Set<string>();
  private lastPiece: number | undefined;

  constructor(private readonly options: AttachmentStoreOptions) {
    this.fs = { ...nodeFs, ...options.fs };
    this.idleMs = options.idleMs ?? ATTACHMENT_IDLE_MS;
    this.expiryMs = options.expiryMs ?? ATTACHMENT_EXPIRY_MS;
  }

  /** How many attachments are staged (finished or not). */
  get count(): number {
    return this.staged.size;
  }

  /** When the last piece came (the pool's clock), whatever became of it; undefined before any. */
  get lastPieceAt(): number | undefined {
    return this.lastPiece;
  }

  /** Resolves once every operation asked for so far - timers' drops included - has run. */
  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  /** One piece, in order; a refusal drops the attachment (and its part file). */
  receive(piece: AttachPiece): Promise<AttachmentOutcome> {
    this.lastPiece = this.options.clock.now();
    return this.serial(async () => {
      // T618: a first piece again for an id it holds is refused, and what it holds stays.
      if (piece.index === 0 && this.staged.has(piece.attachmentId)) {
        return refuse("attachment-order", "This attachment has already begun.");
      }
      const outcome = await this.accept(piece);
      if (!outcome.ok) await this.drop(piece.attachmentId);
      return outcome;
    });
  }

  /** Drops one staged attachment; nothing to do for an id it does not hold. */
  cancel(attachmentId: string): Promise<void> {
    return this.serial(() => this.drop(attachmentId));
  }

  /** Drops the named staged attachments (a refused send); ids it does not hold are skipped. */
  cancelMany(attachmentIds: readonly string[]): Promise<void> {
    return this.serial(async () => {
      for (const id of attachmentIds) await this.drop(id);
    });
  }

  /** Drops everything: the conversation stopped, exited or was removed. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.dropAll();
      await this.removeLeftovers();
    });
  }

  /**
   * The send: every named attachment finished, the files moved to their final names. A refusal
   * drops what it named (T618: not the rest), and any file this call already placed.
   */
  take(ids: readonly string[]): Promise<TakeOutcome> {
    return this.serial(async () => {
      const outcome = await this.claim(ids);
      if (!outcome.ok) for (const id of ids) await this.drop(id);
      return outcome;
    });
  }

  /**
   * Whether `take` would find every named attachment, finished, and of which kinds - asked before a
   * send starts an agent for them. Changes nothing.
   */
  check(ids: readonly string[]): Promise<AttachmentOutcome<ConversationAttachmentKind[]>> {
    return this.serial(async () => {
      const found = this.find(ids);
      return found.ok ? { ok: true, value: found.value.map((staged) => staged.kind) } : found;
    });
  }

  /** The files a send placed and then could not send are removed again (FR-332). */
  discard(placed: readonly ReadyAttachment[]): Promise<void> {
    return this.serial(async () => {
      for (const attachment of placed) if (attachment.kind === "file") await this.fs.unlink(attachment.path).catch(() => undefined);
    });
  }

  /* ----------------------------------------------------------------------------------------- */

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async accept(piece: AttachPiece): Promise<AttachmentOutcome> {
    const known = this.staged.get(piece.attachmentId);
    if (piece.index === 0) {
      if (known !== undefined) return refuse("attachment-order", "This attachment has already begun.");
      const begun = await this.begin(piece);
      if (!begun.ok) return begun;
    } else {
      if (known === undefined) return refuse("attachment-unknown", "Hallpass holds no attachment of that name; add it again.");
      if (known.complete || piece.index !== known.nextIndex) {
        return refuse("attachment-order", "The pieces of this attachment arrived out of order.");
      }
    }
    const staged = this.staged.get(piece.attachmentId)!;
    const bytes = Buffer.from(piece.data, "base64");
    if (staged.received + bytes.length > staged.declaredSize) {
      return refuse("attachment-too-large", "This attachment is larger than it said it was.");
    }
    if (staged.partPath !== undefined) {
      try {
        if (piece.index === 0) await this.fs.writeExclusive(staged.partPath, bytes);
        else await this.fs.append(staged.partPath, bytes);
      } catch (error) {
        // A part file that could not be created exclusively is not this attachment's to remove.
        if (piece.index === 0) staged.partPath = undefined;
        return this.writeFailure(error);
      }
    } else {
      staged.chunks.push(bytes);
    }
    staged.received += bytes.length;
    staged.nextIndex = piece.index + 1;
    this.arm(staged, piece.final ? this.expiryMs : this.idleMs);
    if (!piece.final) return { ok: true };
    if (staged.received !== staged.declaredSize) {
      return refuse("attachment-incomplete", "This attachment ended before all of it arrived.");
    }
    if (staged.kind === "image" && Buffer.concat(staged.chunks).toString("base64").length > CONVERSATION_IMAGE_MAX_CHARS) {
      return refuse("attachment-too-large", "This picture is too large to send.");
    }
    if (staged.kind === "tab" && Buffer.concat(staged.chunks).toString("utf8").length > CONVERSATION_TAB_TEXT_MAX_CHARS) {
      return refuse("attachment-too-large", "The page's text is longer than 50 000 characters.");
    }
    staged.complete = true;
    return { ok: true };
  }

  /** The first piece: what it is, against the limits; a file gets its part file's place. */
  private async begin(piece: AttachPiece): Promise<AttachmentOutcome> {
    const { attachmentId: id, kind, name, size } = piece;
    if (kind === undefined || name === undefined || size === undefined) {
      return refuse("attachment-order", "The first piece of an attachment says what it is.");
    }
    if (piece.thumbnail !== undefined && kind !== "image") return refuse("attachment-type", "Only a picture has a thumbnail.");
    if (piece.tab !== undefined && kind !== "tab") return refuse("attachment-type", "Only the tab has an address.");
    const counts = { image: 0, file: 0, tab: 0 };
    let filesBytes = 0;
    for (const other of this.staged.values()) {
      counts[other.kind] += 1;
      if (other.kind === "file") filesBytes += other.declaredSize;
    }
    const staged: Staged = { id, kind, name, declaredSize: size, received: 0, nextIndex: 0, complete: false, chunks: [], armed: 0 };
    switch (kind) {
      case "image": {
        if (counts.image >= CONVERSATION_MAX_IMAGES) return refuse("attachment-too-many", `At most ${CONVERSATION_MAX_IMAGES} pictures per message.`);
        const mimeType = piece.mimeType;
        if (mimeType === undefined || !(CONVERSATION_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
          return refuse("attachment-type", "Only PNG, JPEG, GIF and WebP pictures can be attached.");
        }
        if (size > IMAGE_MAX_BYTES) return refuse("attachment-too-large", "This picture is too large to send.");
        staged.mimeType = mimeType;
        if (piece.thumbnail !== undefined) staged.thumbnail = piece.thumbnail;
        break;
      }
      case "tab": {
        if (counts.tab >= CONVERSATION_MAX_TABS) return refuse("attachment-too-many", "Only one tab can go with a message.");
        if (piece.tab === undefined) return refuse("attachment-type", "The tab's address and title are missing.");
        if (size > TAB_MAX_BYTES) return refuse("attachment-too-large", "The page's text is longer than 50 000 characters.");
        staged.tab = piece.tab;
        break;
      }
      case "file": {
        if (counts.file >= CONVERSATION_MAX_FILES) return refuse("attachment-too-many", `At most ${CONVERSATION_MAX_FILES} files per message.`);
        if (size > CONVERSATION_FILE_MAX_BYTES) return refuse("attachment-too-large", "A file can be at most 25 MB.");
        if (filesBytes + size > CONVERSATION_FILES_TOTAL_MAX_BYTES) {
          return refuse("attachment-too-large", "The files of one message can be at most 25 MB together.");
        }
        const place = await this.subfolder();
        if (!place.ok) return place;
        staged.partPath = join(place.value!, `.${id}.part`);
        break;
      }
    }
    this.staged.set(id, staged);
    return { ok: true };
  }

  /**
   * `<realpath(folder)>\hallpass-attachments`, made on demand, which must resolve to itself: a
   * junction or link under that name leading anywhere else is refused.
   */
  private async subfolder(): Promise<AttachmentOutcome<string>> {
    let folder: string;
    try {
      folder = await this.fs.realpath(this.options.folder);
    } catch {
      return refuse("attachment-folder-gone", "The conversation's folder is gone, so a file cannot be copied into it.");
    }
    const wanted = join(folder, ATTACHMENTS_FOLDER);
    try {
      await this.fs.mkdir(wanted);
      const real = await this.fs.realpath(wanted);
      if (!samePath(real, wanted)) throw new Error("the attachments folder leads outside the conversation folder");
    } catch (error) {
      this.options.log?.("conversation.attachment-folder-refused", errorCode(error) ?? "outside");
      return refuse("attachment-write-failed", `Hallpass could not use the ${ATTACHMENTS_FOLDER} folder in the conversation's folder.`);
    }
    if (!this.swept) {
      this.swept = true;
      await this.sweep(wanted);
    }
    await this.removeLeftovers();
    return { ok: true, value: wanted };
  }

  /**
   * T618: part files older than the expiry, left by a broker that ended mid-transfer. Nothing but a
   * `.<id>.part` name is touched, and none this store is staging; a failure only leaves it there.
   */
  private async sweep(folder: string): Promise<void> {
    const mine = new Set([...this.staged.values()].flatMap((staged) => (staged.partPath === undefined ? [] : [staged.partPath])));
    const now = (this.options.wallNow ?? Date.now)();
    const names = await this.fs.readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      if (!PART_NAME.test(name)) continue;
      const path = join(folder, name);
      if (mine.has(path)) continue;
      const modified = await this.fs.mtimeMs(path).catch(() => undefined);
      if (modified === undefined || now - modified <= this.expiryMs) continue;
      await this.fs.unlink(path).catch(() => undefined);
    }
  }

  /** T618: part files whose removal failed after their link; one more try each. */
  private async removeLeftovers(): Promise<void> {
    for (const path of [...this.leftovers]) {
      try {
        await this.fs.unlink(path);
        this.leftovers.delete(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") this.leftovers.delete(path);
      }
    }
  }

  private find(ids: readonly string[]): { ok: true; value: Staged[] } | { ok: false; error: ConversationError } {
    if (new Set(ids).size !== ids.length) return refuse("attachment-unknown", "The same attachment was named twice.");
    const chosen: Staged[] = [];
    for (const id of ids) {
      const staged = this.staged.get(id);
      if (staged === undefined) return refuse("attachment-unknown", "An attachment of this message is no longer held; add it again.");
      if (!staged.complete) return refuse("attachment-incomplete", "An attachment of this message has not fully arrived.");
      chosen.push(staged);
    }
    return { ok: true, value: chosen };
  }

  private async claim(ids: readonly string[]): Promise<TakeOutcome> {
    const found = this.find(ids);
    if (!found.ok) return found;
    const chosen = found.value;
    const ready: ReadyAttachment[] = [];
    let place: string | undefined;
    for (const staged of chosen) {
      if (staged.kind === "image") {
        ready.push({
          kind: "image",
          id: staged.id,
          name: staged.name,
          size: staged.declaredSize,
          mimeType: staged.mimeType!,
          data: Buffer.concat(staged.chunks).toString("base64"),
          ...(staged.thumbnail === undefined ? {} : { thumbnail: staged.thumbnail }),
        });
        continue;
      }
      if (staged.kind === "tab") {
        ready.push({
          kind: "tab",
          id: staged.id,
          name: staged.name,
          size: staged.declaredSize,
          ...staged.tab!,
          text: Buffer.concat(staged.chunks).toString("utf8"),
        });
        continue;
      }
      if (place === undefined) {
        const checked = await this.subfolder();
        if (!checked.ok) {
          await this.removePlaced(ready);
          return checked;
        }
        place = checked.value!;
      }
      const placed = await this.place(staged, place);
      if (!placed.ok) {
        await this.removePlaced(ready);
        return placed;
      }
      ready.push({ kind: "file", id: staged.id, name: basename(placed.value!), size: staged.declaredSize, path: placed.value! });
    }
    for (const staged of chosen) {
      staged.timer?.cancel();
      this.staged.delete(staged.id);
    }
    return { ok: true, value: ready };
  }

  /** The part file under its final name: exclusive, ` (n)` past a taken one, then the part removed. */
  private async place(staged: Staged, folder: string): Promise<AttachmentOutcome<string>> {
    const part = staged.partPath!;
    const base = sanitizeAttachmentName(staged.name);
    let linkWorks = true;
    for (let n = 1; n <= MAX_NAME_NUMBER; n++) {
      const name = n === 1 ? base : numberedName(base, n);
      const target = join(folder, name);
      if (!samePath(dirname(target), folder) || basename(target) !== name) {
        return refuse("attachment-write-failed", "Hallpass refused a file name that leads outside the attachments folder.");
      }
      if (linkWorks) {
        try {
          await this.fs.link(part, target);
        } catch (error) {
          if (errorCode(error) === "EEXIST") continue;
          linkWorks = false;
        }
      }
      if (!linkWorks) {
        try {
          await this.fs.copyExclusive(part, target);
        } catch (error) {
          if (errorCode(error) === "EEXIST") continue;
          // The exclusive copy did not find the name taken, so whatever is there now is this call's.
          await this.fs.unlink(target).catch(() => undefined);
          return this.writeFailure(error);
        }
      }
      await this.removePart(part);
      staged.partPath = undefined;
      return { ok: true, value: target };
    }
    return refuse("attachment-write-failed", `Too many files named ${base} already; rename the file and attach it again.`);
  }

  /**
   * T618: the part once its bytes have their final name. Another process (a scanner, the indexer)
   * may hold it a moment: one retry after a short wait, then it is remembered and tried again on
   * `clear` and on the next use of the folder rather than forgotten.
   */
  private async removePart(part: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.fs.unlink(part);
        return;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        if (attempt === 0) await delay(PART_RETRY_MS);
      }
    }
    this.options.log?.("conversation.attachment-part-kept", "remove-failed");
    this.leftovers.add(part);
  }

  private async removePlaced(ready: readonly ReadyAttachment[]): Promise<void> {
    for (const attachment of ready) if (attachment.kind === "file") await this.fs.unlink(attachment.path).catch(() => undefined);
  }

  /** A write that failed because the folder went away says so; anything else is a write failure. */
  private async writeFailure(error: unknown): Promise<{ ok: false; error: ConversationError }> {
    const gone = await this.fs.realpath(this.options.folder).then(
      () => false,
      () => true,
    );
    if (gone) return refuse("attachment-folder-gone", "The conversation's folder is gone, so a file cannot be copied into it.");
    this.options.log?.("conversation.attachment-write-failed", errorCode(error) ?? "unknown");
    return refuse("attachment-write-failed", "Hallpass could not write the file into the conversation's folder.");
  }

  private arm(staged: Staged, ms: number): void {
    staged.timer?.cancel();
    const armed = ++staged.armed;
    staged.timer = this.options.clock.setTimer(() => {
      staged.timer = undefined;
      void this.serial(async () => {
        // T618: a piece queued before this drop re-armed the attachment; its own timer decides now.
        if (this.staged.get(staged.id) === staged && staged.armed === armed) await this.drop(staged.id);
      });
    }, ms);
  }

  private async drop(id: string): Promise<void> {
    const staged = this.staged.get(id);
    if (staged === undefined) return;
    this.staged.delete(id);
    staged.timer?.cancel();
    if (staged.partPath !== undefined) await this.fs.unlink(staged.partPath).catch(() => undefined);
  }

  private async dropAll(): Promise<void> {
    for (const id of [...this.staged.keys()]) await this.drop(id);
  }
}

/** Windows paths compare without case. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
