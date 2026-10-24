import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInstallState, AgentTestResult } from "@hallpass/contracts";
import {
  acquireInstallLock,
  installLockPath,
  installStatePath,
  lastTestPath,
  markInterruptedInstalls,
  readInstallState,
  readLastTest,
  readSharedState,
  shownInstallState,
  watchSharedState,
  writeInstallState,
  writeLastTest,
} from "../src/broker/shared-agent-state.js";
import { deadPid, makeTempDir, removeDir, waitFor } from "./conversation-harness.js";

/**
 * 024 T742 (R-375, R-378; data-model "Per computer"): what every browser's broker on this computer
 * shares about an agent, in `agents\<agent>\` under the Hallpass data folder - the download's state
 * (`install-state.json`), the last test's result (`last-test.json`), and the lock one install holds
 * (`install.lock`, `{ pid, browserId }`). Files are replaced whole; a lock whose broker is gone is
 * stale and taken over; a watching broker sees another broker's change within a second.
 */

const STARTED = "2026-10-24T08:00:00.000Z";
const state = (overrides: Partial<AgentInstallState> = {}): AgentInstallState => ({
  phase: "downloading",
  percent: 40,
  etaSeconds: 30,
  startedAt: STARTED,
  browserId: "chrome-a1",
  pid: 4_000_001,
  ...overrides,
});
const test: AgentTestResult = {
  outcome: "passed",
  start: "ok",
  model: { answered: true, ms: 1234 },
  browserTools: "available",
  ranAt: "2026-10-24T08:05:00.000Z",
};

let dir: string;
let data: string;
beforeEach(async () => {
  dir = await makeTempDir("hallpass-shared-");
  data = join(dir, "data");
});
afterEach(async () => {
  await removeDir(dir);
});

describe("024 T742 the shared state files", () => {
  it("writes install-state.json whole under agents\\<agent>\\ and reads it back", async () => {
    await writeInstallState(data, "deepseek", state());
    expect(installStatePath(data, "deepseek")).toBe(join(data, "agents", "deepseek", "install-state.json"));
    expect(await readInstallState(data, "deepseek")).toEqual(state());
    // Replaced whole: nothing half-written or temporary is left beside it.
    await writeInstallState(data, "deepseek", state({ percent: 60 }));
    expect(await readInstallState(data, "deepseek")).toMatchObject({ percent: 60 });
    expect(await readdir(join(data, "agents", "deepseek"))).toEqual(["install-state.json"]);
  });

  it("reads a missing, damaged or out-of-contract file as none, and refuses to write one out of contract", async () => {
    expect(await readInstallState(data, "codex")).toBeUndefined();
    await writeInstallState(data, "codex", state());
    await writeFile(installStatePath(data, "codex"), "{ half", "utf8");
    expect(await readInstallState(data, "codex")).toBeUndefined();
    await writeFile(installStatePath(data, "codex"), JSON.stringify({ ...state(), percent: 100 }), "utf8");
    expect(await readInstallState(data, "codex")).toBeUndefined();
    await expect(writeInstallState(data, "codex", state({ percent: 100 }))).rejects.toThrow();
  });

  it("writes and reads last-test.json", async () => {
    expect(await readLastTest(data, "hermes")).toBeUndefined();
    await writeLastTest(data, "hermes", test);
    expect(lastTestPath(data, "hermes")).toBe(join(data, "agents", "hermes", "last-test.json"));
    expect(await readLastTest(data, "hermes")).toEqual(test);
  });

  it("reads every agent's files at once", async () => {
    await writeInstallState(data, "deepseek", state());
    await writeLastTest(data, "claude-code", test);
    const snapshot = await readSharedState(data);
    expect(snapshot.deepseek).toEqual({ install: state() });
    expect(snapshot["claude-code"]).toEqual({ lastTest: test });
    expect(snapshot.codex).toEqual({});
  });
});

