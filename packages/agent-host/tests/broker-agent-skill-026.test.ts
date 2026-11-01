import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationOverviewFrameSchema, conversationResultFrameSchema } from "@hallpass/contracts";
import { AGENT_SKILL_TEXT, installSkill, readSkillStates } from "../src/agent-skill.js";
import { createCommandHandler } from "../src/broker/commands.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { ConversationPool } from "../src/broker/conversation.js";
import type { FolderActions } from "../src/broker/folders.js";
import { makeTempDir, removeDir, waitFor } from "./conversation-harness.js";

/**
 * 026 T834 - the broker's part (contracts/frames.md, R-414, R-415): every overview carries both
 * folders' states with the profile said as `%USERPROFILE%`; `ui.conversation.install-skill` writes on
 * the owner's command and refuses a changed copy without `replaceChanged`.
 */

let home: string;

beforeEach(async () => {
  home = await makeTempDir("hallpass-skill-broker-");
});

afterEach(async () => {
  await removeDir(home);
});

function handler() {
  const sent: Record<string, unknown>[] = [];
  const index = memoryConversationIndex();
  const folders = memoryFolderList();
  const env = { USERPROFILE: home };
  const pool = new ConversationPool({
    dataDir: join(home, "data"),
    browserRunId: "run-skill",
    index,
    folders,
    resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "no launches in this test" } }),
    onEvent: () => undefined,
  });
  const commands = createCommandHandler({
    sessionId: "broker-skill",
    send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
    pool,
    index,
    folders,
    consent: { read: async () => "granted", write: async () => undefined },
    folderActions: {} as FolderActions,
    availability: async (agent) => ({ agent, availability: "ready" }),
    install: async () => ({ ok: true, directory: "x" }),
    userProfile: home,
    skills: {
      read: () => readSkillStates(env),
      install: (location, replaceChanged) => installSkill(location, { env, ...(replaceChanged === undefined ? {} : { replaceChanged }) }),
    },
  });
  let counter = 0;
  const run = async (command: unknown) => {
    const commandId = `k-${++counter}`;
    await commands.handle({ type: "conversation-command", sessionId: "broker-skill", commandId, command });
    return sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId);
  };
  const overviews = () => sent.filter((frame) => frame.type === "conversation-overview");
  return { commands, run, overviews, pool };
}

describe("026 the broker and the Hallpass skill", () => {
  it("the overview carries both folders, said with %USERPROFILE%, and passes the contract", async () => {
    const { commands, overviews, pool } = handler();
    try {
      await commands.sendOverview();
      const frame = overviews().at(-1)!;
      expect(conversationOverviewFrameSchema.safeParse(frame).success).toBe(true);
      expect(frame.skills).toEqual([
        { location: "claude-code", state: "not-installed", folder: join("%USERPROFILE%", ".claude", "skills", "hallpass") },
        { location: "agents", state: "not-installed", folder: join("%USERPROFILE%", ".agents", "skills", "hallpass") },
      ]);
      expect(JSON.stringify(frame)).not.toContain(home);
    } finally {
      await pool.shutdown();
    }
  });

  it("install-skill writes the skill, and the next overview reads Up to date", async () => {
    const { run, overviews, pool } = handler();
    try {
      const result = await run({ type: "ui.conversation.install-skill", payload: { location: "claude-code" } });
      expect(result).toMatchObject({ ok: true });
      expect(conversationResultFrameSchema.safeParse(result).success).toBe(true);
      expect(await readFile(join(home, ".claude", "skills", "hallpass", "SKILL.md"), "utf8")).toBe(AGENT_SKILL_TEXT);
      await waitFor(() => (overviews().at(-1)?.skills as { state: string }[] | undefined)?.[0]?.state === "up-to-date", "the overview after the install");
    } finally {
      await pool.shutdown();
    }
  });

  it("a changed copy: skill-changed without replaceChanged, nothing written; replaced with it", async () => {
    const file = join(home, ".agents", "skills", "hallpass", "SKILL.md");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "mine\n", "utf8");
    const { run, pool } = handler();
    try {
      const refused = await run({ type: "ui.conversation.install-skill", payload: { location: "agents" } });
      expect(refused).toMatchObject({ ok: false, error: { code: "skill-changed" } });
      expect(conversationResultFrameSchema.safeParse(refused).success).toBe(true);
      expect(await readFile(file, "utf8")).toBe("mine\n");
      expect(await run({ type: "ui.conversation.install-skill", payload: { location: "agents", replaceChanged: true } })).toMatchObject({ ok: true });
      expect(await readFile(file, "utf8")).toBe(AGENT_SKILL_TEXT);
    } finally {
      await pool.shutdown();
    }
  });

  it("a write that fails answers skill-write-failed with the reason, the profile said as %USERPROFILE%", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "skills"), "not a folder", "utf8");
    const { run, pool } = handler();
    try {
      const failed = await run({ type: "ui.conversation.install-skill", payload: { location: "claude-code" } });
      expect(failed).toMatchObject({ ok: false, error: { code: "skill-write-failed" } });
      expect(JSON.stringify(failed)).not.toContain(home);
    } finally {
      await pool.shutdown();
    }
  });

  it("a broker without the skill port sends no skills and refuses the command", async () => {
    const sent: Record<string, unknown>[] = [];
    const index = memoryConversationIndex();
    const folders = memoryFolderList();
    const pool = new ConversationPool({
      dataDir: join(home, "data"),
      browserRunId: "run-noskill",
      index,
      folders,
      resolveLaunch: async () => ({ ok: false, error: { code: "agent-missing", detail: "none" } }),
      onEvent: () => undefined,
    });
    const commands = createCommandHandler({
      sessionId: "broker-skill",
      send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
      pool,
      index,
      folders,
      consent: { read: async () => "granted", write: async () => undefined },
      folderActions: {} as FolderActions,
      availability: async (agent) => ({ agent, availability: "ready" }),
      install: async () => ({ ok: true, directory: "x" }),
    });
    try {
      await commands.sendOverview();
      expect(sent.at(-1)?.skills).toBeUndefined();
      await commands.handle({ type: "conversation-command", sessionId: "broker-skill", commandId: "n-1", command: { type: "ui.conversation.install-skill", payload: { location: "agents" } } });
      expect(sent.find((frame) => frame.commandId === "n-1")).toMatchObject({ ok: false, error: { code: "broker-unavailable" } });
    } finally {
      await pool.shutdown();
    }
  });
});
