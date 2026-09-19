import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BUDGET_USD, buildArgs, defaultSpawner, type ProbeAnswer } from "./agent-runner.js";
import { findPageTarget, frameTargetsOf, readPageTreeBaseline, summariseAxTree } from "./baseline.js";
import { buildAcceptExpression, buildResetExpression, buildSetSiteModeExpression, findWorkerTarget } from "./pairing.js";
import {
  CONTAINMENT_DECOYS,
  buildCandidateNames,
  judge,
  judgeContainment,
  judgeFile,
  parseScenarioFile,
  scenarioVerdict,
  sessionJudge,
} from "./scenarios.js";

const file = {
  id: "s0-first-call",
  slice: "S0",
  evidence: "E1",
  page: "about:blank",
  prompt: "call it once",
  answerSchema: { type: "object" },
  expect: { kind: "observed-equals", value: "ok" },
};

describe("scenario files", () => {
  it("names the missing field rather than failing later on undefined", () => {
    expect(() => parseScenarioFile({ ...file, expect: undefined }, "s0.json")).toThrow(/missing "expect"/);
  });

  it("refuses an expectation kind the judge cannot evaluate", () => {
    expect(() => parseScenarioFile({ ...file, expect: { kind: "vibes" } }, "s0.json")).toThrow(/unknown expect.kind/);
  });

  it("gives a scenario without bounds the owner's quota defaults", () => {
    const parsed = parseScenarioFile(file, "s0.json");
    // 004/T129d - the turn budget has to fit a multi-step scenario. Twelve did not: both S4
    // scenarios stopped mid tool call at $0.34 of a $0.50 cap, so the money was spent and nothing
    // was observed. The dollar cap is the guard; the turn count must not decide the outcome.
    expect(parsed.maxTurns).toBe(40);
    expect(parsed.maxBudgetUsd).toBe(0.5);
    expect(parsed.timeoutMs).toBe(240_000);
  });

  it("keeps the bounds a scenario sets for itself", () => {
    const parsed = parseScenarioFile({ ...file, maxTurns: 4, maxBudgetUsd: 0.1, timeoutMs: 1000 }, "s0.json");
    expect([parsed.maxTurns, parsed.maxBudgetUsd, parsed.timeoutMs]).toEqual([4, 0.1, 1000]);
  });

  /**
   * 004/T099b - a scenario has to be able to destroy one of its own sessions.
   *
   * `s1-server-killed` kills one session's mcp-server on purpose and the claim is about the
   * *other* one: it keeps working and never inherits the dead session's tab. While every session
   * had to pass, that scenario could not be written at all - the session the scenario killed failed
   * it. So a session carries a role, and only the `pass` ones decide.
   */
  it("treats a session with no declared role as one that has to pass", () => {
    const parsed = parseScenarioFile({ ...file, concurrency: 2 }, "s0.json");
    expect(sessionJudge(parsed, 0)).toBe("pass");
    expect(sessionJudge(parsed, 1)).toBe("pass");
  });

  it("names the session whose role it cannot judge rather than ignoring it", () => {
    expect(() =>
      parseScenarioFile({ ...file, sessions: [{ judge: "pass" }, { judge: "sacrificial" }] }, "s1.json"),
    ).toThrow(/unknown sessions\[1\].judge/);
  });

  it("passes a scenario whose killed session failed, as long as every pass session passed", () => {
    const roles = ["pass", "expected-killed"] as const;
    expect(scenarioVerdict(["pass", "fail"], roles)).toBe("pass");
    expect(scenarioVerdict(["fail", "fail"], roles)).toBe("fail");
    // The killed session succeeding anyway is recorded, not punished: the claim is about the other.
    expect(scenarioVerdict(["pass", "pass"], roles)).toBe("pass");
  });

  it("refuses to call a scenario passed when nothing in it had to pass", () => {
    expect(scenarioVerdict(["fail"], ["expected-killed"])).toBe("fail");
  });

  /**
   * 004/T129b - a scenario declares the site mode its own claim needs.
   *
   * Every effect on an undecided site becomes an owner prompt that nobody is there to answer, so a
   * hover or a typing scenario would measure a timeout instead of the capability. The mode is the
   * same class of environment step as the pairing the probe already establishes, so it is declared
   * in the file beside the other setup and applied before the session starts.
   */
  it("keeps the site mode a scenario declares for itself", () => {
    const parsed = parseScenarioFile({ ...file, setup: { siteMode: "skip-checks" } }, "s4.json");
    expect(parsed.setup?.siteMode).toBe("skip-checks");
  });

  it("names a site mode the extension has no such thing as, rather than writing it", () => {
    expect(() => parseScenarioFile({ ...file, setup: { siteMode: "allow" } }, "s4.json")).toThrow(
      /unknown setup.siteMode "allow"/,
    );
  });

  it("judges the agent's observed string against the file, trimming nothing else", () => {
    expect(judge({ kind: "observed-equals", value: "ok" }, " ok ")).toBe("pass");
    expect(judge({ kind: "observed-equals", value: "ok" }, "bridge-unavailable")).toBe("fail");
    expect(judge({ kind: "observed-contains", value: "artifact" }, "artifact-body-read")).toBe("pass");
  });

  /**
   * 005/T187 B19 - SC-042's "exists on disk" is the harness's check, not the caller's. The caller
   * (`claude -p`) is sandboxed to its own workspace and cannot see the owner's Downloads folder, so
   * a scenario names the answer field carrying the path and the run checks it after the caller
   * returns. Absent from a file, nothing is checked and nothing changes for the other scenarios.
   */
  it("checks the path a scenario names for existence, and says which way it went", () => {
    const parsed = parseScenarioFile({ ...file, verifyFile: "filename" }, "s8.json");
    // The path field is the scenario's own (its answer schema asks for it), so `ProbeAnswer` does
    // not name it - the same way a tree-containment answer carries `fullRead`.
    const answer = (filename: string): ProbeAnswer => ({ scenario: "s8", steps: [], observed: "download-reported", ...{ filename } });
    const path = "C:\Users\owner\Downloads\master.zip";
    expect(judgeFile(parsed, answer(path), (candidate) => candidate === path)).toEqual({
      verdict: "pass",
      detail: `file exists: ${path}`,
    });
    expect(judgeFile(parsed, answer(path), () => false)).toEqual({ verdict: "fail", detail: `file missing: ${path}` });
    expect(judgeFile(parsed, answer(""), () => true)).toEqual({ verdict: "fail", detail: "no path reported in filename" });
    expect(judgeFile(parseScenarioFile(file, "s0.json"), answer(path), () => true)).toBeUndefined();
  });

  it("refuses a verifyFile that does not name a field", () => {
    expect(() => parseScenarioFile({ ...file, verifyFile: 7 }, "s8.json")).toThrow(/"verifyFile" that is not a field name/);
  });
});

