import { describe, expect, it } from "vitest";
import { AGENT_UPLOAD_MAX_BASE64_CHARS } from "@hallpass/contracts";
import {
  createScreenshotCache,
  SCREENSHOT_BUDGET_CHARS,
  SCREENSHOT_ISSUED_LIMIT,
  SCREENSHOT_RETENTION_MS,
} from "../src/screenshot-cache.js";

/**
 * 013/T327 (US3) — what the host keeps of a screenshot, and for how long (FR-168, FR-172, FR-175).
 *
 * The cache is where this feature's whole retention promise lives, and every clause of it is a rule
 * about time or size - so the clock and the id source are injected and there is not a single timer
 * in the module. A sweep that only runs when somebody touches the cache is what makes these
 * assertions the *whole* behaviour rather than a sample of it: there is no background moment in
 * which an entry might quietly change state.
 *
 * The three answers `take` distinguishes are the point of the design. "Never issued here" and "was
 * issued and is gone" lead an agent to different next moves - the first means it is quoting an id
 * from somebody else's session or from before a reconnect, the second means take a new screenshot -
 * so they are two answers, not one.
 */

const PNG = "image/png";

/** A clock a test moves by hand; nothing in the cache may advance it. */
function clock(startMs = 1_757_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = startMs;
  return { now: () => at, advance: (ms) => void (at += ms) };
}

/** An id source a test can read off the page: `issue` composes `img_` in front of it. */
function counter(): () => string {
  let next = 0;
  return () => `id${String(++next).padStart(8, "0")}`;
}

/**
 * A picture the size a real screenshot is: well inside one upload frame, so the only bound it can
 * ever meet is the session's accumulated budget.
 */
const PICTURE_CHARS = 300_000;
const PICTURE = "a".repeat(PICTURE_CHARS);

