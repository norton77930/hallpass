import type { ScreenshotSpace, ScreenshotSpaces } from "./agent-tools/coordinate-space.js";

/**
 * Where each tab's latest whole-viewport picture space is kept (012 change log 2026-10-17, R-280).
 *
 * `chrome.storage.session`, one key holding a map of tab id to space, for the reason the 012
 * viewport record lives there (R-170): the worker that took the picture is often not the worker
 * that receives the click aimed at it, and a space forgotten by an eviction would silently put that
 * click back in the wrong pixels. A browser restart empties the area, and with it every tab id.
 *
 * Bounded rather than cleared per tab: a closed tab's id is never reused in a browser run, so a
 * stale entry costs a few bytes and answers nothing; the least recently pictured go once there are
 * more than `MAX_TABS`. Recency is a counter stored on each entry (`at`), never the map's order:
 * tab ids are integer-like keys, which object order sorts numerically and a storage round trip does
 * not keep, so order alone would evict the lowest ids instead. Reads stay closed - no area, or
 * nothing readable, is no space, which is the pass-through every point had before.
 */

/** The session-area key. */
export const AGENT_SCREENSHOT_SPACES_KEY = "agentScreenshotSpaces";

const MAX_TABS = 64;

/** The part of a storage area this module uses; `chrome.storage.session` is one. */
export type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type ScreenshotSpaceStoreDeps = {
  /** Defaults to `chrome.storage.session`, looked up on each call so composing needs no browser. */
  session?: StorageAreaLike | undefined;
};

/** A stored entry: the space, and when it was pictured relative to every other entry (`at`). */
type Entry = ScreenshotSpace & { at: number };

type Spaces = Record<string, Entry>;

function isSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null) return false;
  const size = value as Record<string, unknown>;
  return (
    typeof size.width === "number" && size.width > 0 && typeof size.height === "number" && size.height > 0
  );
}

function isSpace(value: unknown): value is ScreenshotSpace {
  if (typeof value !== "object" || value === null) return false;
  const space = value as Record<string, unknown>;
  return isSize(space.frame) && isSize(space.image);
}

function chromeSessionArea(): StorageAreaLike | undefined {
  return typeof chrome === "undefined"
    ? undefined
    : (chrome.storage?.session as unknown as StorageAreaLike | undefined);
}

export function createScreenshotSpaceStore(deps: ScreenshotSpaceStoreDeps = {}): ScreenshotSpaces {
  const area = (): StorageAreaLike | undefined => ("session" in deps ? deps.session : chromeSessionArea());

  async function read(): Promise<Spaces> {
    const raw = await area()
      ?.get([AGENT_SCREENSHOT_SPACES_KEY])
      .catch(() => undefined);
    const value = raw?.[AGENT_SCREENSHOT_SPACES_KEY];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const spaces: Spaces = {};
    for (const [tabId, space] of Object.entries(value)) {
      if (isSpace(space)) {
        const at = (space as { at?: unknown }).at;
        spaces[tabId] = {
          frame: { width: space.frame.width, height: space.frame.height },
          image: { width: space.image.width, height: space.image.height },
          // An entry with no readable `at` is the oldest there is.
          at: typeof at === "number" && Number.isFinite(at) ? at : 0,
        };
      }
    }
    return spaces;
  }

  /** One write at a time, so two pictures of two tabs taken side by side both land. */
  let writes: Promise<unknown> = Promise.resolve();

  return {
    async get(tabId) {
      const entry = (await read())[String(tabId)];
      return entry === undefined ? undefined : { frame: entry.frame, image: entry.image };
    },
    remember(tabId, space) {
      const job = async (): Promise<void> => {
        const target = area();
        if (!target) return;
        const spaces = await read();
        const newest = Math.max(0, ...Object.values(spaces).map((entry) => entry.at));
        delete spaces[String(tabId)];
        if (space) spaces[String(tabId)] = { frame: space.frame, image: space.image, at: newest + 1 };
        // By the stored counter, never by key order: the least recently pictured go first.
        const kept = Object.entries(spaces)
          .sort(([, a], [, b]) => a.at - b.at)
          .slice(-MAX_TABS);
        await target.set({ [AGENT_SCREENSHOT_SPACES_KEY]: Object.fromEntries(kept) });
      };
      const next = writes.then(job, job);
      writes = next.catch(() => undefined);
      return next;
    },
  };
}
