import { describe, expect, it } from "vitest";
import {
  createPairingController,
  EMPTY_PAIRING_STATE,
  reducePairing,
  type PairingState,
} from "../src/service-worker/pairing-controller.js";

/**
 * 003/T014 — the pairing state machine (data-model "PairedAgent").
 *
 * The reducer is separated from the store because the interesting claims are all about the
 * transitions: an agent is never paired by connecting, one agent's acceptance never pairs another,
 * and unpairing takes effect at once rather than at the end of a session (FR-032).
 */

const CLAUDE = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };
const OTHER = { agentId: "agent-2", displayName: "Another Agent", origin: "stdio:local" };
const AT = "2026-09-08T00:00:00.000Z";

describe("T014 pairing reducer", () => {
  it("holds a first connection as pending rather than pairing it", () => {
    const state = reducePairing(EMPTY_PAIRING_STATE, { type: "connection", ...CLAUDE });

    expect(state.pending).toEqual(CLAUDE);
    expect(state.paired).toEqual([]);
  });

  it("pairs on the owner's accept and remembers what the owner saw", () => {
    const pending = reducePairing(EMPTY_PAIRING_STATE, { type: "connection", ...CLAUDE });
    const state = reducePairing(pending, { type: "decide", agentId: "agent-1", accepted: true, at: AT });

    expect(state.pending).toBeUndefined();
    expect(state.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  it("returns to absent on the owner's decline, pairing nothing", () => {
    const pending = reducePairing(EMPTY_PAIRING_STATE, { type: "connection", ...CLAUDE });
    const state = reducePairing(pending, { type: "decide", agentId: "agent-1", accepted: false, at: AT });

    expect(state).toEqual(EMPTY_PAIRING_STATE);
  });

  it("raises no prompt for an agent the owner already paired", () => {
    const paired = reducePairing(
      reducePairing(EMPTY_PAIRING_STATE, { type: "connection", ...CLAUDE }),
      { type: "decide", agentId: "agent-1", accepted: true, at: AT },
    );

    const state = reducePairing(paired, { type: "connection", ...CLAUDE });

    expect(state.pending).toBeUndefined();
    expect(state.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  it("keeps a second agent independent of the first (US1 scenario 5)", () => {
    const paired = reducePairing(
      reducePairing(EMPTY_PAIRING_STATE, { type: "connection", ...CLAUDE }),
      { type: "decide", agentId: "agent-1", accepted: true, at: AT },
    );

    const state = reducePairing(paired, { type: "connection", ...OTHER });

    expect(state.pending).toEqual(OTHER);
    expect(state.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  it("returns a paired agent to absent when the owner unpairs it", () => {
    const paired: PairingState = {
      paired: [{ ...CLAUDE, acceptedAt: AT }, { ...OTHER, acceptedAt: AT }],
    };

    const state = reducePairing(paired, { type: "unpair", agentId: "agent-1" });

    expect(state.paired).toEqual([{ ...OTHER, acceptedAt: AT }]);
  });

  it("drops a decision for an agent nobody is waiting on", () => {
    const state = reducePairing(EMPTY_PAIRING_STATE, {
      type: "decide",
      agentId: "agent-9",
      accepted: true,
      at: AT,
    });

    expect(state).toEqual(EMPTY_PAIRING_STATE);
  });
});

describe("T015 pairing controller", () => {
  function controllerWith(initial: PairingState = EMPTY_PAIRING_STATE) {
    let stored = initial;
    const projections: PairingState[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => AT,
      onChange: (state) => projections.push(state),
    });
    return { controller, projections, stored: () => stored };
  }

  it("holds a new agent's connection until the owner answers, then pairs it durably", async () => {
    const { controller, stored } = controllerWith();

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();
    expect((await controller.state()).pending).toEqual(CLAUDE);

    await controller.decide("agent-1", true);

    await expect(decision).resolves.toBe(true);
    expect(stored().paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  /**
   * 006 FR-084 (S1 review): Ignore is not a decline. The prompt leaves the panel and nothing is
   * answered - the host's own bound expires the request and its next call raises it again - so
   * the agent is not left with a standing refusal the owner never made.
   */
  it("drops the prompt on ignore without answering the session that raised it", async () => {
    const { controller, stored, projections } = controllerWith();
    let settled: boolean | undefined;
    void controller.decidePairing(CLAUDE).then((accepted) => {
      settled = accepted;
    });
    await controller.ready();

    await controller.ignore("agent-1");

    expect((await controller.state()).pending).toBeUndefined();
    expect(projections.at(-1)?.pending).toBeUndefined();
    expect(stored().paired).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBeUndefined();
    // The next request is a fresh question, and the owner's accept settles that one.
    const again = controller.decidePairing(CLAUDE);
    await controller.ready();
    expect((await controller.state()).pending).toEqual(CLAUDE);
    await controller.decide("agent-1", true);
    await expect(again).resolves.toBe(true);
  });

  it("answers an already-paired agent at once, with no prompt", async () => {
    const { controller } = controllerWith({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await expect(controller.decidePairing(CLAUDE)).resolves.toBe(true);
    expect((await controller.state()).pending).toBeUndefined();
  });

  it("answers false on decline and stores nothing", async () => {
    const { controller, stored } = controllerWith();

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();
    await controller.decide("agent-1", false);

    await expect(decision).resolves.toBe(false);
    expect(stored().paired).toEqual([]);
  });

  it("makes an unpair effective immediately for the next call", async () => {
    const { controller, stored } = controllerWith({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await controller.unpair("agent-1");

    expect(stored().paired).toEqual([]);
    await expect(controller.isPaired("agent-1")).resolves.toBe(false);
  });
});

describe("T096b pairing across several sessions of one agent", () => {
  function controllerWith(initial: PairingState = EMPTY_PAIRING_STATE) {
    let stored = initial;
    const projections: PairingState[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => AT,
      onChange: (state) => projections.push(state),
    });
    return { controller, projections, stored: () => stored };
  }

  it("answers every session waiting on one agent's prompt with one decision", async () => {
    const { controller, stored } = controllerWith();

    const first = controller.decidePairing(CLAUDE);
    const second = controller.decidePairing(CLAUDE);
    await controller.ready();

    await controller.decide("agent-1", true);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(stored().paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  it("joins a second session to the prompt already raised, asking the owner once", async () => {
    const { controller, projections } = controllerWith();

    void controller.decidePairing(CLAUDE);
    void controller.decidePairing({ ...CLAUDE, displayName: "Claude Code (2)" });
    await controller.ready();

    expect((await controller.state()).pending).toEqual(CLAUDE);
    expect(projections.filter((state) => state.pending?.agentId === "agent-1")).toHaveLength(1);
  });

  it("refuses every waiting session when the prompt is abandoned", async () => {
    const { controller } = controllerWith();

    const first = controller.decidePairing(CLAUDE);
    const second = controller.decidePairing(CLAUDE);
    await controller.ready();

    await controller.abandonPending();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("still answers an already-paired agent's every session at once, with no prompt", async () => {
    const { controller } = controllerWith({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await expect(controller.decidePairing(CLAUDE)).resolves.toBe(true);
    await expect(controller.decidePairing(CLAUDE)).resolves.toBe(true);
    expect((await controller.state()).pending).toBeUndefined();
  });
});

/**
 * 004/T111f — the cache the controller keeps must never outrank the record it caches.
 *
 * The controller reads the durable state once and writes that *cache* back on every mutation, so a
 * write to the key made by anything else - another worker generation, a repair, the panel's own
 * storage - was invisible to it and was silently overwritten by the next mutation. B28 saw exactly
 * that live: a pairing was accepted, reported success, and read back as `{"paired":[]}` because the
 * `abandon` that followed the session's link drop wrote the stale cache over it.
 */
describe("T111f the stored record outranks the cache", () => {
  function controllerWith(initial: PairingState) {
    let stored: PairingState = { paired: [...initial.paired] };
    let announce: (() => void) | undefined;
    const controller = createPairingController({
      read: async () => ({ paired: [...stored.paired] }),
      // Only the durable half reaches storage, as `writePairingState` does.
      write: async (state) => {
        stored = { paired: [...state.paired] };
      },
      now: () => AT,
      watch: (onExternalChange) => {
        announce = onExternalChange;
      },
    });
    /** A write to the key by something other than this controller, and the event it raises. */
    function writeElsewhere(state: PairingState): void {
      stored = { paired: [...state.paired] };
      announce?.();
    }
    return { controller, writeElsewhere, stored: () => stored };
  }

  it("keeps a pairing written outside it when an unrelated mutation follows", async () => {
    const { controller, writeElsewhere, stored } = controllerWith({
      paired: [{ ...OTHER, acceptedAt: AT }],
    });
    // The controller has read the record, so from here on it is answering from its cache.
    await controller.state();

    writeElsewhere({ paired: [{ ...OTHER, acceptedAt: AT }, { ...CLAUDE, acceptedAt: AT }] });
    await controller.unpair("agent-2");

    expect(stored().paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
    await expect(controller.isPaired("agent-1")).resolves.toBe(true);
  });

  it("still holds the prompt it raised when the record changes underneath it", async () => {
    const { controller, writeElsewhere, stored } = controllerWith(EMPTY_PAIRING_STATE);

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();

    // The prompt lives in this worker, not in storage, so a change to the durable half must not
    // take it away: the session waiting on it is still holding its first tool call.
    writeElsewhere({ paired: [{ ...OTHER, acceptedAt: AT }] });
    await controller.decide("agent-1", true);

    await expect(decision).resolves.toBe(true);
    expect(stored().paired).toEqual([{ ...OTHER, acceptedAt: AT }, { ...CLAUDE, acceptedAt: AT }]);
  });
});

/**
 * 004/T111g — an accept recorded outside the panel route must settle the sessions waiting on it.
 *
 * T111f taught the controller to see external writes; it did not teach it to act on what it sees.
 * The CDP helper (and any other writer) can only write the durable record - it cannot call
 * `decide`, which is the one thing that settles a pending prompt's waiters. So the record said
 * "paired" while the session that raised the prompt was still holding its first tool call, and the
 * call timed out with `not-paired: no answer` against a record that already said otherwise.
 */
describe("T111g an external accept settles the waiting sessions", () => {
  function controllerWith(initial: PairingState) {
    let stored: PairingState = { paired: [...initial.paired] };
    const projections: PairingState[] = [];
    let announce: (() => void) | undefined;
    const controller = createPairingController({
      read: async () => ({ paired: [...stored.paired] }),
      write: async (state) => {
        stored = { paired: [...state.paired] };
      },
      now: () => AT,
      onChange: (state) => projections.push(state),
      watch: (onExternalChange) => {
        announce = onExternalChange;
      },
    });
    function writeElsewhere(state: PairingState): void {
      stored = { paired: [...state.paired] };
      announce?.();
    }
    return { controller, writeElsewhere, projections, stored: () => stored };
  }

  it("resolves a waiting session when the record says paired, with no decision through the panel", async () => {
    const { controller, writeElsewhere } = controllerWith(EMPTY_PAIRING_STATE);

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();

    // The only thing that happens: the durable record gains the agent. No `decide` call.
    writeElsewhere({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await expect(decision).resolves.toBe(true);
    expect((await controller.state()).pending).toBeUndefined();
  });

  it("leaves a session waiting when the external write pairs a different agent", async () => {
    const { controller, writeElsewhere } = controllerWith(EMPTY_PAIRING_STATE);

    let settled: boolean | undefined;
    void controller.decidePairing(CLAUDE).then((accepted) => {
      settled = accepted;
    });
    await controller.ready();

    writeElsewhere({ paired: [{ ...OTHER, acceptedAt: AT }] });
    await controller.state();

    expect(settled).toBeUndefined();
    expect((await controller.state()).pending).toEqual(CLAUDE);
  });

  it("does not leave anyone believing an externally removed pairing still stands", async () => {
    const { controller, writeElsewhere, projections } = controllerWith({
      paired: [{ ...CLAUDE, acceptedAt: AT }],
    });
    // The controller has read the record, so the panel's projection is what it last announced.
    await controller.state();

    writeElsewhere(EMPTY_PAIRING_STATE);
    await controller.state();

    await expect(controller.isPaired("agent-1")).resolves.toBe(false);
    expect(projections.at(-1)?.paired).toEqual([]);
  });
});
