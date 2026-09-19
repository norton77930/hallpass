import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_GROUP_TITLE } from "../src/chrome-adapters/tab-groups.js";
import { createAgentTabManager, type AgentTabManager } from "../src/service-worker/agent-tab-manager.js";

/**
 * 004/T102 - the tab lease (R-117, data-model TabLease).
 *
 * 003 answered "may this session touch this tab" with the tab group, which was enough while the
 * only tabs an agent could reach were the ones it opened itself. S2 lets the agent take the tab the
 * owner is looking at, so the group can no longer be the authority: the owner's tab is in no group
 * until it is claimed, and two sessions asking for the same tab have to get two different answers.
 * The lease is that authority, and the group stays as the *visible* marking of it.
 *
 * The invariant everything else rests on is at most one lease per tab: every refusal, every
 * handover and the indicator's single control read it, so it is asserted directly and under a race
 * rather than inferred from the tools that use it.
 */

type FakeTab = { id: number; url: string; groupId: number; active: boolean; windowId: number };

const UNGROUPED = -1;

function installChrome(tabs: FakeTab[]): { tabs: FakeTab[]; groupTitles: Map<number, string> } {
  const store: Record<string, unknown> = {};
  const groupTitles = new Map<number, string>();
  let nextGroupId = 100;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(store, values);
        },
      },
    },
    tabs: {
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        if (groupId !== undefined && !tabs.some((tab) => tab.groupId === groupId)) {
          throw new Error("No group with id: " + groupId);
        }
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async ungroup(tabIds: number[] | number) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = UNGROUPED;
        }
      },
    },
    tabGroups: {
      async update(groupId: number, properties: { title?: string }) {
        if (properties.title !== undefined) groupTitles.set(groupId, properties.title);
        return { id: groupId, ...properties };
      },
      async query({ title }: { title?: string }) {
        return [...groupTitles]
          .filter(([, groupTitle]) => title === undefined || groupTitle === title)
          .filter(([groupId]) => tabs.some((tab) => tab.groupId === groupId))
          .map(([groupId, groupTitle]) => ({ id: groupId, title: groupTitle }));
      },
    },
  };
  return { tabs, groupTitles };
}

function ownerTabs(): FakeTab[] {
  return [
    { id: 7, url: "https://owner.test/one", groupId: UNGROUPED, active: true, windowId: 1 },
    { id: 8, url: "https://owner.test/two", groupId: UNGROUPED, active: false, windowId: 1 },
    { id: 9, url: "chrome://settings", groupId: UNGROUPED, active: false, windowId: 1 },
  ];
}

