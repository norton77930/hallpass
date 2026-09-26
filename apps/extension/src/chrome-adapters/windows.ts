/**
 * The one `chrome.windows` call the agent path makes (003/T042, FR-046).
 *
 * A window is not a tab, which is why this is its own file: `resize_window` names a tab because a
 * tab is the only thing the agent owns, but what it changes is the window that tab happens to sit
 * in - a window that may also hold tabs the owner is using. That asymmetry is the whole reason the
 * result reports the size Chrome ended up with rather than the size that was asked for.
 *
 * `chrome.windows` needs no permission of its own; it comes with `tabs`.
 */

export type WindowSize = { width: number; height: number };

/** Chrome's own word for what a window is; `chrome.windows.Window["state"]` without the enum import. */
export type WindowState = "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen";

/**
 * What a resize did: the size Chrome ended up with, and the state the window was in before it.
 *
 * The second half exists for 008/FR-118. Un-maximising is a change to the owner's window made so
 * the agent's size could be honoured, and nothing else in the browser remembers it happened - so
 * the one call that did it is the one place the prior state can honestly be read. It is read
 * *before* any update, which is why it is answered here rather than asked for afterwards.
 */
export type WindowResize = { size: WindowSize; priorState: WindowState | undefined };

/**
 * Resizes a window and answers with what it actually became. Chrome clamps to the display, so the
 * requested size and the resulting size are different facts and only the second one is true.
 *
 * Chrome applies `width`/`height` only to a window in the "normal" state: on a maximized,
 * minimized or fullscreen window the bounds are dropped without an error, and the call answers
 * with the unchanged size (2026-09-16: 1024x768 asked, 2064x1120 answered, twice). So a window
 * that is not "normal" is restored to "normal" first, in its own call - the agent asked for a
 * size, and un-maximizing is the only way a size can be honoured. A window already in "normal"
 * state gets the bounds in a single call, exactly as before.
 */
export async function resizeWindow(windowId: number, size: WindowSize): Promise<WindowResize> {
  const current = await chrome.windows.get(windowId);
  const priorState = current.state as WindowState | undefined;
  if (priorState !== undefined && priorState !== "normal") {
    await chrome.windows.update(windowId, { state: "normal" });
  }
  const updated = await chrome.windows.update(windowId, { width: size.width, height: size.height });
  return { size: { width: updated.width ?? size.width, height: updated.height ?? size.height }, priorState };
}

/**
 * The window as Chrome has it now, or `undefined` when there is no such window (008/FR-119).
 *
 * A window closed between the resize and the release is the ordinary case rather than a failure -
 * the owner closed it - so the throw is read as the fact it is and nothing is reported.
 */
export async function getWindowFacts(
  windowId: number,
): Promise<{ state?: string | undefined; width?: number | undefined; height?: number | undefined } | undefined> {
  try {
    const window = await chrome.windows.get(windowId);
    return { state: window.state, width: window.width, height: window.height };
  } catch {
    return undefined;
  }
}

/**
 * The owner's last-focused normal window, now and on every move (fix 2026-09-23, panel in another
 * window). The panel port compares it with the window each Hallpass panel is in, so the badge and
 * the question's bound follow the panel the owner can actually see.
 *
 * Three choices, each for a reason:
 * - "normal" windows only, on both the read and the event: a devtools or popup window taking focus
 *   is not the owner leaving the window their panel is in.
 * - `WINDOW_ID_NONE` is never passed on. Chrome sends it whenever every Chrome window loses focus -
 *   the owner switching to the terminal their agent runs in, which is exactly when a pairing card
 *   arrives. The window they will come back to is still the last one they used, so it stands.
 * - The first read is `getLastFocused`, and a focus event that lands before it answers wins: the
 *   event is newer than whatever the read found. A read that fails leaves the window unknown, which
 *   the panel port counts as "not seen" until the first event says otherwise.
 */
export function watchLastFocusedWindow(listener: (windowId: number) => void): void {
  const windows = chrome.windows;
  if (!windows) return;
  let heardEvent = false;
  const none = windows.WINDOW_ID_NONE ?? -1;
  windows.onFocusChanged?.addListener(
    (windowId) => {
      if (windowId === none || windowId < 0) return;
      heardEvent = true;
      listener(windowId);
    },
    { windowTypes: ["normal"] },
  );
  void Promise.resolve()
    .then(() => windows.getLastFocused({ windowTypes: ["normal"] }))
    .then((window) => {
      if (heardEvent || typeof window?.id !== "number" || window.id < 0) return;
      listener(window.id);
    })
    .catch(() => undefined);
}

/** Puts a window back into the state it was in before `resize_window` took it out of it (FR-119). */
export async function setWindowState(windowId: number, state: WindowState): Promise<void> {
  await chrome.windows.update(windowId, { state: state as chrome.windows.WindowState });
}
