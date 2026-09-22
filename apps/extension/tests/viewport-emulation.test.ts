import { describe, expect, it } from "vitest";
import {
  AGENT_VIEWPORTS_KEY,
  createViewportEmulation,
  createViewportStore,
  decideClear,
  type ViewportRecord,
} from "../src/service-worker/viewport-emulation.js";

/**
 * 012/T305 — the emulated viewport, and the two moments it has to survive (FR-156, FR-159, FR-160).
 *
 * The measurement this file is built on (R-166) overturned what the reference reading assumed:
 * detaching the debugger does **not** drop an emulation. Chrome keeps the page at the size it was
 * given until the tab reloads, so an emulation that is not explicitly cleared outlives the session
 * that asked for it and the owner is left with a page laid out for a phone. Every claim here is
 * about that one fact - the clear goes out *before* the detach, on a record that is read from
 * storage rather than remembered, because the worker that set the size is routinely not the worker
 * that gives it back (MV3 eviction, R-167).
 */

const TAB = 7;
const OTHER_TAB = 8;
const SESSION = "session-v1";

const RECORD: ViewportRecord = { tabId: TAB, sessionId: SESSION, width: 375, height: 812, setAt: 1_757_000_000_000 };

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

type Command = { tabId: number; method: string; params?: Record<string, unknown> };

/**
 * The attachment as this module uses it: four calls and one hook.
 *
 * `release` runs the registered hooks and *then* records a detach, which is the real module's own
 * order (`input.ts`) and the only way the claim "the clear goes out first" can be checked at all.
 */
function fakeAttachments(options: { attached?: number[]; refuse?: boolean } = {}) {
  const attached = new Set(options.attached ?? []);
  const commands: Command[] = [];
  const holders: Array<{ tabId: number; holder: string; verb: "acquire" | "drop" }> = [];
  const beforeRelease: Array<(tabId: number) => Promise<void> | void> = [];
  const failMethods = new Set<string>();
  return {
    commands,
    holders,
    failMethods,
    attachedTabs: attached,
    async acquire(tabId: number, holder: string) {
      holders.push({ tabId, holder, verb: "acquire" });
      if (options.refuse) return { ok: false as const, unavailableReason: "devtools-open" as const };
      attached.add(tabId);
      return { ok: true as const };
    },
    async drop(tabId: number, holder: string) {
      holders.push({ tabId, holder, verb: "drop" });
      attached.delete(tabId);
    },
    async send(tabId: number, method: string, params?: Record<string, unknown>) {
      if (failMethods.has(method)) throw new Error(`refused ${method}`);
      commands.push({ tabId, method, ...(params ? { params } : {}) });
      return method === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 1187, clientHeight: 707 } } : {};
    },
    attached() {
      return [...attached];
    },
    onBeforeRelease(listener: (tabId: number) => Promise<void> | void) {
      beforeRelease.push(listener);
    },
    async release(tabId: number) {
      for (const listener of beforeRelease) await listener(tabId);
      commands.push({ tabId, method: "detach" });
      attached.delete(tabId);
    },
  };
}

function methods(commands: Command[]): string[] {
  return commands.map((command) => command.method);
}

describe("T305 decideClear", () => {
  it("sends the clear over an attachment that is still there", () => {
    expect(decideClear(RECORD, true)).toBe("send-clear");
  });

  /**
   * The eviction case (R-167): Chrome kept the emulation *and* the attachment this worker no longer
   * knows about, or dropped the attachment and kept the emulation. Either way the page is still the
   * wrong size, so the clear is worth an attachment of its own rather than being skipped.
   */
  it("attaches for the clear when this worker has no attachment left", () => {
    expect(decideClear(RECORD, false)).toBe("attach-clear-detach");
  });

  it("does nothing for a tab that was never given a viewport", () => {
    expect(decideClear(undefined, true)).toBe("nothing");
    expect(decideClear(undefined, false)).toBe("nothing");
  });
});

