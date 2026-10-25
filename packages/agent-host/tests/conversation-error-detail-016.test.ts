import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Transform } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentTestRunner } from "../src/broker/agent-test.js";
import type { AdapterLaunchSpec } from "../src/broker/agents.js";
import { spawnAgentProcess } from "../src/broker/conversation.js";
import { NO_USER_ENVIRONMENT, fakeAgentSpec, killLoggedPids, poolHarness } from "./conversation-harness.js";

/**
 * 0.16.1 (follow-up of 0.16.0): the Codex connector fails a turn its account cannot run (usage
 * limit, a refused sign-in) with the generic JSON-RPC error - `code` -32603, `message` "Internal
 * error" - and puts Codex's own words in `data` (`data.message`; the ACP SDK's own wrapping uses
 * `data.details`). The turn's notice, and with it the settings page's Test reason, says those words,
 * still without any value of the agent's environment (SC-161); "Internal error" alone only when the
 * error carries nothing more.
 */

const LIMIT = "You've hit your usage limit. Try again at 3:05 PM.";
const SECRET_NAME = "HALLPASS_TEST_SECRET";
const SECRET = "plain7x9k2m";

type Data = unknown;

/** The fake's -32603 error that starts with the usage-limit text, re-said in the connector's shape. */
function rewrite(line: string, data: (said: string) => Data): string {
  try {
    const frame = JSON.parse(line) as { error?: { code?: unknown; message?: unknown } };
    const said = frame.error?.message;
    if (frame.error?.code === -32603 && typeof said === "string" && said.startsWith(LIMIT)) {
      const shaped = data(said);
      frame.error = { code: -32603, message: "Internal error", ...(shaped === undefined ? {} : { data: shaped }) };
      return JSON.stringify(frame);
    }
  } catch {
    // Not a whole JSON frame: passed on as it is.
  }
  return line;
}

/** The plain spawn of the fake agent, with what it writes to stdout rewritten frame by frame. */
function connectorShaped(data: (said: string) => Data) {
  return (spec: AdapterLaunchSpec, cwd: string): ChildProcess => {
    const child = spawnAgentProcess(spec, cwd);
    let rest = "";
    const out = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        rest += chunk.toString("utf8");
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        done(null, lines.map((line) => `${rewrite(line, data)}\n`).join(""));
      },
      flush(done) {
        done(null, rest === "" ? "" : rewrite(rest, data));
      },
    });
    child.stdout!.pipe(out);
    Object.defineProperty(child, "stdout", { value: out, configurable: true, writable: true });
    return child;
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

describe("0.16.1 a turn error whose words are in `data` (the Codex connector's shape)", () => {
  it.each([
    ["data.message (Codex's turn error)", (said: string) => ({ message: said, codexErrorInfo: "usageLimitExceeded" })],
    ["data.details (the ACP SDK's wrapping)", (said: string) => ({ details: said })],
    ["data as text", (said: string) => said],
  ] as const)("%s: the `turn-failed` notice says the agent's words, no value of its environment", async (_shape, data) => {
    const lines: string[] = [];
    const h = await poolHarness({
      env: { FAKE_ACP_TURN_ERROR: `${LIMIT} ({env:${SECRET_NAME}})`, [SECRET_NAME]: SECRET },
      spawnAgent: connectorShaped(data),
      log: (code, detail) => lines.push(`${code} ${detail ?? ""}`),
    });
    cleanups.push(h.cleanup);
    const id = await h.start("codex");
    await h.turn(id, "fail:turn");

    const notices = h.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));
    expect(notices.map((notice) => notice.code)).toEqual(["turn-failed"]);
    expect(notices[0]!.text).toContain("usage limit");
    expect(notices[0]!.text).toContain(SECRET_NAME);
    expect(JSON.stringify(h.rec.events)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  }, 60_000);

  it("no detail at all: the notice still says the error's own message", async () => {
    const h = await poolHarness({ env: { FAKE_ACP_TURN_ERROR: LIMIT }, spawnAgent: connectorShaped(() => undefined) });
    cleanups.push(h.cleanup);
    const id = await h.start("codex");
    await h.turn(id, "fail:turn");
    const notices = h.rec.of(id).flatMap((entry) => (entry.event.type === "notice" ? [entry.event] : []));
    expect(notices.map((notice) => notice.text)).toEqual(["The agent's turn failed: Internal error"]);
  }, 60_000);

  it("the settings page's Test: the stored reason says the agent's words", async () => {
    const harness = await poolHarness({ store: false });
    cleanups.push(harness.cleanup);
    const testLog = join(harness.dir, "fake-test.log");
    const runner = createAgentTestRunner({
      dataDir: harness.dataDir,
      resolveLaunch: async (agent) => ({
        ok: true,
        // The fake's own text differs from the words re-said in `data`: a whole value of the
        // agent's environment would be scrubbed from the reason (SC-161).
        spec: fakeAgentSpec({ FAKE_ACP_LOG: testLog, FAKE_ACP_SCENARIO: "codex", FAKE_ACP_FAIL_AT: "prompt", FAKE_ACP_FAIL_MESSAGE: `${LIMIT} (fake)` }),
        versions: { agent, tested: "1.0.0", found: "1.0.0" },
      }),
      browserTools: async () => "available",
      userEnvironment: NO_USER_ENVIRONMENT,
      spawnAgent: connectorShaped(() => ({ message: LIMIT, codexErrorInfo: "usageLimitExceeded" })),
    });
    cleanups.push(async () => {
      await runner.shutdown();
      await killLoggedPids(testLog);
    });

    const result = await runner.run("codex");
    expect(result).toMatchObject({ outcome: "failed", start: "ok", model: { answered: false } });
    expect(result.model.answered === false ? result.model.reason : "").toContain("usage limit");
  }, 120_000);
});
