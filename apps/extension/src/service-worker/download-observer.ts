import {
  AGENT_DOWNLOADS_KEPT,
  AGENT_DOWNLOAD_TERMINAL_STATES,
  type AgentDownloadRecord,
  type AgentWaitDownload,
} from "@hallpass/contracts";
import {
  watchDownloadChanged,
  watchDownloadCreated,
  type DownloadDelta,
  type DownloadSnapshot,
} from "../chrome-adapters/downloads.js";

/**
 * The browser's downloads, observed and attributed to sessions (005/T179, R-123, FR-076..FR-080).
 *
 * The browser's record carries no tab id, so there is one rule and it is about time: a download
 * created while a session holds at least one tab is that session's. When several hold one it is
 * every one of theirs, and each is told so (`shared`) rather than one being quietly left out; when
 * none does it is the owner's and no ring ever carries it. A change updates every ring that carries
 * the id. Nothing here acts on a download - the adapter cannot even express it.
 *
 * Where it lives (FR-080): `chrome.storage.session`, one key, a ring per session - newest first,
 * bounded - beside the watermark the `download-complete` wait reads (R-124). Session storage because
 * the records die with the browser like the sessions do, and because a worker evicted mid-download
 * has to find what its predecessor wrote when the browser wakes it for the change. Writes go
 * through one settled chain, the same shape as the bridge rings: two events in quick succession
 * must not read the same ring and lose one, and a write that rejects must not stop the next.
 */

export const AGENT_DOWNLOADS_KEY = "agentDownloads";

/**
 * One session's records and its wait watermark: the moment the session's last `download-complete`
 * wait was answered, `0` until one has been. A completion is "the next one" when it ended after
 * this, which is what lets a small file that finished before the wait began still be answered -
 * once - and never twice (FR-078).
 */
export type DownloadRing = { items: AgentDownloadRecord[]; waitWatermark: number };

type StoredRings = Record<string, DownloadRing>;

type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};

export type DownloadObserverDeps = {
  /** The two subscriptions the adapter offers; injected so a test can raise the events itself. */
  onCreated: typeof watchDownloadCreated;
  onChanged: typeof watchDownloadChanged;
  /** Who holds at least one tab right now (`AgentTabManager.sessionsHoldingAnyTab`). */
  holders: () => Promise<string[]>;
  /** Defaults to `chrome.storage.session`. */
  storage?: StorageAreaLike;
  now?: () => number;
  reportDiagnostic?: (code: string) => void;
};

export type DownloadObserver = {
  /** Subscribes to the browser; call once at worker start, before anything can download. */
  start(): void;
  /** The session's records, newest first (`downloads_context`). */
  list(sessionId: string): Promise<AgentDownloadRecord[]>;
  /**
   * The newest record if it is over and ended after the watermark, moving the watermark to now;
   * `undefined` when nothing is there to answer. One poll of a `download-complete` wait.
   */
  takeCompletion(sessionId: string): Promise<AgentWaitDownload | undefined>;
  /** The session ended: its ring goes with it and nobody else's (FR-080). */
  discard(sessionId: string): Promise<void>;
  /** Every queued write so far has settled; for tests, which raise events synchronously. */
  settled(): Promise<void>;
};

function sessionArea(): StorageAreaLike | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
}

function isTerminal(state: AgentDownloadRecord["state"]): state is AgentWaitDownload["state"] {
  return (AGENT_DOWNLOAD_TERMINAL_STATES as readonly string[]).includes(state);
}

