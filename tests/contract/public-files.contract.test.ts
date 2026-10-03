import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_DESCRIPTORS } from "../../packages/contracts/src/agent-tools.js";
import {
  IMPLEMENTED_AGENT_TOOL_NAMES,
  PENDING_AGENT_TOOL_NAMES,
} from "../../packages/agent-host/src/tool-offering.js";
import { isForbiddenPath } from "../../scripts/snapshot-check.js";
import { repoRoot } from "../../scripts/package.js";

/**
 * 009/T257 — what a stranger who clones the repository is handed (FR-131, FR-132, FR-134; SC-068,
 * SC-070).
 *
 * Every fact is read from the tree rather than restated: the dependency notices are checked against
 * the `package.json` files that declare the dependencies and the licence fields in `node_modules/`,
 * the README's tool table against the host's own list of tools, and the private-citation scan
 * against `git ls-files` minus the paths the snapshot check calls private.
 *
 * The citation pattern is built from parts so that this file — which has to spell it — is not its
 * own first hit; `scripts/snapshot-check.ts` and its allow-list are skipped for the same reason.
 */

const part = (...pieces: string[]): string => pieces.join("");

const CITATION = new RegExp(
  [
    part("evidence ", "§"),
    part("reference-", "behaviour-evidence"),
    part("reference-", "functional-teardown"),
    part("reference-", "extension-analysis"),
    part("reference-", "feature-matrix"),
    part("reference-", "parity-delta"),
    part("reference-", "codex-ux-analysis"),
  ].join("|"),
);

/** Files that spell the pattern on purpose: this test, the check that owns the private set, its list. */
const CITATION_EXEMPT = new Set([
  "tests/contract/public-files.contract.test.ts",
  "scripts/snapshot-check.ts",
  "scripts/snapshot-allowlist.txt",
]);

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "json", "md", "html", "css", "yml", "yaml", "txt", "ps1", "cmd", "svg",
]);

const PUBLIC_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.zh-TW.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/design-notes.md",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".gitattributes",
  "scripts/snapshot-check.ts",
] as const;

/** FR-132: the order a first-time reader needs, extra headings between any two allowed. */
const README_SECTIONS = [
  "How it differs",
  "Install",
  "First use",
  "The consent model",
  "Tools",
  "Testing",
  "Upgrading from 0.2.0",
  "Contributing",
  "Licence",
] as const;

const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

function shippedDependencies(): Array<{ name: string; version: string }> {
  const manifests = ["apps/extension/package.json", "packages/agent-host/package.json"];
  const out: Array<{ name: string; version: string }> = [];
  for (const manifest of manifests) {
    const deps = (JSON.parse(read(manifest)) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const [name, version] of Object.entries(deps)) {
      if (name.startsWith("@hallpass/")) continue;
      if (!out.some((entry) => entry.name === name)) out.push({ name, version });
    }
  }
  return out;
}

/** The licence the notices file writes for a package, read out of its table row. */
function noticedLicence(notices: string, name: string): string | undefined {
  for (const line of notices.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim().replace(/`/g, ""));
    if (cells[1] === name) return cells[3];
  }
  return undefined;
}

describe("T257 the repository carries every public document", () => {
  it("has each file FR-131 and FR-134 name", () => {
    for (const file of PUBLIC_FILES) {
      expect(existsSync(resolve(repoRoot, file)), `${file} is missing`).toBe(true);
    }
  });

  it("carries the Apache 2.0 licence verbatim", () => {
    const license = read("LICENSE");
    expect(license.trimStart().startsWith("Apache License")).toBe(true);
    expect(license).toContain("Version 2.0");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
  });
});

describe("T257 the notices name every dependency the artifacts ship", () => {
  const notices = read("THIRD_PARTY_NOTICES.md");

  it("names each runtime dependency with the version the manifest pins", () => {
    const deps = shippedDependencies();
    expect(deps.map((dep) => dep.name).sort()).toEqual(
      ["@modelcontextprotocol/sdk", "gifenc", "react", "react-dom", "zod"],
    );
    for (const { name, version } of deps) {
      expect(notices, `${name} is not in the notices`).toContain(name);
      expect(notices, `${name}'s version ${version} is not in the notices`).toContain(version);
    }
  });

  it("writes the licence each package declares for itself", () => {
    for (const { name } of shippedDependencies()) {
      const manifest = resolve(repoRoot, "node_modules", name, "package.json");
      expect(existsSync(manifest), `${name} is not installed; run npm ci`).toBe(true);
      const declared = (JSON.parse(readFileSync(manifest, "utf8")) as { license?: string }).license;
      expect(noticedLicence(notices, name), `the notices' licence for ${name}`).toBe(declared);
    }
  });
});

