import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { switchedEnvironment } from "./fake-acp-agent-switch.js";

/** 024 T791: the switchable fake - the gate changes its knobs between steps through a file. */

const SWITCH = resolve(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent-switch.ts");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "fake-acp-switch-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("switchedEnvironment", () => {
  it("lays the file's values over the environment and removes the ones set to null", () => {
    const file = join(scratch, "switch.json");
    writeFileSync(file, JSON.stringify({ FAKE_ACP_FAIL_AT: "prompt", FAKE_ACP_LOG: null }));
    expect(switchedEnvironment({ FAKE_ACP_LOG: "log.jsonl", KEEP: "1" }, file)).toEqual({ FAKE_ACP_FAIL_AT: "prompt", KEEP: "1" });
  });

  it("changes nothing when the file is missing, unreadable or not an object", () => {
    const base = { KEEP: "1" };
    expect(switchedEnvironment(base, undefined)).toEqual(base);
    expect(switchedEnvironment(base, join(scratch, "absent.json"))).toEqual(base);
    const bad = join(scratch, "bad.json");
    writeFileSync(bad, "[1,2]");
    expect(switchedEnvironment(base, bad)).toEqual(base);
  });
});

describe("as a process", () => {
  it("runs the fake with the switched environment and its arguments", () => {
    const file = join(scratch, "switch.json");
    writeFileSync(file, JSON.stringify({ FAKE_ACP_VERSION: "9.9.9 switched" }));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", SWITCH, "--version"], {
      env: { ...process.env, FAKE_ACP_SWITCH_FILE: file },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("9.9.9 switched");
  });
});