describe("013 screenshot cache", () => {
  it("hands back the bytes and the type the screenshot answer carried", () => {
    const time = clock();
    const cache = createScreenshotCache({ now: time.now, randomId: counter() });

    const issued = cache.issue("iVBORw0KGgo=", PNG);

    expect(issued).toEqual({ imageId: "img_id00000001", retained: true });
    expect(cache.take(issued.imageId)).toEqual({
      kind: "ok",
      file: { type: PNG, bytesBase64: "iVBORw0KGgo=" },
    });
    // Taking does not spend it: the same picture may go into two pages inside the window.
    expect(cache.take(issued.imageId)).toMatchObject({ kind: "ok" });
  });

  it("forgets a picture a millisecond past the retention window", () => {
    const time = clock();
    const cache = createScreenshotCache({ now: time.now, randomId: counter() });
    const issued = cache.issue("iVBORw0KGgo=", PNG);

    time.advance(SCREENSHOT_RETENTION_MS);
    expect(cache.take(issued.imageId), "the last millisecond is still inside the window").toMatchObject({
      kind: "ok",
    });

    time.advance(1);
    expect(cache.take(issued.imageId)).toEqual({ kind: "gone", why: "expired" });
  });

  it("evicts the oldest and stops as soon as the new one fits", () => {
    const time = clock();
    // A budget exactly two pictures wide, shortened the way a gate run shortens it: the product's
    // own eight mebibytes would take a dozen pictures to reach, and the rule is the same at both
    // sizes.
    const cache = createScreenshotCache({
      now: time.now,
      randomId: counter(),
      budgetChars: 2 * PICTURE_CHARS,
    });

    const first = cache.issue(PICTURE, PNG);
    time.advance(1_000);
    const second = cache.issue(PICTURE, PNG);
    time.advance(1_000);
    const third = cache.issue(PICTURE, PNG);

    // Three will not fit in two, so the oldest goes - and only the oldest, because two of them do
    // fit. An eviction that cleared the cache would throw away a picture nobody asked it to, which
    // is the difference between a budget and a flush.
    expect(third.retained).toBe(true);
    expect(cache.take(first.imageId)).toEqual({ kind: "gone", why: "evicted" });
    expect(cache.take(second.imageId)).toMatchObject({ kind: "ok" });
    expect(cache.take(third.imageId)).toMatchObject({ kind: "ok" });
  });

  it("never stores a picture larger than the whole budget, and still issues its id", () => {
    const time = clock();
    // A budget under one upload frame, so the budget is the bound this case is about.
    const cache = createScreenshotCache({ now: time.now, randomId: counter(), budgetChars: PICTURE_CHARS });

    const huge = cache.issue("a".repeat(PICTURE_CHARS + 1), PNG);

    // The id exists so the *answer* can say why: an agent told "too large to retain" on the spot
    // learns the rule without spending a call on it (R-179).
    expect(huge).toEqual({ imageId: "img_id00000001", retained: false });
    expect(cache.take(huge.imageId)).toEqual({ kind: "gone", why: "oversize" });

    // And nothing was stored: the whole budget is still free for the next picture.
    const fits = cache.issue("a".repeat(PICTURE_CHARS), PNG);
    expect(fits.retained).toBe(true);
    expect(cache.take(fits.imageId)).toMatchObject({ kind: "ok" });
  });

  /**
   * S2c review F1 — the *other* bound a retained picture has to satisfy (FR-168, FR-172).
   *
   * A retained picture is only worth keeping if `upload_image` can carry it back to the worker, and
   * that trip is one native-messaging frame bounded at `AGENT_UPLOAD_MAX_BASE64_CHARS`. The
   * `screenshot` tool refuses a bigger picture itself, but the `computer` tool's screenshot action
   * does not, so a cache that only watched its own budget would hold a picture whose only upload
   * would be refused by the contract - "retained" with the one sentence that promises an upload.
   * The effective bound is therefore the smaller of the two, and it is said here rather than left
   * to whichever caller happens to check.
   */
  it("will not retain a picture larger than one upload frame, whatever the budget allows", () => {
    const time = clock();
    const cache = createScreenshotCache({ now: time.now, randomId: counter() });
    // The budget is a session's accumulation and is far the larger of the two numbers.
    expect(SCREENSHOT_BUDGET_CHARS).toBeGreaterThan(AGENT_UPLOAD_MAX_BASE64_CHARS);

    const overFrame = cache.issue("a".repeat(AGENT_UPLOAD_MAX_BASE64_CHARS + 1), PNG);

    expect(overFrame.retained).toBe(false);
    expect(cache.take(overFrame.imageId)).toEqual({ kind: "gone", why: "oversize" });

    // Exactly one frame's worth is a picture the upload can carry, so it is kept.
    const fits = cache.issue("a".repeat(AGENT_UPLOAD_MAX_BASE64_CHARS), PNG);
    expect(fits.retained).toBe(true);
    expect(cache.take(fits.imageId)).toMatchObject({ kind: "ok" });
  });

  it("says unknown for an id it never issued", () => {
    const cache = createScreenshotCache({ now: clock().now, randomId: counter() });

    expect(cache.take("img_a1b2c3d4e5")).toEqual({ kind: "unknown" });
  });

  it("sees nothing of another cache's ids (FR-175)", () => {
    const time = clock();
    const mine = createScreenshotCache({ now: time.now, randomId: counter() });
    const theirs = createScreenshotCache({ now: time.now, randomId: counter() });

    const issued = theirs.issue("iVBORw0KGgo=", PNG);

    // Same id text, minted by the other cache: not "gone", not "expired" - never issued *here*.
    // One cache per session process is what makes this the isolation claim rather than a lookup.
    expect(mine.take(issued.imageId)).toEqual({ kind: "unknown" });
    expect(theirs.take(issued.imageId)).toMatchObject({ kind: "ok" });
  });

  it("forgets that it ever issued an id when it is cleared (R-180)", () => {
    const time = clock();
    const cache = createScreenshotCache({ now: time.now, randomId: counter() });
    const issued = cache.issue("iVBORw0KGgo=", PNG);

    cache.clear();

    // `unknown` rather than `gone`, because the issued set goes with the bytes: a cleared cache
    // belongs to a session that has started again, and "I never gave you that" is the honest answer.
    expect(cache.take(issued.imageId)).toEqual({ kind: "unknown" });
  });

  it("remembers what it issued only up to the bound, oldest forgotten first", () => {
    const time = clock();
    const cache = createScreenshotCache({ now: time.now, randomId: counter() });

    const first = cache.issue("a", PNG);
    for (let n = 1; n < SCREENSHOT_ISSUED_LIMIT; n += 1) {
      cache.issue("a", PNG);
    }
    // The bound is not reached yet: the first id is still one this cache admits to minting.
    expect(cache.take(first.imageId)).toMatchObject({ kind: "ok" });

    const last = cache.issue("a", PNG);

    // A session cannot be allowed to grow a set of ids without limit, and the oldest id is the one
    // least likely to be quoted - so it becomes an id this cache no longer knows anything about.
    expect(cache.take(first.imageId)).toEqual({ kind: "unknown" });
    expect(cache.take(last.imageId)).toMatchObject({ kind: "ok" });
  });

  /**
   * 018 T507 M1 (FR-275, R-272): a picture belongs to the browser that took it. Asked for from
   * another browser it is an id never issued there - not merely gone - so it cannot be put into a
   * page the owner never let it be taken in.
   */
  it("answers unknown for a picture taken under another browser, and ok under its own", () => {
    const cache = createScreenshotCache({ now: clock().now, randomId: counter() });

    const taken = cache.issue("a", PNG, "browser-a");

    expect(cache.take(taken.imageId, "browser-b")).toEqual({ kind: "unknown" });
    expect(cache.take(taken.imageId, "browser-a")).toMatchObject({ kind: "ok" });
    // And once gone, still not admitted as "gone" to the other browser.
    cache.clear();
    const oversize = createScreenshotCache({ now: clock().now, randomId: counter(), budgetChars: 1 });
    const big = oversize.issue("abc", PNG, "browser-a");
    expect(oversize.take(big.imageId, "browser-b")).toEqual({ kind: "unknown" });
    expect(oversize.take(big.imageId, "browser-a")).toEqual({ kind: "gone", why: "oversize" });
  });

  it("mints opaque ids that do not repeat", () => {
    const cache = createScreenshotCache({ now: clock().now });

    const ids = new Set<string>();
    for (let n = 0; n < 1_000; n += 1) {
      const { imageId } = cache.issue("a", PNG);
      expect(imageId).toMatch(/^img_[a-z0-9]{10}$/u);
      ids.add(imageId);
    }

    expect(ids.size).toBe(1_000);
  });
});
