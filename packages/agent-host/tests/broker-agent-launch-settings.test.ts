import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { CONVERSATION_AGENTS, CONVERSATION_MODES, type ConversationMode } from "@hallpass/contracts";
import { hermesManagedDirectory, launchSettings, writeLaunchFiles } from "../src/broker/agent-launch-settings.js";

/**
 * 021/T642 - launch-time modes (R-347, R-349, R-350, R-351): what Hallpass sets when it starts Hermes
 * or DeepSeek in a panel mode. Hermes gets a Hallpass-owned managed settings layer that switches tools
 * off (never the owner's own settings); DeepSeek gets its permission mode and telemetry off in the
 * environment. No key, endpoint or model is ever set, and no full-access mode is ever named.
 */

const DATA = "C:\\data\\hallpass";
const managed = (mode: ConversationMode) => win32.join(DATA, "agents", "hermes", "managed", mode);
const configOf = (mode: ConversationMode) => win32.join(managed(mode), "config.yaml");

/** A file system that records what was written. */
function files(initial: Record<string, string> = {}) {
  const content: Record<string, string> = { ...initial };
  const writes: string[] = [];
  return {
    content,
    writes,
    fs: {
      readText: async (path: string) => {
        if (!(path in content)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return content[path]!;
      },
      writeText: async (path: string, text: string) => {
        writes.push(path);
        content[path] = text;
      },
    },
  };
}

describe("Hermes: the managed settings layer (R-347)", () => {
  it("strict switches the command, code-running, helper-agent and saved-login tools off and uses Hermes' default mode", () => {
    const settings = launchSettings("hermes", "strict", DATA);
    expect(settings.env).toEqual({ HERMES_MANAGED_DIR: managed("strict") });
    expect(settings.agentMode).toBe("default");
    expect(settings.files).toEqual([
      { path: configOf("strict"), text: "agent:\n  disabled_toolsets: [terminal, code_execution, delegation, browser_vault]\n" },
    ]);
    expect(hermesManagedDirectory(DATA, "strict")).toBe(managed("strict"));
  });

  it("agent-review switches only the saved-login tool off and uses accept_edits", () => {
    const settings = launchSettings("hermes", "agent-review", DATA);
    expect(settings.env).toEqual({ HERMES_MANAGED_DIR: managed("agent-review") });
    expect(settings.agentMode).toBe("accept_edits");
    expect(settings.files).toEqual([{ path: configOf("agent-review"), text: "agent:\n  disabled_toolsets: [browser_vault]\n" }]);
  });

  it("overwrites a tampered layer and writes nothing else", async () => {
    const machine = files({ [configOf("strict")]: "agent:\n  disabled_toolsets: []\n" });
    await writeLaunchFiles(launchSettings("hermes", "strict", DATA).files, machine.fs);
    expect(machine.writes).toEqual([configOf("strict")]);
    expect(machine.content[configOf("strict")]).toBe("agent:\n  disabled_toolsets: [terminal, code_execution, delegation, browser_vault]\n");
  });

  it("writes a missing layer, and leaves one with the right content alone", async () => {
    const machine = files();
    await writeLaunchFiles(launchSettings("hermes", "agent-review", DATA).files, machine.fs);
    await writeLaunchFiles(launchSettings("hermes", "agent-review", DATA).files, machine.fs);
    expect(machine.writes).toEqual([configOf("agent-review")]);
  });

  it("does not fail when another broker's write left the right content, and does when the content is wrong", async () => {
    const right = launchSettings("hermes", "strict", DATA).files;
    const raced = files();
    const won = {
      readText: raced.fs.readText,
      writeText: async (path: string, text: string) => {
        raced.content[path] = text;
        throw new Error("EPERM: the file is open");
      },
    };
    await expect(writeLaunchFiles(right, won)).resolves.toBeUndefined();
    const failing = { readText: raced.fs.readText, writeText: async () => Promise.reject(new Error("EACCES")) };
    raced.content[configOf("strict")] = "tampered";
    await expect(writeLaunchFiles(right, failing)).rejects.toThrow(/EACCES/);
  });
});

describe("DeepSeek: permission mode and telemetry in the environment (R-349, R-350)", () => {
  it("strict starts read-only with telemetry disabled, and sets no agent mode", () => {
    expect(launchSettings("deepseek", "strict", DATA)).toEqual({
      env: { DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" },
      files: [],
    });
  });

  it("agent-review starts workspace-write with telemetry disabled", () => {
    expect(launchSettings("deepseek", "agent-review", DATA)).toEqual({
      env: { DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" },
      files: [],
    });
  });
});

describe("what no launch ever sets", () => {
  const all = CONVERSATION_AGENTS.flatMap((agent) => CONVERSATION_MODES.map((mode) => ({ agent, mode, ...launchSettings(agent, mode, DATA) })));

  it("leaves Claude Code and Codex to their agent modes: no environment, no files", () => {
    for (const agent of ["claude-code", "codex"] as const) {
      for (const mode of CONVERSATION_MODES) expect(launchSettings(agent, mode, DATA)).toEqual({ env: {}, files: [] });
    }
  });

  it("never names a full-access mode", () => {
    for (const entry of all) {
      const values = [...Object.values(entry.env), entry.agentMode, ...entry.files.map((file) => file.text)];
      for (const value of values) {
        expect(value ?? "", `${entry.agent} ${entry.mode}`).not.toMatch(/danger-full-access|dont_ask|agent-full-access|bypassPermissions/);
      }
    }
  });

  it("never sets a key, a token, an endpoint or a model", () => {
    for (const entry of all) {
      for (const name of Object.keys(entry.env)) {
        expect(name, `${entry.agent} ${entry.mode}`).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|ENDPOINT|URL|HOST|MODEL|PROVIDER/i);
      }
    }
  });

  it("refuses a mode that is not one of the panel's two", () => {
    expect(() => launchSettings("deepseek", "full-access" as ConversationMode, DATA)).toThrow(/mode/);
    expect(() => launchSettings("hermes", "dont_ask" as ConversationMode, DATA)).toThrow(/mode/);
  });
});
