import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_GROUP_TITLE,
  queryAgentGroupIds,
  STALE_AGENT_GROUP_TITLES,
  WAITING_GROUP_TITLE,
  WORKING_GROUP_TITLE,
} from "../src/chrome-adapters/tab-groups.js";
import { createGroupPresenter } from "../src/service-worker/group-presenter.js";
import { createAgentStopSignals } from "../src/service-worker/agent-tools/stop.js";

/**
 * 016/T442 - the tab strip says what a session is doing (FR-238 - FR-241, R-207,
 * contracts/tab-group.md).
 *
 * The group was titled once, at creation, and never again. Now its title follows the session:
 * `🔔 Hallpass` while a question waits on the owner, `⌛ Hallpass` while a call is in flight and for
 * a second after the last one ends (so consecutive calls do not flicker it), `Hallpass` otherwise.
 * The owner's tab strip is theirs, so the presenter writes only when the title actually changes,
 * and never to a group whose session has ended - that group's marking has been withdrawn.
 */

type Update = { groupId: number; properties: { title?: string; color?: string } };

function installChrome(groups: Array<{ id: number; title: string }> = []): Update[] {
  const updates: Update[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    tabGroups: {
      async update(groupId: number, properties: Update["properties"]) {
        updates.push({ groupId, properties });
        return { id: groupId, ...properties };
      },
      async query(filter: { title?: string }) {
        return groups.filter((group) => filter.title === undefined || group.title === filter.title);
      },
    },
  };
  return updates;
}

