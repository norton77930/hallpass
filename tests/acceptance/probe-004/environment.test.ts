import { describe, expect, it } from "vitest";

import { AGENT_EXTENSION_ID, checkEnvironment, referenceExtensionId } from "./environment.js";
import type { EnvironmentDeps, FetchLike } from "./environment.js";

/**
 * 004/T084 — the environment check.
 *
 * The probe attaches to the owner's own Chrome, so the run either starts against the right browser
 * or it must say precisely what is missing: a report that says "failed" without naming the piece
 * costs the owner a debugging session for nothing. Two behaviours are pinned here - an unreachable
 * endpoint is fatal and points at the quickstart, and everything else is a *named* problem in a
 * list, so a degraded run is still a run with a readable table.
 *
 * Nothing here touches a browser: the fetch is a fake, and so are the file and command probes.
 */

const VERSION = { Browser: "Chrome/152.0.7300.0", "Protocol-Version": "1.3" };

/** A stand-in for the parity baseline: its real id is machine configuration, never a literal here (009/FR-129). */
const REFERENCE_ID = "areferenceextensionidplaceholder";

function target(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `target-${id}`, title: `page ${id}`, url: `chrome-extension://${id}/manifest.json`, ...extra };
}

function jsonResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function deps(overrides: Partial<EnvironmentDeps> = {}): EnvironmentDeps {
  return {
    endpoint: "http://127.0.0.1:9222",
    fetch: async (url) => {
      if (url.endsWith("/json/version")) {
        return jsonResponse(VERSION);
      }
      if (url.endsWith("/json/list")) {
        return jsonResponse([target(AGENT_EXTENSION_ID), target(REFERENCE_ID, { title: "Claude in Chrome" })]);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    fileExists: async () => true,
    runCommand: async (command) => ({ ok: true, stdout: command === "claude" ? "2.1.266 (Claude Code)\n" : "ok" }),
    pairing: {
      agentId: async () => "agent-abc",
      isPaired: async () => true,
      establish: async () => ({ established: true, detail: "warm-up session" }),
    },
    hostManifestPath: "C:/host/com.hallpass.host.json",
    referenceExtensionId: REFERENCE_ID,
    mcpServerPath: "D:/repo/packages/agent-host/dist/mcp-server.js",
    registryKeys: ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.hallpass.host"],
    ...overrides,
  };
}

describe("probe-004 environment check", () => {
  it("fills the report's table from the browser and the CLI", async () => {
    const environment = await checkEnvironment(deps());

    expect(environment.browserVersion).toBe("Chrome/152.0.7300.0");
    expect(environment.extensionBuild).toContain(AGENT_EXTENSION_ID);
    expect(environment.referenceVersion).toContain("Claude in Chrome");
    expect(environment.claudeVersion).toBe("2.1.266 (Claude Code)");
    expect(environment.bridgeInstall).toContain("host manifest");
    expect(environment.problems).toEqual([]);
  });

  /**
   * 004/T167. Another Claude Code session's `hallpass` server is a second agent the probe never
   * started; the run is refused with the pids rather than left to fail on whichever scenario the
   * foreign pairing prompt lands in.
   */
  it("refuses the run while another session's agent-bridge server is attached, naming its pid", async () => {
    const environment = await checkEnvironment(
      deps({ agentServers: async () => [{ pid: 75160, parentPid: 65348 }] }),
    );

    expect(environment.foreignAgentServers).toBe("1 attached — pid 75160");
    expect(environment.problems).toEqual([expect.stringContaining("75160 (parent 65348)")]);
  });

  it("records 'none' when the machine was asked and no foreign server was found, and says when it was not asked", async () => {
    expect((await checkEnvironment(deps({ agentServers: async () => [] }))).foreignAgentServers).toBe("none");
    expect((await checkEnvironment(deps())).foreignAgentServers).toBe("not checked");
  });

  it("is fatal and names the quickstart step when the endpoint is unreachable", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(checkEnvironment(deps({ fetch: failing }))).rejects.toThrow(/quickstart\.md/);
    await expect(checkEnvironment(deps({ fetch: failing }))).rejects.toThrow(/HALLPASS_CDP_ENDPOINT/);
  });

  it("wakes a sleeping extension with /json/new, re-lists, then closes the page it opened", async () => {
    const requests: string[] = [];
    let woken = false;

    const fetchWithSleepingReference: FetchLike = async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/json/version")) {
        return jsonResponse(VERSION);
      }
      if (url.endsWith("/json/list")) {
        return jsonResponse(
          woken
            ? [target(AGENT_EXTENSION_ID), target(REFERENCE_ID, { title: "Claude in Chrome" })]
            : [target(AGENT_EXTENSION_ID)],
        );
      }
      if (url.includes("/json/new")) {
        woken = true;
        return jsonResponse({ id: "woken-target", url: `chrome-extension://${REFERENCE_ID}/manifest.json` });
      }
      return jsonResponse({});
    };

    const environment = await checkEnvironment(deps({ fetch: fetchWithSleepingReference }));

    expect(requests).toContain(`PUT http://127.0.0.1:9222/json/new?chrome-extension://${REFERENCE_ID}/manifest.json`);
    expect(requests).toContain("GET http://127.0.0.1:9222/json/close/woken-target");
    expect(environment.referenceVersion).toContain("Claude in Chrome");
    expect(environment.problems).toEqual([]);
  });

  it("names every missing piece instead of failing opaquely", async () => {
    const environment = await checkEnvironment(
      deps({
        fetch: async (url) => {
          if (url.endsWith("/json/version")) {
            return jsonResponse(VERSION);
          }
          if (url.endsWith("/json/list")) {
            return jsonResponse([target(AGENT_EXTENSION_ID)]);
          }
          return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
        },
        fileExists: async (path) => !path.includes("mcp-server.js"),
        runCommand: async (command) =>
          command === "claude" ? { ok: false, stdout: "" } : { ok: false, stdout: "ERROR: no such key" },
      }),
    );

    const problems = environment.problems.join("\n");
    expect(environment.problems).toHaveLength(4);
    expect(problems).toContain(REFERENCE_ID);
    expect(problems).toContain("mcp-server.js");
    expect(problems).toContain("NativeMessagingHosts");
    expect(problems).toContain("claude");
    expect(environment.claudeVersion).toBe("not found");
  });

  /**
   * 009/FR-129. The baseline's id is machine configuration, so a machine that was never told it has
   * nothing to look for: hunting `chrome-extension:///manifest.json` would open a tab in the owner's
   * browser and then report the baseline "not loaded", which reads like a missing extension rather
   * than a missing setting.
   */
  it("says the baseline id is missing instead of hunting the browser for it", async () => {
    const requests: string[] = [];

    const environment = await checkEnvironment(
      deps({
        referenceExtensionId: "",
        fetch: async (url, init) => {
          requests.push(`${init?.method ?? "GET"} ${url}`);
          if (url.endsWith("/json/version")) return jsonResponse(VERSION);
          if (url.endsWith("/json/list")) return jsonResponse([target(AGENT_EXTENSION_ID)]);
          throw new Error(`unexpected fetch ${url}`);
        },
      }),
    );

    expect(requests.some((request) => request.includes("/json/new"))).toBe(false);
    expect(environment.referenceVersion).toBe("not configured");
    expect(environment.problems).toEqual(["reference extension id not configured (set HALLPASS_REFERENCE_EXTENSION_ID)."]);
  });

  it("reads the baseline id from the environment, and treats an unset variable as unconfigured", () => {
    expect(referenceExtensionId({ HALLPASS_REFERENCE_EXTENSION_ID: "anextensionidfromtheenvironment" })).toBe("anextensionidfromtheenvironment");
    expect(referenceExtensionId({})).toBe("");
  });
});

