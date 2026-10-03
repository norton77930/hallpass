import { AGENT_BROWSER_NAME_MAX_CHARS, type AgentBrowserKind } from "@hallpass/contracts";
import type { StorageAreaLike } from "./browser-run.js";

/**
 * Who this browser is (018 R-268, FR-267, data-model "Browser identity").
 *
 * One random id per profile, minted the first time anything asks and kept in
 * `chrome.storage.local`, so it survives the worker, a browser restart and an extension update -
 * the opposite lifetime of `browser-run.ts`, which is per run in `storage.session`. Beside it, the
 * name the owner gave this browser in the panel; absent means the default name (R-269), which the
 * relay computes because it depends on the other browsers.
 *
 * The kind is read off the browser and never stored: a profile does not change browser.
 *
 * Re-minted only when the relay reports that another live browser of another run holds the same
 * id (a copied profile, R-276). The name is kept with a number after it, so the two browsers read
 * differently in every list.
 */

/** Where the identity lives: `chrome.storage.local`, per profile and kept across restarts. */
export const AGENT_BROWSER_IDENTITY_KEY = "agentBrowserIdentity";

export type BrowserIdentity = { browserId: string; kind: AgentBrowserKind; name?: string };

export type BrowserIdentityStore = {
  /**
   * The identity, minting it on first use. `undefined` without a storage area: an id this worker
   * could not keep would be a new browser after every eviction, so saying nothing - which the relay
   * records as a legacy browser - is the honest answer.
   */
  read(): Promise<BrowserIdentity | undefined>;
  /** A new id, the owner's name (if any) kept with a numbered suffix (R-276). */
  remint(): Promise<BrowserIdentity | undefined>;
  /** Keeps the owner's name. The caller has already normalised it (`normalizeBrowserName`). */
  rename(name: string): Promise<BrowserIdentity | undefined>;
};

/** The minted id's rule, as `relay-ack.browserId` checks it: 8-64 letters, digits and '-'. */
const BROWSER_ID_RULE = /^[A-Za-z0-9-]{8,64}$/u;

/** A random UUID (36 chars), or 32 hex chars where `randomUUID` is missing; both fit the rule. */
function mintBrowserId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The part of `navigator` the kind is read from. */
export type NavigatorLike = {
  userAgentData?: { brands?: ReadonlyArray<{ brand: string }> };
  /** Brave's own marker; present only in Brave. */
  brave?: unknown;
};

/**
 * The browser's kind from its user-agent brands (plus Brave's own marker).
 *
 * The brands list holds the product, "Chromium", and a deliberately garbled placeholder (GREASE)
 * that changes between versions. A product this does not know - Opera, Vivaldi - is `unknown`
 * rather than "Chromium": the default name would otherwise call it something it is not.
 */
export function detectBrowserKind(nav: NavigatorLike | undefined): AgentBrowserKind {
  if (nav === undefined) return "unknown";
  if (nav.brave !== undefined && nav.brave !== null) return "brave";
  const brands = (nav.userAgentData?.brands ?? []).map((entry) => entry.brand);
  if (brands.includes("Brave")) return "brave";
  if (brands.includes("Microsoft Edge")) return "edge";
  if (brands.includes("Google Chrome")) return "chrome";
  const products = brands.filter((brand) => brand !== "Chromium" && !/not.*brand/iu.test(brand));
  if (brands.includes("Chromium") && products.length === 0) return "chromium";
  return "unknown";
}

/**
 * The owner's name numbered on (R-276): "Work" becomes "Work 2", "Work 2" becomes "Work 3". The
 * base is shortened when the number would push the name past 40 characters.
 */
export function suffixedBrowserName(name: string): string {
  const numbered = /^(.*\S) (\d+)$/u.exec(name);
  const base = numbered ? numbered[1]! : name;
  const next = numbered ? Number(numbered[2]) + 1 : 2;
  const suffix = ` ${next}`;
  return `${base.slice(0, AGENT_BROWSER_NAME_MAX_CHARS - suffix.length).trimEnd()}${suffix}`;
}

type Stored = { browserId: string; name?: string };

function readStored(value: unknown): { browserId?: string; name?: string } {
  if (typeof value !== "object" || value === null) return {};
  const record = value as { browserId?: unknown; name?: unknown };
  return {
    ...(typeof record.browserId === "string" && BROWSER_ID_RULE.test(record.browserId) ? { browserId: record.browserId } : {}),
    ...(typeof record.name === "string" && record.name.length > 0 ? { name: record.name } : {}),
  };
}

export function createBrowserIdentity(
  area: StorageAreaLike | undefined,
  options: { kind: AgentBrowserKind; mint?: () => string },
): BrowserIdentityStore {
  const mint = options.mint ?? mintBrowserId;
  /**
   * The current identity, held for this worker's life once read - as `browser-run.ts` holds its id,
   * for the same reason: two reads that raced would otherwise mint two ids for one browser. Every
   * write is chained onto it, so a rename and a re-mint never overtake each other.
   */
  let settled: Promise<Stored | undefined> | undefined;

  async function readOrMint(): Promise<Stored | undefined> {
    if (!area) return undefined;
    const stored = readStored((await area.get([AGENT_BROWSER_IDENTITY_KEY]))[AGENT_BROWSER_IDENTITY_KEY]);
    if (stored.browserId !== undefined) return { browserId: stored.browserId, ...(stored.name ? { name: stored.name } : {}) };
    // No id, or one that does not fit the rule: mint, and keep a name the owner already gave.
    return write({ browserId: mint(), ...(stored.name ? { name: stored.name } : {}) });
  }

  async function write(next: Stored): Promise<Stored> {
    await area!.set({ [AGENT_BROWSER_IDENTITY_KEY]: next });
    return next;
  }

  function current(): Promise<Stored | undefined> {
    settled ??= readOrMint().catch((error: unknown) => {
      // A failed read is not an identity, and must not be the answer for the worker's life.
      settled = undefined;
      throw error;
    });
    return settled;
  }

  function update(change: (stored: Stored) => Stored): Promise<BrowserIdentity | undefined> {
    const next = current().then((stored) => (stored === undefined ? undefined : write(change(stored))));
    // A failed write leaves the next ask to read storage again rather than trust memory.
    settled = next.catch((error: unknown) => {
      settled = undefined;
      throw error;
    });
    return next.then(withKind);
  }

  function withKind(stored: Stored | undefined): BrowserIdentity | undefined {
    return stored === undefined ? undefined : { browserId: stored.browserId, kind: options.kind, ...(stored.name ? { name: stored.name } : {}) };
  }

  return {
    read: () => current().then(withKind),
    remint: () =>
      update((stored) => ({ browserId: mint(), ...(stored.name ? { name: suffixedBrowserName(stored.name) } : {}) })),
    rename: (name) => update((stored) => ({ browserId: stored.browserId, name })),
  };
}

/**
 * The real identity, over `chrome.storage.local` and the worker's `navigator`. Held by its caller
 * for the worker's life rather than in a module variable, as `sessionBrowserRun` is.
 */
export function localBrowserIdentity(): BrowserIdentityStore {
  return createBrowserIdentity(
    typeof chrome !== "undefined" ? (chrome.storage?.local as unknown as StorageAreaLike | undefined) : undefined,
    { kind: detectBrowserKind(typeof navigator === "undefined" ? undefined : (navigator as unknown as NavigatorLike)) },
  );
}
