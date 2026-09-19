import { describe, expect, it } from "vitest";
import {
  createOffscreenAdapter,
  OFFSCREEN_DOCUMENT_URL,
  type OffscreenApi,
  type OffscreenRuntime,
} from "../src/chrome-adapters/offscreen.js";

/**
 * 008/T215 — opening the one document an extension is allowed (R-134).
 *
 * Chrome permits exactly one offscreen document per extension, and `hasDocument()` answers about a
 * document that may be in the middle of being created. Two sessions starting a recording in the same
 * tick therefore both see "no document" and both call `createDocument`, and the second one throws.
 * The adapter has to survive that twice over - by not making the second call at all, and by treating
 * the error as the good news it is when the call happens anyway.
 */

type CreateCall = { url: string; reasons: string[]; justification: string };

type FakeOffscreen = OffscreenApi & {
  creates: CreateCall[];
  readonly closes: number;
  /** Lets the pending `createDocument` finish, whenever the test is ready. */
  settleCreate: () => void;
};

function fakeOffscreen(options: { open?: boolean; createFails?: Error } = {}): FakeOffscreen {
  let open = options.open ?? false;
  let closes = 0;
  const creates: CreateCall[] = [];
  // A gate made up front, so a test may open it before or after the call reaches it.
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    creates,
    get closes() {
      return closes;
    },
    settleCreate: release,
    hasDocument: async () => open,
    createDocument: async (parameters) => {
      creates.push({
        url: parameters.url,
        reasons: [...parameters.reasons],
        justification: parameters.justification,
      });
      // Held until the test lets it go, so two callers can genuinely overlap inside it.
      await gate;
      if (options.createFails) {
        throw options.createFails;
      }
      open = true;
    },
    closeDocument: async () => {
      open = false;
      closes += 1;
    },
  };
}

function fakeRuntime(reply: unknown = {}): OffscreenRuntime & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    sendMessage: async (message: unknown) => {
      sent.push(message);
      return reply;
    },
  };
}

/** A runtime that can also say which documents the extension has open, as Chrome's can. */
function runtimeWithContexts(documentUrls: string[]): OffscreenRuntime {
  return {
    ...fakeRuntime(),
    getContexts: async () => documentUrls.map((documentUrl) => ({ documentUrl })),
  };
}

describe("opening and talking to the offscreen document (008/T215)", () => {
  it("does not create a second document when one is already open", async () => {
    const api = fakeOffscreen({ open: true });
    await createOffscreenAdapter(api, fakeRuntime()).ensureOpen();
    expect(api.creates).toEqual([]);
  });

  it("creates it once, for blobs, with a justification a reviewer can read", async () => {
    const api = fakeOffscreen();
    const adapter = createOffscreenAdapter(api, fakeRuntime());
    const opening = adapter.ensureOpen();
    api.settleCreate();
    await opening;

    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]?.url).toBe(OFFSCREEN_DOCUMENT_URL);
    expect(api.creates[0]?.reasons).toEqual(["BLOBS"]);
    expect(api.creates[0]?.justification).toMatch(/GIF/);
  });

  it("lets two callers who arrive together share the one creation", async () => {
    const api = fakeOffscreen();
    const adapter = createOffscreenAdapter(api, fakeRuntime());
    // Both calls are in flight before the first `createDocument` is allowed to finish.
    const both = Promise.all([adapter.ensureOpen(), adapter.ensureOpen()]);
    api.settleCreate();
    await both;

    expect(api.creates).toHaveLength(1);
  });

  it("treats Chrome's single-document error as the document already being there", async () => {
    const api = fakeOffscreen({
      createFails: new Error("Only a single offscreen document may be created."),
    });
    const adapter = createOffscreenAdapter(api, fakeRuntime());
    const opening = adapter.ensureOpen();
    api.settleCreate();

    await expect(opening).resolves.toBeUndefined();
  });

  it("accepts the race once the open document turns out to be this one", async () => {
    const api = fakeOffscreen({
      createFails: new Error("Only a single offscreen document may be created."),
    });
    const adapter = createOffscreenAdapter(
      api,
      runtimeWithContexts([`chrome-extension://abc/${OFFSCREEN_DOCUMENT_URL}`]),
    );
    const opening = adapter.ensureOpen();
    api.settleCreate();

    await expect(opening).resolves.toBeUndefined();
  });

  it("refuses the race when the one document that exists is somebody else's", async () => {
    const api = fakeOffscreen({
      createFails: new Error("Only a single offscreen document may be created."),
    });
    const adapter = createOffscreenAdapter(
      api,
      runtimeWithContexts(["chrome-extension://abc/audio-keepalive.html"]),
    );
    const opening = adapter.ensureOpen();
    api.settleCreate();

    await expect(opening).rejects.toThrow(/audio-keepalive\.html/);
  });

  it("still reports an error that is not the race", async () => {
    const api = fakeOffscreen({ createFails: new Error("No offscreen permission") });
    const adapter = createOffscreenAdapter(api, fakeRuntime());
    const opening = adapter.ensureOpen();
    api.settleCreate();

    await expect(opening).rejects.toThrow(/No offscreen permission/);
  });

  it("closes a document that is open and says nothing when there is none", async () => {
    const closed = fakeOffscreen({ open: true });
    await createOffscreenAdapter(closed, fakeRuntime()).close();
    expect(closed.closes).toBe(1);

    const never = fakeOffscreen();
    await expect(createOffscreenAdapter(never, fakeRuntime()).close()).resolves.toBeUndefined();
    expect(never.closes).toBe(0);
  });

  it("sends a message through the runtime and hands back the document's answer", async () => {
    const runtime = fakeRuntime({ frames: 3 });
    const adapter = createOffscreenAdapter(fakeOffscreen({ open: true }), runtime);

    const reply = await adapter.send<{ frames: number }>({
      type: "recording/add-frame",
      sessionId: "s1",
    });
    expect(reply.frames).toBe(3);
    expect(runtime.sent).toEqual([{ type: "recording/add-frame", sessionId: "s1" }]);
  });
});
