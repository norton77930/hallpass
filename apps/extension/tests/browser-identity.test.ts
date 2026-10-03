import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLinkFrameSchema } from "@hallpass/contracts";
import { normalizeBrowserName } from "../src/browser-name.js";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { composeAgentRuntime } from "../src/service-worker/agent-runtime.js";
import {
  AGENT_BROWSER_IDENTITY_KEY,
  createBrowserIdentity,
  detectBrowserKind,
  suffixedBrowserName,
} from "../src/service-worker/browser-identity.js";

/**
 * 018/T499, T501 — who this browser is (R-268, FR-267, FR-268).
 *
 * The identity is per profile and outlives the worker, the browser run and an extension update, so
 * it lives in `chrome.storage.local` and is minted exactly once; the kind is read off the browser,
 * never stored; and a re-mint (a copied profile, R-276) keeps the owner's name, numbered, so the
 * two browsers can be told apart in every list.
 */

function memoryArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
  };
}

const ID_RULE = /^[A-Za-z0-9-]{8,64}$/u;

describe("T499 browser identity store", () => {
  it("mints once into storage.local, and a second store instance reads the same identity", async () => {
    const area = memoryArea();
    const first = createBrowserIdentity(area, { kind: "chrome" });

    const minted = await first.read();
    expect(minted?.browserId).toMatch(ID_RULE);
    expect(minted?.kind).toBe("chrome");
    expect(minted?.name).toBeUndefined();
    expect(area.store[AGENT_BROWSER_IDENTITY_KEY]).toEqual({ browserId: minted?.browserId });
    // Two reads that race in one worker mint one id, not two.
    const [again, raced] = await Promise.all([first.read(), first.read()]);
    expect(again?.browserId).toBe(minted?.browserId);
    expect(raced?.browserId).toBe(minted?.browserId);

    // The next worker (or the browser after a restart) reads it back rather than minting.
    const second = createBrowserIdentity(area, { kind: "chrome", mint: () => "should-not-be-used" });
    expect((await second.read())?.browserId).toBe(minted?.browserId);
  });

  it("re-mints a stored id that does not fit the rule, and keeps the stored name", async () => {
    const area = memoryArea({ [AGENT_BROWSER_IDENTITY_KEY]: { browserId: "bad/id", name: "Work" } });
    const identity = createBrowserIdentity(area, { kind: "edge", mint: () => "0123456789abcdef" });
    expect(await identity.read()).toEqual({ browserId: "0123456789abcdef", kind: "edge", name: "Work" });
  });

  it("says nothing without a storage area: an id it cannot keep would change on every eviction", async () => {
    expect(await createBrowserIdentity(undefined, { kind: "chrome" }).read()).toBeUndefined();
  });

  it("re-mints on conflict with a new id and keeps the name with a numbered suffix", async () => {
    const ids = ["aaaaaaaa-1111", "bbbbbbbb-2222", "cccccccc-3333"];
    const area = memoryArea();
    const identity = createBrowserIdentity(area, { kind: "chrome", mint: () => ids.shift() ?? "dddddddd-4444" });
    await identity.read();

    // Never named: the re-mint has no name to number either - the default name applies.
    expect(await identity.remint()).toEqual({ browserId: "bbbbbbbb-2222", kind: "chrome" });

    await identity.rename("Work");
    expect(await identity.remint()).toEqual({ browserId: "cccccccc-3333", kind: "chrome", name: "Work 2" });
    expect(area.store[AGENT_BROWSER_IDENTITY_KEY]).toEqual({ browserId: "cccccccc-3333", name: "Work 2" });
    expect((await createBrowserIdentity(area, { kind: "chrome" }).read())?.name).toBe("Work 2");
  });

  it("numbers a numbered name on, and keeps a long name inside 40 characters", () => {
    expect(suffixedBrowserName("Work")).toBe("Work 2");
    expect(suffixedBrowserName("Work 2")).toBe("Work 3");
    const long = "x".repeat(40);
    expect(suffixedBrowserName(long)).toBe(`${"x".repeat(38)} 2`);
  });

  it("detects the kind from the user-agent brands and Brave's own marker", () => {
    const brands = (...names: string[]) => ({
      userAgentData: { brands: names.map((brand) => ({ brand, version: "153" })) },
    });
    expect(detectBrowserKind(brands("Not)A;Brand", "Google Chrome", "Chromium"))).toBe("chrome");
    expect(detectBrowserKind(brands("Microsoft Edge", "Not=A?Brand", "Chromium"))).toBe("edge");
    expect(detectBrowserKind(brands("Chromium", "Not_A Brand"))).toBe("chromium");
    expect(detectBrowserKind({ ...brands("Chromium", "Not_A Brand"), brave: { isBrave: () => true } })).toBe("brave");
    expect(detectBrowserKind(brands("Brave", "Chromium", "Not/A)Brand"))).toBe("brave");
    // A brand it cannot place is not passed off as plain Chromium.
    expect(detectBrowserKind(brands("Opera", "Chromium", "Not?A_Brand"))).toBe("unknown");
    expect(detectBrowserKind({})).toBe("unknown");
    expect(detectBrowserKind(undefined)).toBe("unknown");
  });
});

