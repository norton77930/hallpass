import {
  AGENT_RECORDING_FILENAME_PATTERN,
  AGENT_RECORDING_MAX_FRAMES,
  type AgentRefusal,
  type GifRecorderExportResult,
  type GifRecorderStatusResult,
  type RecordingState,
} from "@hallpass/contracts";
import type { DownloadDelta } from "../../chrome-adapters/downloads.js";
import type { OffscreenAdapter } from "../../chrome-adapters/offscreen.js";
import type { DescribedAction } from "./action-label.js";
import type { FrameCapture } from "./frame-capture.js";

/**
 * One recording per session, from `start` to the file on disk (008/T219, FR-100..FR-103, FR-107,
 * FR-108, D-008-2, D-008-3, R-134, R-137).
 *
 * The worker holds no frame. Each one goes to the offscreen document as it is taken, and what stays
 * here is a summary of four numbers per session in `chrome.storage.session` - re-read on every call,
 * never cached in a variable, because MV3 evicts this worker between tool calls and the reference's
 * answer to that (a keep-alive that holds the worker up for the length of the recording) is the
 * trade D-008-2 rules out. A fresh worker picks the recording up exactly where the evicted one left
 * it, and the frames were never its to lose.
 *
 * **The export sequence** is deliberate and its order is the guarantee (S2 review):
 *
 *   encode → download → *the browser says the file is written* → revoke → clear → count → close
 *
 * Nothing is thrown away before the file exists. A download that failed keeps the frames and the
 * recording's state, so the agent can ask again rather than discovering an empty recorder; only the
 * blob URL goes, because it is this worker's to release either way. The document is closed when the
 * count says no session has frames and no blob URL is outstanding - two questions, because either
 * one alone would close a document that is still holding something.
 *
 * The download itself is the worker's (design-notes §2): an offscreen document has no
 * download API of its own, and the blob URL is the whole of the hand-off. It runs while the session
 * still holds its tabs, which is what lets `download-observer.ts` attribute the file to it at
 * `onCreated` time - the reason FR-108's automatic export happens *before* the tabs go.
 */

/** Where the per-session summaries live; `chrome.storage.session`, so they die with the browser. */
export const AGENT_RECORDINGS_KEY = "agentRecordings";

/** How long a page is given to settle before the frame is taken (FR-101). */
export const RECORDING_SETTLE_MS = 100;

/** The name an export takes when the agent names none (FR-107); local time, as the owner reads it. */
export const RECORDING_DEFAULT_PREFIX = "agent-recording-";

/** The part of a storage area this module uses; `chrome.storage.session` is one. */
type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/** One session's recording as the worker keeps it (data-model Recording). */
export type StoredRecording = {
  state: RecordingState["state"];
  frames: number;
  skipped: number;
  full: boolean;
  startedAt: number;
  /** The `#n` the next action's label carries; the initial frame is 0 and carries none. */
  nextIndex: number;
  /** The last viewport measured for the recorded tab, for a capture that cannot measure one. */
  viewport?: { width: number; height: number };
  /** What the last export wrote, for the session card (FR-108). */
  lastExport?: string;
};

/** The session area, as this module needs it; a test hands over a map. */
export type RecordingStore = {
  read(): Promise<Record<string, StoredRecording>>;
  write(recordings: Record<string, StoredRecording>): Promise<void>;
};

/**
 * The real store: one key of `chrome.storage.session`, read on every call.
 *
 * Session storage because a recording dies with the browser exactly as the session it belongs to
 * does, and because a worker Chrome woke for the *next* tool call has to find what its predecessor
 * wrote - which is the whole of D-008-2's promise that no keep-alive is needed.
 */
export function sessionRecordingStore(): RecordingStore {
  const area = (): StorageAreaLike | undefined =>
    typeof chrome !== "undefined" ? (chrome.storage?.session as unknown as StorageAreaLike | undefined) : undefined;
  return {
    async read() {
      const raw = await area()?.get([AGENT_RECORDINGS_KEY]);
      const stored = raw?.[AGENT_RECORDINGS_KEY];
      return stored && typeof stored === "object" ? (stored as Record<string, StoredRecording>) : {};
    },
    async write(recordings) {
      await area()?.set({ [AGENT_RECORDINGS_KEY]: recordings });
    },
  };
}