describe("the quota cap", () => {
  it("puts a per-scenario --max-budget-usd on every session", () => {
    const args = buildArgs({ ...file, maxTurns: 12, timeoutMs: 1000, maxBudgetUsd: 0.25 } as never, {
      mcpConfig: "C:/x/.mcp.json",
    });
    expect(args.slice(args.indexOf("--max-budget-usd"))).toEqual(["--max-budget-usd", "0.25"]);
  });

  it("falls back to the brief's default when the scenario names none", () => {
    const args = buildArgs({ ...file, maxTurns: 12, timeoutMs: 1000 } as never, { mcpConfig: "C:/x/.mcp.json" });
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe(String(DEFAULT_MAX_BUDGET_USD));
  });
});

describe("the mcp config a session is given", () => {
  /**
   * The first live run (2026-09-09) died here, five sessions at once: the runner passed the
   * repository's own `.mcp.json` by absolute path, and the spawner still used `shell: true` on
   * Windows, so the absolute `<repo>\.mcp.json` was split at the space in it into a directory read
   * (EISDIR) and a stray relative path. The shell is gone now, but the config stays relative: it is
   * written into each session's workspace anyway, and a value with no space in it cannot be split
   * by whatever runs it next.
   */
  it("names the workspace-local config, so a repository path with a space cannot split it", () => {
    const args = buildArgs({ ...file, maxTurns: 12, timeoutMs: 1000 } as never, { mcpConfig: ".mcp.json" });
    const value = args[args.indexOf("--mcp-config") + 1]!;
    expect(value).toBe(".mcp.json");
    expect(value).not.toMatch(/\s/);
  });
});

