import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { HostEnvironment } from "./host-paths.js";
import { uploadConfigPath } from "./upload-policy.js";

/**
 * The only writer of `config.json` (014 FR-194, contracts/upload-directory.md).
 *
 * `upload-policy.ts` reads that file and decides uploads from it; this writes it, and the two are
 * separate on purpose. The reader is fail-closed and runs on the path of every `file_upload`; the
 * writer runs only when the owner has answered a card, and it is the one place that may make the
 * list *wider*. Keeping them apart is what lets the contract test assert that the request handlers
 * of the MCP server never reach this module (T381): an agent has no route to the list at all, and
 * that is a claim about the import graph rather than about anybody's discipline.
 *
 * Two processes write here - the server when the owner says "from now on", the relay when they
 * revoke a row - so every change is read-merge-write onto a temp file and a rename over the real
 * one. A rename is the atomic step: the reader either sees the file it saw before or the whole new
 * one, never half a document, which for a fail-closed reader would mean "no directories at all"
 * and an upload refused for no reason the owner could see. A lost update needs two owner actions
 * inside the same few milliseconds and is undone by repeating the one that lost (R-187 §5).
 *
 * What it will not do: create a directory the owner named, or keep one that has gone. A candidate
 * is a directory that exists, spelled absolutely, at the moment they answer - anything else is
 * refused and nothing is written, because a root that resolves to something else later is exactly
 * what the `realpath` rule in the reader exists to stop.
 */

/** The list as the file now reads, and where the file is: the shape `upload-roots` carries. */
export type UploadRootsListing = {
  roots: string[];
  path: string;
  /**
   * The file exists and could not be read as a list (014 FR-194).
   *
   * Treated as `[]`, exactly as `readUploadConfig` treats it, and said out loud rather than shown
   * as "no directories": a file the owner hand-edited into invalid JSON may name ten directories,
   * and a panel that quietly reported none would be telling them their list was empty.
   */
  malformed?: boolean;
  /**
   * The name of the copy this module made of a file it could not read (S3 review F4).
   *
   * `config.json.invalid`, beside the real one. The list is fail-closed, so an unreadable document
   * is read as no directories at all - and the first "from now on" after that used to write a
   * fresh document straight over it. A hand-edited file naming ten directories would be gone with
   * no copy and nothing said. One copy is kept, the newest, and it is named here so the panel can
   * tell the owner where their document went and the agent never has to.
   */
  preserved?: string;
};

/** Why one candidate was not added. Never a message for the agent: the owner's panel and the log. */
export type UploadRootRefusalReason = "not-absolute" | "not-a-directory" | "write-failed";

export type UploadRootsChange = {
  listing: UploadRootsListing;
  refused: Array<{ candidate: string; reason: UploadRootRefusalReason }>;
  /** Whether the file on disk changed. A candidate already on the list changes nothing. */
  written: boolean;
};

export type UploadConfigStore = {
  /** Where the file is, for the panel's own row. */
  path: () => string;
  list: () => Promise<UploadRootsListing>;
  add: (candidates: readonly string[]) => Promise<UploadRootsChange>;
  remove: (root: string) => Promise<UploadRootsChange>;
};

/** The note the installer's template carries, re-written onto a file this module creates. */
const CONFIG_NOTE = "Absolute directories the local agent may upload files from. Empty means no uploads at all.";

/** What a file this module could not read is renamed to, beside the real one (S3 review F4). */
const INVALID_SUFFIX = ".invalid";

/**
 * How many writes this process has made, for the temp file's name (S3 review F5).
 *
 * Module-scoped rather than per store, because two stores in one process are two writers of one
 * file: the pid tells this process's temp files from another's, and the counter tells its own
 * apart. `config.json.tmp` was one name for all of them - several servers and the relay - so two
 * writes in flight wrote the same temp file and a rename could publish half of each. The reader is
 * fail-closed, so half a document means "no directories at all" and an upload refused for a reason
 * the owner could not see anywhere.
 */