describe("T102 tab leases", () => {
  let fake: ReturnType<typeof installChrome>;
  let manager: AgentTabManager;

  beforeEach(() => {
    fake = installChrome(ownerTabs());
    manager = createAgentTabManager();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("claims an unheld tab, marks its group and records an owner-kind lease", async () => {
    const claimed = await manager.claim("session-a", 7);

    expect(claimed).toEqual({
      ok: true,
      lease: { tabId: 7, sessionId: "session-a", kind: "owner", since: expect.any(String) },
    });
    // The lease is the authority; the group is how the owner sees it, so both happen or neither.
    expect(fake.tabs[0]?.groupId).not.toBe(UNGROUPED);
    expect(fake.groupTitles.get(fake.tabs[0]?.groupId ?? -1)).toBe(AGENT_GROUP_TITLE);
    expect(await manager.leases()).toEqual([
      { tabId: 7, sessionId: "session-a", kind: "owner", since: expect.any(String) },
    ]);
  });

  it("holds at most one lease per tab: two simultaneous claims, exactly one wins", async () => {
    // Not awaited in turn: this is the race the invariant exists for - two sessions asking for the
    // owner's tab in the same turn, neither having seen the other's answer.
    const outcomes = await Promise.all([manager.claim("session-a", 7), manager.claim("session-b", 7)]);

    const winner = outcomes.find((outcome) => outcome.ok === true);
    const loser = outcomes.find((outcome) => outcome.ok === false);
    expect(outcomes.filter((outcome) => outcome.ok === true)).toHaveLength(1);
    expect(loser).toEqual({
      ok: false,
      reason: "held-by-session",
      sessionId: winner?.ok === true ? winner.lease.sessionId : "",
    });
    expect(await manager.leases()).toHaveLength(1);
  });

  it("refuses a tab another live session holds, naming the holder", async () => {
    await manager.claim("session-a", 7);

    expect(await manager.claim("session-b", 7)).toEqual({
      ok: false,
      reason: "held-by-session",
      sessionId: "session-a",
    });
  });

  it("refuses a restricted page and a tab that is gone, and leases neither", async () => {
    expect(await manager.claim("session-a", 9)).toEqual({ ok: false, reason: "restricted-page" });
    expect(await manager.claim("session-a", 404)).toEqual({ ok: false, reason: "tab-gone" });
    expect(await manager.leases()).toEqual([]);
  });

  it("answers ownership with the four facts the tools branch on", async () => {
    await manager.claim("session-a", 7);

    expect(await manager.ownership("session-a", 7)).toEqual({ state: "this" });
    expect(await manager.ownership("session-b", 7)).toEqual({
      state: "held-by-session",
      sessionId: "session-a",
    });
    // The owner's own tab, held by nobody: not a refusal about somebody else, an invitation to claim.
    expect(await manager.ownership("session-a", 8)).toEqual({ state: "not-yours" });
    expect(await manager.ownership("session-a", 404)).toEqual({ state: "gone" });
  });

  it("releases: the lease is dropped and the tab leaves the visible group", async () => {
    await manager.claim("session-a", 7);

    await manager.release("session-a", 7);

    expect(await manager.leases()).toEqual([]);
    expect(fake.tabs[0]?.groupId).toBe(UNGROUPED);
    // Released to nobody, so the next session may take it.
    expect((await manager.claim("session-b", 7)).ok).toBe(true);
  });

  it("releases the lease of a tab the owner closed, without touching the rest", async () => {
    await manager.claim("session-a", 7);
    await manager.claim("session-a", 8);

    fake.tabs.splice(0, 1);
    const context = await manager.context("session-a");

    expect(context.gone).toEqual([7]);
    expect(await manager.leases()).toEqual([
      { tabId: 8, sessionId: "session-a", kind: "owner", since: expect.any(String) },
    ]);
  });

  it("ends a session by releasing its own leases and nobody else's", async () => {
    await manager.claim("session-a", 7);
    await manager.claim("session-b", 8);

    await manager.endSession("session-a");

    expect(await manager.leases()).toEqual([
      { tabId: 8, sessionId: "session-b", kind: "owner", since: expect.any(String) },
    ]);
    expect(await manager.ownership("session-b", 8)).toEqual({ state: "this" });
  });

  it("tracks mainTabId as the tab most recently created, claimed or acted on", async () => {
    await manager.adopt("session-a", 7);
    expect(await manager.mainTabId("session-a")).toBe(7);

    await manager.claim("session-a", 8);
    expect(await manager.mainTabId("session-a")).toBe(8);

    // An effect on an older tab makes that one the main tab again: the indicator's control brings
    // the owner to where the agent is working now, not to where it started.
    await manager.touch("session-a", 7);
    expect(await manager.mainTabId("session-a")).toBe(7);
  });

  /**
   * B17's finding: while a session sits idle the relay is torn down and respawned every 25-30 s,
   * and each respawn re-announces the session and opens a fresh 15 s reconciliation window. That
   * churn is invisible to the agent, so nothing it holds may depend on it - a lease released by a
   * respawn would take the owner's tab back off an agent that never stopped working.
   */
  it("keeps an idle session's leases, group and mainTabId across two relay respawns", async () => {
    await manager.claim("session-a", 7);
    await manager.adopt("session-a", 8);
    const groupId = fake.tabs[0]?.groupId;

    for (const respawn of ["2026-09-09T10:00:25.000Z", "2026-09-09T10:00:52.000Z"]) {
      await manager.beginReconciliation(respawn);
      // The greeting the respawned relay forwards; the session did nothing else in between.
      await manager.announce("session-a", respawn);
      expect(await manager.reconcile()).toEqual([]);
    }

    expect(await manager.leases()).toEqual([
      { tabId: 7, sessionId: "session-a", kind: "owner", since: expect.any(String) },
      { tabId: 8, sessionId: "session-a", kind: "agent", since: expect.any(String) },
    ]);
    expect(fake.tabs[0]?.groupId).toBe(groupId);
    expect(await manager.mainTabId("session-a")).toBe(8);
    expect(await manager.ownership("session-a", 7)).toEqual({ state: "this" });
  });
});
