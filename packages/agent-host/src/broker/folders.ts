import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, win32 } from "node:path";
import { z } from "zod";
import { CONVERSATION_MAX_FOLDERS, conversationFolderEntrySchema, type ConversationError, type ConversationFolderEntry } from "@hallpass/contracts";
import { writeHostFileAtomically } from "../bridge-link.js";
import type { FolderList } from "./conversation-index.js";
import { readHostJsonFile } from "./index-store.js";
import { redact } from "./redact.js";
import { runCommand, type RunResult } from "./run-command.js";

/**
 * The owner's folders and the conversations' scratch folders (019 T562; R-319, R-320, FR-303,
 * D-019-1, D-019-8, D-019-9).
 *
 * - `<data>\folders.json` = `{ "version": 1, "folders": [{ path, addedAt }] }`, at most 30, written
 *   like the index: re-read, temp + rename, a corrupt file kept aside (`index-store.ts`).
 * - Scratch folders are `<data>\scratch\<conversationId>`, made when a conversation starts and never
 *   deleted by Hallpass (D-019-8): nothing here can delete one.
 * - "Add folder" opens the Windows folder dialog through `powershell.exe -NoProfile -STA`, a
 *   `FolderBrowserDialog` owned by a top-most, invisible form so it does not open behind Chrome
 *   (R-320's mitigation; the z-order is checked by hand, T562). One dialog at a time: a second
 *   request while it is open joins the first and gets the same answer - two panel documents asking
 *   at once (FR-288) are one owner wanting one folder, and a refusal would show an error for
 *   something that is in fact on screen.
 * - Under PowerShell Constrained Language Mode the dialog cannot be created; the script says so
 *   before trying, and the answer is `path-entry`: the panel offers a typed path instead, checked for
 *   existence here (R-320 finding 10).
 * - "Open folder" starts `explorer.exe` with the path as its one argument, no shell.
 *
 * Every process launch is injected, so no test opens a dialog or an Explorer window.
 */

export function folderListPath(dataDir: string): string {
  return join(dataDir, "folders.json");
}

/** D-019-8: one scratch folder per conversation, derived from its id (which is safe as a name). */
export function scratchFolderPath(dataDir: string, conversationId: string): string {
  return win32.join(dataDir, "scratch", conversationId);
}

/** Makes the conversation's scratch folder if it is not there; `undefined` when it cannot be made. */
export async function ensureScratchFolder(dataDir: string, conversationId: string): Promise<string | undefined> {
  const path = scratchFolderPath(dataDir, conversationId);
  try {
    await mkdir(path, { recursive: true });
    return path;
  } catch {
    return undefined;
  }
}

export const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** An absolute drive or UNC path within the contract's bounds; nothing relative reaches `stat` or Explorer. */
export function isAbsoluteFolderPath(path: string): boolean {
  return path.length >= 3 && path.length <= 1024 && /^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+)/u.test(path);
}

/* ------------------------------------------------------------------------------------------- */
/* folders.json                                                                                 */
/* ------------------------------------------------------------------------------------------- */

const folderFileSchema = z.strictObject({ version: z.literal(1), folders: z.array(conversationFolderEntrySchema) });

/**
 * T578: `C:\work\proj`, `C:\work\proj\` and `C:\work\proj/` are one folder. The trailing separators
 * go; a drive root (`C:\`) keeps its one, since `C:` alone is the drive's current directory.
 */
export function normalizeFolderPath(path: string): string {
  if (/^[A-Za-z]:[\\/]*$/u.test(path)) return `${path.slice(0, 2)}\\`;
  return path.replace(/[\\/]+$/u, "");
}

const sameFolder = (a: string, b: string) => normalizeFolderPath(a).toLowerCase() === normalizeFolderPath(b).toLowerCase();

