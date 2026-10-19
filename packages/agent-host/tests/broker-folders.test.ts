import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_MAX_FOLDERS } from "@hallpass/contracts";
import {
  createFolderActions,
  ensureScratchFolder,
  fileFolderList,
  scratchFolderPath,
  type DialogRun,
} from "../src/broker/folders.js";
import { makeTempDir, poolHarness, removeDir } from "./conversation-harness.js";

/**
 * 019/T561 - the owner's folders (R-319, R-320, FR-303, D-019-1/8/9): `<data>\folders.json` with at
 * most 30 folders, a scratch folder per conversation under `scratch\<conversationId>` that Hallpass
 * never deletes, `folder-missing` for a folder that is gone, the Windows folder dialog's answer
 * (cancel or a path), and the path-entry fallback when PowerShell runs in Constrained Language Mode.
 * The dialog and Explorer are injected: no test opens either.
 */

let dir: string;
let data: string;

beforeEach(async () => {
  dir = await makeTempDir("hallpass-folders-");
  data = join(dir, "data");
});

afterEach(async () => {
  await removeDir(dir);
});

const AT = "2026-10-19T12:00:00.000Z";
const encoded = (path: string) => Buffer.from(path, "utf8").toString("base64");

/** A dialog that answers with `stdout` (and `code`) and records how it was launched. */
function dialog(stdout: string, code = 0) {
  const calls: { command: string; args: readonly string[] }[] = [];
  let release: (() => void) | undefined;
  const held = { hold: false };
  const run: DialogRun = async (command, args) => {
    calls.push({ command, args });
    if (held.hold) await new Promise<void>((done) => (release = done));
    return { code, stdout, stderr: "", timedOut: false };
  };
  return { run, calls, held, release: () => release?.() };
}

function actions(options: { run?: DialogRun; launched?: { command: string; args: readonly string[] }[] } = {}) {
  const folders = fileFolderList({ path: join(data, "folders.json"), now: () => Date.parse(AT) });
  const launched = options.launched ?? [];
  const folderActions = createFolderActions({
    folders,
    now: () => Date.parse(AT),
    runDialog: options.run ?? dialog("CANCEL").run,
    launch: (command, args) => {
      launched.push({ command, args });
    },
  });
  return { folders, folderActions, launched };
}

