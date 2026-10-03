import { randomBytes } from "node:crypto";
import { AGENT_UPLOAD_MAX_BASE64_CHARS } from "@hallpass/contracts";

/**
 * What the host keeps of a screenshot so the agent can put it into a page (013 US3, R-177, R-179).
 *
 * It lives in the *host* rather than in the worker because the host is the one end every screenshot
 * already crosses, and because one `mcp-server` process is one agent session: its memory dies with
 * the session, survives a worker recycling, and is unreadable by another session or by the panel
 * without anybody writing an isolation rule (FR-168, FR-175). The worker never sees an id and never
 * stores a picture.
 *
 * Pure and timer-free on purpose. The clock and the id source are injected, and expiry is swept
 * when somebody touches the cache, so there is no background moment in which an entry changes state
 * behind a test's back - and nothing to unref, clear or leak in a process whose stdout belongs to
 * the MCP transport.
 */

/** Five minutes (FR-168). Long enough to read a picture and act on it, short enough to forget. */
export const SCREENSHOT_RETENTION_MS = 300_000;

/**
 * Eight mebibytes of base64, counted in characters because that is the unit the pictures arrive in.
 *
 * This is a bound on a *session's* accumulation - what a long session taking a picture a minute
 * would otherwise grow without limit - and not on one picture: that is `retainLimit` below.
 */
export const SCREENSHOT_BUDGET_CHARS = 8_388_608;

/**
 * How many ids a session admits to having minted.
 *
 * The issued set is what keeps "never issued here" and "issued and now gone" two different answers,
 * and those two answers lead an agent to two different next moves. It cannot grow for ever either,
 * so the oldest id - the one least likely to be quoted - is the one forgotten first.
 */
export const SCREENSHOT_ISSUED_LIMIT = 10_000;

/**
 * The two sentences a screenshot answer carries beside its id (FR-167, R-179).
 *
 * Here rather than in `mcp-server.ts` because that file is an entry point: importing it starts a
 * server on this process's stdio, so anything a test or a gate spec needs to read has to sit where
 * reading it costs nothing.
 */
export const SCREENSHOT_UPLOAD_SENTENCES = {
  retained: "Quote imageId to upload_image to put this picture into a page (kept 5 minutes).",
  oversize: "Too large to retain for upload_image; a smaller screenshot (scale or region) can be.",
} as const;

/** Why an id that was issued no longer resolves to a picture. */
export type ScreenshotGoneReason = "expired" | "evicted" | "oversize";

/** What `take` found: the picture, an id this cache never minted, or the reason it is gone. */
export type ScreenshotTake =
  | { kind: "ok"; file: { type: string; bytesBase64: string } }
  | { kind: "unknown" }
  | { kind: "gone"; why: ScreenshotGoneReason };

export type ScreenshotCache = {
  /**
   * Mint an id for a picture and keep the bytes if they fit. `retained: false` is the oversize
   * case: the id is issued anyway, so the answer can tell the agent why on the spot.
   */
  issue(bytesBase64: string, mimeType: string, issuer?: string): { imageId: string; retained: boolean };
  /**
   * Resolve an id. Does *not* remove it: one picture may go into two pages inside the window.
   *
   * 018 (T507 M1, FR-275): `issuer` is the browser the picture was taken in and `requester` the
   * browser asking. A picture asked for from another browser is `unknown` - never issued *there* -
   * so a screenshot cannot travel into a page in a browser where the owner never let it be taken.
   */
  take(imageId: string, requester?: string): ScreenshotTake;
  /** Drop the bytes and the issued set together (R-180: link loss, reconnect, unpair). */
  clear(): void;
};

export type ScreenshotCacheOptions = {
  now?: () => number;
  /** The id's ten opaque characters; `issue` puts `img_` in front of them. */
  randomId?: () => string;
  /** The retention window and the budget, for a gate that has to watch them pass (S3/T341). */
  retentionMs?: number;
  budgetChars?: number;
};

type Entry = { mimeType: string; bytesBase64: string; storedAt: number };

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Ten characters of `[a-z0-9]` from a cryptographic source; opaque to everyone but this module. */
function mintSuffix(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) {
    out += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return out;
}

