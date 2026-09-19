import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createManifest,
  resolveBuildConfig,
  TEST_BUILD_PUBLIC_KEY,
} from "../src/build-config.ts";
import { resolveBuildTarget, type ResolvedBuildTarget } from "../build-target.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The manifest refers to these through `__MSG_*__`, so Chrome refuses to load the unpacked
 * directory unless a matching `_locales` subtree exists. The values are not duplicated here: they
 * are read back out of the in-app catalogs so the two can never drift apart.
 *
 * The catalog keys carry an `.agent` suffix (006 R-128, FR-089) - the suffix the archived narrow
 * build's own keys were distinguished from. Those keys went with it (009/T246); the suffix stays so
 * the catalogs and this reader keep naming the same entries.
 */
const MANIFEST_MESSAGE_KEYS = ["extName", "extActionTitle", "extCommandDescription"] as const;

function catalogKeyFor(key: (typeof MANIFEST_MESSAGE_KEYS)[number]): string {
  return `${key}.agent`;
}

/** Chrome locale directories use an underscore; the in-app catalogs use a hyphen. */
const LOCALES = [
  { chromeLocale: "en_US", source: "src/locales/en-US.ts" },
  { chromeLocale: "zh_TW", source: "src/locales/zh-TW.ts" },
] as const;

function readManifestMessages(sourceRelativePath: string): Record<string, { message: string }> {
  const sourcePath = resolve(rootDir, sourceRelativePath);
  const source = readFileSync(sourcePath, "utf8");
  const messages: Record<string, { message: string }> = {};
  for (const key of MANIFEST_MESSAGE_KEYS) {
    const catalogKey = catalogKeyFor(key);
    const match = new RegExp(`"${catalogKey}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(source);
    const raw = match?.[1];
    if (raw === undefined) {
      throw new Error(`${sourceRelativePath} is missing the "${catalogKey}" message`);
    }
    messages[key] = { message: JSON.parse(`"${raw}"`) as string };
  }
  return messages;
}

function writeLocales(outDir: string): void {
  for (const { chromeLocale, source } of LOCALES) {
    const localeDir = resolve(outDir, "_locales", chromeLocale);
    mkdirSync(localeDir, { recursive: true });
    writeFileSync(
      resolve(localeDir, "messages.json"),
      `${JSON.stringify(readManifestMessages(source), null, 2)}\n`,
    );
  }
}

/**
 * Vite emits an HTML entry at its source-relative path, but the extension names its documents at
 * the root: the manifest declares `side-panel.html` and `chrome.offscreen.createDocument` asks for
 * `offscreen.html` (008/T214). The emitted asset URLs are already extension-root absolute
 * (`/side-panel.js`), so a document can be moved without rewriting anything inside it.
 */
function placeEmittedDocument(outDir: string, sourceDir: string, documentName: string): void {
  const emitted = resolve(outDir, "src", sourceDir, "index.html");
  const target = resolve(outDir, documentName);
  if (!existsSync(emitted)) {
    if (existsSync(target)) {
      return; // already placed by an earlier run
    }
    if (!existsSync(outDir)) {
      return; // this mode has not been built
    }
    throw new Error(`expected a document at ${emitted} or ${target}`);
  }
  renameSync(emitted, target);
}

/**
 * Both documents are moved before the emitted `src` tree goes, so run order cannot leave a
 * half-emptied directory behind.
 */
function placeDocuments(outDir: string): void {
  placeEmittedDocument(outDir, "side-panel", "side-panel.html");
  placeEmittedDocument(outDir, "offscreen", "offscreen.html");
  rmSync(resolve(outDir, "src"), { recursive: true, force: true });
}

function write(target: ResolvedBuildTarget): void {
  const config = resolveBuildConfig(target.profile);
  const outDir = resolve(rootDir, "dist", target.outDir);
  mkdirSync(outDir, { recursive: true });
  // The artefact is loaded unpacked and has to keep one stable Extension ID across runs, which is
  // what the key pins.
  const body = createManifest(config, { publicKey: TEST_BUILD_PUBLIC_KEY });
  writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(body, null, 2)}
`);
  writeLocales(outDir);
  placeDocuments(outDir);
}

// The target decides the profile and the endpoints the artefact is built against, so it is never
// inferred. Writing several from one invocation hid which one a caller actually meant.
write(resolveBuildTarget(process.argv[2]));