describe("the real spawner", () => {
  /**
   * Costs nothing: it spawns `node`, not `claude`, and asks it to echo its own argv. The two things
   * asserted are exactly the two that killed the first live runs - a value containing a space, and a
   * JSON value full of quotes and braces - so the next failure of this shape is caught here rather
   * than in a report that looks like a product failure.
   */
  it("delivers a spaced path and a JSON schema to the child verbatim", async () => {
    const schema = JSON.stringify({ type: "object", properties: { observed: { type: "string" } } });
    const spaced = "C:\\a directory with spaces\\.mcp.json";
    const child = defaultSpawner("node", ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", spaced, schema], {
      cwd: process.cwd(),
    });

    const stdout = await new Promise<string>((resolve) => {
      let text = "";
      child.onStdout((chunk) => void (text += chunk));
      child.onExit(() => resolve(text));
      child.stdin.end();
    });

    expect(JSON.parse(stdout)).toEqual([spaced, schema]);
  });
});

describe("the pairing helper", () => {
  const targets = [
    { id: "1", type: "page", url: "chrome-extension://agent/side-panel.html" },
    { id: "2", type: "service_worker", url: "chrome-extension://other/sw.js", webSocketDebuggerUrl: "ws://other" },
    { id: "3", type: "service_worker", url: "chrome-extension://agent/service-worker.js", webSocketDebuggerUrl: "ws://agent" },
  ];

  it("picks the agent build's worker, not another extension's and not a page", () => {
    expect(findWorkerTarget(targets, "agent")?.webSocketDebuggerUrl).toBe("ws://agent");
    expect(findWorkerTarget(targets, "absent")).toBeUndefined();
  });

  it("writes the accepted agent into the durable pairing state, replacing its own earlier entry", () => {
    const expression = buildAcceptExpression({
      agentId: "a-1",
      displayName: "Claude Code (probe)",
      origin: "probe-004",
      acceptedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(expression).toContain('const key = "agentPairings"');
    expect(expression).toContain('"agentId":"a-1"');
    expect(expression).toContain("entry.agentId !== agent.agentId");
    expect(expression).toContain("chrome.storage.local.set");
  });

  /**
   * 004/T129b - the site's mode, written the way the accept is written.
   *
   * Only this one site's entry may change: the store keeps every decided site under one key, so an
   * expression that wrote a fresh object would erase the owner's other decisions to set one of them.
   */
  it("writes one site's mode into the durable site-mode state, keeping the other sites", () => {
    const expression = buildSetSiteModeExpression("https://en.wikipedia.org", "skip-checks");
    expect(expression).toContain('const key = "agentSiteModes"');
    expect(expression).toContain('"https://en.wikipedia.org"');
    expect(expression).toContain('"skip-checks"');
    expect(expression).toContain("...stored");
    expect(expression).toContain("chrome.storage.local.set");
  });

  it("resets to a genuinely empty paired list, not to a missing key", () => {
    expect(buildResetExpression()).toContain("agentPairings: { paired: [] }");
  });
});

/**
 * 004/T117b - SC-036 as a verdict the harness reaches.
 *
 * The standard is containment, not a ratio: every heading and link the page's own tree names has to
 * be in the **full** read, every control it names in the **default** read. The two reads are judged
 * apart because they answer different questions - "did you return the page" and "did you return
 * what can be acted on" - and a ratio against a tree full of generic containers measured neither.
 */
describe("containment against the browser's own tree", () => {
  const tree = {
    url: "https://example.com/",
    nodeCount: 6,
    frameCount: 1,
    sampleNames: [],
    named: { headings: ["Overview", "Evidence"], links: ["Docs"], controls: ["Share", "Search"] },
  };

  it("passes when the full read carries every heading, link and control (SC-036 Amendment 2)", () => {
    const outcome = judgeContainment(tree, {
      scenario: "s3-tree",
      steps: [],
      observed: "read",
      fullRead: ["Overview", "Evidence", "Docs", "Share", "Search", "a paragraph"],
    });
    expect(outcome.verdict).toBe("pass");
    expect(outcome.detail).toContain("headings+links 3/3");
    expect(outcome.detail).toContain("controls 2/2");
  });

  it("names what was missing from the full read, headings/links and controls apart", () => {
    const outcome = judgeContainment(tree, {
      scenario: "s3-tree",
      steps: [],
      observed: "read",
      fullRead: ["Overview", "Docs", "Share"],
    });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain('full read missing (headings/links) "Evidence"');
    expect(outcome.detail).toContain('full read missing (controls) "Search"');
  });

  // A name is matched on its text, not its spacing: the page's tree and the read reach the same
  // string through different renderers, and "Share  " vs "Share" is not a missed node.
  it("matches names by their text, ignoring case and surrounding space", () => {
    expect(
      judgeContainment(tree, {
        scenario: "s3-tree",
        steps: [],
        observed: "read",
        fullRead: [" overview ", "EVIDENCE", "Docs", "share", "search"],
      }).verdict,
    ).toBe("pass");
  });

  /**
   * 004/T129a - a name may not match or miss on a glyph.
   *
   * The extension names this control with a trailing private-use icon character where the browser's
   * tree does not. The 2026-09-09 run scored 4 of 4 only because the agent silently transcribed the
   * visible text without it; raw containment was 3 of 4. A check whose answer depends on what an
   * agent chose to copy is not a check, so both sides are reduced to their text first.
   */
  it("matches a name whose sides differ only by a private-use or formatting character", () => {
    const outcome = judgeContainment(
      { ...tree, named: { headings: [], links: [], controls: ["Copy", "Open in new tab"] } },
      {
        scenario: "s3-tree",
        steps: [],
        observed: "read",
        fullRead: ["Copy\uf0c5", "Open\u200d in\u2007new\ufeff tab"],
      },
    );
    expect(outcome.verdict).toBe("pass");
    expect(outcome.detail).toContain("controls 2/2");
  });

  // Silence is not containment: an answer with no lists would otherwise contain everything of
  // nothing and pass, which is the failure mode this whole task exists to remove.
  it("fails an answer that reported no full read at all, saying so", () => {
    const outcome = judgeContainment(tree, { scenario: "s3-tree", steps: [], observed: "read" });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain("reported no full read");
  });

  it("fails, naming the page, when no browser tree was captured to compare against", () => {
    const outcome = judgeContainment(undefined, { scenario: "s3-tree", steps: [], observed: "read", fullRead: [] });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain("no browser tree");
  });
});

/**
 * 004/T137 - the cheaper question: ask which of a short list of names is missing, not for a
 * transcript. `s5-github-capacity` moved to this shape because transcription produced a false answer
 * ("21 missing" when the truth was 7); `s3-artifact-frame` has not moved and keeps the block above.
 */
describe("candidate names for a tree-containment prompt (T137)", () => {
  it("combines the page's own headings, links and controls with the two decoys, once each", () => {
    const before = {
      url: "https://example.com/",
      nodeCount: 3,
      frameCount: 1,
      sampleNames: [],
      named: { headings: ["Overview"], links: ["Docs"], controls: ["Share"] },
    };
    expect(buildCandidateNames(before)).toEqual(["Overview", "Docs", "Share", ...CONTAINMENT_DECOYS]);
  });
});

/**
 * 004/T137 - the judge's new shape, and the trap the brief names.
 *
 * The prompt's genuine names come from a capture taken *before* the session runs; the truth this
 * judges against is `after`, captured once the session is done (T117b's reasoning, unchanged). A name
 * the page loses in between would make an agent that correctly reports it absent read as wrong - so
 * only a name **both** captures agree on is judged. The decoys carry no such caveat: neither capture
 * ever has them, so the rule is unconditional - both must be in `notFound`, always.
 */
describe("containment via notFound, judged against both captures (T137)", () => {
  const before = {
    url: "https://example.com/",
    nodeCount: 8,
    frameCount: 1,
    sampleNames: [],
    // "Gone Tomorrow" is on the page when the prompt is built...
    named: { headings: ["Overview", "Evidence"], links: ["Docs", "Gone Tomorrow"], controls: ["Share"] },
  };
  const after = {
    url: "https://example.com/",
    nodeCount: 7,
    frameCount: 1,
    sampleNames: [],
    // ...and gone by the time the judge reads the page again.
    named: { headings: ["Overview", "Evidence"], links: ["Docs"], controls: ["Share"] },
  };
  const decoys = ["Quazzleworth Compliance Ledger", "Effendorf Diagnostic Toggle 9042"];

  it("passes when every genuine name is reported found and both decoys are reported not found", () => {
    const outcome = judgeContainment(after, { scenario: "s5-tree", steps: [], observed: "read", notFound: [...decoys] }, before, decoys);
    expect(outcome.verdict).toBe("pass");
    expect(outcome.detail).toContain("genuine names 4/4 reported found");
    expect(outcome.detail).toContain("decoys 2/2 correctly reported not found");
  });

  it("fails a genuine name the agent wrongly reported as not found", () => {
    const outcome = judgeContainment(
      after,
      { scenario: "s5-tree", steps: [], observed: "read", notFound: ["Evidence", ...decoys] },
      before,
      decoys,
    );
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain('wrongly reported not found "Evidence"');
  });

  it("the decoy rule: fails when a decoy is missing from notFound - an answer that never really looked", () => {
    const outcome = judgeContainment(after, { scenario: "s5-tree", steps: [], observed: "read", notFound: [decoys[0]!] }, before, decoys);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain(`decoys missing from notFound "${decoys[1]}"`);
  });

  it("the two-captures trap: a name present before but gone after decides nothing, pass or fail", () => {
    const outcome = judgeContainment(
      after,
      { scenario: "s5-tree", steps: [], observed: "read", notFound: ["Gone Tomorrow", ...decoys] },
      before,
      decoys,
    );
    expect(outcome.verdict).toBe("pass");
  });

  it("fails, naming the reason, when no capture was taken before the run", () => {
    const outcome = judgeContainment(after, { scenario: "s5-tree", steps: [], observed: "read", notFound: [] }, undefined, decoys);
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain("no browser tree was captured before the run");
  });
});

describe("the browser-tree baseline", () => {
  it("counts only the nodes the browser exposes, and the frames they came from", () => {
    const summary = summariseAxTree("https://example.com/", {
      nodes: [
        { nodeId: "1", frameId: "f1", role: { value: "RootWebArea" }, name: { value: "Root" } },
        { nodeId: "2", frameId: "f1", role: { value: "button" }, name: { value: "Button" } },
        { nodeId: "3", frameId: "f2", role: { value: "heading" }, name: { value: "Artifact heading" } },
        { nodeId: "4", frameId: "f2", ignored: true, role: { value: "heading" }, name: { value: "hidden" } },
      ],
    });
    expect(summary.nodeCount).toBe(3);
    expect(summary.frameCount).toBe(2);
    expect(summary.sampleNames).toEqual(["Root", "Button", "Artifact heading"]);
  });

  // T117b: the same read now also says *what* the page names, bucketed the way SC-036 judges it -
  // an ignored node is not part of the page, so its heading is not something a read must carry.
  it("buckets the page's own names into the headings, links and controls SC-036 compares", () => {
    const summary = summariseAxTree("https://example.com/", {
      nodes: [
        { nodeId: "1", role: { value: "heading" }, name: { value: "Overview" } },
        { nodeId: "2", role: { value: "link" }, name: { value: "Docs" } },
        { nodeId: "3", role: { value: "button" }, name: { value: "Share" } },
        { nodeId: "4", role: { value: "textbox" }, name: { value: "Search" } },
        { nodeId: "5", role: { value: "generic" }, name: { value: "container" } },
        { nodeId: "6", role: { value: "heading" }, name: { value: "  " } },
        { nodeId: "7", ignored: true, role: { value: "link" }, name: { value: "hidden link" } },
        { nodeId: "8", role: { value: "link" }, name: { value: "Docs" } },
      ],
    });
    expect(summary.named).toEqual({ headings: ["Overview"], links: ["Docs"], controls: ["Share", "Search"] });
  });

  it("reports an empty page as empty rather than as one phantom frame", () => {
    expect(summariseAxTree("about:blank", { nodes: [] })).toMatchObject({ nodeCount: 0, frameCount: 0 });
  });

  /**
   * 004/T129a - the baseline has to reach the frames the page really shows.
   *
   * The 2026-09-09 run of `s3-artifact-frame` judged containment 0 of 0 headings and links and
   * called it a pass: the artifact renders in a cross-origin frame, which is a target of its own,
   * and the query on the page's target cannot see into it. A baseline that names nothing contains
   * nothing, and containment of nothing holds - the vacuous pass this check exists to prevent.
   */
  it("reads each cross-origin frame's own target and merges it into the page's baseline", async () => {
    const targets = [
      { id: "page", type: "page", url: "https://claude.ai/code/artifact/x", webSocketDebuggerUrl: "ws://page" },
      { id: "frame", type: "iframe", parentId: "page", url: "https://artifacts.test/a", webSocketDebuggerUrl: "ws://frame" },
      { id: "other", type: "iframe", parentId: "elsewhere", url: "https://ads.test/a", webSocketDebuggerUrl: "ws://other" },
    ];
    const trees: Record<string, unknown> = {
      "ws://page": { nodes: [{ nodeId: "1", frameId: "f1", role: { value: "RootWebArea" }, name: { value: "Artifact host" } }] },
      "ws://frame": {
        nodes: [
          { nodeId: "2", frameId: "f2", role: { value: "heading" }, name: { value: "Gap inventory" } },
          { nodeId: "3", frameId: "f2", role: { value: "link" }, name: { value: "SC-033" } },
        ],
      },
      "ws://other": { nodes: [{ nodeId: "9", frameId: "f9", role: { value: "heading" }, name: { value: "Another page" } }] },
    };
    const asked: string[] = [];

    const baseline = await readPageTreeBaseline(
      {
        endpoint: "http://127.0.0.1:9222",
        fetch: async () => ({ ok: true, json: async () => targets }),
        send: async (socketUrl, method) => {
          if (method === "Accessibility.getFullAXTree") {
            asked.push(socketUrl);
            return trees[socketUrl];
          }
          return {};
        },
      },
      "https://claude.ai/code/artifact/x",
    );

    expect(asked).toEqual(["ws://page", "ws://frame"]);
    expect(baseline?.named.headings).toEqual(["Gap inventory"]);
    expect(baseline?.named.links).toEqual(["SC-033"]);
    expect(baseline?.nodeCount).toBe(3);
    expect(baseline?.frameCount).toBe(2);
  });

  it("takes the frames that hang off this page, not every frame in the browser", () => {
    const targets = [
      { id: "page", type: "page", url: "https://claude.ai/x" },
      { id: "frame", type: "iframe", parentId: "page", url: "https://artifacts.test/a" },
      { id: "nested", type: "iframe", parentId: "frame", url: "https://artifacts.test/b" },
      { id: "other", type: "iframe", parentId: "another-page", url: "https://ads.test/a" },
      { id: "another-page", type: "page", url: "https://elsewhere.test/" },
    ];
    expect(frameTargetsOf(targets, "page").map((entry) => entry.id)).toEqual(["frame", "nested"]);
  });

  it("matches a page target by prefix, because pages redirect under us", () => {
    const list = [
      { id: "1", type: "service_worker", url: "chrome-extension://a/sw.js" },
      { id: "2", type: "page", url: "https://example.com/landing?x=1" },
    ];
    expect(findPageTarget(list, "https://example.com/")?.id).toBe("2");
    expect(findPageTarget(list, "https://other.test/")).toBeUndefined();
  });
});
