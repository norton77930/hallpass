import { win32 } from "node:path";

/**
 * The Windows programs the broker starts, each by its absolute path (R-369; security review
 * 2026-11-05 S7).
 *
 * Node looks a bare program name up in the child's working directory before `PATH`. The broker's
 * children run in folders the owner's agent writes into - a conversation's project folder, a scratch
 * folder - and the Codex shim ends the CLI's tree from inside one of them. A `taskkill.exe` an agent
 * put there would run instead of the system's, as the user, with no card between an edit and an
 * execution. The same holds, with less exposure, for the broker's own working folder. So every system
 * program is named here by its path under `%SystemRoot%`, and nothing spawns one by its bare name.
 */
const systemRoot = (): string => process.env.SystemRoot ?? "C:\\Windows";

/** `%SystemRoot%\System32\<name>`. */
export const system32 = (name: string): string => win32.join(systemRoot(), "System32", name);

export const TASKKILL = system32("taskkill.exe");
export const WHERE_EXE = system32("where.exe");
export const EXPLORER_EXE = win32.join(systemRoot(), "explorer.exe");
/** Windows PowerShell, which every Windows carries; not `pwsh`, which the owner may not have. */
export const WINDOWS_POWERSHELL = system32(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"));

/** The one `taskkill` line this package ever runs: the process and everything under it, by force. */
export function taskKillCommand(pid: number): { file: string; args: string[] } {
  return { file: TASKKILL, args: ["/pid", String(pid), "/T", "/F"] };
}
