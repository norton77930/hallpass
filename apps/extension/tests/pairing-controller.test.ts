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

    await expect(decision).resolves.toBe("accepted");
    expect(stored().paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  /**
   * 006 FR-084 as amended 2026-09-24: Ignore answers the waiting session at once as a decline of
   * this request (FR-032a) - not a standing refusal: nothing is stored, and the next request is a
   * fresh question.
   */
  it("answers the session that raised the prompt as declined on ignore, and asks afresh next time", async () => {
    const { controller, stored, projections } = controllerWith();
    let settled: string | undefined;
    void controller.decidePairing(CLAUDE).then((accepted) => {
      settled = accepted;
    });
    await controller.ready();

    await controller.ignore("agent-1");

    expect((await controller.state()).pending).toBeUndefined();
    expect(projections.at(-1)?.pending).toBeUndefined();
    expect(stored().paired).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe("declined");
    // The next request is a fresh question, and the owner's accept settles that one.
    const again = controller.decidePairing(CLAUDE);
    await controller.ready();
    expect((await controller.state()).pending).toEqual(CLAUDE);
    await controller.decide("agent-1", true);
    await expect(again).resolves.toBe("accepted");
  });

  it("answers an already-paired agent at once, with no prompt", async () => {
    const { controller } = controllerWith({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await expect(controller.decidePairing(CLAUDE)).resolves.toBe("accepted");
    expect((await controller.state()).pending).toBeUndefined();
  });

  /**
   * 003 FR-032a: the owner's decline and an unpair are different answers, and the bridge marks only
   * the first - so the controller has to say which one settled a waiting session.
   */
  it("answers 'declined' on decline, stores nothing, and asks afresh next time", async () => {
    const { controller, stored } = controllerWith();

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();
    await controller.decide("agent-1", false);

    await expect(decision).resolves.toBe("declined");
    expect(stored().paired).toEqual([]);
    // Not remembered: the next request is a fresh card.
    void controller.decidePairing(CLAUDE);
    await controller.ready();
    expect((await controller.state()).pending).toEqual(CLAUDE);
  });

  it("answers 'unpaired' to a session still waiting when the agent is unpaired", async () => {
    const { controller } = controllerWith();

    const decision = controller.decidePairing(CLAUDE);
    await controller.ready();
    await controller.unpair("agent-1");

    await expect(decision).resolves.toBe("unpaired");
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

    await expect(first).resolves.toBe("accepted");
    await expect(second).resolves.toBe("accepted");
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

  it("settles every waiting session as abandoned, not as any answer of the owner's", async () => {
    const { controller } = controllerWith();

    const first = controller.decidePairing(CLAUDE);
    const second = controller.decidePairing(CLAUDE);
    await controller.ready();

    await controller.abandonPending();

    // The link went away; the owner decided nothing (FR-032a). The bridge answers this with silence.
    await expect(first).resolves.toBe("abandoned");
    await expect(second).resolves.toBe("abandoned");
  });

  it("still answers an already-paired agent's every session at once, with no prompt", async () => {
    const { controller } = controllerWith({ paired: [{ ...CLAUDE, acceptedAt: AT }] });

    await expect(controller.decidePairing(CLAUDE)).resolves.toBe("accepted");
    await expect(controller.decidePairing(CLAUDE)).resolves.toBe("accepted");
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

    await expect(decision).resolves.toBe("accepted");
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

    await expect(decision).resolves.toBe("accepted");
    expect((await controller.state()).pending).toBeUndefined();
  });

  it("leaves a session waiting when the external write pairs a different agent", async () => {
    const { controller, writeElsewhere } = controllerWith(EMPTY_PAIRING_STATE);

    let settled: string | undefined;
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

/**
 * Live finding 2026-09-24: the host withdraws a request at its bound and asks again on the next call,
 * so one session can reach the worker twice for one card. Only the newest may be answered - two
 * answers for one Ignore reached the host as two declines, and the second refused the agent's next
 * request before the owner had seen it.
 */
describe("FR-032a one answer per session", () => {
  it("answers only a session's newest request and lets the withdrawn one go silently", async () => {
    let stored: PairingState = EMPTY_PAIRING_STATE;
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        stored = state;
      },
      now: () => AT,
    });

    const first = controller.decidePairing({ ...CLAUDE, sessionId: "s-1" });
    await controller.ready();
    const second = controller.decidePairing({ ...CLAUDE, sessionId: "s-1" });
    await controller.ready();
    const other = controller.decidePairing({ ...CLAUDE, sessionId: "s-2" });
    await controller.ready();

    await controller.ignore("agent-1");

    await expect(first).resolves.toBe("abandoned");
    await expect(second).resolves.toBe("declined");
    await expect(other).resolves.toBe("declined");
  });
});

/**
 * 003 FR-032a review F1: a transition whose write failed is not believed. Before FR-032a a failed
 * decision left the session sticky-refused, so a half-applied prompt was unreachable; now the host
 * re-requests after its bound, and that re-request must reach the panel as a prompt.
 *
 * Since the 018 T513 follow-up only a transition that changes `paired` writes at all, so the write
 * that can fail - and must not be believed - is the owner's accept (or an unpair).
 */
describe("FR-032a F1 a failed write is not taken", () => {
  it("leaves the agent unpaired and the prompt up when the accept's write fails", async () => {
    let stored: PairingState = EMPTY_PAIRING_STATE;
    let failNext = true;
    const projections: PairingState[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async (state) => {
        if (failNext) {
          failNext = false;
          throw new Error("storage unavailable");
        }
        stored = state;
      },
      now: () => AT,
      onChange: (state) => projections.push(state),
    });

    void controller.decidePairing(CLAUDE);
    await controller.ready();
    expect(projections.at(-1)?.pending).toEqual(CLAUDE);

    await expect(controller.decide("agent-1", true)).rejects.toThrow("storage unavailable");
    expect(await controller.isPaired("agent-1")).toBe(false);
    expect((await controller.state()).pending).toEqual(CLAUDE);
    expect(projections.at(-1)).toEqual({ paired: [], pending: CLAUDE });

    await controller.decide("agent-1", true);

    expect(stored.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
    expect(projections.at(-1)?.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
  });

  it("leaves the agent paired, and announces no projection without it, when the unpair's write fails", async () => {
    const stored: PairingState = { paired: [{ ...CLAUDE, acceptedAt: AT }] };
    const projections: PairingState[] = [];
    const controller = createPairingController({
      read: async () => stored,
      write: async () => {
        throw new Error("storage unavailable");
      },
      now: () => AT,
      onChange: (state) => projections.push(state),
    });
    await controller.ready();

    await expect(controller.unpair("agent-1")).rejects.toThrow("storage unavailable");

    expect(await controller.isPaired("agent-1")).toBe(true);
    expect(stored.paired).toEqual([{ ...CLAUDE, acceptedAt: AT }]);
    expect(projections.every((state) => state.paired.some((agent) => agent.agentId === "agent-1"))).toBe(true);
  });
});

/**
 * Follow-up of 018 T513 (coverage.md): the host's withdrawal arrived on time, but the worker's
 * `storage.local` had stopped answering, and the card waited on a write before it could leave. Only
 * `paired` is stored, so a transition that changes nothing but the card has nothing to write.
 */
describe("018 T513 follow-up: the card does not wait on storage", () => {
  it("takes the card down on the host's withdrawal while storage never answers a write", async () => {
    const projections: PairingState[] = [];
    const controller = createPairingController({
      read: async () => EMPTY_PAIRING_STATE,
      write: () => new Promise<void>(() => undefined),
      now: () => AT,
      onChange: (state) => projections.push(state),
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    void controller.decidePairing({ ...CLAUDE, sessionId: "s-1", requestId: "r-1" });
    await settle();
    expect(projections.at(-1)?.pending).toEqual(CLAUDE);
    expect(controller.waitingSessions("agent-1")).toBe(1);

    controller.withdraw("agent-1", "s-1", "r-1");
    await settle();

    expect(projections.at(-1)?.pending).toBeUndefined();
    expect(controller.waitingSessions("agent-1")).toBe(0);
  });
});