describe("T561 folders.json", () => {
  it("keeps at most 30 folders, written as { version: 1, folders }, read again by another broker", async () => {
    const folders = fileFolderList({ path: join(data, "folders.json") });
    for (let n = 1; n <= CONVERSATION_MAX_FOLDERS + 1; n++) await folders.add(`D:\\work\\p${n}`, AT);
    await folders.add("d:\\WORK\\P31", AT);

    const onDisk = JSON.parse(await readFile(join(data, "folders.json"), "utf8")) as { version: number; folders: { path: string }[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.folders).toHaveLength(CONVERSATION_MAX_FOLDERS);
    // The oldest goes; a path already there (in any case) is not added twice.
    expect(onDisk.folders.map((folder) => folder.path)).not.toContain("D:\\work\\p1");
    const other = fileFolderList({ path: join(data, "folders.json") });
    expect(await other.has("D:\\Work\\p31")).toBe(true);
    expect(await other.remove("D:\\work\\p31")).toBe(true);
    expect(await folders.has("D:\\work\\p31")).toBe(false);
  }, 60_000); // 31 sequential temp + rename writes: seconds alone, longer under the full parallel run
});

describe("T561 scratch folders", () => {
  it("live under scratch\\<conversationId>, are made on demand and are never deleted", async () => {
    const id = "conv-0000000000000001";
    expect(scratchFolderPath(data, id)).toBe(join(data, "scratch", id));
    expect(await ensureScratchFolder(data, id)).toBe(join(data, "scratch", id));
    expect((await stat(join(data, "scratch", id))).isDirectory()).toBe(true);

    const h = await poolHarness({ dir });
    try {
      const started = await h.start("claude-code");
      const path = scratchFolderPath(data, started);
      expect(h.pool.folderOf((await h.index.get(started))!)).toBe(path);
      expect((await h.pool.remove(started)).ok).toBe(true);
      await h.pool.shutdown();
      expect((await stat(path)).isDirectory()).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

describe("T561 a missing folder", () => {
  it("is folder-missing for open-folder and for a typed path; Explorer is not started", async () => {
    const { folderActions, launched } = actions();
    const missing = join(dir, "gone");
    expect(await folderActions.open(missing)).toMatchObject({ ok: false, error: { code: "folder-missing" } });
    expect(await folderActions.addTyped(missing)).toMatchObject({ kind: "failed", error: { code: "folder-missing" } });
    expect(await folderActions.addTyped("relative\\path")).toMatchObject({ kind: "failed", error: { code: "folder-missing" } });
    expect(launched).toEqual([]);
  });

  it("open-folder starts explorer.exe with the path as its single argument, no shell", async () => {
    const path = join(dir, "a folder & more");
    await mkdir(path);
    const { folderActions, launched } = actions();
    expect(await folderActions.open(path)).toEqual({ ok: true });
    expect(launched).toEqual([{ command: "explorer.exe", args: [path] }]);
  });
});

describe("T561 the folder dialog", () => {
  it("is PowerShell -NoProfile -STA with a FolderBrowserDialog on a top-most owner", async () => {
    const fake = dialog("CANCEL");
    await actions({ run: fake.run }).folderActions.addFromDialog();
    expect(fake.calls).toHaveLength(1);
    const { command, args } = fake.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-STA"]));
    const script = args.at(-1)!;
    expect(script).toMatch(/FolderBrowserDialog/u);
    expect(script).toMatch(/TopMost = \$true/u);
    expect(script).toMatch(/LanguageMode/u);
    // Single quotes only: no double quote to be re-escaped on the way through the command line.
    expect(script).not.toMatch(/"/u);
  });

  it("cancel adds nothing", async () => {
    const { folderActions, folders } = actions({ run: dialog("CANCEL\r\n").run });
    expect(await folderActions.addFromDialog()).toEqual({ kind: "cancelled" });
    expect(await folders.list()).toEqual([]);
  });

  it("a chosen path (any script) is added to the list", async () => {
    const chosen = join(dir, "專案 demo");
    await mkdir(chosen);
    const { folderActions, folders } = actions({ run: dialog(`PATH:${encoded(chosen)}\r\n`).run });
    expect(await folderActions.addFromDialog()).toEqual({ kind: "added", path: chosen });
    expect(await folders.list()).toEqual([{ path: chosen, addedAt: AT }]);
  });

  it("is one at a time: a second request while it is open joins the first", async () => {
    const chosen = join(dir, "shared");
    await mkdir(chosen);
    const fake = dialog(`PATH:${encoded(chosen)}`);
    fake.held.hold = true;
    const { folderActions, folders } = actions({ run: fake.run });
    const first = folderActions.addFromDialog();
    const second = folderActions.addFromDialog();
    await new Promise((done) => setImmediate(done));
    fake.release();
    expect(await first).toEqual({ kind: "added", path: chosen });
    expect(await second).toEqual({ kind: "added", path: chosen });
    expect(fake.calls).toHaveLength(1);
    expect(await folders.list()).toHaveLength(1);
  });

  it("a dialog that fails to open is failed, with no path added", async () => {
    const { folderActions, folders } = actions({ run: dialog("", 1).run });
    expect(await folderActions.addFromDialog()).toMatchObject({ kind: "failed", error: { code: "broker-unavailable" } });
    expect(await folders.list()).toEqual([]);
  });

  it("Constrained Language Mode is detected and answered with the path-entry fallback, which checks the path", async () => {
    const { folderActions, folders } = actions({ run: dialog("MODE:ConstrainedLanguage\r\n", 3).run });
    expect(await folderActions.addFromDialog()).toMatchObject({ kind: "path-entry", detail: expect.stringMatching(/Constrained/u) });
    expect(await folders.list()).toEqual([]);

    const typed = join(dir, "typed");
    await mkdir(typed);
    expect(await folderActions.addTyped(typed)).toEqual({ kind: "added", path: typed });
    expect(await folders.has(typed)).toBe(true);
  });
});
