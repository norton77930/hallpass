/**
 * Issue #17 research probe - `npm run probe:017` (or `-- --agent codex --agent hermes`).
 *
 * For each side-panel agent: the launch a strict side-panel conversation would get (the host's own
 * launcher, so the same installed connector or program), in a fresh empty folder, with no MCP server -
 * so no browser access - and one prompt asking it to put a two-choice question to the user (`probe.ts`).
 * Each agent costs one model call. Nothing the agent asks is allowed. The report goes to
 * `tests/acceptance/probe-017/reports/` (git-ignored, never published): a summary table and every
 * agent's recorded events.
 *
 * Needs a build (`npm run build`): it loads the host's `dist/` modules. Like probe-004 it loads its
 * sibling `.ts` and those modules through URLs built at run time, which `--experimental-strip-types`
 * follows and TypeScript does not try to resolve.
 *
 * Exit codes: 0 ran (whatever the agents did), 2 refused before any agent started.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENTS = ["claude-code", "codex", "hermes", "deepseek"] as const;
type Agent = (typeof AGENTS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DIST = join(ROOT, "packages", "agent-host", "dist");

const load = async (path: string): Promise<Record<string, any>> => import(pathToFileURL(path).href) as Promise<Record<string, any>>;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { agent: { type: "string", multiple: true }, bound: { type: "string" } }, allowPositionals: false });
  const agents = (values.agent ?? [...AGENTS]) as string[];
  const unknown = agents.filter((agent) => !(AGENTS as readonly string[]).includes(agent));
  if (unknown.length > 0) {
    process.stderr.write(`probe-017: unknown agent ${unknown.join(", ")}; choose from ${AGENTS.join(", ")}\n`);
    return 2;
  }
  if (!existsSync(join(DIST, "broker", "commands.js"))) {
    process.stderr.write("probe-017: no host build - run `npm run build` first.\n");
    return 2;
  }
  const boundMs = Number(values.bound ?? "180") * 1000;

  const probe = await load(join(HERE, "probe.ts"));
  const { createAgentLauncher } = await load(join(DIST, "broker", "commands.js"));
  const { defaultAgentPorts } = await load(join(DIST, "broker", "agents.js"));
  const { spawnAgentProcess, MODE_ALLOW_LIST } = await load(join(DIST, "broker", "conversation.js"));
  const { killTreeAsync } = await load(join(DIST, "broker", "run-command.js"));
  const launcher = createAgentLauncher({ ports: defaultAgentPorts(join(DIST, "codex-app-server-shim.js")) });

  process.stdout.write(`probe-017: ${agents.length} agent(s), one model call each, up to ${boundMs / 1000} s each.\n`);
  const results: Array<{ agent: Agent; record: Record<string, any> }> = [];
  for (const agent of agents as Agent[]) {
    process.stdout.write(`  ${agent} ... `);
    const launch = await launcher.resolveLaunch(agent, "strict");
    if (!launch.ok) {
      const record = { started: false, capabilities: [], events: [], error: `${launch.error.code}: ${launch.error.detail}`, durationMs: 0 };
      results.push({ agent, record });
      process.stdout.write(`not started (${launch.error.code})\n`);
      continue;
    }
    const cwd = await mkdtemp(join(tmpdir(), `hallpass-probe-017-${agent}-`));
    const child = spawnAgentProcess(launch.spec, cwd);
    try {
      const modeId: string | undefined = MODE_ALLOW_LIST[agent]?.strict;
      const record = await probe.probeQuestions({ child, cwd, boundMs, ...(modeId === undefined ? {} : { modeId }) });
      results.push({ agent, record });
      process.stdout.write(`${probe.summarize(record)}\n`);
    } finally {
      await killTreeAsync(child.pid).catch(() => false);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const reports = join(HERE, "reports");
  await mkdir(reports, { recursive: true });
  const lines = [
    `# Probe 017 - how each agent asks the user a question (${new Date().toISOString()})`,
    "",
    `Prompt: ${probe.QUESTION_PROMPT}`,
    "",
    "| Agent | Result |",
    "| --- | --- |",
    ...results.map(({ agent, record }) => `| ${agent} | ${probe.summarize(record).replace(/\|/gu, "\\|")} |`),
    "",
    ...results.flatMap(({ agent, record }) => [`## ${agent}`, "", "```json", JSON.stringify(record, null, 2), "```", ""]),
  ];
  const file = join(reports, `probe-017-${stamp}.md`);
  await writeFile(file, lines.join("\n"), "utf8");
  process.stdout.write(`probe-017: report written to ${file}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`probe-017: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
