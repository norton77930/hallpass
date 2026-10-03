import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserChoicePath, readBrowserChoice, writeBrowserChoice } from "../src/browser-choice-store.js";
import { browserChoicesDirectory } from "../src/host-paths.js";

/**
 * 018 T503 - the remembered choice, one file per agent (R-271, R-279, D-018-5, D-018-11):
 * `choices/<agentId>.json` `{ browserId, chosenAt }`, temp-then-rename, last writer wins.
 */

const AGENT = "0123456789abcdef0123456789abcdef";

describe("018 T503 browser choice store", () => {
  let dataDir = "";
  let env: { LOCALAPPDATA: string };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hallpass-choice-"));
    env = { LOCALAPPDATA: dataDir };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reads nothing before anything was chosen", async () => {
    await expect(readBrowserChoice(AGENT, env)).resolves.toBeUndefined();
  });

  it("writes choices/<agentId>.json and reads it back; the last write wins", async () => {
    await writeBrowserChoice(AGENT, "browser-a", new Date("2026-10-03T08:00:00.000Z"), env);
    await writeBrowserChoice(AGENT, "browser-b", new Date("2026-10-03T09:00:00.000Z"), env);

    await expect(readBrowserChoice(AGENT, env)).resolves.toEqual({
      browserId: "browser-b",
      chosenAt: "2026-10-03T09:00:00.000Z",
    });
    expect(JSON.parse(await readFile(join(browserChoicesDirectory(env), `${AGENT}.json`), "utf8"))).toEqual({
      browserId: "browser-b",
      chosenAt: "2026-10-03T09:00:00.000Z",
    });
    // Temp-then-rename leaves nothing behind.
    expect(await readdir(browserChoicesDirectory(env))).toEqual([`${AGENT}.json`]);
  });

  it("keeps each agent's choice in its own file", async () => {
    await writeBrowserChoice(AGENT, "browser-a", new Date(), env);
    await writeBrowserChoice("other-agent", "browser-b", new Date(), env);

    expect((await readBrowserChoice(AGENT, env))?.browserId).toBe("browser-a");
    expect((await readBrowserChoice("other-agent", env))?.browserId).toBe("browser-b");
  });

  it("reads a file that is not a choice as no choice", async () => {
    await mkdir(browserChoicesDirectory(env), { recursive: true });
    await writeFile(join(browserChoicesDirectory(env), `${AGENT}.json`), "{ half");
    await expect(readBrowserChoice(AGENT, env)).resolves.toBeUndefined();

    await writeFile(join(browserChoicesDirectory(env), `${AGENT}.json`), JSON.stringify({ browserId: "../x", chosenAt: "t" }));
    await expect(readBrowserChoice(AGENT, env)).resolves.toBeUndefined();

    await writeFile(
      join(browserChoicesDirectory(env), `${AGENT}.json`),
      JSON.stringify({ browserId: "browser-a", chosenAt: "t", extra: 1 }),
    );
    await expect(readBrowserChoice(AGENT, env)).resolves.toBeUndefined();
  });

  it("refuses an agent id or browser id that could name a file anywhere else", async () => {
    for (const agentId of ["", "..", "a/b", "a\\b", "c:x", "a.json", "x".repeat(129)]) {
      expect(() => browserChoicePath(agentId, env), agentId).toThrow(/agent id/);
      await expect(readBrowserChoice(agentId, env)).resolves.toBeUndefined();
      await expect(writeBrowserChoice(agentId, "browser-a", new Date(), env)).rejects.toThrow(/agent id/);
    }
    await expect(writeBrowserChoice(AGENT, "../browser", new Date(), env)).rejects.toThrow(/browser id/);
  });

  // T507 m4: `NUL.json` is the NUL device on Windows, not a file in `choices/`.
  it("refuses an agent id that is a Windows device name, in any case", async () => {
    for (const agentId of ["CON", "prn", "Aux", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
      expect(() => browserChoicePath(agentId, env), agentId).toThrow(/agent id/);
      await expect(readBrowserChoice(agentId, env)).resolves.toBeUndefined();
      await expect(writeBrowserChoice(agentId, "browser-a", new Date(), env)).rejects.toThrow(/agent id/);
    }
    // Only the whole name is reserved.
    expect(() => browserChoicePath("CONSOLE", env)).not.toThrow();
    expect(() => browserChoicePath("COM10", env)).not.toThrow();
  });
});
