import { describe, expect, it } from "vitest";
import {
  applyTransition,
  beginTransitionState,
  clearPending,
  isLoopbackOrigin,
  noteKnownOrigin,
  type TabTransitionState,
  type TransitionLookups,
} from "../src/service-worker/agent-tools/transitions.js";
import {
  AGENT_TRANSITIONS_ALLOWED_KEY,
  AGENT_TRANSITIONS_KEY,
  AGENT_TRANSITION_ALLOWANCES_KEY,
  AGENT_TRANSITIONS_TEST_SWITCH_KEY,
  createTransitionStore,
} from "../src/service-worker/transition-store.js";

/**
 * 014/T360 — the six rules, in order, over one tab (FR-185, FR-188, FR-189, data-model).
 *
 * The rules are a table in the spec and they are a table here, because their *order* is the whole
 * design: every row below would be a pending transition if the row above it had not exempted it,
 * so a test that asked each rule in isolation would pass with them applied in any order at all.
 * Each case therefore arranges a destination that rule (f) would hold and turns on exactly one
 * exemption.
 *
 * What is deliberately not here: anything about tabs, sessions, prompts or storage. This module
 * decides "does this arrival need the owner", and the runtime decides what to do about it - which
 * is what lets the gate's switch (rule a, off) and the owner's remembered pair (rule d) be pinned
 * as two answers of one function rather than as two code paths.
 */

const A = "https://a.test";
const B = "https://b.test";
const C = "https://c.test";