export function createDownloadObserver(deps: DownloadObserverDeps): DownloadObserver {
  const now = deps.now ?? (() => Date.now());

  /**
   * One writer at a time; the stored chain is the *settled* one, so a write that rejects still
   * rejects for its own caller while the next starts from a resolved link (the bridge rings' rule).
   */
  let writes: Promise<void> = Promise.resolve();
  function queue<T>(work: () => Promise<T>): Promise<T> {
    const next = writes.then(work);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function read(): Promise<{ area: StorageAreaLike; rings: StoredRings } | undefined> {
    const area = deps.storage ?? sessionArea();
    if (!area) return undefined;
    const raw = await area.get([AGENT_DOWNLOADS_KEY]);
    const stored = raw[AGENT_DOWNLOADS_KEY];
    const rings = stored && typeof stored === "object" ? ({ ...(stored as StoredRings) }) : {};
    return { area, rings };
  }

  async function created(item: DownloadSnapshot): Promise<void> {
    // Who holds a tab is asked *now*, at creation: the attribution is about this moment, and a
    // lease taken or dropped afterwards must not re-decide it. The write is queued at once too,
    // behind the events before it and ahead of the ones after: the browser reports a change right
    // behind a creation for a small file, and the change has to find the record the creation wrote.
    const holding = deps.holders();
    await queue(async () => {
      const holders = await holding;
      if (holders.length === 0) return;
      const attribution = holders.length === 1 ? "session" : "shared";
      const found = await read();
      if (!found) return;
      const { area, rings } = found;
      for (const sessionId of holders) {
        const ring = rings[sessionId] ?? { items: [], waitWatermark: 0 };
        const record: AgentDownloadRecord = { ...item, attribution };
        rings[sessionId] = {
          ...ring,
          // Newest first, bounded: the twenty-first oldest falls off the end (FR-079).
          items: [record, ...ring.items.filter((held) => held.id !== item.id)].slice(0, AGENT_DOWNLOADS_KEPT),
        };
      }
      await area.set({ [AGENT_DOWNLOADS_KEY]: rings });
    });
  }

  async function changed(delta: DownloadDelta): Promise<void> {
    await queue(async () => {
      const found = await read();
      if (!found) return;
      const { area, rings } = found;
      let touched = false;
      for (const [sessionId, ring] of Object.entries(rings)) {
        const index = ring.items.findIndex((record) => record.id === delta.id);
        if (index < 0) continue;
        const { id: _id, ...fields } = delta;
        const items = [...ring.items];
        const merged = { ...items[index]!, ...fields };
        // A terminal delta is not guaranteed to carry the browser's end time (a cancellation often
        // does not). The wait keys on `endedAt`, so an ending without one is stamped with the moment
        // it was observed rather than left un-ended forever.
        if (isTerminal(merged.state) && merged.endedAt === undefined) {
          merged.endedAt = new Date(now()).toISOString();
        }
        // The change record carries the total but never the received count, so a download that
        // completed would keep the `0` it was created with (the probe's finished zip, T187 B19). A
        // complete download is a whole one; the total the browser named is what it received.
        if (merged.state === "complete" && merged.totalBytes >= 0 && merged.bytesReceived < merged.totalBytes) {
          merged.bytesReceived = merged.totalBytes;
        }
        items[index] = merged;
        rings[sessionId] = { ...ring, items };
        touched = true;
      }
      // A change about a download nobody was told of - the owner's own - is nobody's event.
      if (touched) await area.set({ [AGENT_DOWNLOADS_KEY]: rings });
    });
  }

  return {
    start() {
      deps.onCreated((item) => {
        void created(item).catch(() => deps.reportDiagnostic?.("agent.downloads.record-failed"));
      });
      deps.onChanged((delta) => {
        void changed(delta).catch(() => deps.reportDiagnostic?.("agent.downloads.update-failed"));
      });
    },
    list(sessionId) {
      return queue(async () => (await read())?.rings[sessionId]?.items ?? []);
    },
    takeCompletion(sessionId) {
      return queue(async () => {
        const found = await read();
        const ring = found?.rings[sessionId];
        const newest = ring?.items[0];
        if (!found || !ring || !newest || !isTerminal(newest.state) || newest.endedAt === undefined) return undefined;
        const endedAt = Date.parse(newest.endedAt);
        if (!(endedAt > ring.waitWatermark)) return undefined;
        // Moved to now - or to the record's own end if the clock says that is later - so this
        // record can never satisfy a second wait and the next completion still can.
        found.rings[sessionId] = { ...ring, waitWatermark: Math.max(now(), endedAt) };
        await found.area.set({ [AGENT_DOWNLOADS_KEY]: found.rings });
        return { id: newest.id, filename: newest.filename, url: newest.url, state: newest.state };
      });
    },
    discard(sessionId) {
      return queue(async () => {
        const found = await read();
        if (!found || !(sessionId in found.rings)) return;
        delete found.rings[sessionId];
        await found.area.set({ [AGENT_DOWNLOADS_KEY]: found.rings });
      });
    },
    settled() {
      return writes;
    },
  };
}