export type RecorderDownloads = {
  download(options: {
    url: string;
    filename: string;
    saveAs: boolean;
    conflictAction: "uniquify";
  }): Promise<number>;
  onChanged(listener: (delta: DownloadDelta) => void): void;
};

export type RecorderDeps = {
  offscreen: Pick<OffscreenAdapter, "ensureOpen" | "close" | "send">;
  /** One frame of the tab; the recorder hands over the last viewport it knows for the fallback. */
  capture(tabId: number, lastViewport?: { width: number; height: number }): Promise<FrameCapture>;
  downloads: RecorderDownloads;
  store: RecordingStore;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  /** What the frames are stamped with: the manifest's name and version, read at run time. */
  watermark(): string;
  reportDiagnostic?: (code: string) => void;
};

export type ExportOutcome =
  | { ok: true; result: GifRecorderExportResult }
  | { ok: false; refusal: Extract<AgentRefusal, { reason: "invalid-filename" | "empty-recording" | "download-failed" }> };

export type AgentRecorder = {
  start(sessionId: string, tabId: number): Promise<GifRecorderStatusResult>;
  stop(sessionId: string): Promise<RecordingState>;
  clear(sessionId: string): Promise<RecordingState>;
  noteAction(sessionId: string, tabId: number, action: DescribedAction): Promise<RecordingState>;
  export(sessionId: string, filename?: string): Promise<ExportOutcome>;
  /** The session is ending (FR-108): export what there is, under the default name, or drop it. */
  exportIfFrames(sessionId: string): Promise<GifRecorderExportResult | undefined>;
  stateOf(sessionId: string): Promise<RecordingState>;
  /** Every session's recording, for the panel's card line (FR-109). */
  listStates(): Promise<Record<string, RecordingState & { lastExport?: string }>>;
};

const NONE: RecordingState = { state: "none", frames: 0, skipped: 0, full: false };

