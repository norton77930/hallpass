import { describe, expect, it } from "vitest";
import {
  batchStepCallId,
  createAgentStopSignals,
} from "../src/service-worker/agent-tools/stop.js";

/**
 * 014/T352 — the registry learns *why* a call was ended (R-185 §1, data-model "Stop flag").
 *
 * Until now a flag was a boolean and every runner answered the one literal `owner-stopped`. The
 * owner now has two controls that end a call and they mean opposite things about what is left
 * afterwards: Stop ends the session and hands its tabs back, and 中斷 ends this step and keeps
 * everything (FR-179). Both reach the runner through this one flag, so the flag has to carry the
 * word - a runner that guessed would tell an agent its tabs were gone when they are still held.
 *
 * The second thing here is the promise. A flag is read at a runner's own checkpoints, which is
 * exactly right for Stop - a batch step already delivered must still report what the page did -
 * but it cannot meet FR-179's one-second bound on its own: a `wait` between polls, or a runner
 * parked on a page that never answers, has no checkpoint to reach. So the handle also offers the
 * interrupt as something a caller can await, and the dispatcher races it (T354).
 */

describe("T352 the reason a call was ended", () => {
  it("says nothing about a call nobody has ended", () => {
    const stops = createAgentStopSignals();
    const handle = stops.begin("call-1", "session-a");

    expect(handle.stopped()).toBe(false);
    // Undefined rather than a default: "not stopped" is not a kind of stopping, and a runner that
    // read a word here would answer one for a call that is still running.
    expect(handle.reason()).toBeUndefined();
  });

  it("keeps the owner's Stop saying exactly what it said in 0.5.0", () => {
    const stops = createAgentStopSignals();
    const handle = stops.begin("call-1", "session-a");

    stops.stopSession("session-a");

    expect(handle.stopped()).toBe(true);
    expect(handle.reason()).toBe("owner-stopped");
  });

  it("flags only the interrupted session's calls, and says the owner interrupted them", () => {
    const stops = createAgentStopSignals();
    const mine = stops.begin("call-1", "session-a");
    const theirs = stops.begin("call-2", "session-b");

    expect(stops.interruptSession("session-a")).toEqual({ interrupted: 1 });

    expect(mine.stopped()).toBe(true);
    expect(mine.reason()).toBe("owner-interrupted");
    // Another agent's call is not the owner's to end from this card (004/T103a's boundary).
    expect(theirs.stopped()).toBe(false);
    expect(theirs.reason()).toBeUndefined();
  });

  it("reaches a batch's steps, which run under ids only this worker knows", () => {
    const stops = createAgentStopSignals();
    const batch = stops.begin("call-1", "session-a");
    const step = stops.begin(batchStepCallId("call-1", 2), "session-a");
    const other = stops.begin("call-9", "session-a");

    // Two *calls* are in flight as far as anything outside this worker is concerned - the batch
    // and the unrelated call - and the step is a third registration of one of them. The count is
    // of calls, because it is what the owner is told ("nothing was running") and what the agent
    // sent.
    expect(stops.interruptSession("session-a")).toEqual({ interrupted: 2 });
    expect(step.stopped()).toBe(true);
    expect(step.reason()).toBe("owner-interrupted");
    expect(batch.stopped()).toBe(true);
    expect(other.stopped()).toBe(true);
  });

  it("still lets a stop name one call and reach the steps inside it", () => {
    const stops = createAgentStopSignals();
    const batch = stops.begin("call-1", "session-a");
    const step = stops.begin(batchStepCallId("call-1", 0), "session-a");
    const sibling = stops.begin("call-10", "session-a");

    stops.stop("call-1");

    expect(batch.reason()).toBe("owner-stopped");
    expect(step.reason()).toBe("owner-stopped");
    // `call-10` merely begins with `call-1`; a call id that is a prefix of another is a different
    // call, which is what the separator exists to say (003/B5).
    expect(sibling.stopped()).toBe(false);
  });

  it("interrupts nothing when nothing is in flight, and says so", () => {
    const stops = createAgentStopSignals();
    const handle = stops.begin("call-1", "session-a");
    handle.end();

    expect(stops.interruptSession("session-a")).toEqual({ interrupted: 0 });
    expect(stops.inFlight("session-a")).toBe(0);
  });

  it("counts what the card's 中斷 control is enabled by", () => {
    const stops = createAgentStopSignals();
    const first = stops.begin("call-1", "session-a");
    stops.begin("call-2", "session-a");
    // The runner of `call-2` polls the flag as well: one call, two registrations, one in flight.
    stops.begin(batchStepCallId("call-2", 0), "session-a");
    stops.begin("call-3", "session-b");

    expect(stops.inFlight("session-a")).toBe(2);
    expect(stops.inFlight("session-b")).toBe(1);
    first.end();
    expect(stops.inFlight("session-a")).toBe(1);
    // A call that has answered is no longer interruptible, so the count is the same fact the
    // registry answers `stop` from - never a separate tally that could drift from it.
    expect(stops.inFlight("session-c")).toBe(0);
  });

  it("offers the interrupt as something a caller can await, and the stop as something it cannot", async () => {
    const stops = createAgentStopSignals();
    const interrupted = stops.begin("call-1", "session-a");
    const stopped = stops.begin("call-2", "session-b");

    let stopSettled = false;
    void stopped.interrupted().then(() => {
      stopSettled = true;
    });

    stops.stopSession("session-b");
    stops.interruptSession("session-a");

    // The one the owner interrupted resolves; the dispatcher answers on it (FR-179).
    await expect(interrupted.interrupted()).resolves.toBeUndefined();
    await Promise.resolve();
    // The owner's Stop is deliberately *not* awaited here: a stop ends the session, its runner
    // answers at its own next checkpoint as it always did, and a race on it would change what
    // FR-184 says must not change.
    expect(stopSettled).toBe(false);
  });

  it("resolves an interrupt asked about after the fact", async () => {
    const stops = createAgentStopSignals();
    const handle = stops.begin("call-1", "session-a");

    stops.interruptSession("session-a");

    // The race is armed by the dispatcher a tick after `begin`, and an interrupt that arrived in
    // between must not be a promise nobody ever resolves.
    await expect(handle.interrupted()).resolves.toBeUndefined();
  });
});