/**
 * 004/T111c — the probe's own pairing.
 *
 * The S0 run of 2026-09-09 was refused `not-paired` on every scenario because a journey that had run
 * earlier ended by unpairing the agent. Nothing was wrong with the probe's scenarios; the probe was
 * simply reading state a different run happened to leave behind. The check therefore establishes what
 * it needs: it asks the browser whether this machine's agent id is accepted, and when it is not, it
 * runs a minimal warm-up session and accepts the request *that session* raises - the CDP helper can
 * only answer a request already in flight, so a seeded record with nothing pending is not enough.
 *
 * A warm-up costs the owner a few cents, so the two branches are pinned separately: it must not run
 * when the pairing is already there, and it must run when it is not.
 */
describe("probe-004 pairing check", () => {
  it("reports the pairing it found and does not spend a warm-up session on it", async () => {
    let warmUps = 0;

    const environment = await checkEnvironment(
      deps({
        pairing: {
          agentId: async () => "agent-abc",
          isPaired: async () => true,
          establish: async () => {
            warmUps += 1;
            return { established: true, detail: "warm-up session" };
          },
        },
      }),
    );

    expect(warmUps).toBe(0);
    expect(environment.pairing).toContain("found");
    expect(environment.pairing).toContain("agent-abc");
    expect(environment.problems).toEqual([]);
  });

  it("runs the warm-up session when the agent id is not paired, and says so", async () => {
    const asked: string[] = [];

    const environment = await checkEnvironment(
      deps({
        pairing: {
          agentId: async () => "agent-abc",
          isPaired: async () => false,
          establish: async (agentId) => {
            asked.push(agentId);
            return { established: true, detail: "accepted at 8000 ms of the warm-up call" };
          },
        },
      }),
    );

    expect(asked).toEqual(["agent-abc"]);
    expect(environment.pairing).toContain("established");
    expect(environment.pairing).toContain("accepted at 8000 ms");
    expect(environment.problems).toEqual([]);
  });

  it("refuses the run when the warm-up could not pair the agent", async () => {
    const environment = await checkEnvironment(
      deps({
        pairing: {
          agentId: async () => "agent-abc",
          isPaired: async () => false,
          establish: async () => ({ established: false, detail: "the warm-up session timed out" }),
        },
      }),
    );

    // Every scenario would answer `not-paired`; that is a wasted paid run, not a measurement.
    expect(environment.problems.join("\n")).toContain("not paired");
    expect(environment.problems.join("\n")).toContain("the warm-up session timed out");
  });

  it("does not spend a warm-up when the machine is already missing something else", async () => {
    let warmUps = 0;

    const environment = await checkEnvironment(
      deps({
        fileExists: async (path) => !path.includes("mcp-server.js"),
        pairing: {
          agentId: async () => "agent-abc",
          isPaired: async () => false,
          establish: async () => {
            warmUps += 1;
            return { established: true, detail: "warm-up session" };
          },
        },
      }),
    );

    expect(warmUps).toBe(0);
    expect(environment.pairing).toContain("not checked");
  });
});
