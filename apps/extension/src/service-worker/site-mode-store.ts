import { siteModeRecordSchema, type SiteMode, type SiteModeRecord } from "@hallpass/contracts";

/**
 * The owner's standing decision for one site (003/T023, FR-041, FR-042, R-107, R-108).
 *
 * Three things about it are deliberate. The default is `ask`, not "no record": a site the owner has
 * never decided about must reach them, and a store that answered "unknown" would leave every caller
 * to invent the safe reading for itself. The key is the *origin* - scheme, host and port - because
 * anything coarser applies one page's decision to another page's, and the fixtures this feature is
 * proven against differ only by port. And it lives in `chrome.storage.local` because it is the
 * owner's decision rather than a session's: it must outlive the worker, the browser, and the agent
 * that happened to be connected when it was made.
 *
 * The store holds no policy about what a mode *means*. That is the gate's; keeping it out of here is
 * what lets the panel and the gate read the same record without either of them being able to decide
 * on the other's behalf.
 */

const STORAGE_KEY = "agentSiteModes";

/** What a site nobody has decided about is worth: the owner is asked, every time. */
export const DEFAULT_SITE_MODE: SiteMode = "ask";

export type SiteModePatch = {
  mode?: SiteMode;
  diagnosticsGranted?: boolean;
};

export type SiteModeStore = {
  /** The record for one site, defaulted rather than absent. Never writes. */
  get(site: string): Promise<SiteModeRecord>;
  /** Applies one change and answers with the whole record it produced. */
  set(site: string, patch: SiteModePatch): Promise<SiteModeRecord>;
  /** Only the sites the owner has actually decided about, for the panel's list. */
  list(): Promise<SiteModeRecord[]>;
  /**
   * Forgets one site's record entirely (006 FR-086): the mode *and* the diagnostics grant go, and
   * the site answers the default again. A revoke is not `set(site, { mode: "ask" })` - that would
   * keep the row in the list as a decision the owner made, which is the opposite of what they did.
   */
  clear(site: string): Promise<void>;
};

/**
 * The site one page URL belongs to, or `undefined` when it has none this feature can decide about.
 *
 * `URL.origin` is the derivation rather than a hand-assembled `protocol//host`, because it is the
 * one that already knows a default port is not written out - two spellings of the same site would be
 * two records, and the owner's decision would apply to one of them.
 */
export function siteOfUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // `origin` is "null" for the schemes with no meaningful one (about:, data:, and on some engines
  // the extension's own). A page with no origin has no site to hold a decision.
  return parsed.origin === "null" || parsed.origin === "" ? undefined : parsed.origin;
}

function assertSite(site: string): void {
  if (!siteModeRecordSchema.shape.site.safeParse(site).success) {
    // Thrown, not defaulted: a caller that reached here with a path or a wildcard has a bug, and
    // silently recording the decision under a normalised key would apply it to more than was meant.
    throw new Error(`expected a site origin, got: ${site}`);
  }
}

type StoredRecords = Record<string, { mode: SiteMode; diagnosticsGranted: boolean }>;

export type SiteModeStoreDeps = {
  read: () => Promise<StoredRecords>;
  write: (records: StoredRecords) => Promise<void>;
  /**
   * Registers a listener for changes to the stored map made outside this store, so the cache can be
   * dropped instead of being written back over them (004/T129c).
   */
  watch?: (onExternalChange: () => void) => void;
};

async function readRecords(): Promise<StoredRecords> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!area) return {};
  const raw = (await area.get([STORAGE_KEY])) as Record<string, unknown>;
  const stored = raw[STORAGE_KEY];
  if (!stored || typeof stored !== "object") return {};
  const out: StoredRecords = {};
  for (const [site, value] of Object.entries(stored as Record<string, unknown>)) {
    // Every stored entry is re-admitted by the contract on the way out. Storage is not a trusted
    // input: an entry written by an older build, or edited by hand, must not become a mode the gate
    // then honours.
    const parsed = siteModeRecordSchema.safeParse({ site, ...(value as object) });
    if (parsed.success) {
      out[site] = { mode: parsed.data.mode, diagnosticsGranted: parsed.data.diagnosticsGranted };
    }
  }
  return out;
}

async function writeRecords(records: StoredRecords): Promise<void> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!area) return;
  await area.set({ [STORAGE_KEY]: records });
}

/**
 * Tells the store when the record changes under it (004/T129c).
 *
 * The store's own writes raise this too, which costs one re-read and is the price of not having to
 * tell its own writes from anyone else's - a distinction storage does not offer and that would put
 * the cache back in charge of deciding whom to believe.
 */
export function watchSiteModes(onExternalChange: () => void): void {
  const changed = typeof chrome !== "undefined" ? chrome.storage?.onChanged : undefined;
  changed?.addListener((changes, areaName) => {
    if (areaName === "local" && STORAGE_KEY in changes) {
      onExternalChange();
    }
  });
}

export function createSiteModeStore(
  deps: SiteModeStoreDeps = { read: readRecords, write: writeRecords, watch: watchSiteModes },
): SiteModeStore {
  let loaded: StoredRecords | undefined;
  /**
   * The record changed since `loaded` was taken, so `loaded` is a claim about storage that storage
   * no longer agrees with (004/T129c). The mode a probe run - or the panel in another worker
   * generation - wrote must reach the gate, and must not be written back over by the next `set`.
   */
  let stale = false;
  deps.watch?.(() => {
    stale = true;
  });
  /**
   * One chain for every mutation. Two decisions arriving together - the panel's and an `ask`
   * prompt's "remember this" - must not each read the map, change their own entry and write the
   * whole thing back, which is how one of the two disappears.
   */
  let queue: Promise<void> = Promise.resolve();

  async function load(): Promise<StoredRecords> {
    if (stale) {
      stale = false;
      loaded = await deps.read();
    }
    loaded ??= await deps.read();
    return loaded;
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function recordOf(site: string, stored: StoredRecords): SiteModeRecord {
    const entry = stored[site];
    return {
      site,
      mode: entry?.mode ?? DEFAULT_SITE_MODE,
      diagnosticsGranted: entry?.diagnosticsGranted ?? false,
    };
  }

  return {
    async get(site) {
      assertSite(site);
      return recordOf(site, await enqueue(load));
    },
    async set(site, patch) {
      assertSite(site);
      return enqueue(async () => {
        const stored = { ...(await load()) };
        const current = recordOf(site, stored);
        const next = {
          mode: patch.mode ?? current.mode,
          diagnosticsGranted: patch.diagnosticsGranted ?? current.diagnosticsGranted,
        };
        // A record that says exactly what the absence of one says is not a decision: it would sit
        // in the panel's list as something the owner decided and may revoke, for a site they have
        // decided nothing about. Back at the default, the site is forgotten instead.
        if (next.mode === DEFAULT_SITE_MODE && !next.diagnosticsGranted) {
          delete stored[site];
        } else {
          stored[site] = next;
        }
        loaded = stored;
        await deps.write(stored);
        return { site, ...next };
      });
    },
    async clear(site) {
      assertSite(site);
      await enqueue(async () => {
        const stored = { ...(await load()) };
        delete stored[site];
        loaded = stored;
        await deps.write(stored);
      });
    },
    async list() {
      const stored = await enqueue(load);
      return Object.keys(stored)
        .sort()
        .map((site) => recordOf(site, stored));
    },
  };
}
