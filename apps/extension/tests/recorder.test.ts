import { AGENT_RECORDING_MAX_FRAMES } from "@hallpass/contracts";
import { describe, expect, it } from "vitest";
import type { DownloadDelta } from "../src/chrome-adapters/downloads.js";
import {
  AGENT_RECORDINGS_KEY,
  createRecorder,
  type RecorderDeps,
  type RecordingStore,
} from "../src/service-worker/recording/recorder.js";

/**
 * 008/T219 — the recorder (FR-100..FR-103, FR-107..FR-109, D-008-2, D-008-3).
 *
 * Everything here is about two things the worker does not own: the frames, which live in the
 * offscreen document, and the file, which the browser writes. What the worker keeps is the summary -
 * four numbers per session in `chrome.storage.session`, re-read on every call because MV3 evicts the
 * worker between tool calls and a recorder that remembered its state in a variable would start every
 * fresh worker with none.
 *
 * The export sequence is the one the S2 review pinned: encode, download, and only when the browser
 * says the file is written do the frames and the blob URL go. A download that failed keeps both, so
 * the agent can ask again.
 */

type Sent = { type: string } & Record<string, unknown>;

function memoryStore(initial: Record<string, unknown> = {}): RecordingStore & { raw: Record<string, unknown> } {
  const raw: Record<string, unknown> = { ...initial };
  return {
    raw,
    async read() {
      return (raw[AGENT_RECORDINGS_KEY] ?? {}) as Record<string, never>;
    },
    async write(value) {
      raw[AGENT_RECORDINGS_KEY] = value;
    },
  };
}

type Harness = {
  /** Delivers one `downloads.onChanged` delta to the recorder, as the browser would. */
  emit: (delta: DownloadDelta) => void;
  deps: RecorderDeps;
  sent: Sent[];
  store: RecordingStore & { raw: Record<string, unknown> };
  slept: number[];
  downloads: Array<Record<string, unknown>>;
  closes: () => number;
  /** Answers the next `recording/count` with these numbers. */
  counts: { sessions: number; pendingBlobUrls?: number };
  /** What the browser will say about the next download it is asked for. */
  downloadOutcome: NonNullable<DownloadDelta["state"]>;
  captures: number;
  failCaptureFrom: (nth: number) => void;
};