describe("T305 the record store", () => {
  it("round-trips one record per tab and replaces the one a second set covers", async () => {
    const area = fakeArea();
    const store = createViewportStore(area);

    await store.remember(RECORD);
    await store.remember({ ...RECORD, tabId: OTHER_TAB });
    await expect(store.forTab(TAB)).resolves.toEqual(RECORD);
    await expect(store.forTab(OTHER_TAB)).resolves.toEqual({ ...RECORD, tabId: OTHER_TAB });

    // A second `set` on the same tab is the same emulation at another size, not a second one.
    const wider = { ...RECORD, width: 2560, height: 1440, setAt: 1_757_000_000_001 };
    await store.remember(wider);
    await expect(store.forTab(TAB)).resolves.toEqual(wider);
    expect(Object.keys((area.raw[AGENT_VIEWPORTS_KEY] ?? {}) as Record<string, unknown>)).toEqual([
      String(TAB),
      String(OTHER_TAB),
    ]);

    await store.forget(TAB);
    await expect(store.forTab(TAB)).resolves.toBeUndefined();
    await expect(store.forTab(OTHER_TAB)).resolves.toBeDefined();
  });
});

describe("T305 the emulation over an attachment", () => {
  function build(options: { attached?: number[]; refuse?: boolean; area?: Record<string, unknown> } = {}) {
    const attachments = fakeAttachments(options);
    const area = fakeArea(options.area ?? {});
    const activity: Array<{ sessionId: string; outcome: string; size?: { width: number; height: number } }> = [];
    const diagnostics: string[] = [];
    const emulation = createViewportEmulation({
      store: createViewportStore(area),
      attachments,
      onActivity: (sessionId, outcome, size) => activity.push({ sessionId, outcome, ...(size ? { size } : {}) }),
      reportDiagnostic: (code) => diagnostics.push(code),
    });
    // Wired the way `agent-runtime.ts` wires it (T308): the module offers the hook, the composition
    // decides that the attachments are the thing that fires it.
    attachments.onBeforeRelease((tabId) => emulation.onBeforeRelease(tabId));
    return { attachments, area, activity, diagnostics, emulation };
  }

  it("takes the attachment as its own holder and gives the page the size", async () => {
    const { attachments, activity, emulation } = build();

    await expect(emulation.set(SESSION, TAB, { width: 375, height: 812 })).resolves.toEqual({ ok: true });

    expect(attachments.holders).toEqual([{ tabId: TAB, holder: "viewport", verb: "acquire" }]);
    expect(attachments.commands).toEqual([
      {
        tabId: TAB,
        method: "Emulation.setDeviceMetricsOverride",
        // Density is the display's business, not this feature's (spec Out of Scope): the page is
        // told it has 375 CSS pixels, and the picture's own density is answered by the capture.
        params: { width: 375, height: 812, deviceScaleFactor: 1, mobile: false },
      },
    ]);
    await expect(emulation.current(TAB)).resolves.toMatchObject({ sessionId: SESSION, width: 375, height: 812 });
    expect(activity).toEqual([{ sessionId: SESSION, outcome: "set", size: { width: 375, height: 812 } }]);
  });

  it("says why when Chrome will not let the session debug that tab", async () => {
    const { attachments, emulation } = build({ refuse: true });

    await expect(emulation.set(SESSION, TAB, { width: 375, height: 812 })).resolves.toEqual({
      ok: false,
      unavailableReason: "devtools-open",
    });
    expect(methods(attachments.commands)).toEqual([]);
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
  });

  it("clears the page, drops the record and lets the attachment go on reset", async () => {
    const { attachments, activity, emulation } = build();
    await emulation.set(SESSION, TAB, { width: 375, height: 812 });

    // The real size is measured on the way out, while the attachment this emulation held is still
    // there: after the clear, so it is the window's own size rather than the one being given back.
    await expect(emulation.reset(SESSION, TAB)).resolves.toEqual({ ok: true, real: { width: 1187, height: 707 } });

    expect(methods(attachments.commands)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.clearDeviceMetricsOverride",
      "Page.getLayoutMetrics",
    ]);
    expect(attachments.holders.at(-1)).toEqual({ tabId: TAB, holder: "viewport", verb: "drop" });
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
    expect(activity.at(-1)).toEqual({ sessionId: SESSION, outcome: "cleared" });
  });

  /**
   * FR-159, and the whole reason this module exists: R-166 measured a page still 500 px wide two
   * and a half seconds after the debugger was detached. The clear has to be the last thing that
   * goes out over the attachment, not something the detach is trusted to do.
   */
  it("clears the emulation before the attachment is detached, and only for a tab that has one", async () => {
    const { attachments, activity, emulation } = build();
    await emulation.set(SESSION, TAB, { width: 375, height: 812 });
    attachments.commands.length = 0;

    await attachments.release(TAB);

    // One plain clear, because this worker is holding the attachment the override was set over:
    // that is the case R-176 measured as reliable on both builds.
    expect(methods(attachments.commands)).toEqual(["Emulation.clearDeviceMetricsOverride", "detach"]);
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
    expect(activity.at(-1)).toEqual({ sessionId: SESSION, outcome: "cleared" });

    // A tab nobody emulated is released with nothing sent on its way out.
    attachments.commands.length = 0;
    await attachments.release(OTHER_TAB);
    expect(methods(attachments.commands)).toEqual(["detach"]);
  });

  /**
   * R-176 (branded Chrome 153) — a clear from a *fresh* attachment does not undo an override the
   * detached one set.
   *
   * Measured on the owner's own build: a new attachment sending `clearDeviceMetricsOverride` on its
   * own left the page at 500x500, while one that first re-asserted the override and then cleared it
   * put the page back every time. So the borrowed attachment takes the size back before it gives it
   * up - the emulation has to be *this* attachment's before this attachment can drop it.
   */
  it("re-asserts the size over a borrowed attachment before clearing it", async () => {
    const stored = { [AGENT_VIEWPORTS_KEY]: { [TAB]: { sessionId: SESSION, width: 375, height: 812, setAt: 1 } } };
    const { attachments, emulation } = build({ area: stored });

    await emulation.onBeforeRelease(TAB);

    expect(attachments.commands).toEqual([
      {
        tabId: TAB,
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 375, height: 812, deviceScaleFactor: 1, mobile: false },
      },
      { tabId: TAB, method: "Emulation.clearDeviceMetricsOverride" },
    ]);
    // Borrowed for the clear and given straight back: nothing keeps an attachment for this.
    expect(attachments.holders).toEqual([
      { tabId: TAB, holder: "viewport", verb: "acquire" },
      { tabId: TAB, holder: "viewport", verb: "drop" },
    ]);
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
  });

  /**
   * R-167 — the worker was evicted and came back. Its map of attachments is what was lost; the
   * record is in `chrome.storage.session` and the page is still emulated, so the next thing that
   * needs the debugger on that tab re-applies the size rather than leaving the two disagreeing.
   */
  it("re-applies the size the next time the tab is attached", async () => {
    const stored = { [AGENT_VIEWPORTS_KEY]: { [TAB]: { sessionId: SESSION, width: 375, height: 812, setAt: 1 } } };
    const { attachments, emulation } = build({ area: stored });

    await emulation.onAttached(OTHER_TAB);
    expect(attachments.commands).toEqual([]);

    await emulation.onAttached(TAB);

    expect(attachments.commands).toEqual([
      {
        tabId: TAB,
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 375, height: 812, deviceScaleFactor: 1, mobile: false },
      },
    ]);
  });

  /**
   * 012/S2c F1 - the holder set has to be complete again after an eviction, not just the size.
   *
   * Whatever attached the tab this time (an effect, the diagnostics) will let go of its own holder
   * eventually, and a detach with a record still in storage is the emulation outliving the session
   * again. Claiming the holder here is what keeps the attachment alive for as long as the
   * emulation, which is the invariant `set` establishes on the path that is not an eviction.
   */
  it("claims its holder again when the tab is attached after an eviction", async () => {
    const stored = { [AGENT_VIEWPORTS_KEY]: { [TAB]: { sessionId: SESSION, width: 375, height: 812, setAt: 1 } } };
    const { attachments, emulation } = build({ area: stored, attached: [TAB] });

    await emulation.onAttached(TAB);

    expect(attachments.holders).toEqual([{ tabId: TAB, holder: "viewport", verb: "acquire" }]);
    expect(methods(attachments.commands)).toEqual(["Emulation.setDeviceMetricsOverride"]);

    // And nothing at all for a tab nobody emulated: no holder, no command.
    attachments.holders.length = 0;
    await emulation.onAttached(OTHER_TAB);
    expect(attachments.holders).toEqual([]);
  });

  /**
   * 012/S2c F4 - a reset that cleared nothing must not answer as though it had.
   *
   * After an eviction the clear needs an attachment of its own, and Chrome refuses one while the
   * owner has developer tools open on that tab. The page is then still emulated, so `emulated:
   * false` would be a plain untruth and the record is the only thing that would let a later call
   * put it right. Both stay, and the agent is told in the attachment's own words.
   */
  it("says why a reset could not be delivered, and keeps the record to try again", async () => {
    const stored = { [AGENT_VIEWPORTS_KEY]: { [TAB]: { sessionId: SESSION, width: 375, height: 812, setAt: 1 } } };
    const { attachments, activity, emulation } = build({ area: stored, refuse: true });

    await expect(emulation.reset(SESSION, TAB)).resolves.toEqual({
      ok: false,
      unavailableReason: "devtools-open",
    });

    expect(methods(attachments.commands)).toEqual([]);
    await expect(emulation.current(TAB)).resolves.toBeDefined();
    // And no line on the card for something that did not happen.
    expect(activity).toEqual([]);
  });

  it("answers a reset on a tab nobody emulated without attaching anything to it", async () => {
    const { attachments, emulation } = build();

    await expect(emulation.reset(SESSION, TAB)).resolves.toEqual({ ok: true });

    // A reset is not a reason to start debugging a tab: with no attachment there is no measurement,
    // and the caller answers from what the browser already knows about the tab.
    expect(attachments.holders).toEqual([]);
    expect(methods(attachments.commands)).toEqual([]);
  });

  it("measures a tab nobody emulated when there is already an attachment on it", async () => {
    const { attachments, emulation } = build({ attached: [TAB] });

    await expect(emulation.reset(SESSION, TAB)).resolves.toEqual({ ok: true, real: { width: 1187, height: 707 } });

    expect(methods(attachments.commands)).toEqual(["Page.getLayoutMetrics"]);
  });

  /**
   * 012/S2c F5 - the tab is gone, so the record is too.
   *
   * There is nothing to clear on a tab Chrome no longer has, and nothing to send it over. What
   * would be left is a record naming a tab id, and Chrome hands ids out again: the next tab to get
   * this one would be re-emulated by the first `acquire` that touched it (`onAttached`), for a
   * session that never asked about it.
   */
  it("forgets a closed tab's record without sending anything", async () => {
    const { attachments, emulation } = build();
    await emulation.set(SESSION, TAB, { width: 375, height: 812 });
    attachments.commands.length = 0;

    await emulation.forget(TAB);

    await expect(emulation.current(TAB)).resolves.toBeUndefined();
    expect(methods(attachments.commands)).toEqual([]);
  });

  it("reports the command Chrome refused rather than throwing it at the caller", async () => {
    const { attachments, diagnostics, emulation } = build();
    attachments.failMethods.add("Emulation.setDeviceMetricsOverride");

    const answered = await emulation.set(SESSION, TAB, { width: 375, height: 812 });

    expect(answered.ok).toBe(false);
    expect(diagnostics).toContain("agent.viewport.apply-failed");
    // Nothing is recorded for a size the page was never given: a record here would be a promise to
    // clear something that is not there.
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
  });

  it("drops the record even when the clear could not be delivered", async () => {
    const { attachments, diagnostics, emulation } = build();
    await emulation.set(SESSION, TAB, { width: 375, height: 812 });
    attachments.failMethods.add("Emulation.clearDeviceMetricsOverride");

    await emulation.onBeforeRelease(TAB);

    expect(diagnostics).toContain("agent.viewport.clear-failed");
    // The tab is going; a record kept for it would be owed to an attachment nobody holds.
    await expect(emulation.current(TAB)).resolves.toBeUndefined();
  });
});
