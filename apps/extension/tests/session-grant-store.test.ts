import { describe, expect, it } from "vitest";
import { AGENT_SESSION_GRANTS_KEY, createSessionGrantStore } from "../src/service-worker/session-grant-store.js";

const A = "https://a.com";
const B = "https://b.com";
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const T1 = 1_000;
const T2 = 2_000;

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
 * 031/T913 - the session grant store (R-456, data-model "Session grant").
 *
 * Entries are only ever added, never replaced; a grant covers its own session, its own agent, its
 * exact origin and its own kind; it goes with its session or with its agent's unpair.
 */
describe("T913 the session grant store", () => {
  it("covers the exact origin and kind that were granted, for that session only", async () => {
    const store = createSessionGrantStore({ session: fakeArea(), now: () => T1 });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });

    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(true);
    // Another kind is not this grant.
    expect(await store.covers("s1", AGENT, A, "diagnostics")).toBe(false);
    // Exact origin only.
    expect(await store.covers("s1", AGENT, "https://www.a.com", "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, "http://a.com", "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, "https://a.com:8443", "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, "https://a.com/", "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, "not an origin", "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, B, "page-actions")).toBe(false);
    // Another session is never covered.
    expect(await store.covers("s2", AGENT, A, "page-actions")).toBe(false);
  });

  it("adds entries one at a time and lists a session's own, with their source and time", async () => {
    const store = createSessionGrantStore({ session: fakeArea(), now: () => T1 });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    await store.add("s1", AGENT, { site: A, kind: "diagnostics", source: "browser" });
    await store.add("s1", AGENT, { site: B, kind: "page-actions", source: "browser" });
    await store.add("s2", AGENT, { site: B, kind: "diagnostics", source: "client" });

    expect(await store.list("s1", AGENT)).toEqual([
      { sessionId: "s1", site: A, kind: "page-actions", source: "client", grantedAt: T1 },
      { sessionId: "s1", site: A, kind: "diagnostics", source: "browser", grantedAt: T1 },
      { sessionId: "s1", site: B, kind: "page-actions", source: "browser", grantedAt: T1 },
    ]);
    expect(await store.list("s2", AGENT)).toEqual([{ sessionId: "s2", site: B, kind: "diagnostics", source: "client", grantedAt: T1 }]);
    expect(await store.list("s3", AGENT)).toEqual([]);
  });

  it("keeps the first entry when the same session, site and kind is added again", async () => {
    let clock = T1;
    const store = createSessionGrantStore({ session: fakeArea(), now: () => clock });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    clock = T2;
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "browser" });

    expect(await store.list("s1", AGENT)).toEqual([{ sessionId: "s1", site: A, kind: "page-actions", source: "client", grantedAt: T1 }]);
  });

  it("clears one session and leaves the others", async () => {
    const store = createSessionGrantStore({ session: fakeArea(), now: () => T1 });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    await store.add("s2", AGENT, { site: B, kind: "page-actions", source: "client" });

    await store.clearSession("s1");

    expect(await store.list("s1", AGENT)).toEqual([]);
    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
    expect(await store.covers("s2", AGENT, B, "page-actions")).toBe(true);
    await expect(store.clearSession("never-had-one")).resolves.toBeUndefined();
  });

  it("clears every session of an unpaired agent by its id, including sessions nobody has in memory", async () => {
    const session = fakeArea();
    const before = createSessionGrantStore({ session, now: () => T1 });
    await before.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    await before.add("s2", OTHER_AGENT, { site: B, kind: "page-actions", source: "client" });

    const restarted = createSessionGrantStore({ session, now: () => T1 });
    await restarted.add("s3", AGENT, { site: B, kind: "diagnostics", source: "browser" });
    await restarted.clearAgent(AGENT);

    expect(await restarted.list("s1", AGENT)).toEqual([]);
    expect(await restarted.list("s3", AGENT)).toEqual([]);
    expect(await restarted.covers("s2", OTHER_AGENT, B, "page-actions")).toBe(true);
  });

  it("survives a worker restart: a second store over the same area reads the first's grants", async () => {
    const session = fakeArea();
    await createSessionGrantStore({ session, now: () => T1 }).add("s1", AGENT, { site: A, kind: "diagnostics", source: "client" });

    const restarted = createSessionGrantStore({ session });

    expect(await restarted.covers("s1", AGENT, A, "diagnostics")).toBe(true);
    expect(await restarted.list("s1", AGENT)).toEqual([{ sessionId: "s1", site: A, kind: "diagnostics", source: "client", grantedAt: T1 }]);
  });

  it("treats malformed stored data as empty without throwing, and drops it on the next write", async () => {
    const good = { agentId: AGENT, grants: [{ site: B, kind: "page-actions", source: "client", grantedAt: T1 }] };
    for (const value of [
      null,
      "x",
      42,
      [A],
      { s1: null },
      { s1: { agentId: AGENT } },
      { s1: { grants: [] } },
      { s1: { agentId: AGENT, grants: "x" } },
      { s1: { agentId: AGENT, grants: [{ site: A, kind: "everything", source: "client", grantedAt: T1 }] } },
      { s1: { agentId: AGENT, grants: [{ site: A, kind: "page-actions", source: "nowhere", grantedAt: T1 }] } },
      { s1: { agentId: AGENT, grants: [{ site: A, kind: "page-actions", source: "client", grantedAt: "soon" }] } },
    ]) {
      const store = createSessionGrantStore({ session: fakeArea({ [AGENT_SESSION_GRANTS_KEY]: value }) });
      expect(await store.list("s1", AGENT)).toEqual([]);
      expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
    }

    const session = fakeArea({ [AGENT_SESSION_GRANTS_KEY]: { bad: "x", s2: good } });
    await createSessionGrantStore({ session, now: () => T1 }).add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    expect(Object.keys(session.raw[AGENT_SESSION_GRANTS_KEY] as object).sort()).toEqual(["s1", "s2"]);
  });

  it("never covers a stored site that is not an origin", async () => {
    const session = fakeArea({
      [AGENT_SESSION_GRANTS_KEY]: {
        s1: { agentId: AGENT, grants: [{ site: "a.com", kind: "page-actions", source: "client", grantedAt: T1 }] },
      },
    });
    const store = createSessionGrantStore({ session });

    expect(await store.covers("s1", AGENT, "a.com", "page-actions")).toBe(false);
  });
});

