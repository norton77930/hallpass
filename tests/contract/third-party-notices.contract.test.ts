import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT_ENTRIES } from "../../scripts/package.js";
import {
  GENERATED_END,
  GENERATED_START,
  generatedSection,
  NOTICES_FILE,
  readNotice,
  repoRoot,
  shippedPackages,
  withGenerated,
} from "../../scripts/third-party-notices.js";

/**
 * Review 2026-11-05 L4 - the notices name every package the artifacts ship, with its licence text, and
 * the zip carries them. The host bundles pull in the whole production closure of the MCP SDK, the
 * extension the unified/micromark family; the hand-written table named the direct dependencies only
 * and pointed at a `node_modules/` a zip user does not have.
 */
describe("L4 third-party notices", () => {
  const notices = readFileSync(resolve(repoRoot, NOTICES_FILE), "utf8");
  const lock = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8")) as Parameters<typeof shippedPackages>[0];

  it("stays LF in every checkout, because the generator writes LF", () => {
    expect(readFileSync(resolve(repoRoot, ".gitattributes"), "utf8")).toMatch(/^THIRD_PARTY_NOTICES\.md text eol=lf\r?$/m);
    expect(notices).not.toContain("\r");
  });

  it("the committed generated section is what the lockfile and the installed packages say", () => {
    expect(notices).toContain(GENERATED_START);
    expect(notices).toContain(GENERATED_END);
    expect(withGenerated(notices, generatedSection())).toBe(notices);
  });

  it("the closure holds the direct dependencies and what they bring, and no dev dependency", () => {
    const names = new Set(shippedPackages(lock).map((pkg) => pkg.name));
    for (const direct of ["react", "react-dom", "react-markdown", "remark-gfm", "gifenc", "zod", "@modelcontextprotocol/sdk", "@agentclientprotocol/sdk", "koffi"]) {
      expect(names.has(direct), direct).toBe(true);
    }
    // Brought in by the direct ones: bundled, so noticed.
    for (const transitive of ["micromark", "unified", "ajv", "@koromix/koffi-win32-x64"]) expect(names.has(transitive), transitive).toBe(true);
    // Never shipped.
    for (const dev of ["vite", "vitest", "typescript", "playwright", "@playwright/test", "jsdom"]) expect(names.has(dev), dev).toBe(false);
    // The other platforms' koffi binaries are optional and not staged.
    expect([...names].filter((name) => name.startsWith("@koromix/koffi-"))).toEqual(["@koromix/koffi-win32-x64"]);
  });

  it("reads a koffi binary package as koffi itself whether or not this platform installed it, so every platform generates the same file", () => {
    // Public CI 0.19.0: Windows installs koffi-win32-x64 (no licence file) and noted it as such, Linux
    // and macOS did not install it and read koffi's MIT text, so the committed file failed there.
    const root = mkdtempSync(join(tmpdir(), "hallpass-notices-"));
    try {
      const write = (dir: string, files: Record<string, string>) => {
        mkdirSync(resolve(root, dir), { recursive: true });
        for (const [name, body] of Object.entries(files)) writeFileSync(resolve(root, dir, name), body);
      };
      write("node_modules/koffi", { "package.json": JSON.stringify({ license: "MIT" }), LICENSE: "MIT License\nkoffi text" });
      write("node_modules/@koromix/koffi-win32-x64", { "package.json": JSON.stringify({ license: "MIT" }) });
      const pkg = { name: "@koromix/koffi-win32-x64", version: "1.0.0", path: "node_modules/@koromix/koffi-win32-x64" };
      const installed = readNotice(pkg, root);
      rmSync(resolve(root, "node_modules/@koromix/koffi-win32-x64"), { recursive: true, force: true });
      const absent = readNotice(pkg, root);
      expect(installed.text).toBe("MIT License\nkoffi text");
      expect(installed).toEqual(absent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every listed package has a licence text or an explicit note, and the zip carries the file", () => {
    const generated = notices.slice(notices.indexOf(GENERATED_START), notices.indexOf(GENERATED_END));
    const rows = [...generated.matchAll(/^\| (\S+) \| (\S+) \| ([^|]+) \|$/gm)].filter(([, name]) => name !== "Package" && name !== "---");
    expect(rows.length).toBeGreaterThan(20);
    for (const [, name, version] of rows) {
      expect(generated, `${name} ${version} has a licence heading`).toContain(`#### ${name} ${version} (`);
    }
    expect(PACKAGE_ROOT_ENTRIES).toContain(NOTICES_FILE);
  });
});
