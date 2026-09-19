/**
 * The `chrome.downloads` surface the agent path uses (005/T179, FR-076, D-005-2; 008/T219, FR-107).
 *
 * Two subscriptions and one write. The permission was traced to *observing* the browser's downloads
 * so a session can be told the name and state of a file a page produced, and 008 adds exactly one
 * thing the extension asks the browser to write: the GIF a session's recording was encoded into
 * (FR-107, R-137). It is a file this extension made, from bytes it holds, into the browser's own
 * download folder - and it goes through the download facility rather than around it precisely so
 * that the owner sees it in their downloads like anything else, and so the session's own
 * `downloads_context` can list it.
 *
 * Every *other* member of the API - `open`, `show`, `acceptDanger`, `pause`, `resume`, `cancel`,
 * `removeFile`, `erase`, `search` - is an action on the owner's existing files, and none of them is
 * reachable through this module. `download-observer.test.ts` reads this file and holds it to that.
 *
 * The browser's record is translated here into the words the contract uses, so nothing downstream
 * has to know the platform's enums: its `interrupted` is a `failed` unless the owner did it, and its
 * danger vocabulary is one flag.
 */

/** A download as the browser reports it at creation, in the contract's words (no attribution yet). */
export type DownloadSnapshot = {
  id: number;
  url: string;
  /** The saved path; empty until the browser has decided it (edge case in the spec). */
  filename: string;
  state: "in_progress" | "complete" | "failed" | "canceled";
  startedAt: string;
  endedAt?: string;
  bytesReceived: number;
  totalBytes: number;
  danger: boolean;
};

/** What one change says; only the fields the browser reported as changed are present. */
export type DownloadDelta = {
  id: number;
  filename?: string;
  state?: DownloadSnapshot["state"];
  endedAt?: string;
  bytesReceived?: number;
  totalBytes?: number;
  danger?: boolean;
};

/** The browser's own record; only the fields this module reads. */
type ChromeDownloadItem = {
  id: number;
  url: string;
  filename: string;
  state: string;
  error?: string;
  danger: string;
  startTime: string;
  endTime?: string;
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
};

/** The browser's change record: each changed field as `{ current }`. */
type ChromeDownloadDelta = {
  id: number;
  filename?: { current?: string };
  state?: { current?: string };
  error?: { current?: string };
  danger?: { current?: string };
  endTime?: { current?: string };
  totalBytes?: { current?: number };
  fileSize?: { current?: number };
};

type ChromeDownloads = {
  onCreated: { addListener(callback: (item: ChromeDownloadItem) => void): void };
  onChanged: { addListener(callback: (delta: ChromeDownloadDelta) => void): void };
  download(options: ChromeDownloadOptions): Promise<number>;
};

/** What 008's export asks the browser for, and the only shape this module will express. */
export type ChromeDownloadOptions = {
  /** A blob URL the extension minted; never a page's url and never one an agent named. */
  url: string;
  /** A base name with its extension - no path: `conflictAction` decides what a collision becomes. */
  filename: string;
  /** Always false: the owner is not asked where their agent's recording goes (FR-107). */
  saveAs: boolean;
  conflictAction: "uniquify";
};

function api(): ChromeDownloads | undefined {
  // Only the agent profile declares the permission; a build without it observes nothing, which is
  // the honest state for it rather than a failure.
  return (globalThis as { chrome?: { downloads?: ChromeDownloads } }).chrome?.downloads;
}

/**
 * The browser's states are `in_progress`, `interrupted` and `complete`; an interruption the owner
 * asked for is a cancellation to the agent, and any other is a failure. `error` names the reason
 * and is the only way to tell the two apart.
 */
function stateOf(state: string | undefined, error: string | undefined): DownloadSnapshot["state"] | undefined {
  if (state === "in_progress" || state === "complete") return state;
  if (state === "interrupted") return error === "USER_CANCELED" || error === "USER_SHUTDOWN" ? "canceled" : "failed";
  return undefined;
}

/**
 * The browser's danger vocabulary is many words; the agent is told one fact - flagged or not.
 * "Not yet known" (a scan pending, or nothing said) is not a flag: the agent takes no action either
 * way, and a listing that cried danger on every large file would teach it to ignore the field.
 */
const NOT_FLAGGED = new Set([
  "safe",
  "accepted",
  "deepScannedSafe",
  "deepScannedFailed",
  "allowlistedByPolicy",
  "asyncScanning",
  "asyncLocalPasswordScanning",
  "promptForScanning",
  "promptForLocalPasswordScanning",
  "passwordProtected",
  "blockedTooLarge",
]);
function flagged(danger: string | undefined): boolean {
  return danger !== undefined && !NOT_FLAGGED.has(danger);
}

export function watchDownloadCreated(listener: (item: DownloadSnapshot) => void): void {
  api()?.onCreated.addListener((item) => {
    listener({
      id: item.id,
      url: item.url,
      filename: item.filename ?? "",
      state: stateOf(item.state, item.error) ?? "in_progress",
      startedAt: item.startTime,
      ...(item.endTime === undefined ? {} : { endedAt: item.endTime }),
      bytesReceived: item.bytesReceived ?? 0,
      totalBytes: item.totalBytes ?? -1,
      danger: flagged(item.danger),
    });
  });
}

export function watchDownloadChanged(listener: (delta: DownloadDelta) => void): void {
  api()?.onChanged.addListener((delta) => {
    const state = delta.state === undefined ? undefined : stateOf(delta.state.current, delta.error?.current);
    // The change record carries no `bytesReceived`; the file's size, reported once the bytes are
    // all there, is the closest fact the browser offers and is carried as the bytes received.
    const bytes = delta.fileSize?.current;
    listener({
      id: delta.id,
      ...(delta.filename?.current === undefined ? {} : { filename: delta.filename.current }),
      ...(state === undefined ? {} : { state }),
      ...(delta.endTime?.current === undefined ? {} : { endedAt: delta.endTime.current }),
      ...(bytes === undefined || bytes < 0 ? {} : { bytesReceived: bytes }),
      ...(delta.totalBytes?.current === undefined ? {} : { totalBytes: delta.totalBytes.current }),
      ...(delta.danger?.current === undefined ? {} : { danger: flagged(delta.danger.current) }),
    });
  });
}

/**
 * Writes one file this extension made (008 FR-107, R-137).
 *
 * The url is always a blob URL the offscreen document minted from bytes it encoded itself; nothing
 * here will fetch a page's url or one an agent named, because the caller is the recorder's export
 * and there is no other caller. A build without the permission - the narrow profile - has no
 * `chrome.downloads` at all, which is a failure rather than a silent no-op: an export that answered
 * `ok` without writing anything would be the worst of the three possible outcomes.
 */
export async function downloadFile(options: ChromeDownloadOptions): Promise<number> {
  const downloads = api();
  if (!downloads) throw new Error("downloads-unavailable");
  return downloads.download(options);
}