let writeCounter = 0;

async function realDirectory(candidate: string): Promise<string | undefined> {
  try {
    const real = await realpath(resolve(candidate));
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The stored spelling of a root, resolved; `undefined` for one that is not there today. */
async function realOf(root: string): Promise<string | undefined> {
  return realDirectory(root);
}

function sameRoot(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  // Case-insensitively on Windows, where two spellings of one path are one path - the same rule
  // `within()` applies in the reader, and the two must agree or a de-duplicated list would still
  // admit a file twice.
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function createUploadConfigStore(env: HostEnvironment = process.env): UploadConfigStore {
  const path = uploadConfigPath(env);
  /**
   * One change at a time inside this process.
   *
   * It is not the cross-process guard - there isn't one, and R-187 §5 says why that is acceptable -
   * but two answers arriving in one process (two sessions, two cards) would otherwise read the same
   * file and write two lists, each missing the other's directory. Here they queue.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    // The queue must not reject, or every later change would be handed a rejected promise.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The file as an object, plus what the list reads as. Unknown keys are the owner's; they stay. */
  async function read(): Promise<{ document: Record<string, unknown>; roots: string[]; malformed: boolean }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      // Absent is not malformed: nobody has answered a card yet, and the list is empty.
      return { document: { "//": CONFIG_NOTE }, roots: [], malformed: false };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { document: { "//": CONFIG_NOTE }, roots: [], malformed: true };
      }
      const document = parsed as Record<string, unknown>;
      const listed = Array.isArray(document.uploadRoots) ? document.uploadRoots : undefined;
      if (listed === undefined) {
        return { document, roots: [], malformed: true };
      }
      // The same filter the reader applies, so the panel shows the list the host will actually use.
      return {
        document,
        roots: listed.filter(
          (root): root is string => typeof root === "string" && root.length > 0 && isAbsolute(root),
        ),
        malformed: false,
      };
    } catch {
      return { document: { "//": CONFIG_NOTE }, roots: [], malformed: true };
    }
  }

  /**
   * Temp file, then rename. Returns whether the file on disk is now the new one, and the name of
   * the copy kept of one that could not be read.
   *
   * `preserve` is the unreadable case (S3 review F4): the document about to be written is this
   * module's own template, not the owner's, so the owner's is moved aside *first* and the write
   * only happens if that move did. One copy is kept - the rename replaces an older one - because
   * the file that matters is the one they last had, and a directory filling with dated copies is
   * not a thing anybody asked this host to keep.
   */
  async function write(
    document: Record<string, unknown>,
    roots: string[],
    preserve = false,
  ): Promise<{ written: boolean; preserved?: string }> {
    // Its own name per write and per process (S3 review F5): a rename is only atomic if the file
    // being renamed is nobody else's.
    const temporary = `${path}.${process.pid}.${(writeCounter += 1)}.tmp`;
    let preserved: string | undefined;
    if (preserve) {
      try {
        await rename(path, `${path}${INVALID_SUFFIX}`);
        preserved = `${basename(path)}${INVALID_SUFFIX}`;
      } catch {
        // Nothing could be moved aside, so nothing is written over: the owner's document stays
        // exactly as it is and their answer is reported as unrecorded, which is what it is.
        return { written: false };
      }
    }
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ ...document, uploadRoots: roots }, null, 2)}\n`, "utf8");
      await rename(temporary, path);
      return { written: true, ...(preserved === undefined ? {} : { preserved }) };
    } catch {
      // Whatever went wrong, the file the reader uses has not been touched. The temp file is swept
      // if it is ours to sweep; a failure here is not a second failure to report.
      await rm(temporary, { force: true }).catch(() => undefined);
      return { written: false, ...(preserved === undefined ? {} : { preserved }) };
    }
  }

  /** Whether a copy of an unreadable document is standing beside the file (S3 review F4). */
  async function preservedCopy(): Promise<string | undefined> {
    try {
      await stat(`${path}${INVALID_SUFFIX}`);
      return `${basename(path)}${INVALID_SUFFIX}`;
    } catch {
      return undefined;
    }
  }

  function listingOf(roots: string[], malformed: boolean, preserved?: string): UploadRootsListing {
    return {
      roots,
      path,
      ...(malformed ? { malformed: true } : {}),
      ...(preserved === undefined ? {} : { preserved }),
    };
  }

  return {
    path: () => path,
    async list() {
      const current = await read();
      // The copy is a standing fact about the owner's machine, not an event: the relay answers this
      // in another process and days later, and the panel's row is the only place they are told
      // where their unreadable document went (S3 review F4).
      return listingOf(current.roots, current.malformed, await preservedCopy());
    },
    add(candidates) {
      return serialise(async () => {
        const current = await read();
        const refused: UploadRootsChange["refused"] = [];
        const roots = [...current.roots];
        // Resolved once, before anything is added, so a candidate is compared against the list as
        // the reader will compare a file against it.
        const existing = await Promise.all(roots.map(realOf));
        let changed = false;
        for (const candidate of candidates) {
          if (!isAbsolute(candidate)) {
            refused.push({ candidate, reason: "not-absolute" });
            continue;
          }
          const real = await realDirectory(candidate);
          if (real === undefined) {
            refused.push({ candidate, reason: "not-a-directory" });
            continue;
          }
          if (existing.some((root) => sameRoot(root, real))) continue;
          roots.push(real);
          existing.push(real);
          changed = true;
        }
        if (!changed) {
          return { listing: listingOf(current.roots, current.malformed && refused.length === 0), refused, written: false };
        }
        /**
         * The owner's document is moved aside before this one is written (S3 review F4).
         *
         * Only when it could not be read: the write below carries this module's template, and the
         * template over a file naming ten directories the owner hand-edited into invalid JSON is
         * the one deletion nothing here would ever be asked for.
         */
        const written = await write(
          current.malformed ? { "//": CONFIG_NOTE } : current.document,
          roots,
          current.malformed,
        );
        if (!written.written) {
          // The owner's answer could not be recorded. Every candidate they named is refused for
          // the one reason, and the list they are shown is the list that is still on disk.
          return {
            listing: listingOf(current.roots, current.malformed, written.preserved),
            refused: [
              ...refused,
              ...candidates
                .filter((candidate) => !refused.some((entry) => entry.candidate === candidate))
                .map((candidate) => ({ candidate, reason: "write-failed" as const })),
            ],
            written: false,
          };
        }
        // `malformed` stands on this answer even though the file now reads perfectly: it is about
        // the document the owner had, and it is the half of the notice that says why there is a
        // copy beside it at all.
        return { listing: listingOf(roots, current.malformed, written.preserved), refused, written: true };
      });
    },
    remove(root) {
      return serialise(async () => {
        const current = await read();
        const target = await realOf(root);
        const existing = await Promise.all(current.roots.map(realOf));
        // Matched by real path where both resolve, and by the stored spelling otherwise: a row for
        // a directory that has since been deleted must still be revocable.
        const kept = current.roots.filter((entry, index) => !(sameRoot(existing[index], target) || entry === root));
        if (kept.length === current.roots.length) {
          return { listing: listingOf(current.roots, current.malformed), refused: [], written: false };
        }
        // The same preservation as an add's (S3 review F4): a revoke is a write too, and a write
        // over a document nobody could read is the same loss whichever press caused it.
        const written = await write(
          current.malformed ? { "//": CONFIG_NOTE } : current.document,
          kept,
          current.malformed,
        );
        if (!written.written) {
          return {
            listing: listingOf(current.roots, current.malformed, written.preserved),
            refused: [{ candidate: root, reason: "write-failed" }],
            written: false,
          };
        }
        return { listing: listingOf(kept, current.malformed, written.preserved), refused: [], written: true };
      });
    },
  };
}
