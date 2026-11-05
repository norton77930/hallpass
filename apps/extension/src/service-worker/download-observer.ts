import {
  AGENT_DOWNLOADS_KEPT,
  AGENT_DOWNLOAD_TERMINAL_STATES,
  type AgentDownloadRecord,
  type AgentWaitDownload,
} from "@hallpass/contracts";
import { canonicalOriginFromUrl } from "@hallpass/domain";
import {
  watchDownloadChanged,
  watchDownloadCreated,
  type DownloadDelta,
  type DownloadSnapshot,
} from "../chrome-adapters/downloads.js";

/**
 * The browser's downloads, observed and attributed to sessions (005/T179, R-123, FR-076..FR-080;
 * amended 2026-11-05, #36).
 *
 * The browser's record carries no tab id, but it names where the download came from: the page that
 * started it (`referrer`) and the source (`url`). A download is a session's when it was created while
 * that session held a tab *and* one of those origins is a site one of its tabs is on or is about to
 * be on (`pendingUrl`), or one the session announced it was navigating to (`expect`). When several
 * sessions qualify it is every one of theirs, and each is told so (`shared`) rather than one being
 * quietly left out; a download that matches no session's tabs is the owner's and no ring ever
 * carries it - however many tabs an idle agent holds on other sites. Before #36 the rule was time
 * alone, and an owner's own download on an unrelated site reached every agent that held any tab.
 * The one exception is a file this extension made itself (a recording export, a blob under the
 * extension's own origin): it has no page, so it goes to whoever holds a tab, as before.
 *
 * The record carries the file's *name*, not the path the browser saved it under: the agent asks
 * what the page produced, and the path names the owner's profile folder.
 *
 * A change updates every ring that carries the id. Nothing here acts on a download - the adapter
 * cannot even express it.
 *
 * Where it lives (FR-080): `chrome.storage.session`, one key, a ring per session - newest first,
 * bounded - beside the ids the `download-complete` wait has answered (R-124, 015/R-199). Session storage because
 * the records die with the browser like the sessions do, and because a worker evicted mid-download
 * has to find what its predecessor wrote when the browser wakes it for the change. Writes go
 * through one settled chain, the same shape as the bridge rings: two events in quick succession
 * must not read the same ring and lose one, and a write that rejects must not stop the next.
 */

export const AGENT_DOWNLOADS_KEY = "agentDownloads";

/**
 * One session's records and the ids its `download-complete` waits have already answered (015/R-199,
 * FR-207..FR-209). Every terminal record not in `answered` is pending, so a small file that finished
 * before the wait began is still answered - once - and two downloads that finish out of creation
 * order are both answered, earliest end first. `answered` only names ids still in `items`: an id
 * that falls off the ring leaves the list with it.
 */
export type DownloadRing = { items: AgentDownloadRecord[]; answered: number[] };

/**
 * A ring as it may be found in storage: written by this build, or by one before 015 that kept a
 * single watermark (the moment of the last answer) instead of `answered`.
 */
type StoredRing = { items: AgentDownloadRecord[]; answered?: number[]; waitWatermark?: number };

type StoredRings = Record<string, DownloadRing>;

type StorageAreaLike = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};

/** One session holding tabs, with the origins its tabs are on or are moving to (#36). */
export type DownloadHolder = { sessionId: string; origins: string[] };

export type DownloadObserverDeps = {
  /** The two subscriptions the adapter offers; injected so a test can raise the events itself. */
  onCreated: typeof watchDownloadCreated;
  onChanged: typeof watchDownloadChanged;
  /** Who holds at least one tab right now, and where those tabs are (`url` and `pendingUrl`). */
  holders: () => Promise<DownloadHolder[]>;
  /** This extension's own origin (`chrome-extension://<id>`): a blob under it is a file this extension made. */
  ownOrigin?: string;
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
   * Among the session's terminal records not yet answered to it, the one that ended first (ties:
   * the smaller id), recorded as answered; `undefined` when nothing is there to answer. One poll of
   * a `download-complete` wait.
   */
  takeCompletion(sessionId: string): Promise<AgentWaitDownload | undefined>;
  /**
   * The session's records whose `startedAt` is at or after `sinceMs`, newest first. Read-only: it
   * answers nothing a `download-complete` wait would (015/T405, the press path).
   */
  createdSince(sessionId: string, sinceMs: number): Promise<AgentDownloadRecord[]>;
  /**
   * The session is navigating a tab to `origin` and the browser may answer with a download (#36):
   * a download from that origin created before `untilMs` is the session's even if the tab's address
   * never shows it (the navigation is cancelled the moment it becomes a download).
   */
  expect(sessionId: string, origin: string, untilMs: number): void;
  /** The session ended: its ring goes with it and nobody else's (FR-080). */
  discard(sessionId: string): Promise<void>;
  /** Every queued write so far has settled; for tests, which raise events synchronously. */
  settled(): Promise<void>;
};

/**
 * The origin a download's url or referrer names, in the form the tab addresses are compared in.
 * A `blob:` url a page minted carries the page's origin inside it; `data:` and the like name none.
 */
export function downloadSourceOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  if (url.startsWith("blob:")) return downloadSourceOrigin(url.slice("blob:".length));
  return canonicalOriginFromUrl(url);
}

/** The file's own name, whichever separator the platform used; empty stays empty. */
export function downloadFileName(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? "";
}

