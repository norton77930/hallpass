/**
 * 035 R-528, data-model "Owner's edge": the edge of the page the owner wants the pill at.
 *
 * One value for the browser profile in `chrome.storage.local` under `agentPillEdge`, written by the
 * service worker alone (on an accepted `ui.agent.pill-move`); a page cannot reach extension storage.
 * Nothing stored, or a value this worker does not know, is `top` - today's place for the pill.
 *
 * The worker keeps a memory mirror so the indicator composer can say the edge synchronously; the
 * composer awaits `ready()` before its first message after a worker start, so a restarted worker
 * never draws a pill at the wrong edge.
 */

export const PILL_EDGE_STORAGE_KEY = "agentPillEdge";

export type PillEdge = "top" | "bottom";

export const DEFAULT_PILL_EDGE: PillEdge = "top";

export function isPillEdge(value: unknown): value is PillEdge {
  return value === "top" || value === "bottom";
}

type Storage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};

export type PillEdgeStore = {
  /** Loads the stored edge into the mirror, once; never rejects (an unreadable store is `top`). */
  ready(): Promise<void>;
  /** The mirror: `top` until `ready()` has resolved. */
  current(): PillEdge;
  /** The stored edge, read from storage now. */
  read(): Promise<PillEdge>;
  /** Stores the edge, one write at a time; rejects when it cannot be saved, leaving the mirror as it was. */
  set(edge: PillEdge): Promise<PillEdge>;
};

export function createPillEdgeStore(options: { storage?: () => Storage | undefined } = {}): PillEdgeStore {
  const storage = options.storage ?? (() => globalThis.chrome?.storage?.local as Storage | undefined);
  let mirror: PillEdge = DEFAULT_PILL_EDGE;
  let loading: Promise<void> | undefined;
  /** One change at a time, so two quick presses end with the last one stored. */
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<PillEdge> {
    const items = (await storage()?.get([PILL_EDGE_STORAGE_KEY]).catch(() => undefined)) ?? {};
    const stored = items[PILL_EDGE_STORAGE_KEY];
    return isPillEdge(stored) ? stored : DEFAULT_PILL_EDGE;
  }

  function ready(): Promise<void> {
    loading ??= read().then((edge) => {
      mirror = edge;
    });
    return loading;
  }

  return {
    ready,
    current: () => mirror,
    read,
    set(edge) {
      const work = async (): Promise<PillEdge> => {
        // A press before the first load would otherwise be overwritten by that load's older value.
        await ready();
        const area = storage();
        if (area === undefined) throw new Error("no storage");
        await area.set({ [PILL_EDGE_STORAGE_KEY]: edge });
        mirror = edge;
        return edge;
      };
      const next = queue.then(work, work);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
