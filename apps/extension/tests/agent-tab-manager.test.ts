import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_GROUP_TITLE,
  RELEASED_GROUP_COLOR,
  RELEASED_GROUP_TITLE,
} from "../src/chrome-adapters/tab-groups.js";
import { createAgentTabManager } from "../src/service-worker/agent-tab-manager.js";
import { createAgentStopSignals } from "../src/service-worker/agent-tools/stop.js";
import { createGroupPresenter } from "../src/service-worker/group-presenter.js";

/**
 * 003/T016 — tab-group ownership (R-104).
 *
 * The group is not decoration: it is the boundary. `tabs_context` shows the session's group and
 * nothing else, so two agent sessions cannot see each other's tabs (SC-024), and every later tool
 * asks the same question before it touches a tab (FR-034). Reconciliation against live tabs is what
 * keeps that boundary honest after the owner closes a tab by hand (FR-044).
 */

type FakeTab = { id: number; url: string; title: string; groupId: number; active: boolean };

type FakeChrome = {
  tabs: FakeTab[];
  groupUpdates: Array<{ groupId: number; properties: unknown }>;
  /** What Chrome would answer `tabGroups.query` with: the title each group carries now. */
  groupTitles: Map<number, string>;
};

const UNGROUPED = -1;

function installChrome(tabs: FakeTab[]): FakeChrome {
  const state: FakeChrome = { tabs, groupUpdates: [], groupTitles: new Map() };
  let nextGroupId = 100;
  const store: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(store, values);
        },
      },
    },
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return state.tabs;
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        if (groupId !== undefined && !state.tabs.some((tab) => tab.groupId === groupId)) {
          // Chrome discards a group the moment its last tab leaves it, and refuses to add a tab to
          // one that is gone. This is what that refusal looks like.
          throw new Error("No group with id: " + groupId);
        }
        const target = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = target;
        }
        return target;
      },
      async ungroup(tabIds: number[]) {
        for (const tab of state.tabs) if (tabIds.includes(tab.id)) tab.groupId = UNGROUPED;
      },
    },
    tabGroups: {
      async update(groupId: number, properties: unknown) {
        // Chrome discards a group with its last tab, and an update to it is refused, not recorded.
        if (!state.tabs.some((tab) => tab.groupId === groupId)) throw new Error("No group with id: " + groupId);
        state.groupUpdates.push({ groupId, properties });
        const title = (properties as { title?: string }).title;
        if (title !== undefined) state.groupTitles.set(groupId, title);
        return { id: groupId, ...(properties as object) };
      },
      async query({ title }: { title?: string }) {
        return [...state.groupTitles]
          .filter(([, groupTitle]) => title === undefined || groupTitle === title)
          .filter(([groupId]) => state.tabs.some((tab) => tab.groupId === groupId))
          .map(([groupId, groupTitle]) => ({ id: groupId, title: groupTitle }));
      },
    },
  };
  return state;
}

