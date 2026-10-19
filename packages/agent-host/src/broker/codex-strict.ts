/**
 * Codex strict mode through Hallpass's own app-server shim (019 D-019-12, R-317; SC-135, SC-136).
 *
 * The panel's strict mode is the Codex adapter's `read-only` mode (`MODE_ALLOW_LIST`), but that mode
 * sends `approvalPolicy: "on-request"`, `approvalsReviewer: "user"` and a `workspaceWrite` sandbox
 * with the conversation folder writable on every `turn/start` to `codex app-server` - and per-turn
 * values beat any config override. Measured with codex-cli 0.163.0 and codex-acp 1.13.1: Codex wrote
 * files and ran changing commands in its folder without a single permission request, 10 runs of 10.
 *
 * So the broker puts a shim between the adapter and the real CLI: the adapter starts
 * `"<CODEX_PATH>" app-server` through cmd.exe, `CODEX_PATH` is the command file below, and the file
 * runs `codex-app-server-shim.js` under the broker's node with the real CLI as its first argument.
 * The shim relays stdio unchanged except one rewrite on the adapter -> server direction, and it fails
 * closed: every `turn/start` that carries a policy field gets a `readOnly` sandbox with no network
 * (and the owner as reviewer), so every write and every changing command has to be asked for, and
 * the adapter turns that request into the owner's card - unless the turn is exactly the agent mode's
 * tuple (on-request, reviewer `auto_review`, a `workspaceWrite` sandbox). An adapter that changed
 * its signature is therefore strict, never writable; title turns (no policy field) and everything
 * else pass byte for byte. Which tuple is the agent mode's is a measurement of codex-acp 1.13.1
 * (T573), so a launch checks the installed adapter still has it (`codexAdapterModesAsMeasured`).
 *
 * The shim's child stays in the broker's kill-on-close job (job.ts): nothing here breaks away.
 */

/** What the strict turn's sandbox becomes. */
export const CODEX_STRICT_SANDBOX_POLICY: Readonly<{ type: "readOnly"; networkAccess: false }> = Object.freeze({
  type: "readOnly",
  networkAccess: false,
});

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The policy fields of a `turn/start`; a turn with none of them (a title turn) is left alone. */
const POLICY_FIELDS = ["approvalPolicy", "approvalsReviewer", "sandboxPolicy"] as const;

/** The agent mode's turn as codex-acp 1.13.1 sends it (T573): the one policy the shim spares. */
function isAgentModeTurn(params: Json): boolean {
  return (
    params.approvalPolicy === "on-request" &&
    params.approvalsReviewer === "auto_review" &&
    isObject(params.sandboxPolicy) &&
    params.sandboxPolicy.type === "workspaceWrite"
  );
}

/**
 * One newline-framed JSON-RPC line from the adapter. A `turn/start` with a policy field that is not
 * exactly the agent mode's gets the read-only sandbox, and a reviewer other than the owner becomes the
 * owner. Anything else - another method, the agent mode's turn, a title turn, a response, a line that
 * does not parse - comes back as the very same string.
 */
export function rewriteStrictTurnStart(line: string): string {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(message) || message.method !== "turn/start" || !isObject(message.params)) return line;
  const params = message.params;
  if (!POLICY_FIELDS.some((field) => field in params) || isAgentModeTurn(params)) return line;
  params.sandboxPolicy = { ...CODEX_STRICT_SANDBOX_POLICY };
  if ("approvalsReviewer" in params && params.approvalsReviewer !== "user") params.approvalsReviewer = "user";
  return JSON.stringify(message);
}

/**
 * The installed adapter's modes as T573 measured them (codex-acp 1.13.1): `read-only` is on-request +
 * reviewer `user` + `workspaceWrite`, `agent` is on-request + reviewer `auto_review` +
 * `workspaceWrite`. The shim spares the second tuple, so an adapter whose strict mode had become it
 * would run strict turns writable. Read from the adapter's code (its mode table), tolerant of
 * spacing and quoting; anything else - a reworded table, another layout - is "not as measured", and
 * the broker refuses to start Codex rather than guess. A new adapter version means measuring again.
 */
