import { describe, expect, it } from "vitest";
import {
  CODEX_SHIM_COMMAND,
  CODEX_SHIM_ENV,
  CODEX_STRICT_SANDBOX_POLICY,
  codexAdapterModesAsMeasured,
  createLineRewriter,
  realCliSpawn,
  rewriteStrictTurnStart,
  shimChildEnvironment,
} from "../src/broker/codex-strict.js";

/**
 * 019 D-019-12 / R-317 / SC-135 - Codex strict mode through Hallpass's app-server shim.
 *
 * The Codex adapter's `read-only` mode sends `on-request` + reviewer `user` + a `workspaceWrite`
 * sandbox on every `turn/start`, so Codex wrote in its folder without a card (measured with
 * codex-cli 0.163.0 / codex-acp 1.13.1). The shim between the adapter and `codex app-server`
 * swaps exactly that signature's sandbox for `readOnly`; everything else passes unchanged.
 */

/** The adapter's `read-only` turn, as its JSON-RPC log shows it (spike, 2026-10-19). */
const strictTurn = (extra: Record<string, unknown> = {}) => ({
  id: 10,
  method: "turn/start",
  params: {
    threadId: "thread-1",
    input: [{ type: "text", text: "Create x.txt", text_elements: [] }],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    summary: "auto",
    effort: "high",
    model: "some-model",
    serviceTier: null,
    ...extra,
  },
});