describe("T257 the README reads in the order FR-132 fixes", () => {
  const readme = read("README.md");
  const headings = [...readme.matchAll(/^## +(.+?)\s*$/gm)].map((match) => match[1]);

  it("opens with the platform, the licence and the demo", () => {
    const firstScreen = readme.slice(0, readme.indexOf("\n## "));
    expect(firstScreen).toContain("Windows 11");
    expect(firstScreen).toContain("Apache-2.0");
    expect(firstScreen).toContain("docs/media/demo.gif");
    expect(firstScreen).toMatch(/!\[[^\]]*]\(docs\/media\/demo\.gif\)/);
  });

  // 010/FR-144: the platform note names the four registered browsers, says which one the
  // acceptance suite runs on, marks the other two as not live-verified, and links the issue.
  it("says which browsers are registered and which are verified", () => {
    const firstScreen = readme.slice(0, readme.indexOf("\n## "));
    for (const browser of ["Google Chrome", "Chromium", "Microsoft Edge", "Brave"]) {
      expect(firstScreen, `the platform note names ${browser}`).toContain(browser);
    }
    expect(firstScreen).toContain("not live-verified");
    expect(firstScreen).toMatch(/\[issue #2]\(\.\.\/\.\.\/issues\/2\)/);
  });

  it("carries the named sections in that relative order", () => {
    const positions = README_SECTIONS.map((section) => {
      const at = headings.indexOf(section);
      expect(at, `the README has no "## ${section}" heading`).toBeGreaterThanOrEqual(0);
      return at;
    });
    expect(positions, `headings found: ${headings.join(" / ")}`).toEqual([...positions].sort((a, b) => a - b));
  });

  it("names every tool the host offers, all 37 of them", () => {
    const offered = new Set<string>([
      // A described tool the host still holds back is not offered yet.
      ...AGENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name).filter(
        (name) => !PENDING_AGENT_TOOL_NAMES.has(name),
      ),
      ...IMPLEMENTED_AGENT_TOOL_NAMES,
      // Listing tabs is answered by the host itself (`mcp-server.ts`), not by a contract descriptor.
      "tabs_context",
    ]);
    // 017 adds `propose_sites`, the thirty-fourth; 018/S4a `list_browsers` and `select_browser`;
    // 018/S5 `request_browser_choice`.
    expect(offered.size).toBe(37);
    for (const name of offered) {
      expect(readme, `the README's tool table does not name \`${name}\``).toContain(`\`${name}\``);
    }
  });
});

describe("T257 CI runs on Windows with no browser, no secret and no paid call", () => {
  const workflow = read(".github/workflows/ci.yml");
  const steps = [...workflow.matchAll(/^\s*-?\s*run: +(.+?)\s*$/gm)].map((match) => match[1] ?? "");

  it("runs the three suites and the snapshot check on windows-latest", () => {
    expect(workflow).toMatch(/runs-on: +windows-latest/);
    for (const command of [
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run build:extension",
      "npm run test:contract",
      "npm run snapshot:check",
    ]) {
      expect(steps, `no step runs ${command}`).toContain(command);
    }
  });

  it("asks for nothing a public runner cannot give", () => {
    for (const forbidden of ["HALLPASS_CDP_ENDPOINT", "playwright test", "claude -p"]) {
      const hit = steps.find((step) => step.includes(forbidden));
      expect(hit, `a step needs ${forbidden}: ${hit ?? ""}`).toBeUndefined();
    }
    expect(workflow, "the workflow reads a secret").not.toContain("secrets.");
  });
});

describe("T257 nothing public cites a private evidence document", () => {
  it("has no citation left in any file the snapshot carries", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const path of tracked) {
      if (isForbiddenPath(path) || CITATION_EXEMPT.has(path)) continue;
      if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1))) continue;
      const file = resolve(repoRoot, path);
      if (!existsSync(file)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (CITATION.test(line)) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits, `private citations survive in:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("T257 the design notes describe behaviour and name nothing private", () => {
  const notes = read("docs/design-notes.md");
  const headings = notes.match(/^## +.+$/gm) ?? [];

  it("covers the comparison and all seven behaviour sections", () => {
    expect(headings.some((heading) => heading.includes("Products we compared"))).toBe(true);
    for (const section of [1, 2, 3, 4, 5, 6, 7]) {
      expect(
        headings.some((heading) => heading.startsWith(`## §${section} `)),
        `no heading for §${section}`,
      ).toBe(true);
    }
    for (const product of ["Claude in Chrome", "Codex", "chrome-devtools-mcp"]) {
      expect(notes, `${product} is not named`).toContain(product);
    }
  });

  it("names no identifier, hash, file or teardown of a compared product", () => {
    expect(notes.match(/[a-p]{32}/), "a store identifier").toBeNull();
    expect(notes.match(/\b[0-9a-f]{40}\b/i), "a build hash").toBeNull();
    expect(notes.match(/\b[\w-]+\.js\b/), "an internal file name").toBeNull();
    expect(notes).not.toMatch(/teardown/i);
  });
});
