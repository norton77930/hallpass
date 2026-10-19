/**
 * When the broker's run is over (019 R-312, FR-296; T575, D-019-14).
 *
 * Two signals. The browser's main process going (`browser-process.ts`) ends the run at once - looked
 * at every second, attached or not. A relay going opens a window for a new relay of the same run: 35 s
 * while the browser is known to be alive (Chrome can recycle the worker, and the host with it, and
 * bring it back that late - T572), 15 s when the browser is not known, so a missing pid never makes
 * the broker live longer than it did before. The window opens once per absence and closes when a
 * relay of the run takes the broker back.
 */

/** The window when the browser's main process is not known (R-312 as in 0.13.0). */
export const REDIAL_WINDOW_MS = 15_000;
/** The window while the browser's main process is known to be alive (D-019-14). */
export const RELAY_WINDOW_BROWSER_ALIVE_MS = 35_000;
/** How often the browser's main process is looked at. */
export const BROWSER_POLL_MS = 1_000;

export type BrokerLifetime = {
  openWindow(reason: string): void;
  closeWindow(): void;
  /** No timer fires any more (the broker is shutting down). */
  stop(): void;
};

export function createBrokerLifetime(options: {
  /** Whether the browser's main process is gone; absent when it is not known. */
  browserGone?: () => boolean;
  end: (reason: string) => void;
  log: (code: string, detail?: string) => void;
}): BrokerLifetime {
  const { browserGone, end, log } = options;
  const windowMs = browserGone === undefined ? REDIAL_WINDOW_MS : RELAY_WINDOW_BROWSER_ALIVE_MS;
  let stopped = false;
  let windowTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: string): void => {
    if (stopped) return;
    lifetime.stop();
    end(reason);
  };

  const poll =
    browserGone === undefined
      ? undefined
      : setInterval(() => {
          if (browserGone()) finish("browser-gone");
        }, BROWSER_POLL_MS);

  const lifetime: BrokerLifetime = {
    openWindow(reason) {
      if (stopped || windowTimer !== undefined) return;
      log("broker.window-open", `${reason} ${windowMs}`);
      windowTimer = setTimeout(() => finish("window-expired"), windowMs);
    },
    closeWindow() {
      if (windowTimer === undefined) return;
      clearTimeout(windowTimer);
      windowTimer = undefined;
    },
    stop() {
      stopped = true;
      if (poll !== undefined) clearInterval(poll);
      if (windowTimer !== undefined) clearTimeout(windowTimer);
      windowTimer = undefined;
    },
  };
  return lifetime;
}