describe("024 T742 the install lock", () => {
  const LIVE = 4_000_100;
  const isAlive = (pid: number) => pid === LIVE || pid === process.pid;

  it("is created exclusively with { pid, browserId }; a second broker is told who holds it", async () => {
    const first = await acquireInstallLock(data, "deepseek", { pid: LIVE, browserId: "chrome-a1" }, isAlive);
    expect(first.acquired).toBe(true);
    expect(JSON.parse(await readFile(installLockPath(data, "deepseek"), "utf8"))).toEqual({ pid: LIVE, browserId: "chrome-a1" });
    const second = await acquireInstallLock(data, "deepseek", { pid: process.pid, browserId: "edge-b2" }, isAlive);
    expect(second).toEqual({ acquired: false, holder: { pid: LIVE, browserId: "chrome-a1" } });
  });

  it("is stale when its broker is gone: the next broker takes it", async () => {
    const gone = await deadPid();
    await acquireInstallLock(data, "codex", { pid: gone, browserId: "chrome-a1" }, () => true);
    const taken = await acquireInstallLock(data, "codex", { pid: process.pid, browserId: "edge-b2" });
    expect(taken.acquired).toBe(true);
    expect(JSON.parse(await readFile(installLockPath(data, "codex"), "utf8"))).toEqual({ pid: process.pid, browserId: "edge-b2" });
  });

  it("is removed at the end, and a release never removes another broker's lock", async () => {
    const held = await acquireInstallLock(data, "deepseek", { pid: LIVE, browserId: "chrome-a1" }, isAlive);
    if (!held.acquired) throw new Error("not acquired");
    await held.release();
    expect(await readdir(join(data, "agents", "deepseek"))).toEqual([]);
    // Released twice, or after another broker took it over: that broker's lock stays.
    const next = await acquireInstallLock(data, "deepseek", { pid: process.pid, browserId: "edge-b2" }, isAlive);
    expect(next.acquired).toBe(true);
    await held.release();
    expect(JSON.parse(await readFile(installLockPath(data, "deepseek"), "utf8"))).toEqual({ pid: process.pid, browserId: "edge-b2" });
  });

  it("is never taken by two brokers that find the same stale lock at once", async () => {
    const gone = await deadPid();
    await acquireInstallLock(data, "deepseek", { pid: gone, browserId: "chrome-a1" }, () => true);
    const results = await Promise.all([
      acquireInstallLock(data, "deepseek", { pid: LIVE, browserId: "edge-b2" }, isAlive),
      acquireInstallLock(data, "deepseek", { pid: process.pid, browserId: "brave-c3" }, isAlive),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });
});

describe("024 T742 / R-378 a running state whose broker is gone", () => {
  it("is shown as interrupted, without the pid", async () => {
    const gone = await deadPid();
    expect(shownInstallState(state({ pid: gone }))).toEqual({
      phase: "interrupted",
      percent: 40,
      etaSeconds: null,
      startedAt: STARTED,
      browserId: "chrome-a1",
    });
    const { pid: _pid, ...shown } = state({ pid: process.pid });
    expect(shownInstallState(state({ pid: process.pid }))).toEqual(shown);
  });

  it("is rewritten as interrupted at broker start; a live broker's and a finished one are left alone", async () => {
    const gone = await deadPid();
    await writeInstallState(data, "deepseek", state({ pid: gone }));
    await writeInstallState(data, "codex", state({ pid: process.pid }));
    await writeInstallState(data, "claude-code", state({ pid: gone, phase: "done", percent: 100, etaSeconds: null }));
    const marked = await markInterruptedInstalls(data, { selfPid: 4_000_999, now: () => Date.parse("2026-10-24T09:00:00.000Z") });
    expect(marked).toEqual(["deepseek"]);
    expect(await readInstallState(data, "deepseek")).toEqual(
      state({ pid: gone, phase: "interrupted", etaSeconds: null, endedAt: "2026-10-24T09:00:00.000Z" }),
    );
    expect(await readInstallState(data, "codex")).toEqual(state({ pid: process.pid }));
    expect((await readInstallState(data, "claude-code"))?.phase).toBe("done");
  });
});

describe("024 T742 watching for another broker's changes", () => {
  it("a second reader sees a change within 1 s while watching, and nothing once stopped", async () => {
    let changes = 0;
    const watch = watchSharedState({ dataDir: data, onChange: () => (changes += 1) });
    // Resolves once it has read what is there now, which is not a change.
    await watch.start();
    expect(changes).toBe(0);
    try {
      await writeInstallState(data, "deepseek", state());
      const at = Date.now();
      await waitFor(() => changes >= 1, "the first change", 2_000);
      expect(Date.now() - at).toBeLessThanOrEqual(1_200);
      await writeLastTest(data, "codex", test);
      await waitFor(() => changes >= 2, "the second change", 2_000);
      // The same content again is no change.
      await writeLastTest(data, "codex", test);
      await new Promise((done) => setTimeout(done, 1_300));
      expect(changes).toBe(2);
    } finally {
      watch.stop();
    }
    await writeInstallState(data, "deepseek", state({ percent: 80 }));
    await new Promise((done) => setTimeout(done, 1_300));
    expect(changes).toBe(2);
    expect(watch.watching).toBe(false);
  });
});