const MEASURED_CODEX_MODES: readonly RegExp[] = [
  /"read-only",[^;]{0,300}?"on-request",\s*"user",\s*\{\s*"?type"?\s*:\s*"workspaceWrite"/u,
  /"agent",[^;]{0,300}?"on-request",\s*"auto_review",\s*\{\s*"?type"?\s*:\s*"workspaceWrite"/u,
];

export function codexAdapterModesAsMeasured(adapterCode: string): boolean {
  return MEASURED_CODEX_MODES.every((pattern) => pattern.test(adapterCode));
}

export type LineRewriter = {
  /** The bytes to forward now: every line this chunk completed, rewritten or as received. */
  push(chunk: Buffer): Buffer;
  /** The unterminated rest, as received, once the input has ended. */
  flush(): Buffer;
};

const NEWLINE = 0x0a;

/**
 * Split a byte stream on `\n` and pass each line through `rewrite`. A line `rewrite` returns
 * unchanged is forwarded as the original bytes (a `\r`, an invalid UTF-8 sequence and all), so only a
 * rewritten line ever differs from what came in.
 */
export function createLineRewriter(rewrite: (line: string) => string): LineRewriter {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const out: Buffer[] = [];
      let start = 0;
      for (let end = buffer.indexOf(NEWLINE, start); end !== -1; end = buffer.indexOf(NEWLINE, start)) {
        const raw = buffer.subarray(start, end);
        const text = raw.toString("utf8");
        const rewritten = rewrite(text);
        out.push(rewritten === text ? buffer.subarray(start, end + 1) : Buffer.from(`${rewritten}\n`, "utf8"));
        start = end + 1;
      }
      pending = Buffer.from(buffer.subarray(start));
      return out.length === 1 ? out[0]! : Buffer.concat(out);
    },
    flush() {
      const rest = pending;
      pending = Buffer.alloc(0);
      return rest;
    },
  };
}

/**
 * How long the real CLI gets to leave once the adapter has closed the shim's input; then the shim ends
 * it and what it started, so a CLI that ignores the end of its input does not outlive the adapter.
 */
export const CODEX_SHIM_EXIT_BOUND_MS = 5_000;

/** The environment variables the command file reads the three paths from. */
export const CODEX_SHIM_ENV = Object.freeze({
  node: "HALLPASS_CODEX_NODE",
  shim: "HALLPASS_CODEX_SHIM",
  cli: "HALLPASS_CODEX_CLI",
} as const);

/**
 * `CODEX_PATH`'s command file: the broker's node on the shim, the real CLI, then the adapter's own
 * arguments (`app-server`). The paths come from the environment rather than being written into the
 * file, because cmd.exe reads a batch file in the console code page: a profile path with non-ASCII
 * letters, written as UTF-8, reaches node mangled (measured under code page 950). Expanded
 * variables are not parsed again, so a `&`, `^`, `%` or space in a path stays literal inside the
 * quotes, and delayed expansion is off so a `!` does too. Pure ASCII, the same on every machine.
 */
export const CODEX_SHIM_COMMAND =
  "@echo off\r\nsetlocal DisableDelayedExpansion\r\n" +
  `"%${CODEX_SHIM_ENV.node}%" "%${CODEX_SHIM_ENV.shim}%" "%${CODEX_SHIM_ENV.cli}%" %*\r\n`;

/**
 * The real CLI's environment: the shim's own three variables and the adapter's `CODEX_PATH` (this
 * shim's command file, meaningless to the CLI and to anything it starts) removed, everything else kept.
 */
export function shimChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set<string>([...Object.values(CODEX_SHIM_ENV), "CODEX_PATH"]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name.toUpperCase())));
}

const UNSAFE_FOR_CMD = /["%\r\n\0]/u;

/**
 * How the shim starts the real CLI. `codex.cmd` is a batch file, which Node only starts through a
 * shell: `cmd.exe /d /s /c "<cli> <args>"` with verbatim arguments, as `run-command.ts` does - and
 * for the same reason a quote, a percent sign or a line break is refused rather than escaped.
 */
export function realCliSpawn(
  cli: string,
  args: readonly string[],
  comspec: string,
): { command: string; args: string[]; verbatim: boolean } {
  if (!cli) throw new Error("no Codex CLI was given to the app-server shim");
  if (!/\.(cmd|bat)$/iu.test(cli)) return { command: cli, args: [...args], verbatim: false };
  if ([cli, ...args].some((part) => UNSAFE_FOR_CMD.test(part))) {
    throw new Error("refusing to pass a quote, percent sign or line break to cmd.exe");
  }
  const quote = (part: string) => (/[\s&|<>^()]/u.test(part) ? `"${part}"` : part);
  return { command: comspec, args: ["/d", "/s", "/c", `""${cli}" ${args.map(quote).join(" ")}"`], verbatim: true };
}
