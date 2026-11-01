import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_SKILL_TEXT,
  SHIPPED_SKILL_HASHES,
  installSkill,
  readSkillStates,
  removeInstalledSkills,
  skillFingerprint,
  skillFolders,
  type SkillEnvironment,
} from "../src/agent-skill.js";
import { makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 026 T831, T832 - the Hallpass skill's folders (R-411), states (R-414), install (R-415) and the
 * uninstall's removal (R-416), on a throwaway profile folder.
 */

let home: string;
let env: SkillEnvironment;

beforeEach(async () => {
  home = await makeTempDir("hallpass-skill-");
  env = { USERPROFILE: home };
});

afterEach(async () => {
  await removeDir(home);
});

const claudeFile = () => join(home, ".claude", "skills", "hallpass", "SKILL.md");
const agentsFile = () => join(home, ".agents", "skills", "hallpass", "SKILL.md");
const states = async () => (await readSkillStates(env)).map((entry) => entry.state);
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("026 skill folders and states", () => {
  it("R-411: Claude Code's folder under the profile, or under CLAUDE_CONFIG_DIR; the shared agents' folder under the profile", () => {
    expect(skillFolders(env)).toEqual([
      { location: "claude-code", folder: join(home, ".claude", "skills", "hallpass") },
      { location: "agents", folder: join(home, ".agents", "skills", "hallpass") },
    ]);
    const moved = join(home, "claude-config");
    expect(skillFolders({ ...env, CLAUDE_CONFIG_DIR: moved })[0]).toEqual({ location: "claude-code", folder: join(moved, "skills", "hallpass") });
  });

  it("R-414: not installed; the current text (also with CRLF) is up to date; an older shipped text has an update; anything else is changed", async () => {
    expect(await states()).toEqual(["not-installed", "not-installed"]);
    await put(claudeFile(), AGENT_SKILL_TEXT.replace(/\n/gu, "\r\n"));
    await put(agentsFile(), "---\nname: hallpass\n---\nThe owner's own notes.\n");
    expect(await states()).toEqual(["up-to-date", "changed"]);
    expect(SHIPPED_SKILL_HASHES.at(-1)).toBe(skillFingerprint(AGENT_SKILL_TEXT));
  });

  it("R-414: a copy that is an older shipped text reads update-available", async () => {
    const older = "---\nname: hallpass\n---\nAn older shipped text.\n";
    (SHIPPED_SKILL_HASHES as string[]).unshift(skillFingerprint(older));
    try {
      await put(agentsFile(), older);
      expect((await readSkillStates(env))[1]?.state).toBe("update-available");
    } finally {
      (SHIPPED_SKILL_HASHES as string[]).shift();
    }
  });

  it("R-414: a SKILL.md that cannot be read as a file is unreadable, with the reason", async () => {
    await mkdir(claudeFile(), { recursive: true });
    const [claude] = await readSkillStates(env);
    expect(claude).toMatchObject({ location: "claude-code", state: "unreadable" });
    expect(claude?.detail).toMatch(/EISDIR|illegal operation/u);
  });
});

describe("026 install, update, uninstall", () => {
  it("FR-417: Install creates the folder and writes the current text; a second Install writes nothing", async () => {
    expect(await installSkill("claude-code", { env })).toEqual({ ok: true, written: true });
    expect(await readFile(claudeFile(), "utf8")).toBe(AGENT_SKILL_TEXT);
    expect(await installSkill("claude-code", { env })).toEqual({ ok: true, written: false });
    expect(await states()).toEqual(["up-to-date", "not-installed"]);
  });

  it("FR-419: a changed copy is refused skill-changed and kept; with replaceChanged it is replaced", async () => {
    await put(agentsFile(), "mine\n");
    expect(await installSkill("agents", { env })).toMatchObject({ ok: false, code: "skill-changed" });
    expect(await readFile(agentsFile(), "utf8")).toBe("mine\n");
    expect(await installSkill("agents", { env, replaceChanged: true })).toEqual({ ok: true, written: true });
    expect(await readFile(agentsFile(), "utf8")).toBe(AGENT_SKILL_TEXT);
  });

  it("FR-420: a folder that cannot be made fails skill-write-failed, with nothing half-written", async () => {
    // A file where the `skills` folder should be: the folder cannot be created.
    await put(join(home, ".agents", "skills"), "not a folder");
    const outcome = await installSkill("agents", { env });
    expect(outcome).toMatchObject({ ok: false, code: "skill-write-failed" });
    expect(await readFile(join(home, ".agents", "skills"), "utf8")).toBe("not a folder");
  });

  it("FR-420: a write that fails leaves the previous copy and no temp file", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // read-only folders hold only for a non-root POSIX user
    await installSkill("claude-code", { env });
    const older = "---\nname: hallpass\n---\nAn older shipped text.\n";
    (SHIPPED_SKILL_HASHES as string[]).unshift(skillFingerprint(older));
    try {
      await writeFile(claudeFile(), older, "utf8");
      await chmod(join(claudeFile(), ".."), 0o500);
      expect(await installSkill("claude-code", { env })).toMatchObject({ ok: false, code: "skill-write-failed" });
      expect(await readFile(claudeFile(), "utf8")).toBe(older);
      expect(await readdir(join(claudeFile(), ".."))).toEqual(["SKILL.md"]);
    } finally {
      await chmod(join(claudeFile(), ".."), 0o700);
      (SHIPPED_SKILL_HASHES as string[]).shift();
    }
  });

  it("FR-421: the uninstall removes a shipped copy and its folder, and keeps and names a changed one", async () => {
    await installSkill("claude-code", { env });
    await put(agentsFile(), "mine\n");
    const outcome = await removeInstalledSkills(env);
    expect(outcome).toEqual({ removed: [join(home, ".claude", "skills", "hallpass")], kept: [join(home, ".agents", "skills", "hallpass")] });
    expect(await readdir(join(home, ".claude", "skills"))).toEqual([]);
    expect(await readFile(agentsFile(), "utf8")).toBe("mine\n");
    expect(await removeInstalledSkills(env)).toEqual({ removed: [], kept: [join(home, ".agents", "skills", "hallpass")] });
  });
});
