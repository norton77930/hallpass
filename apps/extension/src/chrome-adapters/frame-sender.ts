/**
 * The browser's own word on which site a frame is (030 R-440, T891, "Measured 2026-11-07").
 *
 * The worker asks one named frame to send it one message, and reads what the browser attaches to
 * that message as its sender: origin, frame id and document id. The page and the frame's own code
 * cannot set those fields, so they are the only input the consent decision takes. The message body
 * carries nothing but this probe's nonce, which only says "this is the reply to this probe" - it is
 * matched, never read for the decision.
 *
 * Injected into the frame's isolated world, as every other per-frame script is (`scripting.ts`), so
 * the page's own world never sees the nonce. Needs no permission the extension does not already
 * hold: scripting and runtime messaging (Principle V, FR-451).
 */

/** The key the probe's one message carries its nonce under. */
export const FRAME_SENDER_PROBE_KEY = "hallpassFrameSenderProbe";

/** What the browser attached to the frame's message (the `chrome.runtime.MessageSender` fields used). */
export type FrameSender = {
  origin?: string | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
};

/**
 * The probe's answer.
 *
 * `documentId` is the document the browser ran the probe in (its injection result), absent when the
 * script did not run there. `sender` is absent when no matching message arrived within the bound.
 * Either one missing means the frame's site is not established, and the caller treats it as unknown.
 */
export type FrameSenderProbe = {
  documentId?: string;
  sender?: FrameSender;
};

/**
 * Runs in the frame: sends the worker one message carrying the nonce, and nothing else.
 *
 * Self-contained, because `executeScript` serialises it. Nobody answers the message, so the
 * sender's promise settles with an error that is nothing to report.
 */
function sendFrameProbe(key: string, nonce: string): boolean {
  void chrome.runtime.sendMessage({ [key]: nonce }).catch(() => undefined);
  return true;
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Asks frame `frameId` of tab `tabId` for one message and answers what the browser said about it.
 *
 * Bounded by `boundMs` (the caller passes the frame bound, 2,000 ms): a frame that does not answer
 * in time answers no sender. Only a message carrying this probe's nonce, from this tab, counts; any
 * other message is left alone. The one-shot listener is removed however the probe ends.
 */
export async function probeFrameSender(tabId: number, frameId: number, boundMs: number): Promise<FrameSenderProbe> {
  const nonce = newNonce();
  let settle: (sender: FrameSender | undefined) => void = () => {};
  const heard = new Promise<FrameSender | undefined>((resolve) => {
    settle = resolve;
  });
  const listener = (message: unknown, sender: chrome.runtime.MessageSender): false => {
    if (typeof message !== "object" || message === null) return false;
    if ((message as Record<string, unknown>)[FRAME_SENDER_PROBE_KEY] !== nonce) return false;
    // The browser's tab, not anything the message says: a nonce seen elsewhere answers nothing here.
    if (sender.tab?.id !== tabId) return false;
    settle({ origin: sender.origin, frameId: sender.frameId, documentId: sender.documentId });
    // Not answered: returning `false` keeps the frame's sender from waiting on a reply.
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  const timer = setTimeout(() => settle(undefined), boundMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    let documentId: string | undefined;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "ISOLATED",
        func: sendFrameProbe,
        args: [FRAME_SENDER_PROBE_KEY, nonce],
      });
      const entry = (results as Array<{ frameId?: number; documentId?: string }> | undefined)?.find(
        (result) => result.frameId === frameId,
      );
      documentId = typeof entry?.documentId === "string" && entry.documentId !== "" ? entry.documentId : undefined;
    } catch {
      // The frame could not be reached - gone, or not a document scripts may run in. No message is
      // coming, so the probe answers at once rather than waiting out its bound.
      settle(undefined);
    }
    const sender = await heard;
    return {
      ...(documentId === undefined ? {} : { documentId }),
      ...(sender === undefined ? {} : { sender }),
    };
  } finally {
    clearTimeout(timer);
    chrome.runtime.onMessage.removeListener(listener);
  }
}