export function createScreenshotCache(options: ScreenshotCacheOptions = {}): ScreenshotCache {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? mintSuffix;
  const retentionMs = options.retentionMs ?? SCREENSHOT_RETENTION_MS;
  const budgetChars = options.budgetChars ?? SCREENSHOT_BUDGET_CHARS;
  /**
   * The largest picture this cache will keep (S2c review F1).
   *
   * Two bounds, and the smaller wins. The budget is the session's, and a picture bigger than the
   * whole budget could not be kept even in an empty cache. The other is the trip the retained bytes
   * exist for: `upload_image` carries them back to the worker in one native-messaging frame, whose
   * `file.bytesBase64` the contract bounds at `AGENT_UPLOAD_MAX_BASE64_CHARS`. The `screenshot`
   * tool refuses a bigger picture itself, but the `computer` tool's screenshot action does not - so
   * keeping one here would be answering "kept, quote the id to upload_image" about a picture no
   * upload could carry. Said once, where the id is minted, rather than at each caller.
   */
  const retainLimit = Math.min(budgetChars, AGENT_UPLOAD_MAX_BASE64_CHARS);

  /** The pictures still held, oldest first: a `Map` keeps insertion order, which is store order. */
  const held = new Map<string, Entry>();
  /**
   * Every id this cache minted, oldest first, and what became of it. `undefined` means it is still
   * held; the two are one structure so a forgotten id cannot be remembered as gone by accident.
   */
  const issued = new Map<string, ScreenshotGoneReason | undefined>();
  /** Which browser each id was issued under (018 T507 M1); forgotten exactly when the id is. */
  const issuers = new Map<string, string>();
  let charsHeld = 0;

  function forget(imageId: string, why: ScreenshotGoneReason): void {
    const entry = held.get(imageId);
    if (entry === undefined) {
      return;
    }
    held.delete(imageId);
    charsHeld -= entry.bytesBase64.length;
    if (issued.has(imageId)) {
      issued.set(imageId, why);
    }
  }

  /** Expiry is checked here and nowhere else: `issue` and `take` are the only ways in. */
  function sweep(): void {
    const at = now();
    for (const [imageId, entry] of held) {
      if (at - entry.storedAt > retentionMs) {
        forget(imageId, "expired");
      }
    }
  }

  function mint(): string {
    // A collision inside one session would let one picture answer for another, so the issued set is
    // consulted rather than trusted to chance; a handful of attempts is far more than ten
    // cryptographic characters ever need.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const imageId = `img_${randomId()}`;
      if (!issued.has(imageId)) {
        return imageId;
      }
    }
    throw new Error("screenshot id source is not producing new ids");
  }

  function remember(imageId: string, why: ScreenshotGoneReason | undefined): void {
    issued.set(imageId, why);
    while (issued.size > SCREENSHOT_ISSUED_LIMIT) {
      const oldest = issued.keys().next();
      if (oldest.done === true) {
        return;
      }
      // The bytes go with the memory of the id: an entry nobody can name is one nobody can take.
      const entry = held.get(oldest.value);
      if (entry !== undefined) {
        held.delete(oldest.value);
        charsHeld -= entry.bytesBase64.length;
      }
      issued.delete(oldest.value);
      issuers.delete(oldest.value);
    }
  }

  return {
    issue(bytesBase64, mimeType, issuer) {
      sweep();
      const imageId = mint();
      if (issuer !== undefined) {
        issuers.set(imageId, issuer);
      }
      if (bytesBase64.length > retainLimit) {
        // Nothing is evicted for a picture that could not be kept even in an empty cache: the
        // session's other screenshots are not the reason this one does not fit.
        remember(imageId, "oversize");
        return { imageId, retained: false };
      }
      while (charsHeld + bytesBase64.length > budgetChars) {
        const oldest = held.keys().next();
        if (oldest.done === true) {
          break;
        }
        forget(oldest.value, "evicted");
      }
      held.set(imageId, { mimeType, bytesBase64, storedAt: now() });
      charsHeld += bytesBase64.length;
      remember(imageId, undefined);
      return { imageId, retained: true };
    },

    take(imageId, requester) {
      sweep();
      const issuer = issuers.get(imageId);
      if (requester !== undefined && issuer !== undefined && issuer !== requester) {
        return { kind: "unknown" };
      }
      const entry = held.get(imageId);
      if (entry !== undefined) {
        return { kind: "ok", file: { type: entry.mimeType, bytesBase64: entry.bytesBase64 } };
      }
      if (!issued.has(imageId)) {
        return { kind: "unknown" };
      }
      // An id this cache minted, whose picture is not here: the reason was recorded when it left.
      return { kind: "gone", why: issued.get(imageId) ?? "expired" };
    },

    clear() {
      held.clear();
      issued.clear();
      issuers.clear();
      charsHeld = 0;
    },
  };
}