export function fileFolderList(options: { path: string; now?: () => number; log?: (code: string, detail?: string) => void }): FolderList {
  const { path } = options;
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();

  /** Entries stored before T578 that differ only by the separator are one row (the oldest stays). */
  const unique = (folders: ConversationFolderEntry[]): ConversationFolderEntry[] => {
    const seen = new Set<string>();
    const kept: ConversationFolderEntry[] = [];
    for (const folder of folders) {
      const key = normalizeFolderPath(folder.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ ...folder, path: normalizeFolderPath(folder.path) });
    }
    return kept;
  };

  const read = async (): Promise<ConversationFolderEntry[]> => {
    const result = await readHostJsonFile(path, folderFileSchema, now());
    if (result.kind === "ok") return unique(result.value.folders).slice(-CONVERSATION_MAX_FOLDERS);
    if (result.kind === "kept-aside") options.log?.("broker.folders-unreadable", result.keptAs);
    return [];
  };

  /** Re-read, change, write temp + rename; one change of this broker at a time. */
  const change = <T>(apply: (folders: ConversationFolderEntry[]) => { folders: ConversationFolderEntry[]; result: T }): Promise<T> => {
    const run = async () => {
      const before = await read();
      const { folders, result } = apply(before);
      if (folders !== before) {
        await writeHostFileAtomically(path, { version: 1, folders: folders.slice(-CONVERSATION_MAX_FOLDERS) });
      }
      return result;
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    list: () => read(),
    has: async (wanted) => (await read()).some((folder) => sameFolder(folder.path, wanted)),
    add: (added, addedAt) =>
      change((folders) => ({
        // At the cap the oldest folder leaves the list (as the S4 seam did); the folder itself is untouched.
        folders: folders.some((folder) => sameFolder(folder.path, added)) ? folders : [...folders, { path: normalizeFolderPath(added), addedAt }],
        result: undefined,
      })),
    remove: (removed) =>
      change((folders) => {
        const kept = folders.filter((folder) => !sameFolder(folder.path, removed));
        return kept.length === folders.length ? { folders, result: false } : { folders: kept, result: true };
      }),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The dialog and Explorer                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** Runs the dialog's process to its end; `runCommand` by default. */
export type DialogRun = (command: string, args: readonly string[]) => Promise<RunResult>;
/** Starts a process and lets it go (Explorer); never through a shell. */
export type Launch = (command: string, args: readonly string[]) => void;

/** The script exits with this when it will not try the dialog (Constrained Language Mode). */
const EXIT_LANGUAGE_MODE = 3;
/** A dialog left open this long is closed; the owner can open it again. */
const DIALOG_BOUND_MS = 15 * 60_000;

/**
 * R-320. Single quotes only - the script travels as one command-line argument, and a double quote
 * would be re-escaped on the way. The language mode is checked first, with nothing Constrained
 * Language Mode refuses; the chosen path is printed as base64 of its UTF-8 bytes so a folder name
 * in any script survives the console's code page.
 */
const DIALOG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$languageMode = [string]$ExecutionContext.SessionState.LanguageMode",
  `if ($languageMode -ne 'FullLanguage') { Write-Output ('MODE:' + $languageMode); exit ${EXIT_LANGUAGE_MODE} }`,
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.FormBorderStyle = 'None'",
  "$owner.Opacity = 0",
  "$owner.Width = 1",
  "$owner.Height = 1",
  "$owner.StartPosition = 'CenterScreen'",
  "$owner.Show()",
  "$owner.Activate()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Choose a folder for Hallpass conversations'",
  "$dialog.ShowNewFolderButton = $true",
  "$answer = $dialog.ShowDialog($owner)",
  "$owner.Close()",
  "if ($answer -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) { Write-Output ('PATH:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))) } else { Write-Output 'CANCEL' }",
  "exit 0",
].join("\n");

export const FOLDER_DIALOG_COMMAND = "powershell.exe";
export const FOLDER_DIALOG_ARGS: readonly string[] = ["-NoProfile", "-NonInteractive", "-STA", "-Command", DIALOG_SCRIPT];

export type DialogOutcome =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" }
  | { kind: "path-entry"; detail: string }
  | { kind: "failed"; detail: string };

/** What the dialog's process said, from its exit code and its marker line. */
export function parseDialogResult(result: RunResult): DialogOutcome {
  if (result.timedOut) return { kind: "failed", detail: "The folder dialog was left open too long and was closed; open it again." };
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim());
  const mode = lines.find((line) => line.startsWith("MODE:"));
  if (result.code === EXIT_LANGUAGE_MODE && mode !== undefined) {
    return {
      kind: "path-entry",
      detail: `PowerShell runs in ${mode.slice(5) || "a restricted"} mode on this computer, so the folder dialog cannot open; type or paste the folder's path instead.`,
    };
  }
  if (result.code === 0) {
    if (lines.includes("CANCEL")) return { kind: "cancelled" };
    const picked = lines.find((line) => line.startsWith("PATH:"));
    if (picked !== undefined) return { kind: "picked", path: Buffer.from(picked.slice(5), "base64").toString("utf8") };
  }
  return { kind: "failed", detail: `The folder dialog could not open${result.code === null ? "" : ` (exit ${result.code})`}.` };
}