describe("T501 the owner's name, normalised by the worker", () => {
  it("strips control characters, trims, and refuses anything outside 1-40 characters", () => {
    expect(normalizeBrowserName("  Work\u0007 laptop\n ")).toBe("Work laptop");
    expect(normalizeBrowserName("\u001b[31mRed")).toBe("[31mRed");
    expect(normalizeBrowserName("   ")).toBeUndefined();
    expect(normalizeBrowserName("\u0000\u0001")).toBeUndefined();
    expect(normalizeBrowserName("y".repeat(41))).toBeUndefined();
    expect(normalizeBrowserName("y".repeat(40))).toBe("y".repeat(40));
  });
});

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

function installChrome(): Record<string, unknown> {
  const local: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
    async remove(keys: string[]) {
      for (const key of keys) delete store[key];
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area({}) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async query() {
        return [];
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return local;
}

function framesOfType(port: FakePort, type: string): Array<Record<string, unknown>> {
  return port.sent.filter((frame) => (frame as { type?: string }).type === type) as Array<Record<string, unknown>>;
}

describe("T501 the composed worker: panel projection and rename", () => {
  let local: Record<string, unknown>;

  beforeEach(() => {
    local = installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("projects this browser from the identity and the relay's peers, and drops the others count with the link", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(framesOfType(port, "relay-ack")).toHaveLength(1));

    const ack = framesOfType(port, "relay-ack")[0]!;
    expect(ack.browserId).toMatch(ID_RULE);
    expect(agentLinkFrameSchema.safeParse(ack).success).toBe(true);
    // Before the relay has said anything about the others, the default is this browser's kind alone.
    await vi.waitFor(async () =>
      expect((await runtime.projection()).browser).toEqual({
        name: expect.any(String),
        defaultName: expect.any(String),
        kind: ack.browserKind,
        others: 0,
      }),
    );

    port.emit({ type: "browser-peers", others: 2, defaultName: "Chrome 2" });
    await vi.waitFor(async () =>
      expect((await runtime.projection()).browser).toEqual({
        name: "Chrome 2",
        defaultName: "Chrome 2",
        kind: ack.browserKind,
        others: 2,
      }),
    );
  });

  it("stores a rename stripped and trimmed, sends browser-name to the relay, and refuses an empty one", async () => {
    const port = fakePort();
    const runtime = composeAgentRuntime({ connectNative: () => port });
    runtime.start();
    port.emit({ type: "relay-started", relayPid: 4242 });
    await vi.waitFor(() => expect(framesOfType(port, "relay-ack")).toHaveLength(1));

    await runtime.renameBrowser("  Lab\u0007 box\n");
    expect(framesOfType(port, "browser-name")).toEqual([{ type: "browser-name", name: "Lab box" }]);
    expect((local[AGENT_BROWSER_IDENTITY_KEY] as { name?: string }).name).toBe("Lab box");
    expect((await runtime.projection()).browser?.name).toBe("Lab box");

    await runtime.renameBrowser(" \u0007 ");
    expect(framesOfType(port, "browser-name")).toHaveLength(1);
    expect((local[AGENT_BROWSER_IDENTITY_KEY] as { name?: string }).name).toBe("Lab box");
  });
});
