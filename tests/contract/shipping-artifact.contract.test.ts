import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const productionRoots = ["apps/extension/src", "packages/contracts/src", "packages/domain/src"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return walk(path);
    }
    return extname(path) === ".ts" || extname(path) === ".tsx" ? [path] : [];
  });
}

describe("T087 shipping artifact", () => {
  it("keeps product source free of test-kit imports", () => {
    const offenders: string[] = [];
    for (const root of productionRoots) {
      for (const file of walk(root)) {
        const relativePath = relative(process.cwd(), file).replace(/\\/g, "/");
        const text = readFileSync(file, "utf8");
        if (text.includes("@hallpass/test-kit") || text.includes("packages/test-kit")) {
          offenders.push(`${relativePath}:test-kit`);
        }
        if (text.includes("declarativeNetRequest")) {
          offenders.push(`${relativePath}:deferred-permission`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps one manifest writer, one locale writer, and no checked-in placeholder", () => {
    // Each of these was a second place the shipped artefact could come from (review H8).
    for (const path of [
      "apps/extension/public/manifest.json",
      "apps/extension/scripts/write-locales.ts",
      "apps/extension/src/manifest.ts",
    ]) {
      expect(existsSync(resolve(path)), path).toBe(false);
    }
  });

  it("names the build target in every manifest-writing script", () => {
    const extension = JSON.parse(
      readFileSync(resolve("apps/extension/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const root = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(extension.scripts.build ?? "").toContain("write-manifest.ts agent");

    // The target is always named. A target-less invocation used to write several artefacts at once,
    // so a caller could not tell which one it had asked for.
    for (const script of [extension.scripts.build ?? "", root.scripts.build ?? ""]) {
      expect(script).not.toMatch(/write-manifest\.ts(?!\s+agent)/);
    }
  });
});