describe("T016 agent tab manager", () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installChrome([
      { id: 1, url: "https://owner.test/", title: "Owner", groupId: UNGROUPED, active: true },
      { id: 2, url: "https://agent.test/one", title: "Agent one", groupId: UNGROUPED, active: false },
      { id: 3, url: "https://agent.test/two", title: "Agent two", groupId: UNGROUPED, active: false },
      { id: 4, url: "https://other-agent.test/", title: "Other agent", groupId: UNGROUPED, active: false },
    ]);
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("has no tabs and no group before the session adopts one", async () => {
    const manager = createAgentTabManager();

    await expect(manager.context("session-a")).resolves.toEqual({ tabs: [], gone: [] });
    expect(fake.groupUpdates).toEqual([]);
  });

  it("puts an adopted tab in a group the owner can see is the agent's", async () => {
    const manager = createAgentTabManager();

    await manager.adopt("session-a", 2);

    const grouped = fake.tabs.find((tab) => tab.id === 2);
    expect(grouped?.groupId).not.toBe(UNGROUPED);
    expect(fake.groupUpdates).toEqual([
      // 016 FR-238, FR-240: "Hallpass" in the session's own colour - the first session is the first
      // in the rotation.
      { groupId: grouped?.groupId, properties: { title: AGENT_GROUP_TITLE, color: "cyan" } },
    ]);
  });

  it("lists only the tabs in the session's own group", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);
    await manager.adopt("session-a", 3);
    await manager.adopt("session-b", 4);

    await expect(manager.context("session-a")).resolves.toEqual({
      tabs: [
        { tabId: 2, url: "https://agent.test/one", title: "Agent one", active: false },
        { tabId: 3, url: "https://agent.test/two", title: "Agent two", active: false },
      ],
      gone: [],
    });
    await expect(manager.context("session-b")).resolves.toEqual({
      tabs: [{ tabId: 4, url: "https://other-agent.test/", title: "Other agent", active: false }],
      gone: [],
    });
  });

  it("drops a tab the owner closed and reports it gone", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);
    await manager.adopt("session-a", 3);

    fake.tabs = fake.tabs.filter((tab) => tab.id !== 3);

    await expect(manager.context("session-a")).resolves.toEqual({
      tabs: [{ tabId: 2, url: "https://agent.test/one", title: "Agent one", active: false }],
      gone: [3],
    });
    // Reported once: the second call has nothing left to reconcile.
    await expect(manager.context("session-a")).resolves.toEqual({
      tabs: [{ tabId: 2, url: "https://agent.test/one", title: "Agent one", active: false }],
      gone: [],
    });
  });

  it("answers the ownership guard every later tool asks (FR-034)", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);
    await manager.adopt("session-b", 4);

    await expect(manager.ownership("session-a", 2)).resolves.toEqual({ state: "this" });
    // Another session's tab, and the owner's own tab, are both refusals - not silent successes.
    // 004/T103 tells them apart: one names its holder, the other is a tab nobody holds.
    await expect(manager.ownership("session-a", 4)).resolves.toEqual({
      state: "held-by-session",
      sessionId: "session-b",
    });
    await expect(manager.ownership("session-a", 1)).resolves.toEqual({ state: "not-yours" });

    fake.tabs = fake.tabs.filter((tab) => tab.id !== 2);
    await expect(manager.ownership("session-a", 2)).resolves.toEqual({ state: "gone" });
  });

  it("refuses to hand a tab from one session to another", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);

    await expect(manager.adopt("session-b", 2)).rejects.toThrow("tab-owned-by-another-session");
  });

  /**
   * 003/M4 Part A — a relay reconnect is not a new session (D-M3-3, review F8/L4).
   *
   * Chrome's relay comes and goes while one agent session runs. The record is keyed by the *agent*
   * session id the host minted, so a second manager - which is what a torn-down and restarted MV3
   * worker builds - reads the same record back and the tabs are still owned. The regression this
   * guards is a session that mints its own id per connection: its tabs would answer `foreign` the
   * moment the link blinked.
   */
  it("keeps the session's tabs owned across a relay reconnect", async () => {
    const before = createAgentTabManager();
    await before.adopt("session-a", 2);

    const after = createAgentTabManager();

    await expect(after.ownership("session-a", 2)).resolves.toEqual({ state: "this" });
    await expect(after.context("session-a")).resolves.toEqual({
      tabs: [{ tabId: 2, url: "https://agent.test/one", title: "Agent one", active: false }],
      gone: [],
    });
  });

  /**
   * 003/M4 — Chrome discards a tab group when its last tab leaves, so a session that closed all its
   * tabs is remembering a group id that no longer names anything. Adopting into it throws, and
   * before this the session could never open another tab for the rest of its life. Found by T044.
   */
  it("opens a fresh group when the one it remembers has been discarded", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);
    const firstGroup = fake.tabs.find((tab) => tab.id === 2)?.groupId;
    // The session closes its own tab, which is what empties - and so destroys - the group.
    await manager.release("session-a", 2);
    fake.tabs = fake.tabs.filter((tab) => tab.id !== 2);

    await manager.adopt("session-a", 3);

    const secondGroup = fake.tabs.find((tab) => tab.id === 3)?.groupId;
    expect(secondGroup).not.toBe(UNGROUPED);
    expect(secondGroup).not.toBe(firstGroup);
    // The new group is marked too, or the owner's tab strip would stop naming the agent's tabs.
    expect(fake.groupUpdates.at(-1)).toEqual({
      groupId: secondGroup,
      properties: { title: AGENT_GROUP_TITLE, color: "cyan" },
    });
    await expect(manager.ownership("session-a", 3)).resolves.toEqual({ state: "this" });
  });

  it("forgets the session and un-marks its group when the session ends", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);
    const groupId = fake.tabs.find((tab) => tab.id === 2)?.groupId;

    await manager.endSession("session-a");

    // The owner's tab strip must stop claiming an agent is driving these tabs the moment the agent
    // is gone; the group itself is left alone because the tabs in it are the owner's now.
    expect(fake.groupUpdates.at(-1)).toEqual({
      groupId,
      properties: { title: RELEASED_GROUP_TITLE, color: RELEASED_GROUP_COLOR },
    });
    await expect(manager.context("session-a")).resolves.toEqual({ tabs: [], gone: [] });
    await expect(manager.ownership("session-a", 2)).resolves.toEqual({ state: "not-yours" });
  });

  /**
   * 004/T099l — the marking has one way out and it is the session's own end.
   *
   * `endSession` is reachable only while this worker is running: a browser restart with tab
   * restore, or an extension reload, brings the group back titled "Agent" with no session record
   * behind it, and the owner reads their own tab strip as saying an agent is driving tabs no agent
   * can reach. The sweep at worker start is the only thing that can answer for those groups.
   */
  describe("orphaned agent groups (T099l)", () => {
    it("un-marks an agent-titled group no session records", async () => {
      const manager = createAgentTabManager();
      await manager.adopt("session-a", 2);
      const groupId = fake.tabs.find((tab) => tab.id === 2)?.groupId;
      // What a restart leaves behind: Chrome restored the titled group, the session record did not
      // survive (it lives in `chrome.storage.session`).
      await (globalThis as { chrome: { storage: { session: { set: (v: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.session.set({
        agentSessions: {},
      });

      await expect(manager.sweepOrphanedGroups()).resolves.toEqual([groupId]);

      expect(fake.groupUpdates.at(-1)).toEqual({
        groupId,
        properties: { title: RELEASED_GROUP_TITLE, color: RELEASED_GROUP_COLOR },
      });
    });

    it("leaves a group a live session still holds marked", async () => {
      const manager = createAgentTabManager();
      await manager.adopt("session-a", 2);
      const updatesBefore = fake.groupUpdates.length;

      await expect(manager.sweepOrphanedGroups()).resolves.toEqual([]);

      expect(fake.groupUpdates).toHaveLength(updatesBefore);
      await expect(manager.ownership("session-a", 2)).resolves.toEqual({ state: "this" });
    });
  });

  /**
   * 005/T178 - who holds a tab right now, and the moment a session is over (FR-077, FR-080).
   *
   * A browser download carries no tab id, so the observer attributes it to whichever sessions hold
   * a tab at that moment; the question is answered from the leases, the one authority on holding.
   * The session's end is a hook for the same reason `onTabLeft` is: this is where the record is
   * dropped, and a ring kept elsewhere has to go with it.
   */
  it("names every session holding at least one tab, from the leases (005/T178)", async () => {
    const manager = createAgentTabManager();
    await expect(manager.sessionsHoldingAnyTab()).resolves.toEqual([]);

    await manager.adopt("session-a", 2);
    await manager.adopt("session-b", 4);
    // Announced but holding nothing: alive, and not a holder.
    await manager.announce("session-c", "2026-09-13T00:00:00.000Z");

    await expect(manager.sessionsHoldingAnyTab()).resolves.toEqual(["session-a", "session-b"]);

    await manager.release("session-b", 4);
    await expect(manager.sessionsHoldingAnyTab()).resolves.toEqual(["session-a"]);

    // A tab the owner closed by hand is no longer held once the manager has noticed it is gone.
    fake.tabs.splice(fake.tabs.findIndex((tab) => tab.id === 2), 1);
    await manager.context("session-a");
    await expect(manager.sessionsHoldingAnyTab()).resolves.toEqual([]);
  });

  it("tells the hook which session ended, after its record is gone (005/T178)", async () => {
    const ended: string[] = [];
    const manager = createAgentTabManager({ onSessionEnded: (sessionId) => void ended.push(sessionId) });
    await manager.adopt("session-a", 2);

    await manager.endSession("session-a");
    expect(ended).toEqual(["session-a"]);

    // A session the manager never knew is not an ending; nothing is announced for it.
    await manager.endSession("session-unknown");
    expect(ended).toEqual(["session-a"]);
  });

  it("frees a dead session's tab for the next session that asks for it", async () => {
    const manager = createAgentTabManager();
    await manager.adopt("session-a", 2);

    await manager.endSession("session-a");

    // Without the record removal the hostage stays for ever: SC-024's refusal is about a *live*
    // session's tabs, and a session nobody can reach again owns nothing.
    await expect(manager.adopt("session-b", 2)).resolves.toBeUndefined();
  });

  /**
   * 016/T443 - the group is presented, not merely marked (FR-238, FR-240, R-207).
   *
   * The presenter decides the title; the manager is where a group comes into existence, so it hands
   * the presenter the group and the session's own colour, and says when the group stops being the
   * session's to title.
   */
  describe("group presentation (016 T443)", () => {
    it("hands each new group to the presenter in its session's colour", async () => {
      const presented: Array<[string, number, string]> = [];
      const manager = createAgentTabManager({
        presentGroup: async (sessionId, groupId, colour) => void presented.push([sessionId, groupId, colour]),
      });

      await manager.adopt("session-a", 2);
      await manager.adopt("session-a", 3);
      await manager.claim("session-b", 4);

      const groupOf = (tabId: number) => fake.tabs.find((tab) => tab.id === tabId)?.groupId ?? UNGROUPED;
      // Once per group, not per tab; the colour is the one the card shows.
      expect(presented).toEqual([
        ["session-a", groupOf(2), "cyan"],
        ["session-b", groupOf(4), "green"],
      ]);
      await expect(manager.identity("session-b")).resolves.toMatchObject({ colourIndex: 1 });
      // The presenter owns the write; the manager wrote no marking of its own.
      expect(fake.groupUpdates).toEqual([]);
    });

    it("says when the session let go of the last tab in its group, and presents the next one", async () => {
      const left: string[] = [];
      const presented: number[] = [];
      const manager = createAgentTabManager({
        presentGroup: async (_sessionId, groupId) => void presented.push(groupId),
        onGroupLeft: (sessionId) => void left.push(sessionId),
      });
      await manager.adopt("session-a", 2);
      await manager.adopt("session-a", 3);

      await manager.release("session-a", 2);
      expect(left).toEqual([]);
      await manager.release("session-a", 3);
      expect(left).toEqual(["session-a"]);

      await manager.claim("session-a", 4);
      expect(presented).toHaveLength(2);
      expect(presented[1]).toBe(fake.tabs.find((tab) => tab.id === 4)?.groupId);
    });

    it("presents the groups live records hold again at worker start, and none other", async () => {
      await createAgentTabManager().adopt("session-a", 2);
      const presented: Array<[string, number, string]> = [];
      // A fresh worker: the same storage, a presenter that remembers nothing.
      const manager = createAgentTabManager({
        presentGroup: async (sessionId, groupId, colour) => void presented.push([sessionId, groupId, colour]),
      });
      await manager.announce("session-b", "2026-09-27T00:00:00.000Z");

      await manager.presentHeldGroups();

      expect(presented).toEqual([["session-a", fake.tabs.find((tab) => tab.id === 2)?.groupId, "cyan"]]);
    });
  });

  /**
   * 016/T444 - a group the session no longer holds a tab of is withdrawn (FR-238, R-207, review
   * F1/F2, contracts/tab-group.md).
   *
   * Three ways a session comes to hold none of its group's tabs: it releases the last one, the
   * owner drags them all out, the owner closes them all. Each withdraws the marking exactly as the
   * session's end does, and the presenter forgets the group: a group the owner kept alive with a tab
   * of theirs is theirs, and must not keep a frozen hourglass or be written to again.
   */
  describe("withdrawal when the session holds no tab of its group (016 T444)", () => {
    const RELEASED = { title: RELEASED_GROUP_TITLE, color: RELEASED_GROUP_COLOR };
    const groupOf = (tabId: number) => fake.tabs.find((tab) => tab.id === tabId)?.groupId ?? UNGROUPED;
    const updatesTo = (groupId: number) =>
      fake.groupUpdates.filter((update) => update.groupId === groupId).map((update) => update.properties);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** The runtime's wiring (agent-runtime.ts): a real presenter, told by a real stop registry. */
    function composeWithPresenter() {
      const stops = createAgentStopSignals();
      const reported: string[] = [];
      const left: string[] = [];
      const presenter = createGroupPresenter({
        inFlight: (sessionId) => stops.inFlight(sessionId),
        waiting: () => false,
        reportFailure: (code) => void reported.push(code),
      });
      stops.onChange((sessionId) => presenter.refresh(sessionId));
      const manager = createAgentTabManager({
        presentGroup: (sessionId, groupId, colour) => presenter.present(sessionId, groupId, colour),
        onGroupLeft: (sessionId) => {
          left.push(sessionId);
          presenter.end(sessionId);
        },
        onSessionEnded: (sessionId) => presenter.end(sessionId),
      });
      return { stops, manager, reported, left };
    }

    it("withdraws the marking when the last tab is released from a group the owner keeps alive (F1)", async () => {
      const { stops, manager, left } = composeWithPresenter();
      await manager.adopt("session-a", 2);
      const groupId = groupOf(2);
      // The owner drags a tab of theirs into the agent's group.
      fake.tabs[0]!.groupId = groupId;
      const call = stops.begin("call-1", "session-a");

      await manager.release("session-a", 2);
      call.end();
      await settle();

      expect(left).toEqual(["session-a"]);
      expect(updatesTo(groupId)).toEqual([{ title: AGENT_GROUP_TITLE, color: "cyan" }, { title: "⌛ Hallpass" }, RELEASED]);

      // The session's next tab opens a group of its own; the owner's group is not marked again.
      await manager.adopt("session-a", 3);
      expect(groupOf(3)).not.toBe(groupId);
      expect(updatesTo(groupId).at(-1)).toEqual(RELEASED);
    });

    it("withdraws the marking when the owner drags every agent tab out of the group (F1)", async () => {
      const { stops, manager, left, reported } = composeWithPresenter();
      await manager.adopt("session-a", 2);
      await manager.adopt("session-a", 3);
      const groupId = groupOf(2);
      fake.tabs[0]!.groupId = groupId;
      for (const tab of fake.tabs) if (tab.id === 2 || tab.id === 3) tab.groupId = UNGROUPED;

      await expect(manager.context("session-a")).resolves.toEqual({ tabs: [], gone: [2, 3] });
      stops.begin("call-1", "session-a");
      await settle();

      expect(left).toEqual(["session-a"]);
      expect(updatesTo(groupId).at(-1)).toEqual(RELEASED);
      expect(reported).toEqual([]);
    });

    it("forgets a group whose tabs the owner closed, so nothing is written to it again (F2)", async () => {
      const { stops, manager, left, reported } = composeWithPresenter();
      await manager.adopt("session-a", 2);
      fake.tabs = fake.tabs.filter((tab) => tab.id !== 2);

      // The withdrawal is refused - the group went with its last tab - and that is not a failure.
      await expect(manager.context("session-a")).resolves.toEqual({ tabs: [], gone: [2] });
      stops.begin("call-1", "session-a");
      await settle();

      expect(left).toEqual(["session-a"]);
      expect(reported).toEqual([]);
    });

    it("keeps the withdrawal last when the session's calls move while it is ending", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { stops, manager } = composeWithPresenter();
        await manager.adopt("session-a", 2);
        const groupId = groupOf(2);
        const area = (globalThis as { chrome: { storage: { session: { set: (values: Record<string, unknown>) => Promise<void> } } } })
          .chrome.storage.session;
        const set = area.set.bind(area);
        let call: { end(): void } | undefined;
        // Between the record's removal and the presenter being told: a call begins (the hourglass
        // goes up), then ends (its quiet second is armed).
        area.set = async (values) => {
          await set(values);
          const sessions = values.agentSessions as Record<string, unknown> | undefined;
          if (sessions !== undefined && !("session-a" in sessions)) call = stops.begin("call-1", "session-a");
          if (values.agentTabLeases !== undefined && call !== undefined) call.end();
        };

        await manager.endSession("session-a");
        vi.advanceTimersByTime(2000);

        expect(call).toBeDefined();
        expect(updatesTo(groupId)).toEqual([{ title: AGENT_GROUP_TITLE, color: "cyan" }, { title: "⌛ Hallpass" }, RELEASED]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
