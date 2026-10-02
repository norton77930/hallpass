import { describe, expect, it } from "vitest";
import { AGENT_SESSION_SITE_PLANS_KEY, createSitePlanStore } from "../src/service-worker/site-plan-store.js";

const A = "https://a.com";
const B = "https://b.com";
const C = "https://c.com";
const STAMP = "2026-10-02T10:00:00.000Z";
const AGENT = "agent-1";

function fakeArea(store: Record<string, unknown> = {}): {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  raw: Record<string, unknown>;
} {
  return {
    raw: store,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
  };
}

/**
 * 017/T464 — the session site plan's store (R-246, data-model "Session site plan").
 *
 * One plan per session, in the session area: it dies with the session, the pairing or the browser
 * (FR-258), a new approval replaces it rather than adding to it (FR-260), and it covers only the
 * exact origins the owner approved.
 */
describe("T464 the session site plan store", () => {
  it("keeps one plan per session in the session area", async () => {
    const session = fakeArea();
    const store = createSitePlanStore({ session, now: () => STAMP });
    await store.set("s1", [A, B], AGENT);
    await store.set("s2", [C], AGENT);

    expect(await store.forSession("s1")).toEqual({ origins: [A, B], approvedAt: STAMP, agentId: AGENT });
    expect(await store.forSession("s2")).toEqual({ origins: [C], approvedAt: STAMP, agentId: AGENT });
    expect(await store.forSession("s3")).toBeUndefined();
    expect(session.raw[AGENT_SESSION_SITE_PLANS_KEY]).toEqual({
      s1: { origins: [A, B], approvedAt: STAMP, agentId: AGENT },
      s2: { origins: [C], approvedAt: STAMP, agentId: AGENT },
    });
  });

  it("replaces a session's previous plan and never merges it (FR-260)", async () => {
    let clock = STAMP;
    const store = createSitePlanStore({ session: fakeArea(), now: () => clock });
    await store.set("s1", [A, B], AGENT);
    clock = "2026-10-02T11:00:00.000Z";
    await store.set("s1", [C], AGENT);

    expect(await store.forSession("s1")).toEqual({ origins: [C], approvedAt: clock, agentId: AGENT });
    expect(await store.covers("s1", A, AGENT)).toBe(false);
    expect(await store.covers("s1", C, AGENT)).toBe(true);
  });

  it("covers exact origins only", async () => {
    const store = createSitePlanStore({ session: fakeArea(), now: () => STAMP });
    await store.set("s1", [A], AGENT);

    expect(await store.covers("s1", A, AGENT)).toBe(true);
    expect(await store.covers("s1", "https://www.a.com", AGENT)).toBe(false);
    expect(await store.covers("s1", "http://a.com", AGENT)).toBe(false);
    expect(await store.covers("s1", "https://a.com:8443", AGENT)).toBe(false);
    expect(await store.covers("s1", "https://a.com/", AGENT)).toBe(false);
    expect(await store.covers("s1", "not an origin", AGENT)).toBe(false);
    expect(await store.covers("s1", "", AGENT)).toBe(false);
    // Another session's plan is not this one's.
    expect(await store.covers("s2", A, AGENT)).toBe(false);
  });

  it("never covers a stored string that is not an origin", async () => {
    const session = fakeArea({
      [AGENT_SESSION_SITE_PLANS_KEY]: { s1: { origins: ["a.com", "not an origin"], approvedAt: STAMP } },
    });
    const store = createSitePlanStore({ session });

    expect(await store.covers("s1", "a.com", AGENT)).toBe(false);
    expect(await store.covers("s1", "not an origin", AGENT)).toBe(false);
  });

  it("clears one session and leaves the others", async () => {
    const store = createSitePlanStore({ session: fakeArea(), now: () => STAMP });
    await store.set("s1", [A], AGENT);
    await store.set("s2", [B], AGENT);

    await store.clear("s1");

    expect(await store.forSession("s1")).toBeUndefined();
    expect(await store.covers("s1", A, AGENT)).toBe(false);
    expect(await store.covers("s2", B, AGENT)).toBe(true);
  });

  it("clears every session of an unpaired agent at once", async () => {
    const store = createSitePlanStore({ session: fakeArea(), now: () => STAMP });
    await store.set("s1", [A], AGENT);
    await store.set("s2", [B], AGENT);
    await store.set("s3", [C], AGENT);

    await store.clearMany(["s1", "s3", "never-had-one"]);

    expect(await store.forSession("s1")).toBeUndefined();
    expect(await store.forSession("s3")).toBeUndefined();
    expect(await store.covers("s2", B, AGENT)).toBe(true);
  });

  /**
   * The unpair gap found in S2b: the runtime knew only the sessions in its memory, so after a worker
   * restart a session that had not greeted again kept its plan through an unpair and had it back on
   * re-pairing. The plan says whose it is, and an unpair clears by that.
   */
  it("clears every plan an agent holds by its id, including sessions nobody has in memory", async () => {
    const session = fakeArea();
    const before = createSitePlanStore({ session, now: () => STAMP });
    await before.set("s1", [A], AGENT);
    await before.set("s2", [B], "agent-2");

    const restarted = createSitePlanStore({ session });
    await restarted.set("s3", [C], AGENT);
    await restarted.clearAgent(AGENT);

    expect(await restarted.forSession("s1")).toBeUndefined();
    expect(await restarted.forSession("s3")).toBeUndefined();
    expect(await restarted.covers("s2", B, "agent-2")).toBe(true);
  });

  /**
   * 017 review M1: a plan is the owner's yes to one agent's session. The same session id under
   * another agent - a re-announcement, or a greeting after a worker restart - is not covered by it.
   */
  it("covers only for the agent the plan was approved for", async () => {
    const store = createSitePlanStore({ session: fakeArea(), now: () => STAMP });
    await store.set("s1", [A], AGENT);

    expect(await store.covers("s1", A, AGENT)).toBe(true);
    expect(await store.covers("s1", A, "agent-2")).toBe(false);
    expect(await store.covers("s1", A, "")).toBe(false);
  });

  it("treats a stored plan that names no agent as no plan: nothing could ever unpair it", async () => {
    const session = fakeArea({
      [AGENT_SESSION_SITE_PLANS_KEY]: { s1: { origins: [A], approvedAt: STAMP } },
    });
    const store = createSitePlanStore({ session });

    expect(await store.forSession("s1")).toBeUndefined();
    expect(await store.covers("s1", A, AGENT)).toBe(false);
  });

  it("survives a worker restart: a second store over the same area reads the first's plan", async () => {
    const session = fakeArea();
    await createSitePlanStore({ session, now: () => STAMP }).set("s1", [A, B], AGENT);

    const restarted = createSitePlanStore({ session });

    expect(await restarted.forSession("s1")).toEqual({ origins: [A, B], approvedAt: STAMP, agentId: AGENT });
    expect(await restarted.covers("s1", B, AGENT)).toBe(true);
  });

  it("treats malformed stored data as empty without throwing", async () => {
    for (const value of [null, "x", 42, [A], { s1: null }, { s1: { origins: "x", approvedAt: STAMP } }, { s1: { origins: [A] } }, { s1: { origins: [A, 3], approvedAt: STAMP } }]) {
      const store = createSitePlanStore({ session: fakeArea({ [AGENT_SESSION_SITE_PLANS_KEY]: value }) });
      expect(await store.forSession("s1")).toBeUndefined();
      expect(await store.covers("s1", A, AGENT)).toBe(false);
    }
  });

  it("drops a malformed record on write and keeps the good ones", async () => {
    const session = fakeArea({
      [AGENT_SESSION_SITE_PLANS_KEY]: { bad: "x", s2: { origins: [B], approvedAt: STAMP, agentId: AGENT } },
    });
    const store = createSitePlanStore({ session, now: () => STAMP });
    await store.set("s1", [A], AGENT);

    expect(session.raw[AGENT_SESSION_SITE_PLANS_KEY]).toEqual({
      s1: { origins: [A], approvedAt: STAMP, agentId: AGENT },
      s2: { origins: [B], approvedAt: STAMP, agentId: AGENT },
    });
  });
});

