import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { z } from "zod";
import { CONVERSATION_AGENTS, type ConversationAgent } from "@hallpass/contracts";
import { AGENT_DESCRIPTIONS, LAUNCH_EXEC_BOUND_MS, type AgentPorts, type ExecResult } from "./agents.js";
import { runCommand } from "./run-command.js";

/**
 * 024 T791: the made-up machine of `HALLPASS_BROKER_TEST_MACHINE` (`test-mode.ts`), honoured only under
 * `HALLPASS_TEST_MODE=1` with the test agent. The settings page's gate needs each agent in a state of
 * its choosing - ready, needing its helper, a version problem, Hermes without its MCP component, a
 * `--version` that never answers - and the broker's own readiness check (`checkAgentReadiness`) to be
 * what says so. So only "the machine" is made up, at the `AgentPorts` seam every machine fact already
 * goes through:
 *
 * - `where.exe <program>` finds an agent's program exactly when the file lists the agent, at a path in
 *   the data folder (`testMachineCliPath`) - never the owner's real one, nor any known location;
 * - that program's `--version` prints the entry's `version`, or never answers (`hang`, until the
 *   check's bound ends it), or is the entry's `program` argv really run with its `env`;
 * - Hermes' MCP component is there when the entry says `mcpComponent`, Git Bash when `gitBash` (default
 *   true) says so;
 * - everything inside the data folder is the real file system: whether an adapter or DeepSeek is
 *   downloaded is what the data folder holds, so a (fake) install changes it as a real one would.
 *
 * The file is read at every check, so a gate can change the machine between steps. A file that is
 * missing or does not match the schema is no machine: the broker answers as it did without one.
 */

const agentEntrySchema = z.strictObject({
  /** What `--version` prints; absent with no `program`, it prints nothing (a version problem). */
  version: z.string().max(200).optional(),
  /** `--version` never answers: the readiness check's bound is what ends it. */
  hang: z.boolean().optional(),
  /** Run for `--version` instead (the arguments follow it), with `env` added to the broker's own. */
  program: z.array(z.string().min(1).max(1_000)).min(1).max(20).optional(),
  env: z.record(z.string().min(1).max(100), z.string().max(1_000)).optional(),
  /** Hermes' optional MCP component (its browser tools' client) is installed. */
  mcpComponent: z.boolean().optional(),
});

const machineSchema = z.strictObject({
  /** Git Bash is on this machine (Hermes' command tool needs it). Default true. */
  gitBash: z.boolean().optional(),
  /** The agents whose program is on this machine; one not listed is not installed. */
  agents: z.strictObject(Object.fromEntries(CONVERSATION_AGENTS.map((agent) => [agent, agentEntrySchema.optional()])) as Record<
    ConversationAgent,
    z.ZodOptional<typeof agentEntrySchema>
  >),
});

export type TestMachineAgent = z.infer<typeof agentEntrySchema>;
export type TestMachine = { gitBash?: boolean; agents: Partial<Record<ConversationAgent, TestMachineAgent>> };

/** The machine file, or undefined when it is missing, unreadable or not one. */
export async function readTestMachine(path: string): Promise<TestMachine | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = machineSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as TestMachine) : undefined;
  } catch {
    return undefined;
  }
}

/** Where the made-up machine says an agent's program is: inside the data folder, under the program's own file name. */
export function testMachineCliPath(dataDir: string, agent: ConversationAgent): string {
  const description = AGENT_DESCRIPTIONS[agent];
  return win32.join(dataDir, "test-machine", agent, description.kind === "fetched" ? `${agent}.exe` : description.cliFile);
}

/**
 * The environment the readiness check reads Hermes' home from: one inside the data folder that holds
 * nothing, so no settings file of the owner's (or of an earlier run) names a key variable.
 */
export function testMachineReadinessEnv(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): Record<string, string | undefined> {
  return { ...env, HERMES_HOME: win32.join(dataDir, "test-machine", "hermes-home") };
}

/** Same path, whatever its case or `..` segments. */
const key = (path: string): string => win32.resolve(path).toLowerCase();

/** Hermes' MCP component as `agents.ts` looks for it beside the program (`..\Lib\site-packages\mcp\__init__.py`). */
const mcpComponentPath = (cliPath: string): string => win32.join(win32.dirname(cliPath), "..", "Lib", "site-packages", "mcp", "__init__.py");

/**
 * A `--version` that never answers: settles only at the bound it was given, as `runCommand` ends a
 * hung program - or at once when `signal` is aborted (024 R-374: a superseded readiness retry).
 */
const hung = (timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> =>
  new Promise((done) => {
    const timer = setTimeout(() => done({ code: null, stdout: "", stderr: "", timedOut: true }), timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      done({ code: null, stdout: "", stderr: "", timedOut: false });
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });

/** `ports` on the made-up `machine`; inside `ports.dataDir` the file system stays the real one. */
export function testMachinePorts(ports: AgentPorts, machine: TestMachine, run: typeof runCommand = runCommand): AgentPorts {
  const dataKey = `${key(ports.dataDir)}\\`;
  const gitBash = win32.join(ports.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  const programs = new Map<string, { agent: ConversationAgent; entry: TestMachineAgent }>();
  const present = new Map<string, boolean>([[key(gitBash), machine.gitBash ?? true]]);
  for (const agent of CONVERSATION_AGENTS) {
    const entry = machine.agents[agent];
    if (entry === undefined || AGENT_DESCRIPTIONS[agent].kind === "fetched") continue;
    const cliPath = testMachineCliPath(ports.dataDir, agent);
    programs.set(key(cliPath), { agent, entry });
    present.set(key(cliPath), true);
    present.set(key(mcpComponentPath(cliPath)), entry.mcpComponent === true);
  }
  const notFound: ExecResult = { code: 1, stdout: "", stderr: "INFO: Could not find files for the given pattern(s).\r\n" };

  return {
    ...ports,
    fs: {
      ...ports.fs,
      exists: async (path) => {
        const known = present.get(key(path));
        if (known !== undefined) return known;
        // The pinned packages and every other host file: the real data folder. Anything else is not on this machine.
        return key(path).startsWith(dataKey) ? ports.fs.exists(path) : false;
      },
    },
    exec: async (file, args, options) => {
      const timeoutMs = options?.timeoutMs ?? LAUNCH_EXEC_BOUND_MS;
      const signal = options?.signal;
      if (/^where(?:\.exe)?$/iu.test(file)) {
        const name = args[0] ?? "";
        if (name.toLowerCase() === "bash") return machine.gitBash === false ? notFound : { code: 0, stdout: `${gitBash}\r\n`, stderr: "" };
        for (const { agent } of programs.values()) {
          const description = AGENT_DESCRIPTIONS[agent];
          if (description.kind !== "fetched" && description.cliFile.toLowerCase() === name.toLowerCase()) {
            return { code: 0, stdout: `${testMachineCliPath(ports.dataDir, agent)}\r\n`, stderr: "" };
          }
        }
        return notFound;
      }
      const program = programs.get(key(file));
      if (program === undefined) return { code: null, stdout: "", stderr: "not on the test machine" };
      const { entry } = program;
      if (entry.program !== undefined) {
        const [command, ...rest] = entry.program;
        const result = await run(command!, [...rest, ...args], {
          timeoutMs,
          env: { ...process.env, ...(entry.env ?? {}) },
          ...(signal === undefined ? {} : { signal }),
        });
        return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
      }
      if (entry.hang === true) return hung(timeoutMs, signal);
      return { code: 0, stdout: entry.version === undefined ? "" : `${entry.version}\r\n`, stderr: "" };
    },
  };
}
