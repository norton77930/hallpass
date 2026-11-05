import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT_ENTRIES } from "../../scripts/package.js";
import {
  GENERATED_END,
  GENERATED_START,
  generatedSection,
  NOTICES_FILE,
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