/**
 * 017 S1 architecture review, items 2 and 3.
 *
 * An approval that was not written down is said, never swallowed: the owner pressed Approve and the
 * agent must not be told it may proceed on a plan the next call will not find (the 014 precedent,
 * `upload-directory-not-recorded`). Reads stay closed - no area is no plan. And the store's own
 * writes are serialised: each is a read of the whole map, a change and a write back, so an approval
 * and a session ending side by side must both land, never the second overwriting the first.
 */
describe("017 the store's failures and its writes in order", () => {
  it("refuses to approve with no storage area, and reads nothing from one", async () => {
    const store = createSitePlanStore({ session: undefined });

    await expect(store.set("s1", [A], AGENT)).rejects.toThrow("site-plan-not-recorded");
    expect(await store.forSession("s1")).toBeUndefined();
    expect(await store.covers("s1", A, AGENT)).toBe(false);
    // Nothing can have been written, so there is nothing to clear and nothing to fail about.
    await expect(store.clear("s1")).resolves.toBeUndefined();
    await expect(store.clearMany(["s1"])).resolves.toBeUndefined();
  });

  it("passes a failed write on to the approver", async () => {
    const area = fakeArea();
    area.set = async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    const store = createSitePlanStore({ session: area });

    await expect(store.set("s1", [A], AGENT)).rejects.toThrow();
    expect(await store.covers("s1", A, AGENT)).toBe(false);
  });

  it("lands every one of several writes made side by side", async () => {
    const session = fakeArea({ [AGENT_SESSION_SITE_PLANS_KEY]: { s2: { origins: [B], approvedAt: STAMP, agentId: AGENT } } });
    const store = createSitePlanStore({ session, now: () => STAMP });

    // An approval, a session ending and another approval, none awaited before the next begins.
    await Promise.all([store.set("s1", [A], AGENT), store.clear("s2"), store.set("s3", [C], AGENT), store.clearMany(["s4"])]);

    expect(session.raw[AGENT_SESSION_SITE_PLANS_KEY]).toEqual({
      s1: { origins: [A], approvedAt: STAMP, agentId: AGENT },
      s3: { origins: [C], approvedAt: STAMP, agentId: AGENT },
    });
  });

  it("keeps writing after one write failed", async () => {
    const area = fakeArea();
    const realSet = area.set;
    let failNext = true;
    area.set = async (items) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
      await realSet(items);
    };
    const store = createSitePlanStore({ session: area, now: () => STAMP });

    const first = store.set("s1", [A], AGENT);
    const second = store.set("s2", [B], AGENT);

    await expect(first).rejects.toThrow();
    await expect(second).resolves.toBeUndefined();
    expect(await store.covers("s2", B, AGENT)).toBe(true);
  });
});
