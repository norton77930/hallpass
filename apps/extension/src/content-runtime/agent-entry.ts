import { moveCursor, removeCursor, type CursorHost } from "./cursor.js";
import { applyIndicator, isIndicatorHide, type IndicatorHost } from "./indicator.js";

/**
 * The agent build's declared content script (004 T107, FR-062).
 *
 * It is deliberately small: it hosts the in-page indicator and nothing else today. The declaration
 * that carries it (`all_frames`, `match_about_blank`, `document_start`) is what a held tab needs
 * for the indicator to be there from the first paint, and it is the same entry the frame reading
 * of S3 will run in.
 *
 * Only the extension's own messages are answered - `sender.id` is Chrome's own attribution and a
 * page cannot forge it - and the only thing this script ever sends is the one message a *trusted*
 * click on the indicator's control produces.
 */
type ChromeAgentRuntime = {
  id?: string;
  sendMessage?: (message: unknown) => unknown;
  onMessage?: {
    addListener(
      listener: (message: unknown, sender: { id?: string }, sendResponse: (response: unknown) => void) => boolean | void,
    ): void;
    removeListener?(
      listener: (message: unknown, sender: { id?: string }, sendResponse: (response: unknown) => void) => boolean | void,
    ): void;
  };
};

type AgentEntryListener = Parameters<NonNullable<ChromeAgentRuntime["onMessage"]>["addListener"]>[0];

/** What this script ever sends: the trusted click, and the "I am here" of a freshly loaded page. */
type AgentContentMessage = { type: "ui.agent.focus-main" } | { type: "ui.agent.announce" };

function post(runtime: ChromeAgentRuntime, message: AgentContentMessage): void {
  // A closed port is what a worker restart looks like from here; the next `indicator` message
  // re-establishes everything, so there is nothing to report and nobody to report it to.
  try {
    const answer = runtime.sendMessage?.(message);
    void (answer as { catch?: (handler: () => void) => void } | undefined)?.catch?.(() => {});
  } catch {
    /* the worker is not listening right now */
  }
}

export function indicatorHost(runtime: ChromeAgentRuntime, doc: Document): IndicatorHost {
  return {
    doc,
    send: (message) => post(runtime, message),
    // The same answer the pointer gets: the browser's, not the page's.
    isTopFrame: cursorHost(doc).isTopFrame,
  };
}

/** Which document this is, asked of the browser: a frame's `window.top` is not the frame's to set. */
export function cursorHost(doc: Document): CursorHost {
  const view = globalThis as { top?: unknown };
  return { doc, isTopFrame: view.top === undefined || view.top === globalThis };
}

export function bindAgentContentRuntime(runtime: ChromeAgentRuntime, doc: Document): void {
  if (!runtime.id || !runtime.onMessage) return;
  const host = indicatorHost(runtime, doc);
  const guard = globalThis as typeof globalThis & { __pocAgentContentListener?: AgentEntryListener };
  const previous = guard.__pocAgentContentListener;
  if (previous && runtime.onMessage.removeListener) runtime.onMessage.removeListener(previous);
  const listener: AgentEntryListener = (message, sender, sendResponse) => {
    // Anything that did not come from this extension is not this extension's message, whoever it
    // claims to be: a page can post into its own frame all day and never gain an indicator.
    if (sender.id !== runtime.id) return false;
    if (applyIndicator(message, host)) {
      // The tab left the session: the pointer that was drawn for that session leaves with the banner.
      if (isIndicatorHide(message)) removeCursor(doc);
      return false;
    }
    // The pointer mark (T127). The browser's own answer decides which document draws it, never the
    // page's - `window.top` is the one fact a frame cannot lie about itself.
    const arrival = moveCursor(message, cursorHost(doc));
    if (arrival === undefined) return false;
    // Answered when the glide has ended, so the worker's press lands where the owner watched the
    // pointer stop. `true` keeps the channel open for that reply; a channel the worker has already
    // let go of (its own arrival cap ran out first) throws here, and that is nothing to report.
    void arrival.then(() => {
      try {
        sendResponse({ arrived: true });
      } catch {
        /* the worker stopped waiting */
      }
    });
    return true;
  };
  guard.__pocAgentContentListener = listener;
  runtime.onMessage.addListener(listener);
  /**
   * The page asks (004/T107b). This script is reloaded at `document_start` on every navigation and
   * the indicator went with the document it was drawn in, so the worker is told the page is here
   * and answers with this tab's state - a raise if the tab is held, "no indicator" if it is not.
   *
   * Announced *after* the listener is registered, so the answer has somewhere to arrive. Nothing
   * is awaited: the answer comes back as an ordinary `indicator` message, not as a reply.
   */
  post(runtime, { type: "ui.agent.announce" });
}

const runtime = (globalThis as { chrome?: { runtime?: ChromeAgentRuntime } }).chrome?.runtime;
if (runtime && typeof document !== "undefined") {
  bindAgentContentRuntime(runtime, document);
}