function projection(record: StoredRecording | undefined): RecordingState {
  if (!record) return NONE;
  return { state: record.state, frames: record.frames, skipped: record.skipped, full: record.full };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `agent-recording-20260919-134507`, in the owner's own time zone (FR-107). */
export function defaultRecordingName(at: number): string {
  const when = new Date(at);
  const date = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${RECORDING_DEFAULT_PREFIX}${date}-${time}`;
}

/** FR-100's grammar, asked here as well as in the contract: the worker writes the file. */
function validName(name: string): boolean {
  if (!AGENT_RECORDING_FILENAME_PATTERN.test(name)) return false;
  if (name.startsWith(".")) return false;
  return !name.toLowerCase().endsWith(".gif");
}

export function createRecorder(deps: RecorderDeps): AgentRecorder {
  /** Downloads this recorder is waiting on, by the browser's own id. */
  const pending = new Map<number, (outcome: DownloadDelta["state"]) => void>();
  /**
   * The path the browser chose for a pending download, by id. `conflictAction: "uniquify"` may turn
   * `TC-1234.gif` into `TC-1234 (1).gif`, and the agent has to be told the name that exists (FR-107;
   * the S9 probe of 2026-09-19 reported a file that was not the one on disk).
   */
  const savedPaths = new Map<number, string>();
  deps.downloads.onChanged((delta) => {
    if (delta.filename !== undefined && delta.filename !== "" && pending.has(delta.id)) {
      savedPaths.set(delta.id, delta.filename);
    }
    if (delta.state === undefined || delta.state === "in_progress") return;
    const waiting = pending.get(delta.id);
    if (!waiting) return;
    pending.delete(delta.id);
    waiting(delta.state);
  });

  async function read(sessionId: string): Promise<StoredRecording | undefined> {
    return (await deps.store.read())[sessionId];
  }

  async function write(sessionId: string, record: StoredRecording | undefined): Promise<void> {
    const all = await deps.store.read();
    if (record === undefined) delete all[sessionId];
    else all[sessionId] = record;
    await deps.store.write(all);
  }

  /**
   * Takes one frame and hands it over, answering whether it made it.
   *
   * A capture that failed is *counted*, never invented and never fatal: FR-101 says the action's own
   * answer does not change because its picture could not be taken.
   */
  async function addFrame(
    sessionId: string,
    tabId: number,
    record: StoredRecording,
    action: (DescribedAction & { index: number }) | null,
  ): Promise<StoredRecording> {
    const captured = await deps.capture(tabId, record.viewport);
    if (!captured.ok) {
      deps.reportDiagnostic?.("agent.recording.frame-skipped");
      return { ...record, skipped: record.skipped + 1 };
    }
    await deps.offscreen.send({
      type: "recording/add-frame",
      sessionId,
      frame: {
        index: record.frames,
        jpegBase64: captured.jpegBase64,
        viewportWidth: captured.viewportWidth,
        viewportHeight: captured.viewportHeight,
        action,
      },
    });
    const frames = record.frames + 1;
    const full = frames >= AGENT_RECORDING_MAX_FRAMES;
    return {
      ...record,
      frames,
      viewport: { width: captured.viewportWidth, height: captured.viewportHeight },
      full,
      // The cap is not a refusal: the recording simply stops growing and says so on every later
      // answer, which is what lets an agent notice before it looks for frames that are not there.
      ...(full ? { state: "stopped" as const } : {}),
    };
  }

  /** Closes the document when the count says nothing is left in it - frames or blob URLs. */
  async function closeIfIdle(): Promise<void> {
    const counted = await deps.offscreen.send<{ sessions?: number; pendingBlobUrls?: number }>({
      type: "recording/count",
    });
    // `pendingBlobUrls` is the S2 review's second question; a document from before it answers
    // nothing, which is read as none outstanding rather than as a reason never to close.
    if ((counted?.sessions ?? 0) === 0 && (counted?.pendingBlobUrls ?? 0) === 0) {
      await deps.offscreen.close();
    }
  }

  async function exportUnder(sessionId: string, name: string): Promise<ExportOutcome> {
    const record = await read(sessionId);
    if (!record || record.frames === 0) return { ok: false, refusal: { reason: "empty-recording" } };
    const encoded = await deps.offscreen.send<{
      blobUrl?: string;
      width?: number;
      height?: number;
      bytes?: number;
      error?: string;
    }>({ type: "recording/export", sessionId, watermark: deps.watermark(), filename: name });
    if (!encoded?.blobUrl) {
      // The document could not build the file. Nothing was written and nothing is thrown away.
      return {
        ok: false,
        refusal: { reason: "download-failed", downloadReason: encoded?.error ?? "encode-failed" },
      };
    }
    const filename = `${name}.gif`;
    let downloadId: number;
    let settled: Promise<DownloadDelta["state"]>;
    try {
      // The waiter is armed before the download is asked for: a small file can be written before
      // `download` has even resolved, and a listener attached afterwards would miss its own answer.
      let resolveSettled: (state: DownloadDelta["state"]) => void = () => undefined;
      settled = new Promise<DownloadDelta["state"]>((resolve) => {
        resolveSettled = resolve;
      });
      downloadId = await deps.downloads.download({
        url: encoded.blobUrl,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      pending.set(downloadId, resolveSettled);
    } catch (error) {
      await deps.offscreen.send({ type: "recording/revoke", blobUrl: encoded.blobUrl });
      return {
        ok: false,
        refusal: {
          reason: "download-failed",
          downloadReason: error instanceof Error ? error.message.slice(0, 200) : "download-refused",
        },
      };
    }
    const outcome = await settled;
    const savedPath = savedPaths.get(downloadId);
    savedPaths.delete(downloadId);
    // The browser's own choice of name wins over the one asked for: it is the file that exists.
    const savedName = savedPath === undefined ? filename : (savedPath.split(/[\\/]/).pop() ?? filename);
    await deps.offscreen.send({ type: "recording/revoke", blobUrl: encoded.blobUrl });
    if (outcome !== "complete") {
      // The frames stay exactly as they were, so the agent may ask again (FR-100's `download-failed`).
      return { ok: false, refusal: { reason: "download-failed", downloadReason: outcome ?? "unknown" } };
    }
    await deps.offscreen.send({ type: "recording/clear", sessionId });
    // The record stays behind with its frames gone and the file named: the card's last line is
    // "exported <file>" (FR-108), which there would be nothing left to say if the entry were
    // dropped. Every count is zeroed, so a later `start` begins a recording rather than joining one.
    await write(sessionId, { ...record, state: "none", frames: 0, skipped: 0, full: false, nextIndex: 1, lastExport: savedName });
    await closeIfIdle();
    return {
      ok: true,
      result: {
        filename: savedName,
        frames: record.frames,
        skipped: record.skipped,
        width: encoded.width ?? 0,
        height: encoded.height ?? 0,
        bytes: encoded.bytes ?? 0,
        downloadId,
      },
    };
  }

  return {
    async start(sessionId, tabId) {
      const existing = await read(sessionId);
      if (existing?.state === "recording") {
        return { ...projection(existing), alreadyRecording: true };
      }
      await deps.offscreen.ensureOpen();
      const started: StoredRecording = {
        state: "recording",
        frames: 0,
        skipped: 0,
        full: false,
        startedAt: deps.clock.now(),
        nextIndex: 1,
        ...(existing?.viewport === undefined ? {} : { viewport: existing.viewport }),
      };
      // Frame 0 is the page as it was before the agent touched it (FR-101): the "before" of the
      // recording, and the only frame that carries no action.
      const withInitial = await addFrame(sessionId, tabId, started, null);
      await write(sessionId, withInitial);
      return projection(withInitial);
    },

    async stop(sessionId) {
      const record = await read(sessionId);
      if (!record || record.state !== "recording") return projection(record);
      const stopped: StoredRecording = { ...record, state: "stopped" };
      await write(sessionId, stopped);
      return projection(stopped);
    },

    async clear(sessionId) {
      const record = await read(sessionId);
      if (!record) return NONE;
      await deps.offscreen.send({ type: "recording/clear", sessionId });
      await write(sessionId, undefined);
      await closeIfIdle();
      return NONE;
    },

    async noteAction(sessionId, tabId, action) {
      const record = await read(sessionId);
      if (!record || record.state !== "recording") return projection(record);
      // The page is given its settling time before the picture is taken, so a frame shows what the
      // action did rather than the instant the command returned (FR-101).
      await deps.clock.sleep(RECORDING_SETTLE_MS);
      const withFrame = await addFrame(sessionId, tabId, record, { ...action, index: record.nextIndex });
      const next: StoredRecording = { ...withFrame, nextIndex: record.nextIndex + 1 };
      await write(sessionId, next);
      return projection(next);
    },

    async export(sessionId, filename) {
      const name = filename ?? defaultRecordingName(deps.clock.now());
      if (!validName(name)) return { ok: false, refusal: { reason: "invalid-filename" } };
      return exportUnder(sessionId, name);
    },

    async exportIfFrames(sessionId) {
      const record = await read(sessionId);
      if (!record) return undefined;
      if (record.frames === 0) {
        // A recording of nothing is dropped rather than written (FR-108).
        await deps.offscreen.send({ type: "recording/clear", sessionId });
        await write(sessionId, undefined);
        await closeIfIdle();
        return undefined;
      }
      const exported = await exportUnder(sessionId, defaultRecordingName(deps.clock.now()));
      if (!exported.ok) {
        deps.reportDiagnostic?.("agent.recording.auto-export-failed");
        return undefined;
      }
      return exported.result;
    },

    async stateOf(sessionId) {
      return projection(await read(sessionId));
    },

    async listStates() {
      const all = await deps.store.read();
      return Object.fromEntries(
        Object.entries(all).map(([sessionId, record]) => [
          sessionId,
          { ...projection(record), ...(record.lastExport === undefined ? {} : { lastExport: record.lastExport }) },
        ]),
      );
    },
  };
}