/**
 * A session id carries no proof of who is behind it: after a worker restart any paired agent that
 * greets with a stored id gets a session under its own agent. The owner's yes was to the agent they
 * were shown, so a grant is read only for the agent it was recorded for (the 017 site plan's rule,
 * 017 review M1).
 */
describe("T913 grants belong to the agent they were given to", () => {
  it("neither covers nor lists another agent's grant under the same session id", async () => {
    const session = fakeArea();
    await createSessionGrantStore({ session, now: () => T1 }).add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });

    const restarted = createSessionGrantStore({ session });

    expect(await restarted.covers("s1", AGENT, A, "page-actions")).toBe(true);
    expect(await restarted.covers("s1", OTHER_AGENT, A, "page-actions")).toBe(false);
    expect(await restarted.list("s1", OTHER_AGENT)).toEqual([]);
    // No agent is nobody's.
    expect(await restarted.covers("s1", "", A, "page-actions")).toBe(false);
    expect(await restarted.list("s1", "")).toEqual([]);
  });

  it("starts another agent's grants afresh under the same session id, never merged into the first agent's", async () => {
    const session = fakeArea();
    const store = createSessionGrantStore({ session, now: () => T1 });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });

    await store.add("s1", OTHER_AGENT, { site: B, kind: "page-actions", source: "browser" });

    // The record is the second agent's alone: the first agent's grant went with the session it was given in.
    expect(session.raw[AGENT_SESSION_GRANTS_KEY]).toEqual({
      s1: { agentId: OTHER_AGENT, grants: [{ site: B, kind: "page-actions", source: "browser", grantedAt: T1 }] },
    });
    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
    expect(await store.covers("s1", OTHER_AGENT, A, "page-actions")).toBe(false);
    expect(await store.covers("s1", OTHER_AGENT, B, "page-actions")).toBe(true);
    // And an unpair of the first agent leaves the second agent's grant alone.
    await store.clearAgent(AGENT);
    expect(await store.covers("s1", OTHER_AGENT, B, "page-actions")).toBe(true);
  });
});

