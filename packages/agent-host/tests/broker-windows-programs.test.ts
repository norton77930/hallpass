import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { killTree, TASKKILL } from "../src/broker/run-command.js";
import { FOLDER_DIALOG_COMMAND } from "../src/broker/folders.js";
import { EXPLORER_EXE, taskKillCommand, WHERE_EXE, WINDOWS_POWERSHELL } from "../src/broker/windows-programs.js";

/**
 * Security review 2026-11-05 S7 — a Windows program the broker starts is named by its absolute path.
 *
 * Node looks a bare name up in the child's working directory first, and the Codex shim ends the
 * CLI's tree from inside the conversation's folder, which the owner's agent writes into. A
 * `taskkill.exe` dropped there would run as the user without any card. `killTreeAsync` already used
 * the System32 path; `killTree` - the shim's and `cancelStart`'s - used the bare name.
 */
describe("S7 Windows programs are run by absolute path", () => {
  it("names taskkill, where, explorer and PowerShell under %SystemRoot%", () => {
    for (const program of [TASKKILL, WHERE_EXE, EXPLORER_EXE, WINDOWS_POWERSHELL, FOLDER_DIALOG_COMMAND]) {
      expect(win32.isAbsolute(program), program).toBe(true);
      expect(program.toLowerCase()).toContain("\\windows\\");
    }
    expect(taskKillCommand(4_000_123)).toEqual({ file: TASKKILL, args: ["/pid", "4000123", "/T", "/F"] });
  });

  it.runIf(process.platform === "win32")("killTree runs taskkill by its System32 path", () => {
    const seen: Array<{ file: string; args: readonly string[] }> = [];
    killTree(4_000_123, { spawnSync: (file, args) => void seen.push({ file, args }) });
    expect(seen).toEqual([{ file: TASKKILL, args: ["/pid", "4000123", "/T", "/F"] }]);
  });

  it("no broker source spawns a system program by its bare name", () => {
    const sources = ["run-command.ts", "folders.ts", "agents.ts", "user-environment.ts"].map((name) =>
      readFileSync(fileURLToPath(new URL(`../src/broker/${name}`, import.meta.url)), "utf8"),
    );
    for (const source of sources) {
      // A string literal naming the program is the bare form; the path form reaches it through
      // `windows-programs.ts`, whose constants carry no quotes at the call site.
      expect(source).not.toMatch(/["'](?:taskkill|where\.exe|explorer\.exe|powershell\.exe)["']/u);
    }
  });
});