describe("T442 group presenter", () => {
  let updates: Update[];
  let waiting: string | undefined;

  function compose() {
    const stops = createAgentStopSignals();
    const presenter = createGroupPresenter({
      inFlight: (sessionId) => stops.inFlight(sessionId),
      waiting: (sessionId) => waiting === sessionId,
    });
    stops.onChange((sessionId) => presenter.refresh(sessionId));
    return { stops, presenter };
  }

  const titles = () => updates.map((update) => update.properties.title);

  beforeEach(() => {
    vi.useFakeTimers();
    updates = installChrome();
    waiting = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("titles and colours a new group for an idle session in one write", async () => {
    const { presenter } = compose();

    await presenter.present("session-a", 7, "purple");

    expect(updates).toEqual([{ groupId: 7, properties: { title: AGENT_GROUP_TITLE, color: "purple" } }]);
    expect(AGENT_GROUP_TITLE).toBe("Hallpass");
  });

  it("starts a group opened during a call as working", async () => {
    const { stops, presenter } = compose();
    stops.begin("call-1", "session-a");

    await presenter.present("session-a", 7, "cyan");

    expect(updates).toEqual([{ groupId: 7, properties: { title: WORKING_GROUP_TITLE, color: "cyan" } }]);
  });

  it("starts a group opened while the session waits on the owner with the bell", async () => {
    const { stops, presenter } = compose();
    stops.begin("call-1", "session-a");
    waiting = "session-a";

    await presenter.present("session-a", 7, "green");

    expect(updates).toEqual([{ groupId: 7, properties: { title: WAITING_GROUP_TITLE, color: "green" } }]);
  });

  it("goes idle -> working at once, and back to idle only after a quiet second", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");

    const call = stops.begin("call-1", "session-a");
    expect(updates.at(-1)).toEqual({ groupId: 7, properties: { title: "⌛ Hallpass" } });

    call.end();
    vi.advanceTimersByTime(999);
    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass"]);

    vi.advanceTimersByTime(1);
    expect(updates.at(-1)).toEqual({ groupId: 7, properties: { title: "Hallpass" } });
  });

  it("keeps the hourglass without a write when the next call begins inside the second", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");

    stops.begin("call-1", "session-a").end();
    vi.advanceTimersByTime(500);
    const next = stops.begin("call-2", "session-a");
    // The timer of the first call is gone: its second passing changes nothing.
    vi.advanceTimersByTime(1500);
    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass"]);

    next.end();
    vi.advanceTimersByTime(1000);
    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass", "Hallpass"]);
  });

  it("puts the bell over the hourglass, and the hourglass back when the question is answered", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");
    const call = stops.begin("call-1", "session-a");

    waiting = "session-a";
    presenter.refreshAll();
    expect(updates.at(-1)).toEqual({ groupId: 7, properties: { title: "🔔 Hallpass" } });

    // Another call of the same session moving while the question waits does not unseat the bell.
    stops.begin("call-2", "session-a").end();
    vi.advanceTimersByTime(2000);
    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass", "🔔 Hallpass"]);

    waiting = undefined;
    presenter.refreshAll();
    expect(updates.at(-1)).toEqual({ groupId: 7, properties: { title: "⌛ Hallpass" } });

    call.end();
    vi.advanceTimersByTime(1000);
    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass", "🔔 Hallpass", "⌛ Hallpass", "Hallpass"]);
  });

  it("does not write a title the group already carries", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");

    presenter.refresh("session-a");
    presenter.refreshAll();
    stops.begin("call-1", "session-a");
    stops.begin("call-2", "session-a");
    presenter.refreshAll();

    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass"]);
  });

  it("answers only for the session whose state moved", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");
    await presenter.present("session-b", 8, "green");

    stops.begin("call-1", "session-b");
    waiting = "session-b";
    presenter.refreshAll();

    expect(updates.slice(2)).toEqual([
      { groupId: 8, properties: { title: "⌛ Hallpass" } },
      { groupId: 8, properties: { title: "🔔 Hallpass" } },
    ]);
  });

  it("writes nothing for a session that has no group", () => {
    const { stops, presenter } = compose();

    stops.begin("call-1", "session-a").end();
    presenter.refreshAll();
    vi.advanceTimersByTime(2000);

    expect(updates).toEqual([]);
  });

  it("never writes to the group of a session that has ended, not even from a pending second", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");
    stops.begin("call-1", "session-a").end();

    presenter.end("session-a");
    vi.advanceTimersByTime(2000);
    stops.begin("call-2", "session-a");
    waiting = "session-a";
    presenter.refreshAll();

    expect(titles()).toEqual(["Hallpass", "⌛ Hallpass"]);
  });

  it("re-presents a group the session opened again after it ended", async () => {
    const { presenter } = compose();
    await presenter.present("session-a", 7, "cyan");
    presenter.end("session-a");

    await presenter.present("session-a", 9, "cyan");

    expect(updates.at(-1)).toEqual({ groupId: 9, properties: { title: "Hallpass", color: "cyan" } });
  });

  it("follows the session to a new group when its old one was discarded", async () => {
    const { stops, presenter } = compose();
    await presenter.present("session-a", 7, "cyan");
    await presenter.present("session-a", 9, "cyan");

    stops.begin("call-1", "session-a");

    expect(updates.at(-1)).toEqual({ groupId: 9, properties: { title: "⌛ Hallpass" } });
  });

  it("swallows a write to a group the owner has since closed", async () => {
    const reported: string[] = [];
    const stops = createAgentStopSignals();
    const presenter = createGroupPresenter({
      inFlight: (sessionId) => stops.inFlight(sessionId),
      waiting: () => false,
      update: async (_groupId, properties) => {
        if (properties.color === undefined) throw new Error("No group with id: 7");
      },
      reportFailure: (code) => reported.push(code),
    });
    stops.onChange((sessionId) => presenter.refresh(sessionId));
    await presenter.present("session-a", 7, "cyan");

    stops.begin("call-1", "session-a");
    await vi.runAllTimersAsync();

    expect(reported).toEqual(["agent.groups.present-failed"]);
  });
});

describe("T442 stale group titles (FR-241)", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("recognises every title a Hallpass group has ever carried, and nothing else", async () => {
    installChrome([
      { id: 1, title: "Agent" },
      { id: 2, title: "Hallpass" },
      { id: 3, title: "⌛ Hallpass" },
      { id: 4, title: "🔔 Hallpass" },
      { id: 5, title: "" },
      { id: 6, title: "Hallpass notes" },
      { id: 7, title: "agent" },
    ]);

    await expect(queryAgentGroupIds()).resolves.toEqual([1, 2, 3, 4]);
    expect([...STALE_AGENT_GROUP_TITLES].sort()).toEqual(["Agent", "Hallpass", "⌛ Hallpass", "🔔 Hallpass"].sort());
  });
});
