import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { AGENT_UPLOAD_MAX_BASE64_CHARS, AGENT_UPLOAD_MAX_FILES } from "@hallpass/contracts";
import { hostDataDirectory, type HostEnvironment } from "./host-paths.js";

/**
 * Which of the owner's files an agent may put into a page (003/T062, US7, FR-051).
 *
 * This is the only part of the feature that touches a file system, and it is deliberately here, in
 * the host: the host is the owner's own process, started by their own agent, and the extension on
 * the other side of the link has no file API at all. So the decision is made once, in one place,
 * and what crosses to the browser is bytes.
 *
 * Two rules, and the order between them is the point. A path is checked against the roots the owner
 * configured *before* it is opened - `realpath` first, so a `..` and a symlink out of a root are the
 * same refusal - and only then is anything read. A check made after the read would already have done
 * the thing the roots exist to prevent.
 *
 * The default allows nothing. An installation nobody has configured cannot upload, which is why the
 * installer writes an empty list rather than leaving the file absent for the code to interpret.
 */

/**
 * How many base64 characters a file of this many bytes becomes (003/C4).
 *
 * The bound the *worker* enforces is on the encoded text, because that is what a frame carries and
 * what the contract's schema measures. Measuring the bytes instead is off by the padding of every
 * file: three files that fit as bytes can fail as base64, and the host would have read all three
 * before the extension refused the frame it built - having already done the reading the bound
 * exists to prevent.
 */
function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export type UploadConfig = { uploadRoots: string[] };

export type UploadFile = { name: string; type: string; bytesBase64: string };

/** Why a call was refused. One word each, stable, and never a path - the log is not a disclosure. */
export type UploadRefusalCode =
  | "outside-roots"
  | "too-many-files"
  | "too-large"
  | "not-a-file";

export type UploadResolution =
  | { ok: true; files: UploadFile[] }
  | { ok: false; reason: "upload-not-allowed"; code: UploadRefusalCode };

export function uploadConfigPath(env: HostEnvironment = process.env): string {
  return join(hostDataDirectory(env), "config.json");
}

/**
 * What the installer writes. The comment key is there because the owner meets this list in a text
 * editor rather than in a document: the file has to explain itself where it is found.
 */
export const UPLOAD_CONFIG_TEMPLATE = JSON.stringify(
  {
    "//": "Absolute directories the local agent may upload files from. Empty means no uploads at all.",
    uploadRoots: [],
  },
  null,
  2,
);

/**
 * The owner's configuration, read tolerantly.
 *
 * Every way of failing to read it - absent, unparsable, the wrong shape - means the same thing and
 * is answered the same way: no roots. A malformed file must not be a wider permission than a missing
 * one, and neither may be an error the agent could interpret as "try again without the check".
 */
export async function readUploadConfig(env: HostEnvironment = process.env): Promise<UploadConfig> {
  try {
    const raw = JSON.parse(await readFile(uploadConfigPath(env), "utf8")) as { uploadRoots?: unknown };
    const roots = Array.isArray(raw.uploadRoots) ? raw.uploadRoots : [];
    return {
      uploadRoots: roots.filter(
        (root): root is string => typeof root === "string" && root.length > 0 && isAbsolute(root),
      ),
    };
  } catch {
    return { uploadRoots: [] };
  }
}

/** Whether `target` is the root itself or sits inside it. Both already resolved to real paths. */
function within(root: string, target: string): boolean {
  if (root === target) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  // Case-insensitively on Windows, where two spellings of one path are one path.
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

/** A small, closed table. An extension nobody listed is bytes, which every browser accepts. */
const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".zip": "application/zip",
};

function mimeTypeOf(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** The file's own name, never the path it came from: the page is told what, not where. */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? "";
}

export async function resolveUploadFiles(
  paths: readonly string[],
  config: UploadConfig,
): Promise<UploadResolution> {
  if (paths.length === 0 || paths.length > AGENT_UPLOAD_MAX_FILES) {
    return { ok: false, reason: "upload-not-allowed", code: "too-many-files" };
  }
  const roots: string[] = [];
  for (const root of config.uploadRoots) {
    try {
      roots.push(await realpath(resolve(root)));
    } catch {
      // A root that is not there decides nothing. It is not an error either: the owner may have
      // listed a drive that is not mounted today.
    }
  }

  const allowed: Array<{ path: string; size: number }> = [];
  let total = 0;
  for (const candidate of paths) {
    let real: string;
    try {
      // Resolved before anything is opened, and resolved *through* symlinks: a link inside a root
      // pointing outside it is the file it points at, and that file is what would be read.
      real = await realpath(resolve(candidate));
    } catch {
      return { ok: false, reason: "upload-not-allowed", code: "not-a-file" };
    }
    if (!roots.some((root) => within(root, real))) {
      return { ok: false, reason: "upload-not-allowed", code: "outside-roots" };
    }
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile()) {
      return { ok: false, reason: "upload-not-allowed", code: "not-a-file" };
    }
    total += base64Chars(info.size);
    if (total > AGENT_UPLOAD_MAX_BASE64_CHARS) {
      return { ok: false, reason: "upload-not-allowed", code: "too-large" };
    }
    allowed.push({ path: real, size: info.size });
  }

  // Only now, with every path decided, is anything opened.
  const files: UploadFile[] = [];
  for (const entry of allowed) {
    const bytes = await readFile(entry.path);
    files.push({
      name: fileNameOf(entry.path),
      type: mimeTypeOf(entry.path),
      bytesBase64: bytes.toString("base64"),
    });
  }
  return { ok: true, files };
}