/**
 * 016/T441 - the count is told, not only asked (FR-238, FR-239, R-207).
 *
 * The tab-group title says whether a session is working, and nothing else in the worker hears a
 * call begin or end: `notify()` follows prompts and sessions. So the registry that already counts
 * in-flight calls says when a session's count moves - and only then, counted the way `inFlight`
 * counts, so a batch's steps and a runner's second registration are not a flicker of changes.
 */
describe("T441 in-flight changes are announced", () => {
  it("names the session when its count moves, and stays quiet when it does not", () => {
    const stops = createAgentStopSignals();
    const heard: string[] = [];
    stops.onChange((sessionId) => heard.push(sessionId));

    const call = stops.begin("call-1", "session-a");
    expect(heard).toEqual(["session-a"]);

    // The runner's own registration and a batch step of the same call: still one call in flight.
    const runner = stops.begin("call-1", "session-a");
    const step = stops.begin(batchStepCallId("call-1", 0), "session-a");
    expect(heard).toEqual(["session-a"]);

    const other = stops.begin("call-2", "session-b");
    expect(heard).toEqual(["session-a", "session-b"]);

    step.end();
    runner.end();
    expect(heard).toEqual(["session-a", "session-b"]);

    call.end();
    expect(heard).toEqual(["session-a", "session-b", "session-a"]);
    // A second `end` of a registration already gone changes nothing and is not announced.
    call.end();
    other.end();
    expect(heard).toEqual(["session-a", "session-b", "session-a", "session-b"]);
  });

  it("stops telling a listener that unsubscribed", () => {
    const stops = createAgentStopSignals();
    const heard: string[] = [];
    const unsubscribe = stops.onChange((sessionId) => heard.push(sessionId));
    unsubscribe();

    stops.begin("call-1", "session-a").end();

    expect(heard).toEqual([]);
  });
});
