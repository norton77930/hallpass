import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_SKILL_LOCATIONS, type AgentSkillLocation, type AgentSkillState } from "@hallpass/contracts";

/**
 * 026 (issue #16): the Hallpass skill for outside coding agents - its text, the fingerprints of every
 * text a release shipped, the two user-level folders it goes into (D-026-1, R-411), each folder's state
 * (R-414), the owner's install or update (R-415) and the uninstall's removal (R-416).
 *
 * The text is also kept readable at `skills/hallpass/SKILL.md`; a contract test fails when they differ
 * (R-413). Nothing here runs on its own: the settings page's command and the uninstall call it.
 */

export const AGENT_SKILL_NAME = "hallpass";

/** R-412: the skill, in the project's own words (FR-413..416, FR-424). */
export const AGENT_SKILL_TEXT = [
  "---",
  "name: hallpass",
  "description: Use when a task needs the user's own Chrome through the Hallpass browser tools (tabs, reading pages, clicking, typing, screenshots). Explains how the tools fit together and how the user's consent works, so you wait for the user instead of failing or retrying.",
  "---",
  "",
  "# Working in the user's browser with Hallpass",
  "",
  "Hallpass gives you the user's real Chrome: their profile, their sign-ins, what they see. Every",
  "page-changing step is the user's to allow. Each tool's own description has the details; this page is",
  "how they fit together.",
  "",
  "## Order of work",
  "",
  "1. **Look**: `tabs_context` lists the tabs and who holds each one. Open a tab with `tabs_create`, or ask",
  "   the user before taking one of theirs with `tabs_claim`.",
  "2. **Read before acting**: `read_page` (structure with element refs and field values), `get_page_text`,",
  "   `find`, `screenshot`. Reading never asks the user. `get_page_text` returns what the user could see by",
  "   scrolling; text the page hides is left out, but same-colour or very small text is still returned.",
  "3. **Act**: `navigate`, `click`, `type`, `key`, `scroll`, `form_input`, `dialog`, and the others. Use the",
  "   refs from your last read; read again after the page changes.",
  "4. **Several steps on one tab**: `browser_batch`. **Several sites in one task**: `propose_sites` first.",
  "5. **Finish**: close the tabs you opened (`tabs_close`) and give back the ones you took (`tabs_release`).",
  "",
  "## How consent works",
  "",
  "- **Pairing**: your first call shows a pairing card in the Hallpass side panel. Tell the user a card is",
  "  waiting there (toolbar icon, or Alt+A) and wait. Pairing is asked once per browser.",
  "- **Site modes**, chosen by the user for each site:",
  "  - `ask` (the default): every page-changing action shows a consent card. Say what you are about to do",
  "    and that the user is asked to approve it in the side panel.",
  "  - `follow-a-plan`: a `browser_batch` is approved once as a plan; single actions still ask.",
  "  - `skip-checks`: nothing is asked on that site.",
  "- **Site plan**: for a task across several sites, `propose_sites` lets the user approve those sites once",
  "  for this session; page actions on them then run without a card.",
  "- **A site the user has not decided about**: when a step lands on one, the call says so and the user is",
  "  asked at your next call on that tab.",
  "- **Diagnostics** (`read_console`, `read_network`, `evaluate`) need a separate per-site grant from the",
  "  user. **Uploads** outside the user's allowed folders are asked about.",
  "- Waiting for a card is normal, not an error.",
  "",
  "## When the answer is no",
  "",
  "- **Declined card**: that is the user's answer. Tell the user which step was not done and ask how to",
  "  continue. Do not send the same step again on your own.",
  "- **Card timed out**: the user did not answer. Report it the same way; repeat the step only if the user",
  "  asks you to.",
  "- **Session ended, tabs taken back, or the step interrupted**: stop your browser work and say so.",
  "- Never try to get around a card: no other tool, tab or route to do the same step. Never ask the user to",
  "  switch a site to `skip-checks`; the site mode is the user's choice in the side panel.",
  "",
  "## Good habits",
  "",
  "- Say in one line what you will do before a page-changing step, so the card the user sees is expected.",
  "- Password, one-time-code and payment-card fields read as redacted; ask the user to fill them.",
  "- Prefer element refs over screen points; use `computer` only when the page structure does not",
  "  describe the target.",
  "- Several browsers connected: `list_browsers`, then `select_browser`, or `request_browser_choice` to let",
  "  the user pick.",
  "",
].join("\n");

