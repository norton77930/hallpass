/**
 * Opening, closing and talking to the offscreen document (008/T215, FR-103, FR-121, R-134).
 *
 * An extension may have exactly one offscreen document, and `chrome.offscreen.hasDocument()` answers
 * about documents that exist, not about one being created right now. Two sessions that start
 * recording in the same tick therefore both hear "no document" and both try to create it. That is
 * handled twice here, because either guard alone still loses a race: callers are serialised behind
 * one in-flight creation, and Chrome's own "only a single offscreen document may be created" error
 * is read as success rather than as a failure - the document the caller wanted does exist.
 *
 * `send` is `chrome.runtime.sendMessage`. It carries no receiver, because there is none to name: the
 * message reaches every listener in the extension and the document's own listener answers only what
 * begins `recording/` (see `src/offscreen/router.ts`).
 *
 * **Every future use of an offscreen document must come through this adapter.** One is all Chrome
 * allows, so a second feature that opens its own - for audio, for a DOM parse, for anything - takes
 * the one this extension already has, and the recording in it. Add the reason and the message prefix
 * here instead; the "single offscreen document" error is read below as the race it usually is, but
 * only after the document that exists is confirmed to be this one.
 */

/** Where Chrome looks for the document; `scripts/write-manifest.ts` puts it there. */
export const OFFSCREEN_DOCUMENT_URL = "offscreen.html";

/**
 * Why this extension needs a document at all, in the words the browser may one day show an owner.
 * `BLOBS` is the reason that fits: the document builds a GIF and hands back a blob URL. It is not
 * `AUDIO_PLAYBACK`, and it is not a keep-alive - the reference uses it as one (design-notes §2) and
 * D-008-2 rules that out.
 */
const JUSTIFICATION = "Encode this session's recorded frames into a GIF file";
const REASONS = ["BLOBS"] as const;

/** Chrome's wording when the document was created between `hasDocument` and `createDocument`. */
const ALREADY_CREATED = /single offscreen document/i;

/** The part of `chrome.offscreen` this uses, so a test can stand in for it. */
export type OffscreenApi = {
  hasDocument(): Promise<boolean>;
  createDocument(parameters: {
    url: string;
    reasons: readonly string[];
    justification: string;
  }): Promise<void>;
  closeDocument(): Promise<void>;
};

/** The part of `chrome.runtime` this uses. */
export type OffscreenRuntime = {
  sendMessage(message: unknown): Promise<unknown>;
  /**
   * Chrome 116+. Optional because a test fake need not have it - and because an absent API is not
   * evidence of a wrong document, so the check below is skipped rather than failed when it is.
   */
  getContexts?(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string | undefined }[]>;
};

export type OffscreenAdapter = {
  /** Resolves once a document exists, whoever created it. */
  ensureOpen(): Promise<void>;
  /** Closes the document if there is one; a no-op when there is not. */
  close(): Promise<void>;
  send<T>(message: unknown): Promise<T>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOffscreenAdapter(
  api: OffscreenApi = chrome.offscreen as unknown as OffscreenApi,
  runtime: OffscreenRuntime = chrome.runtime as unknown as OffscreenRuntime,
): OffscreenAdapter {
  let opening: Promise<void> | undefined;

  /**
   * Whether the one document Chrome says exists is the recording document.
   *
   * The race and the collision throw the same error, and they are not the same thing: another part
   * of the extension opening its own document would leave this call "succeeding" against a document
   * that has no recording listener in it, and the next `send` would time out with nothing to say.
   * Without `getContexts` there is nothing to check, so the error is taken at its word.
   */
  async function existingDocumentIsOurs(): Promise<{ ok: true } | { ok: false; url: string }> {
    if (typeof runtime.getContexts !== "function") {
      return { ok: true };
    }
    const contexts = await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    const other = contexts.find(
      (context) => !(context.documentUrl ?? "").endsWith(OFFSCREEN_DOCUMENT_URL),
    );
    // No contexts at all means the document went away while this was being asked - which is the
    // race resolving itself, not a document belonging to someone else.
    return other ? { ok: false, url: other.documentUrl ?? "an unnamed document" } : { ok: true };
  }

  async function open(): Promise<void> {
    if (await api.hasDocument()) {
      return;
    }
    try {
      await api.createDocument({
        url: OFFSCREEN_DOCUMENT_URL,
        reasons: REASONS,
        justification: JUSTIFICATION,
      });
    } catch (error) {
      // Any other failure - a missing permission, a url Chrome will not load - is the caller's to
      // hear: a recording that silently has nowhere to put its frames is the worse answer.
      if (!ALREADY_CREATED.test(messageOf(error))) {
        throw error;
      }
      const existing = await existingDocumentIsOurs();
      if (!existing.ok) {
        throw new Error(
          `another offscreen document is already open (${existing.url}); ` +
            "an extension may have only one, and recording needs it",
        );
      }
    }
  }

  return {
    async ensureOpen(): Promise<void> {
      if (!opening) {
        // Cleared as it settles, so a later caller opens a document that has since been closed
        // rather than joining a promise about a document that is gone.
        opening = open().finally(() => {
          opening = undefined;
        });
      }
      await opening;
    },
    async close(): Promise<void> {
      if (!(await api.hasDocument())) {
        return;
      }
      await api.closeDocument();
    },
    async send<T>(message: unknown): Promise<T> {
      return (await runtime.sendMessage(message)) as T;
    },
  };
}