function harness(options: { store?: RecordingStore & { raw: Record<string, unknown> } } = {}): Harness {
  const sent: Sent[] = [];
  const slept: number[] = [];
  const downloads: Array<Record<string, unknown>> = [];
  const store = options.store ?? memoryStore();
  let closes = 0;
  let captures = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  let listener: ((delta: DownloadDelta) => void) | undefined;
  const state: Harness = {
    sent,
    store,
    slept,
    downloads,
    closes: () => closes,
    counts: { sessions: 0, pendingBlobUrls: 0 },
    captures: 0,
    failCaptureFrom: (nth) => {
      failFrom = nth;
    },
    downloadOutcome: "complete",
    emit: (delta) => listener?.(delta),
    deps: {
      offscreen: {
        ensureOpen: async () => undefined,
        close: async () => {
          closes += 1;
        },
        send: async <T,>(message: unknown) => {
          const sentMessage = message as Sent;
          sent.push(sentMessage);
          if (sentMessage.type === "recording/export") {
            return { blobUrl: "blob:enc", width: 800, height: 600, bytes: 4096, frames: 3 } as T;
          }
          if (sentMessage.type === "recording/count") {
            return state.counts as T;
          }
          return {} as T;
        },
      },
      capture: async () => {
        captures += 1;
        state.captures = captures;
        return captures >= failFrom
          ? ({ ok: false, reason: "capture-failed" } as const)
          : ({
              ok: true,
              jpegBase64: `frame-${captures}`,
              viewportWidth: 800,
              viewportHeight: 600,
              fallback: false,
            } as const);
      },
      downloads: {
        download: async (options) => {
          downloads.push(options as unknown as Record<string, unknown>);
          // The browser answers in a later task, which is after the recorder has armed its waiter:
          // a microtask would race the `await` that waiter is registered behind.
          setTimeout(() => listener?.({ id: 42, state: state.downloadOutcome }), 0);
          return 42;
        },
        onChanged: (subscriber) => {
          listener = subscriber;
        },
      },
      store,
      clock: {
        now: () => Date.parse("2026-09-19T13:45:07"),
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      watermark: () => "Hallpass 0.9.0",
    },
  };
  return state;
}

describe("createRecorder", () => {
  it("opens the document and records the initial frame on start", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);

    const started = await recorder.start("s1", 9);

    expect(started).toEqual({ state: "recording", frames: 1, skipped: 0, full: false });
    expect(h.sent[0]).toMatchObject({ type: "recording/add-frame", sessionId: "s1" });
    expect((h.sent[0] as unknown as { frame: { index: number; action: unknown } }).frame).toMatchObject({
      index: 0,
      action: null,
    });
  });

  it("answers a second start with alreadyRecording and adds no frame", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    const again = await recorder.start("s1", 9);

    expect(again).toEqual({ state: "recording", frames: 1, skipped: 0, full: false, alreadyRecording: true });
    expect(h.sent.filter((message) => message.type === "recording/add-frame")).toHaveLength(1);
  });

  it("settles before each action's frame and counts a capture that failed", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);
    h.failCaptureFrom(2);

    const state = await recorder.noteAction("s1", 9, { tool: "click", label: "click" });

    expect(h.slept).toEqual([100]);
    expect(state).toEqual({ state: "recording", frames: 1, skipped: 1, full: false });
  });

  it("stamps each action with its own index", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    await recorder.noteAction("s1", 9, { tool: "click", label: "click" });
    await recorder.noteAction("s1", 9, { tool: "type", label: 'type "a"' });

    const frames = h.sent.filter((message) => message.type === "recording/add-frame");
    expect(frames.map((message) => (message as unknown as { frame: { index: number } }).frame.index)).toEqual([0, 1, 2]);
    expect(
      frames.slice(1).map((message) => (message as unknown as { frame: { action: { index: number } } }).frame.action.index),
    ).toEqual([1, 2]);
  });

  it("stops at exactly the cap and marks the recording full", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);
    let state = await recorder.stateOf("s1");
    // The initial frame is frame 0, so 199 actions fill the recording.
    for (let action = 0; action < AGENT_RECORDING_MAX_FRAMES; action += 1) {
      state = await recorder.noteAction("s1", 9, { tool: "key", label: "key Tab" });
    }

    expect(state).toEqual({
      state: "stopped",
      frames: AGENT_RECORDING_MAX_FRAMES,
      skipped: 0,
      full: true,
    });
    expect(h.sent.filter((message) => message.type === "recording/add-frame")).toHaveLength(
      AGENT_RECORDING_MAX_FRAMES,
    );
  });

  it("freezes the list on stop and adds nothing after it", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    expect(await recorder.stop("s1")).toEqual({ state: "stopped", frames: 1, skipped: 0, full: false });
    await recorder.noteAction("s1", 9, { tool: "click", label: "click" });

    expect(h.sent.filter((message) => message.type === "recording/add-frame")).toHaveLength(1);
  });

  it("clears the recording and closes the document when nothing is left in it", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    expect(await recorder.clear("s1")).toEqual({ state: "none", frames: 0, skipped: 0, full: false });
    expect(h.sent.map((message) => message.type)).toEqual([
      "recording/add-frame",
      "recording/clear",
      "recording/count",
    ]);
    expect(h.closes()).toBe(1);
  });

  it("keeps the document open while another session is still recording", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);
    await recorder.start("s2", 10);
    h.counts = { sessions: 1, pendingBlobUrls: 0 };

    await recorder.clear("s1");

    expect(h.closes()).toBe(0);
    expect(await recorder.stateOf("s2")).toEqual({ state: "recording", frames: 1, skipped: 0, full: false });
  });

  it("refuses a filename the grammar does not allow", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    expect(await recorder.export("s1", "../escape")).toEqual({
      ok: false,
      refusal: { reason: "invalid-filename" },
    });
    expect(h.downloads).toEqual([]);
  });

  it("refuses an export of a recording with no frames", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);

    expect(await recorder.export("s1")).toEqual({ ok: false, refusal: { reason: "empty-recording" } });
  });

  it("downloads the encoded file, then revokes, clears and closes", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);
    await recorder.noteAction("s1", 9, { tool: "click", label: "click" });

    const exported = await recorder.export("s1", "TC-1234");

    expect(exported).toEqual({
      ok: true,
      result: {
        filename: "TC-1234.gif",
        frames: 2,
        skipped: 0,
        width: 800,
        height: 600,
        bytes: 4096,
        downloadId: 42,
      },
    });
    expect(h.downloads).toEqual([
      { url: "blob:enc", filename: "TC-1234.gif", saveAs: false, conflictAction: "uniquify" },
    ]);
    expect(h.sent.map((message) => message.type)).toEqual([
      "recording/add-frame",
      "recording/add-frame",
      "recording/export",
      "recording/revoke",
      "recording/clear",
      "recording/count",
    ]);
    expect(h.closes()).toBe(1);
    expect(await recorder.stateOf("s1")).toEqual({ state: "none", frames: 0, skipped: 0, full: false });
  });

  it("answers with the name the browser actually saved when it had to uniquify", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);
    // The browser names the file first, then finishes it - two deltas, as chrome.downloads sends them.
    h.deps.downloads.download = async () => {
      setTimeout(() => {
        h.emit({ id: 42, filename: "C:\\Users\\owner\\Downloads\\TC-1234 (1).gif" });
        h.emit({ id: 42, state: "complete" });
      }, 0);
      return 42;
    };

    const exported = await recorder.export("s1", "TC-1234");

    expect(exported).toMatchObject({ ok: true, result: { filename: "TC-1234 (1).gif" } });
    expect((await recorder.listStates()).s1?.lastExport).toBe("TC-1234 (1).gif");
  });

  it("names the export with the local clock when the agent names nothing", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    const exported = await recorder.export("s1");

    expect(exported).toMatchObject({ ok: true, result: { filename: "agent-recording-20260919-134507.gif" } });
  });

  it("keeps the frames when the browser did not write the file", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    h.downloadOutcome = "failed";

    expect(await recorder.export("s1", "TC-1234")).toEqual({
      ok: false,
      refusal: { reason: "download-failed", downloadReason: "failed" },
    });
    // Revoked, because the URL is this worker's to release either way; the frames stay.
    expect(h.sent.map((message) => message.type)).toEqual([
      "recording/add-frame",
      "recording/export",
      "recording/revoke",
    ]);
    expect(await recorder.stateOf("s1")).toEqual({ state: "recording", frames: 1, skipped: 0, full: false });
    expect(h.closes()).toBe(0);
  });

  it("exports a session's recording at its end and drops an empty one", async () => {
    const h = harness();
    const recorder = createRecorder(h.deps);
    await recorder.start("s1", 9);

    expect(await recorder.exportIfFrames("s1")).toMatchObject({
      filename: "agent-recording-20260919-134507.gif",
    });

    // Nothing recorded, nothing written.
    expect(await recorder.exportIfFrames("s2")).toBeUndefined();
  });

  it("reads the state a previous worker wrote", async () => {
    const h = harness();
    const first = createRecorder(h.deps);
    await first.start("s1", 9);

    // A fresh worker: a new recorder over the same session storage, with no memory of its own.
    const second = createRecorder(harness({ store: h.store }).deps);

    expect(await second.stateOf("s1")).toEqual({ state: "recording", frames: 1, skipped: 0, full: false });
  });
});
