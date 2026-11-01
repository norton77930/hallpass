import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeQuestions, summarize } from "./probe.js";

/**
 * Issue #17 probe, against the fake agent: what an agent sends when asked to put a question to the user
 * is recorded in order and nothing is allowed - an elicitation is declined, a permission request cancelled.
 */

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "fake-acp-agent.ts");
const children: ChildProcess[] = [];
let cwd: string;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await rm(cwd, { recursive: true, force: true });
});

async function fake(env: Record<string, string> = {}): Promise<ChildProcess> {
  cwd = await mkdtemp(join(tmpdir(), "hallpass-probe-017-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", FAKE], {
    cwd,
    env: { ...process.env, FAKE_ACP_SCENARIO: "claude", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

describe("#17 probe: how an agent asks", () => {
  it("records a form elicitation with its field and choices, declines it, and reads the agent's reply", async () => {
    const record = await probeQuestions({ child: await fake(), cwd, prompt: "ask:elicit", boundMs: 30_000 });
    expect(record.started).toBe(true);
    expect(record.events).toEqual([
      { kind: "elicitation", mode: "form", message: "Which colour do you prefer?", scope: "session", fields: [{ name: "colour", type: "string", choices: ["red", "blue"], required: true }] },
      { kind: "text", text: "elicit:decline" },
    ]);
    expect(record.stopReason).toBe("end_turn");
    expect(summarize(record)).toMatch(/^asked by elicitation \(form\)/u);
  }, 60_000);

  it("records a permission request and cancels it; a strict mode is set first", async () => {
    const record = await probeQuestions({ child: await fake(), cwd, prompt: "tool:edit", modeId: "default", boundMs: 30_000 });
    const asked = record.events.find((event) => event.kind === "permission");
    expect(asked).toMatchObject({ kind: "permission", options: expect.arrayContaining([expect.objectContaining({ kind: expect.any(String) })]) });
    expect(summarize(record)).toMatch(/^asked through a permission request/u);
  }, 60_000);

  it("plain text that asks is told apart", async () => {
    const record = await probeQuestions({ child: await fake(), cwd, prompt: "Red or blue?", boundMs: 30_000 });
    expect(record.events).toEqual([{ kind: "text", text: "echo:Red or blue?" }]);
    expect(summarize(record)).toMatch(/^asked in plain text/u);
  }, 60_000);

  it("an agent that exits at start: not started, with the reason", async () => {
    const record = await probeQuestions({ child: await fake({ FAKE_ACP_EXIT_AT: "initialize" }), cwd, boundMs: 30_000 });
    expect(record.started).toBe(false);
    expect(record.error).toMatch(/exited|closed/iu);
    expect(summarize(record)).toMatch(/^did not start/u);
  }, 60_000);
});