/** Failures behave as the site plan store's do: reads stay closed, an add that was not written is said. */
describe("T913 the store's failures and its writes in order", () => {
  it("refuses to record with no storage area, and reads nothing from one", async () => {
    const store = createSessionGrantStore({ session: undefined });

    await expect(store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" })).rejects.toThrow("session-grant-not-recorded");
    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
    expect(await store.list("s1", AGENT)).toEqual([]);
    await expect(store.clearSession("s1")).resolves.toBeUndefined();
    await expect(store.clearAgent(AGENT)).resolves.toBeUndefined();
  });

  it("passes a failed write on to the caller", async () => {
    const area = fakeArea();
    area.set = async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    const store = createSessionGrantStore({ session: area });

    await expect(store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" })).rejects.toThrow();
    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
  });

  it("lands every one of several writes made side by side", async () => {
    const session = fakeArea({
      [AGENT_SESSION_GRANTS_KEY]: {
        s2: { agentId: AGENT, grants: [{ site: B, kind: "page-actions", source: "client", grantedAt: T1 }] },
      },
    });
    const store = createSessionGrantStore({ session, now: () => T1 });

    await Promise.all([
      store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" }),
      store.clearSession("s2"),
      store.add("s1", AGENT, { site: B, kind: "diagnostics", source: "browser" }),
      store.add("s3", AGENT, { site: A, kind: "diagnostics", source: "client" }),
    ]);

    expect(await store.list("s1", AGENT)).toHaveLength(2);
    expect(await store.list("s2", AGENT)).toEqual([]);
    expect(await store.covers("s3", AGENT, A, "diagnostics")).toBe(true);
  });
});

/** 032/T964 - a revoke of a site on the settings page removes it from every session (R-487, FR-490). */
describe("T964 a site revoke forgets that site's grants in every session", () => {
  it("removes both kinds for that exact site in every session and agent, and keeps every other site", async () => {
    const store = createSessionGrantStore({ session: fakeArea(), now: () => T1 });
    await store.add("s1", AGENT, { site: A, kind: "page-actions", source: "client" });
    await store.add("s1", AGENT, { site: A, kind: "diagnostics", source: "browser" });
    await store.add("s1", AGENT, { site: B, kind: "page-actions", source: "client" });
    await store.add("s2", OTHER_AGENT, { site: A, kind: "diagnostics", source: "client" });
    await store.add("s3", AGENT, { site: "https://www.a.com", kind: "page-actions", source: "client" });

    await store.forgetSite(A);

    expect(await store.covers("s1", AGENT, A, "page-actions")).toBe(false);
    expect(await store.covers("s1", AGENT, A, "diagnostics")).toBe(false);
    expect(await store.covers("s2", OTHER_AGENT, A, "diagnostics")).toBe(false);
    expect(await store.list("s2", OTHER_AGENT)).toEqual([]);
    // The session's other sites stand.
    expect(await store.list("s1", AGENT)).toEqual([{ sessionId: "s1", site: B, kind: "page-actions", source: "client", grantedAt: T1 }]);
    // Exact origin, as `covers` compares: a similar name is another site.
    expect(await store.covers("s3", AGENT, "https://www.a.com", "page-actions")).toBe(true);
  });

  it("writes nothing for a site no session holds, and nothing with no area", async () => {
    const session = fakeArea();
    const store = createSessionGrantStore({ session, now: () => T1 });
    await store.add("s1", AGENT, { site: B, kind: "page-actions", source: "client" });
    let writes = 0;
    const realSet = session.set;
    session.set = async (items) => {
      writes += 1;
      await realSet(items);
    };

    await store.forgetSite(A);

    expect(writes).toBe(0);
    expect(await store.covers("s1", AGENT, B, "page-actions")).toBe(true);
    await expect(createSessionGrantStore({ session: undefined }).forgetSite(A)).resolves.toBeUndefined();
  });
});