function sessionArea(): StorageAreaLike | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
}

function isTerminal(state: AgentDownloadRecord["state"]): state is AgentWaitDownload["state"] {
  return (AGENT_DOWNLOAD_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The ring in this build's shape. A ring from before 015 carries a watermark instead of `answered`:
 * every terminal record that ended at or before it was answered by the old rule, so it counts as
 * answered now; the watermark itself is dropped and never written again.
 */
function migrate(ring: StoredRing): DownloadRing {
  const items = Array.isArray(ring.items) ? ring.items : [];
  if (Array.isArray(ring.answered)) return { items, answered: ring.answered };
  const watermark = typeof ring.waitWatermark === "number" ? ring.waitWatermark : 0;
  const answered = items
    .filter(
      (record) => isTerminal(record.state) && record.endedAt !== undefined && Date.parse(record.endedAt) <= watermark,
    )
    .map((record) => record.id);
  return { items, answered };
}

export function createDownloadObserver(deps: DownloadObserverDeps): DownloadObserver {
  const now = deps.now ?? (() => Date.now());
  /** Navigations announced by `expect`, per session; swept of the expired on every read. */
  const expected = new Map<string, Array<{ origin: string; untilMs: number }>>();

  function expectedOrigins(sessionId: string): string[] {
    const live = (expected.get(sessionId) ?? []).filter((entry) => entry.untilMs > now());
    if (live.length === 0) expected.delete(sessionId);
    else expected.set(sessionId, live);
    return live.map((entry) => entry.origin);
  }

  /** The sessions a created download belongs to (#36). */
  function attribute(item: DownloadSnapshot, holders: DownloadHolder[]): string[] {
    if (deps.ownOrigin !== undefined && item.url.startsWith(`blob:${deps.ownOrigin}/`)) {
      // This extension's own file: no page started it, so the time rule is all there is.
      return holders.map((holder) => holder.sessionId);
    }
    const sources = new Set([downloadSourceOrigin(item.referrer), downloadSourceOrigin(item.url)].filter((origin): origin is string => origin !== undefined));
    if (sources.size === 0) return [];
    return holders
      .filter((holder) => [...holder.origins, ...expectedOrigins(holder.sessionId)].some((origin) => sources.has(origin)))
      .map((holder) => holder.sessionId);
  }

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
    const rings: StoredRings = {};
    if (stored && typeof stored === "object") {
      for (const [sessionId, ring] of Object.entries(stored as Record<string, StoredRing>)) {
        rings[sessionId] = migrate(ring);
      }
    }
    return { area, rings };
  }

  async function created(item: DownloadSnapshot): Promise<void> {
    // Who holds a tab is asked *now*, at creation: the attribution is about this moment, and a
    // lease taken or dropped afterwards must not re-decide it. The write is queued at once too,
    // behind the events before it and ahead of the ones after: the browser reports a change right
    // behind a creation for a small file, and the change has to find the record the creation wrote.
    const holding = deps.holders();
    await queue(async () => {
      const holders = attribute(item, await holding);
      if (holders.length === 0) return;
      const attribution = holders.length === 1 ? "session" : "shared";
      const found = await read();
      if (!found) return;
      const { area, rings } = found;
      // The referrer stays with the browser: it is how the download was attributed, not a fact the
      // agent was promised, and the record's shape is closed.
      const { referrer: _referrer, ...reported } = item;
      for (const sessionId of holders) {
        const ring = rings[sessionId] ?? { items: [], answered: [] };
        const record: AgentDownloadRecord = { ...reported, filename: downloadFileName(item.filename), attribution };
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
        if (fields.filename !== undefined) fields.filename = downloadFileName(fields.filename);
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
        if (!found || !ring) return undefined;
        const answered = new Set(ring.answered);
        let next: (AgentDownloadRecord & { state: AgentWaitDownload["state"] }) | undefined;
        let nextEnd = 0;
        for (const record of ring.items) {
          if (!isTerminal(record.state) || record.endedAt === undefined || answered.has(record.id)) continue;
          const endedAt = Date.parse(record.endedAt);
          if (next === undefined || endedAt < nextEnd || (endedAt === nextEnd && record.id < next.id)) {
            next = record as AgentDownloadRecord & { state: AgentWaitDownload["state"] };
            nextEnd = endedAt;
          }
        }
        if (!next) return undefined;
        // Recorded as answered so it can never satisfy a second wait; the list only keeps ids still
        // in the ring, so it stays as bounded as the ring is.
        const held = new Set(ring.items.map((record) => record.id));
        found.rings[sessionId] = {
          items: ring.items,
          answered: [...ring.answered, next.id].filter((id) => held.has(id)),
        };
        await found.area.set({ [AGENT_DOWNLOADS_KEY]: found.rings });
        return { id: next.id, filename: next.filename, url: next.url, state: next.state };
      });
    },
    createdSince(sessionId, sinceMs) {
      return queue(async () => {
        const items = (await read())?.rings[sessionId]?.items ?? [];
        return items.filter((record) => Date.parse(record.startedAt) >= sinceMs);
      });
    },
    expect(sessionId, origin, untilMs) {
      expected.set(sessionId, [...(expected.get(sessionId) ?? []), { origin, untilMs }]);
    },
    discard(sessionId) {
      expected.delete(sessionId);
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
