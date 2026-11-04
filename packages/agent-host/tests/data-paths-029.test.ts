import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterDirectory,
  codexShimCommandPath,
  installedAdapterDirectory,
  installPointerPath,
  defaultAgentPorts,
} from "../src/broker/agents.js";
import { joinUnder } from "../src/broker/data-path.js";
import { hermesManagedDirectory } from "../src/broker/agent-launch-settings.js";
import { scratchFolderPath } from "../src/broker/folders.js";
import {
  agentStateDirectory,
  installLockPath,
  installStatePath,
  lastTestPath,
} from "../src/broker/shared-agent-state.js";

/**
 * #29: the broker's data folder is a real folder of this computer, so every path built on it must
 * be one this computer's file system takes. Built with `win32.join` on Linux or macOS,
 * `/tmp/x` became the relative name `\tmp\x\...` and the write landed in the current folder.
 */

let data: string;

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "hallpass-paths-029-"));
});

afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

const inside = (path: string): void => {
  expect(isAbsolute(path), `${path} is not absolute on this computer`).toBe(true);
  const rel = relative(data, path);
  expect(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)), `${path} is not inside ${data}`).toBe(true);
};

describe("#29 paths under the data folder are this computer's paths", () => {
  it("the shared agent state files", () => {
    inside(agentStateDirectory(data, "codex"));
    inside(installStatePath(data, "codex"));
    inside(lastTestPath(data, "claude-code"));
    inside(installLockPath(data, "deepseek"));
  });

  it("the Hermes managed folder, a conversation's scratch folder and the Codex shim", () => {
    inside(hermesManagedDirectory(data, "strict"));
    inside(scratchFolderPath(data, "3031de63-e966-4b6c-aac0-be7f5f54d5c5"));
    inside(codexShimCommandPath(data));
  });

  it("an adapter's install folders", async () => {
    inside(adapterDirectory(data, "claude-code"));
    inside(installPointerPath(data, "claude-code"));
    inside(await installedAdapterDirectory(data, "claude-code", async () => `{"folder":".install-1-abc"}`));
  });

  it("a write through the real file port lands in the data folder, not the current folder", async () => {
    const before = new Set(await readdir(process.cwd()));
    await defaultAgentPorts("unused-shim.js").fs.writeText(lastTestPath(data, "codex"), "{}\n");
    expect(await readdir(join(data, "agents", "codex"))).toContain("last-test.json");
    expect((await readdir(process.cwd())).filter((name) => !before.has(name) && name.includes("hallpass-paths-029-"))).toEqual([]);
  });

  it("a Windows-looking base keeps Windows paths on any computer, as a test standing in for Windows needs", () => {
    expect(joinUnder("C:\\data\\hallpass", "agents", "codex")).toBe("C:\\data\\hallpass\\agents\\codex");
    expect(joinUnder("\\\\server\\share", "agents")).toBe("\\\\server\\share\\agents");
  });
});