/**
 * R-414: the SHA-256 of every skill text a release shipped (CRLF read as LF), oldest first, the current
 * one last. Never shortened: an older copy is told apart from one the owner changed by this list.
 */
export const SHIPPED_SKILL_HASHES: readonly string[] = [
  // 0.18.0
  "155b758b760ea0bf6360e753090d6b806655dddb47c4d0cd3a20f0e371f37730",
  // issue #37 (get_page_text leaves out hidden text), next release
  "566f7d6c6cb885e9358194d0cf9c60ae23eaf4893681af2da115b7c38aa9f6da",
];

/** R-414: the text's fingerprint; a copy that went through Git or an editor on Windows is the same text. */
export function skillFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

/** Where the folders are: the owner's profile and Claude Code's own config folder when it is moved. */
export type SkillEnvironment = { USERPROFILE?: string | undefined; CLAUDE_CONFIG_DIR?: string | undefined };

/** R-411: each location's folder, in the contract's order. */
export function skillFolders(env: SkillEnvironment = process.env): Array<{ location: AgentSkillLocation; folder: string }> {
  const home = env.USERPROFILE !== undefined && env.USERPROFILE !== "" ? env.USERPROFILE : homedir();
  const claude = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== "" ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
  const folders: Record<AgentSkillLocation, string> = {
    "claude-code": join(claude, "skills", AGENT_SKILL_NAME),
    agents: join(home, ".agents", "skills", AGENT_SKILL_NAME),
  };
  return AGENT_SKILL_LOCATIONS.map((location) => ({ location, folder: folders[location] }));
}

const SKILL_FILE = "SKILL.md";
const isMissing = (error: unknown): boolean => (error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR";
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 600);

/** R-414: one folder's state, by its copy's fingerprint. */
async function stateOf(location: AgentSkillLocation, folder: string): Promise<AgentSkillState> {
  let text: string;
  try {
    text = await readFile(join(folder, SKILL_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return { location, state: "not-installed", folder };
    return { location, state: "unreadable", folder, detail: reason(error) };
  }
  const fingerprint = skillFingerprint(text);
  const at = SHIPPED_SKILL_HASHES.indexOf(fingerprint);
  if (at === SHIPPED_SKILL_HASHES.length - 1) return { location, state: "up-to-date", folder };
  if (at >= 0) return { location, state: "update-available", folder };
  return { location, state: "changed", folder };
}

/** FR-418: both folders' states, `claude-code` first. Folders are the real paths; the broker scrubs them. */
export async function readSkillStates(env: SkillEnvironment = process.env): Promise<AgentSkillState[]> {
  return Promise.all(skillFolders(env).map(({ location, folder }) => stateOf(location, folder)));
}

export type SkillInstallOutcome = { ok: true; written: boolean } | { ok: false; code: "skill-changed" | "skill-write-failed"; detail: string };

/**
 * R-415 (FR-417, FR-419, FR-420): the owner's Install or Update. Up to date: nothing written. A changed
 * or unreadable copy is replaced only with `replaceChanged`. The text goes to a temp file renamed over
 * `SKILL.md`, so a failure leaves the previous copy, or none, and no temp file.
 */
export async function installSkill(
  location: AgentSkillLocation,
  options: { replaceChanged?: boolean; env?: SkillEnvironment } = {},
): Promise<SkillInstallOutcome> {
  const folder = skillFolders(options.env).find((entry) => entry.location === location)!.folder;
  const current = await stateOf(location, folder);
  if (current.state === "up-to-date") return { ok: true, written: false };
  if ((current.state === "changed" || current.state === "unreadable") && options.replaceChanged !== true) {
    return { ok: false, code: "skill-changed", detail: "The skill there was changed since Hallpass installed it; confirm to replace it." };
  }
  const target = join(folder, SKILL_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(temp, AGENT_SKILL_TEXT, "utf8");
    await rename(temp, target);
    return { ok: true, written: true };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return { ok: false, code: "skill-write-failed", detail: reason(error) };
  }
}

/**
 * R-416 (FR-421): the uninstall's part - a copy that is exactly a shipped text goes (and its folder, once
 * empty); any other copy stays and is named.
 */
export async function removeInstalledSkills(env: SkillEnvironment = process.env): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const state of await readSkillStates(env)) {
    if (state.state === "up-to-date" || state.state === "update-available") {
      await rm(join(state.folder, SKILL_FILE), { force: true });
      await rmdir(state.folder).catch(() => undefined);
      removed.push(state.folder);
    } else if (state.state !== "not-installed") {
      kept.push(state.folder);
    }
  }
  return { removed, kept };
}