describe("rewriteStrictTurnStart (SC-135)", () => {
  it("gives the adapter's read-only turn a readOnly sandbox with no network", () => {
    const out = JSON.parse(rewriteStrictTurnStart(JSON.stringify(strictTurn()))) as ReturnType<typeof strictTurn>;
    expect(out.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(CODEX_STRICT_SANDBOX_POLICY).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("keeps the id, the method and every other param as they were", () => {
    const out = JSON.parse(rewriteStrictTurnStart(JSON.stringify(strictTurn()))) as ReturnType<typeof strictTurn>;
    const { sandboxPolicy: _sandbox, ...rest } = out.params;
    const { sandboxPolicy: _original, ...expected } = strictTurn().params;
    expect(out.id).toBe(10);
    expect(out.method).toBe("turn/start");
    expect(rest).toEqual(expected);
    expect(Object.keys(out.params)).toEqual(Object.keys(strictTurn().params));
  });

  it("leaves exactly the agent mode's turn alone: on-request, reviewer auto_review, a workspaceWrite sandbox", () => {
    const agent = JSON.stringify(strictTurn({ approvalsReviewer: "auto_review" }));
    expect(rewriteStrictTurnStart(agent)).toBe(agent);
  });

  it("fails closed: any other turn that carries policy fields gets the readOnly sandbox and the owner as reviewer", () => {
    // A changed adapter signature must not pass as the agent mode: only that exact tuple is spared.
    const cases: Record<string, unknown>[] = [
      { approvalsReviewer: "agent" },
      { approvalsReviewer: undefined },
      { approvalPolicy: "untrusted" },
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      { approvalsReviewer: "auto_review", sandboxPolicy: { type: "dangerFullAccess" } },
      { approvalsReviewer: "auto_review", approvalPolicy: "never" },
      { sandboxPolicy: { type: "readOnly", networkAccess: true } },
      { sandboxPolicy: undefined },
    ];
    for (const extra of cases) {
      const out = JSON.parse(rewriteStrictTurnStart(JSON.stringify(strictTurn(extra)))) as { params: Record<string, unknown> };
      expect(out.params.sandboxPolicy, JSON.stringify(extra)).toEqual({ type: "readOnly", networkAccess: false });
      if ("approvalsReviewer" in out.params) expect(out.params.approvalsReviewer, JSON.stringify(extra)).toBe("user");
    }
    // One policy field alone is enough to be treated as a policy-carrying turn.
    const lone = JSON.parse(
      rewriteStrictTurnStart(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "t", approvalPolicy: "on-request" } })),
    ) as { params: Record<string, unknown> };
    expect(lone.params).toEqual({ threadId: "t", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  it("leaves a turn without any policy field alone (the adapter's title turns)", () => {
    const bare = JSON.stringify({ id: 12, method: "turn/start", params: { threadId: "t", input: [] } });
    expect(rewriteStrictTurnStart(bare)).toBe(bare);
  });

  it("leaves other methods alone, thread/start included, even with the same params", () => {
    for (const method of ["thread/start", "turn/interrupt", "initialize"]) {
      const line = JSON.stringify({ ...strictTurn(), method });
      expect(rewriteStrictTurnStart(line)).toBe(line);
    }
    const response = JSON.stringify({ id: 4, result: strictTurn().params });
    expect(rewriteStrictTurnStart(response)).toBe(response);
  });

  it("passes a line that is not JSON, or not an object, through unchanged", () => {
    for (const line of ["", "not json", '{"method":"turn/start"', "[1,2]", "null", "  \r"]) {
      expect(rewriteStrictTurnStart(line)).toBe(line);
    }
  });
});

describe("createLineRewriter: newline-framed, byte-faithful", () => {
  const relay = (chunks: Buffer[]): Buffer => {
    const rewriter = createLineRewriter(rewriteStrictTurnStart);
    return Buffer.concat([...chunks.map((chunk) => rewriter.push(chunk)), rewriter.flush()]);
  };

  it("forwards untouched lines byte for byte, across chunk boundaries and split UTF-8", () => {
    const bytes = Buffer.from(`{"id":1,"method":"initialize","params":{"name":"\u6e2c\u8a66"}}\nnot json\r\n\n{"x": 1.50}\npartial`, "utf8");
    // Every split point, including inside the three-byte characters.
    for (let at = 0; at <= bytes.length; at += 1) {
      expect(relay([bytes.subarray(0, at), bytes.subarray(at)]).equals(bytes), `split at ${at}`).toBe(true);
    }
  });

  it("rewrites the strict turn inside a stream and leaves its neighbours as they were", () => {
    const before = '{"id":9,"method":"thread/start","params":{"cwd":"C:\\\\x"}}\n';
    const after =
      '{"id":11,"method":"turn/start","params":{"approvalPolicy":"on-request","approvalsReviewer":"auto_review","sandboxPolicy":{"type":"workspaceWrite"}}}\n';
    const strict = `${JSON.stringify(strictTurn())}\n`;
    const out = relay([Buffer.from(before + strict.slice(0, 40)), Buffer.from(strict.slice(40) + after)]).toString("utf8");
    const lines = out.split("\n");
    expect(lines[0]).toBe(before.trimEnd());
    expect(JSON.parse(lines[1]!).params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(lines[2]).toBe(after.trimEnd());
    expect(lines).toHaveLength(4);
  });

  it("holds nothing back after a complete line, and only the open line until flush", () => {
    const rewriter = createLineRewriter((line) => line);
    expect(rewriter.push(Buffer.from("a\nb")).toString()).toBe("a\n");
    expect(rewriter.push(Buffer.from("c")).toString()).toBe("");
    expect(rewriter.flush().toString()).toBe("bc");
    expect(rewriter.flush().toString()).toBe("");
  });
});

describe("the CODEX_PATH command file", () => {
  it("runs node on the shim with the real CLI and the adapter's arguments, every path quoted", () => {
    // The paths travel in the environment, not in the file: cmd.exe reads a batch file in the
    // console code page, which mangles a non-ASCII profile path written as UTF-8 (measured, cp950).
    const { node, shim, cli } = CODEX_SHIM_ENV;
    expect(CODEX_SHIM_COMMAND).toBe(
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%${node}%" "%${shim}%" "%${cli}%" %*\r\n`,
    );
    expect(CODEX_SHIM_COMMAND).not.toMatch(/[^\x20-\x7e\r\n]/u);
  });

  it("keeps the shim's own variables and CODEX_PATH out of the real CLI's environment", () => {
    const env = {
      PATH: "p",
      [CODEX_SHIM_ENV.node]: "n",
      [CODEX_SHIM_ENV.shim]: "s",
      [CODEX_SHIM_ENV.cli]: "c",
      CODEX_HOME: "h",
      CODEX_PATH: "x\app-server-shim.cmd",
      codex_path: "y",
    };
    expect(shimChildEnvironment(env)).toEqual({ PATH: "p", CODEX_HOME: "h" });
    expect(env[CODEX_SHIM_ENV.cli]).toBe("c");
  });
});

describe("realCliSpawn", () => {
  it("starts a .cmd CLI through cmd.exe with verbatim, quoted arguments", () => {
    const cli = "C:\\Users\\some one\\AppData\\Roaming\\npm\\codex.cmd";
    expect(realCliSpawn(cli, ["app-server"], "C:\\Windows\\system32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${cli}" app-server"`],
      verbatim: true,
    });
  });

  it("starts any other CLI directly", () => {
    expect(realCliSpawn("C:\\tools\\codex.exe", ["app-server"], "cmd.exe")).toEqual({
      command: "C:\\tools\\codex.exe",
      args: ["app-server"],
      verbatim: false,
    });
  });

  it("refuses a quote, percent sign or line break on a cmd.exe line, and an empty CLI", () => {
    expect(() => realCliSpawn("C:\\a%b%\\codex.cmd", ["app-server"], "cmd.exe")).toThrow(/cmd\.exe/);
    expect(() => realCliSpawn("C:\\a\\codex.cmd", ['app"server'], "cmd.exe")).toThrow(/cmd\.exe/);
    expect(() => realCliSpawn("", ["app-server"], "cmd.exe")).toThrow(/CLI/);
  });
});

/**
 * The shim spares exactly the agent mode's tuple, so it is only right while the adapter's modes are
 * the measured ones (T573, codex-acp 1.13.1): `read-only` = on-request + reviewer `user` +
 * `workspaceWrite`, `agent` = on-request + reviewer `auto_review` + `workspaceWrite`. A launch checks
 * the installed adapter's code for both and refuses otherwise. The text below is a stand-in written
 * for this test, laid out the way a bundler prints such a table.
 */
describe("codexAdapterModesAsMeasured", () => {
  const mode = (id: string, policy: string, reviewer: string, sandbox: string) =>
    [
      `  static M = new Mode(`,
      `    "${id}",`,
      `    "Label",`,
      `    "What it does",`,
      `    "kind",`,
      `    "${policy}",`,
      `    "${reviewer}",`,
      `    {`,
      `      type: "${sandbox}",`,
      `      writableRoots: []`,
      `    }`,
      `  );`,
      ``,
    ].join("\n");
  const bundle = (
    readOnly = mode("read-only", "on-request", "user", "workspaceWrite"),
    agent = mode("agent", "on-request", "auto_review", "workspaceWrite"),
  ) => `var x = 1;\nclass Mode {\n${readOnly}${agent}}\n`;

  it("accepts an adapter whose read-only and agent modes are the measured tuples", () => {
    expect(codexAdapterModesAsMeasured(bundle())).toBe(true);
  });

  it("refuses an adapter whose strict mode now looks like the agent mode, or whose modes changed", () => {
    expect(codexAdapterModesAsMeasured(bundle(mode("read-only", "on-request", "auto_review", "workspaceWrite")))).toBe(false);
    expect(codexAdapterModesAsMeasured(bundle(undefined, mode("agent", "never", "auto_review", "workspaceWrite")))).toBe(false);
    expect(codexAdapterModesAsMeasured(bundle(undefined, mode("agent", "on-request", "user", "workspaceWrite")))).toBe(false);
    expect(codexAdapterModesAsMeasured(bundle(mode("read-only", "on-request", "user", "readOnly")))).toBe(false);
    expect(codexAdapterModesAsMeasured(bundle(""))).toBe(false);
    expect(codexAdapterModesAsMeasured("")).toBe(false);
  });
});
