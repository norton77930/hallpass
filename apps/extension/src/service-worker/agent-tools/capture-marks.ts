/**
 * Keeps Hallpass's own marks out of a picture handed to the agent (033, FR-509, R-499, D-033-5).
 *
 * The pointer, its caption, the press ring, the pill and the glow are page DOM, so a screenshot
 * paints them like anything else. For the agent they are noise at best and a misleading target at
 * worst, so the two agent-facing captures - the `screenshot` tool and the `computer` screenshot -
 * wrap their capture in `withMarksHidden`: the page is told to hide the marks, the capture waits for
 * the page to say it has painted that (at most `MARKS_ACK_CAP_MS`), and the page is told to show them
 * again whatever became of the capture, with the same wait for its answer: the recording's frame
 * follows a screenshot at once and must not catch the marks half-way back.
 *
 * It is deliberately NOT in `photographTab`: the GIF recorder's frame capture falls back through that
 * function, and a recording is made for people, so its frames keep the marks (D-033-5).
 *
 * Nothing here can fail a screenshot. A page with no listener, a tab that is gone, a sender that
 * throws and a page that never answers are all the same thing from here: the marks are not known to
 * be hidden, and the picture is taken anyway after at most the cap. The page restores the marks by
 * itself three seconds after hiding, so a "show" that is lost still cannot leave them off for good.
 */

/** What the page is told; the page accepts exactly this shape (contracts/page-pointer-messages.md). */
export type MarksMessage = { type: "marks"; hidden: boolean };

/** Sends the top frame of a tab one marks message; what it returns is only waited on, never read. */
export type MarksSender = (tabId: number, message: MarksMessage) => Promise<unknown> | unknown;

/** The longest a capture waits for the page to have painted the marks away, and again to have them back. */
export const MARKS_ACK_CAP_MS = 250;

/** The browser's content-script channel to the top frame; the one place `chrome.tabs` is named here. */
function sendMarksMessage(tabId: number, message: MarksMessage): Promise<unknown> {
  const tabs = (globalThis as { chrome?: { tabs?: { sendMessage?: unknown } } }).chrome?.tabs;
  const send = tabs?.sendMessage as
    | ((tabId: number, message: unknown, options?: { frameId: number }) => Promise<unknown>)
    | undefined;
  if (!send) return Promise.resolve();
  return Promise.resolve().then(() => send(tabId, message, { frameId: 0 }));
}

/** One send that never throws and never rejects: a settled promise whichever way it went. */
function tell(send: MarksSender, tabId: number, hidden: boolean): Promise<void> {
  try {
    return Promise.resolve(send(tabId, { type: "marks", hidden })).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/** Resolves when the page has answered the message, or when the cap has run out; never rejects. */
function tellAndWait(send: MarksSender, tabId: number, hidden: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MARKS_ACK_CAP_MS);
    void tell(send, tabId, hidden).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Captures that are out on one tab right now. Two overlapping captures of a tab share one hide and
 * one show: the first to finish must not bring the marks back under the other's picture.
 */
const holds = new Map<number, { count: number; painted: Promise<void>; send: MarksSender }>();

export async function withMarksHidden<T>(
  tabId: number,
  capture: () => Promise<T>,
  send: MarksSender = sendMarksMessage,
): Promise<T> {
  let hold = holds.get(tabId);
  if (hold) {
    hold.count += 1;
  } else {
    hold = { count: 1, painted: tellAndWait(send, tabId, true), send };
    holds.set(tabId, hold);
  }
  const mine = hold;
  try {
    await mine.painted;
    return await capture();
  } finally {
    mine.count -= 1;
    if (mine.count === 0) {
      holds.delete(tabId);
      // Awaited, capped like the hide (033 review I2): the GIF recorder takes its frame as soon as the
      // screenshot returns, and that frame must have the marks painted back. Never throws, so the
      // capture's own result or error is still what leaves here.
      await tellAndWait(mine.send, tabId, false);
    }
  }
}