/** Lookups under which every arrival is undecided: rule (f) unless a rule above it fires. */
function lookups(overrides: Partial<TransitionLookups> = {}): TransitionLookups {
  return {
    siteMode: async () => "ask",
    allowedPair: async () => false,
    loopbackExempt: async () => true,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function onA(pending?: TabTransitionState["pending"]): TabTransitionState {
  return { known: [A], lastKnown: A, ...(pending === undefined ? {} : { pending }) };
}

describe("T360 the transition rules, in order", () => {
  it("(a) exempts a loopback destination while the gate's switch is unset", async () => {
    const { rule, state } = await applyTransition(onA(), "http://localhost:3000", lookups());
    expect(rule).toBe("loopback");
    expect(state.pending).toBeUndefined();
    expect(state.lastKnown).toBe("http://localhost:3000");
    expect(state.known).toContain("http://localhost:3000");
  });

  it("(a) is the only rule the test switch disables", async () => {
    const off = lookups({ loopbackExempt: async () => false });
    // The same loopback arrival now asks...
    const asked = await applyTransition(onA(), "http://127.0.0.1:19445", off);
    expect(asked.rule).toBe("pending");
    expect(asked.state.pending).toEqual({ from: A, to: "http://127.0.0.1:19445", since: 1_700_000_000_000 });
    // ...while a loopback destination the owner has decided about is still exempt, by rule (c).
    const decided = await applyTransition(onA(), "http://127.0.0.1:19445", {
      ...off,
      siteMode: async () => "skip-checks",
    });
    expect(decided.rule).toBe("site-mode");
    expect(decided.state.pending).toBeUndefined();
  });

  it("(b) an origin the session already knew for this tab clears a pending transition", async () => {
    const state = { known: [A, B], lastKnown: B, pending: { from: A, to: C, since: 1 } };
    const returned = await applyTransition(state, A, lookups());
    expect(returned.rule).toBe("known");
    // FR-189: a return to somewhere the session has been is not a move anybody has to answer for.
    expect(returned.state.pending).toBeUndefined();
    expect(returned.state.lastKnown).toBe(A);
  });

  it("(c) a destination the owner has a mode for needs no second decision", async () => {
    const { rule, state } = await applyTransition(onA(), B, lookups({ siteMode: async () => "follow-a-plan" }));
    expect(rule).toBe("site-mode");
    expect(state.pending).toBeUndefined();
    expect(state.known).toContain(B);
  });

  it("(d) an allowed pair is exempt, and it is the ordered pair that is asked about", async () => {
    const asked: Array<[string, string]> = [];
    const { rule, state } = await applyTransition(
      onA(),
      B,
      lookups({
        allowedPair: async (from, to) => {
          asked.push([from, to]);
          return from === A && to === B;
        },
      }),
    );
    expect(rule).toBe("allowed-pair");
    expect(state.pending).toBeUndefined();
    expect(asked).toEqual([[A, B]]);
  });

  it("(e) the origin a navigate asked for is the origin it may arrive at", async () => {
    const expecting = { ...onA(), expectedNavigate: B };
    const { rule, state } = await applyTransition(expecting, B, lookups());
    expect(rule).toBe("expected-navigate");
    expect(state.pending).toBeUndefined();
    // A redirect onwards to a third origin is not what the call asked for (T362's redirect case).
    const onward = await applyTransition(state, C, lookups());
    expect(onward.rule).toBe("pending");
    expect(onward.state.pending).toMatchObject({ from: B, to: C });
  });

  it("(f) otherwise the owner is owed a question, and successive moves collapse into one", async () => {
    const first = await applyTransition(onA(), B, lookups());
    expect(first.rule).toBe("pending");
    expect(first.state.pending).toEqual({ from: A, to: B, since: 1_700_000_000_000 });
    // FR-189: `to` is replaced and `from` is kept, so the card names where the tab *was*.
    const second = await applyTransition(first.state, C, lookups({ now: () => 1_700_000_009_000 }));
    expect(second.state.pending).toEqual({ from: A, to: C, since: 1_700_000_000_000 });
    // And a pending transition does not make its destination known: a return to A clears it,
    // a second arrival at C does not.
    expect(second.state.known).toEqual([A]);
    expect(second.state.lastKnown).toBe(A);
  });

  it("takes the first origin a tab is known to be on without asking about it", async () => {
    // A blank tab the session claimed: there is no origin it moved *from*, so there is no pair.
    const { rule, state } = await applyTransition(beginTransitionState(undefined), B, lookups());
    expect(rule).toBe("known");
    expect(state.pending).toBeUndefined();
    expect(state.lastKnown).toBe(B);
  });

  it("clears a pending transition when the owner allows it, and keeps the tab on the new origin", () => {
    const allowed = clearPending({ known: [A], lastKnown: A, pending: { from: A, to: B, since: 1 } });
    expect(allowed.pending).toBeUndefined();
    expect(allowed.lastKnown).toBe(B);
    expect(allowed.known).toEqual([A, B]);
  });

  it("knows the three loopback spellings and nothing else", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1:19443")).toBe(true);
    expect(isLoopbackOrigin("http://127.9.9.9")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8080")).toBe(true);
    expect(isLoopbackOrigin("https://a.test")).toBe(false);
    // Not a loopback address, however it reads: the name is the site.
    expect(isLoopbackOrigin("https://localhost.attacker.test")).toBe(false);
    expect(isLoopbackOrigin("https://127.0.0.1.attacker.test")).toBe(false);
  });

  it("seeds an origin as known without touching a pending transition", () => {
    const seeded = noteKnownOrigin(onA({ from: A, to: C, since: 1 }), B);
    expect(seeded.known).toEqual([A, B]);
    expect(seeded.lastKnown).toBe(B);
    expect(seeded.pending).toEqual({ from: A, to: C, since: 1 });
  });
});

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
 * 014/T361 — where the state lives, and how long (data-model, FR-190).
 *
 * Three lifetimes, and the test is mostly about the ends of them: a tab's own state dies with the
 * lease, a session's allowed pairs die with the session, and the owner's remembered pairs outlive
 * both and the worker with them. Nothing here holds a url or a word of a page - origins and two
 * timestamps, which is the whole of what FR-190 permits to be written down.
 */
describe("T361 the transition store", () => {
  it("keeps one state per session and tab", async () => {
    const session = fakeArea();
    const store = createTransitionStore({ session, local: fakeArea() });
    await store.save("s1", 7, { known: [A], lastKnown: A, pending: { from: A, to: B, since: 1 } });
    await store.save("s1", 8, { known: [C], lastKnown: C });
    await store.save("s2", 7, { known: [B], lastKnown: B });

    expect((await store.stateOf("s1", 7))?.pending).toEqual({ from: A, to: B, since: 1 });
    // Two tabs of one session are independent, and so are two sessions on one tab.
    expect((await store.stateOf("s1", 8))?.pending).toBeUndefined();
    expect((await store.stateOf("s2", 7))?.lastKnown).toBe(B);
    expect(session.raw[AGENT_TRANSITIONS_KEY]).toBeDefined();
  });

  it("drops a tab's state when the lease ends, whoever held it", async () => {
    const store = createTransitionStore({ session: fakeArea(), local: fakeArea() });
    await store.save("s1", 7, { known: [A], lastKnown: A, pending: { from: A, to: B, since: 1 } });
    await store.save("s1", 8, { known: [C], lastKnown: C });

    await store.forgetTab(7);

    expect(await store.stateOf("s1", 7)).toBeUndefined();
    expect(await store.stateOf("s1", 8)).toBeDefined();
  });

  it("drops a session's states and its allowed pairs when the session ends", async () => {
    const session = fakeArea();
    const store = createTransitionStore({ session, local: fakeArea() });
    await store.save("s1", 7, { known: [A], lastKnown: A });
    await store.allowForSession("s1", A, B);
    await store.save("s2", 9, { known: [A], lastKnown: A });
    await store.allowForSession("s2", A, C);

    await store.forgetSession("s1");

    expect(await store.stateOf("s1", 7)).toBeUndefined();
    expect(await store.allowsForSession("s1", A, B)).toBe(false);
    // Another agent's session is untouched by this one ending.
    expect(await store.stateOf("s2", 9)).toBeDefined();
    expect(await store.allowsForSession("s2", A, C)).toBe(true);
    expect(session.raw[AGENT_TRANSITIONS_ALLOWED_KEY]).toBeDefined();
  });

  it("allows an ordered pair for one session and not its reverse", async () => {
    const store = createTransitionStore({ session: fakeArea(), local: fakeArea() });
    await store.allowForSession("s1", A, B);
    expect(await store.allowsForSession("s1", A, B)).toBe(true);
    expect(await store.allowsForSession("s1", B, A)).toBe(false);
    expect(await store.allowsForSession("s2", A, B)).toBe(false);
  });

  it("remembers a pair with the time it was allowed, touches it in use, and forgets it on request", async () => {
    const local = fakeArea();
    let clock = Date.parse("2026-09-22T10:00:00.000Z");
    const store = createTransitionStore({ session: fakeArea(), local, now: () => new Date(clock).toISOString() });

    await store.remember(A, B);
    expect(await store.allowances()).toEqual([{ from: A, to: B, allowedAt: "2026-09-22T10:00:00.000Z" }]);
    // The contract's own key: the gate and the panel read this record, not an internal shape.
    expect(local.raw[AGENT_TRANSITION_ALLOWANCES_KEY]).toHaveLength(1);

    clock = Date.parse("2026-09-22T11:30:00.000Z");
    expect(await store.touch(A, B)).toBe(true);
    expect(await store.allowances()).toEqual([
      { from: A, to: B, allowedAt: "2026-09-22T10:00:00.000Z", lastUsedAt: "2026-09-22T11:30:00.000Z" },
    ]);
    // A pair nobody remembered is not written by a touch: only the owner's answer grows this list.
    expect(await store.touch(B, C)).toBe(false);
    expect(await store.allowances()).toHaveLength(1);

    // Remembering the same pair twice is one row, with the first time it was allowed.
    await store.remember(A, B);
    expect(await store.allowances()).toHaveLength(1);

    await store.forget(A, B);
    expect(await store.allowances()).toEqual([]);
  });

  it("reads the gate's switch, and exempts loopback destinations without it", async () => {
    const local = fakeArea();
    const store = createTransitionStore({ session: fakeArea(), local });
    expect(await store.loopbackExempt()).toBe(true);

    await local.set({ [AGENT_TRANSITIONS_TEST_SWITCH_KEY]: true });
    expect(await store.loopbackExempt()).toBe(false);
  });
});
