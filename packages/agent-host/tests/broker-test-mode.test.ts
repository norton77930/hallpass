import { describe, expect, it } from "vitest";
import { readBrokerTestOverrides } from "../src/broker/test-mode.js";

/**
 * 019 T549 / T564 - the broker's test-mode overrides, read from its environment.
 *
 * `HALLPASS_BROKER_TEST_AGENT` (a JSON argv replacing every adapter launch) and
 * `HALLPASS_BROKER_TEST_IDLE_MS` (the idle limit, so the packaged gate can watch an idle stop and a
 * resume without waiting ten minutes, US4.3) are honoured only with `HALLPASS_TEST_MODE=1`; without
 * it neither is, whatever they say.
 */

const AGENT = JSON.stringify(["node.exe", "fake-acp-agent.js"]);

describe("readBrokerTestOverrides", () => {
  it("honours nothing without HALLPASS_TEST_MODE=1", () => {
    for (const mode of [undefined, "", "0", "deterministic", "true"]) {
      const overrides = readBrokerTestOverrides({
        ...(mode === undefined ? {} : { HALLPASS_TEST_MODE: mode }),
        HALLPASS_BROKER_TEST_AGENT: AGENT,
        HALLPASS_BROKER_TEST_IDLE_MS: "5000",
      });
      expect(overrides).toEqual({ codes: [] });
    }
  });

  it("reads the agent argv and the idle limit in test mode", () => {
    const overrides = readBrokerTestOverrides({
      HALLPASS_TEST_MODE: "1",
      HALLPASS_BROKER_TEST_AGENT: AGENT,
      HALLPASS_BROKER_TEST_IDLE_MS: "20000",
    });
    expect(overrides.agent).toEqual({ command: "node.exe", args: ["fake-acp-agent.js"], env: {} });
    expect(overrides.idleMs).toBe(20_000);
    expect(overrides.codes).toEqual(["broker.test-agent", "broker.test-idle"]);
  });

  it("refuses a malformed agent argv and an idle limit that is not a whole number of ms in range", () => {
    for (const raw of ["not json", "[]", "[1]", "{\"command\":\"x\"}"]) {
      expect(readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_AGENT: raw })).toEqual({
        codes: ["broker.test-agent-invalid"],
      });
    }
    for (const raw of ["abc", "0", "-5", "1.5", "999", String(24 * 60 * 60_000 + 1)]) {
      expect(readBrokerTestOverrides({ HALLPASS_TEST_MODE: "1", HALLPASS_BROKER_TEST_IDLE_MS: raw })).toEqual({
        codes: ["broker.test-idle-invalid"],
      });
    }
  });
});