export type AddFolderResult =
  | { kind: "added"; path: string }
  | { kind: "cancelled" }
  | { kind: "path-entry"; detail: string }
  | { kind: "failed"; error: ConversationError };

export type FolderActions = {
  /** The dialog, then the chosen folder into the list (one dialog at a time). */
  addFromDialog(): Promise<AddFolderResult>;
  /** The Constrained Language Mode fallback: a typed path, added only if it is an existing folder. */
  addTyped(path: string): Promise<AddFolderResult>;
  /** Explorer on an existing folder; `folder-missing` when it is gone. */
  open(path: string): Promise<{ ok: true } | { ok: false; error: ConversationError }>;
};

const failure = (code: ConversationError["code"], detail: string) => ({ code, detail: redact(detail).slice(0, 600) });

/** Explorer, detached and without a shell: the path is one argv element. */
export const launchDetached: Launch = (command, args) => {
  const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
};

export function createFolderActions(options: {
  folders: FolderList;
  now?: () => number;
  runDialog?: DialogRun;
  launch?: Launch;
  log?: (code: string, detail?: string) => void;
}): FolderActions {
  const { folders } = options;
  const now = options.now ?? Date.now;
  const runDialog: DialogRun = options.runDialog ?? ((command, args) => runCommand(command, args, { timeoutMs: DIALOG_BOUND_MS }));
  const launch = options.launch ?? launchDetached;
  const log = options.log ?? (() => undefined);
  let open: Promise<AddFolderResult> | undefined;

  const addExisting = async (given: string): Promise<AddFolderResult> => {
    const path = normalizeFolderPath(given);
    if (!isAbsoluteFolderPath(path) || !(await isDirectory(path))) {
      return { kind: "failed", error: failure("folder-missing", `${path} is not an existing folder.`) };
    }
    await folders.add(path, new Date(now()).toISOString());
    return { kind: "added", path };
  };

  const pickAndAdd = async (): Promise<AddFolderResult> => {
    let outcome: DialogOutcome;
    try {
      outcome = parseDialogResult(await runDialog(FOLDER_DIALOG_COMMAND, FOLDER_DIALOG_ARGS));
    } catch (error) {
      outcome = { kind: "failed", detail: `The folder dialog could not start: ${error instanceof Error ? error.message : "unknown"}` };
    }
    switch (outcome.kind) {
      case "picked":
        return addExisting(outcome.path);
      case "cancelled":
        return outcome;
      case "path-entry":
        log("broker.folder-dialog-language-mode");
        return outcome;
      case "failed":
        log("broker.folder-dialog-failed", outcome.detail);
        return { kind: "failed", error: failure("broker-unavailable", outcome.detail) };
    }
  };

  return {
    addFromDialog() {
      open ??= pickAndAdd().finally(() => {
        open = undefined;
      });
      return open;
    },
    addTyped: (path) => addExisting(path.trim()),
    async open(path) {
      if (!isAbsoluteFolderPath(path) || !(await isDirectory(path))) {
        return { ok: false, error: failure("folder-missing", "This conversation's folder does not exist any more.") };
      }
      launch("explorer.exe", [path]);
      return { ok: true };
    },
  };
}
