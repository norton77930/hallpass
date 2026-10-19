import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 019/T524 — the broker's kill-on-close job (R-313).
 *
 * Run in a child process, never in the test runner: assigning the runner to a kill-on-close job
 * would tie every process the suite starts to the runner's exit. The child joins the job, spawns a
 * grandchild the way the broker spawns an agent, and reports membership as Windows sees it
 * (`IsProcessInJob`). That a hard kill of the job's holder ends the tree is T522 (b).
 */

const JOB_MODULE = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "broker", "job.js")).href;

describe.runIf(process.platform === "win32")("T524 broker job", () => {
  it("puts the broker and a child it spawns afterwards in one job, and nothing else", async () => {
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { createKillOnCloseJob } from ${JSON.stringify(JOB_MODULE)};`,
      `const job = createKillOnCloseJob();`,
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `await new Promise((done) => child.once("spawn", done));`,
      `const report = { self: job.contains(process.pid), child: job.contains(child.pid), outsider: job.contains(${process.pid}) };`,
      `child.kill();`,
      `process.stdout.write(JSON.stringify(report));`,
    ].join("\n");
    const holder = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    holder.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    holder.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const code = await new Promise<number | null>((done) => holder.once("exit", done));

    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ self: true, child: true, outsider: false });
  }, 20_000);
});
