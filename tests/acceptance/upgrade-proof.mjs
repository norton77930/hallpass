/**
 * 008/T234 (a), re-run for 009/T259 — the extension side of the 0.2.0 → 0.3.0 upgrade (009 FR-125,
 * SC-065; originally 008 FR-122 for 0.1.x → 0.2.0).
 *
 * The claim is the one a QA tester cares about: replacing the unpacked `extension\` folder and
 * reloading keeps what they decided — the pairing record and every site's mode — because
 * `chrome.storage.local` is keyed by the extension id and the id is pinned by the manifest key, not
 * by the bundle. This proves it instead of assuming it (R-143).
 *
 * Why a standalone script rather than a spec in `tests/e2e/packaged/`. Every spec there is
 * attach-only: it drives the browser the owner already loaded `dist/agent` into. This proof needs
 * the opposite — a browser that starts on the *old* bundle, with a profile nobody else has written
 * to — so it launches its own Chromium per zip and never touches the attached one.
 *
 * Machine hygiene: `LOCALAPPDATA` is repointed at a scratch directory before Chromium starts, so the
 * relay Chrome spawns through native messaging publishes its `bridge.json` there and cannot disturb
 * the bridge the owner's browser is running.
 *
 *   node tests/acceptance/upgrade-proof.mjs [--old <zip> ...] [--new <zip>]
 *
 * Defaults to the 0.2.0 zip the QA team holds (its pre-rename file name) against `release/`'s 0.3.0.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "../..");

function parseArgs(argv) {
  const old = [];
  let next = resolve(repoRoot, "release/hallpass-0.3.0.zip");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--old") old.push(resolve(argv[index + 1] ?? ""));
    if (argv[index] === "--new") next = resolve(argv[index + 1] ?? "");
  }
  if (old.length === 0) {
    // `release/` is gitignored, so a checkout that has never packaged holds none of these; the two
    // versions QA may be running are named rather than globbed, so a half-built zip cannot be picked.
    // The previous release carried the pre-rename package name; the two older ones are still
    // accepted when present.
    const legacyPackageName = ["poc", "browser", "agent"].join("-");
    for (const candidate of [`release/${legacyPackageName}-0.2.0.zip`, `release/${legacyPackageName}-0.1.1.zip`]) {
      const path = resolve(repoRoot, candidate);
      if (existsSync(path)) old.push(path);
    }
  }
  return { old, next };
}

/** bsdtar, the same one `scripts/package.ts` writes the zip with; the Git Bash `tar` cannot read zip. */
function unzip(zipPath, destination) {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync(existsSync(tar) ? tar : "tar", ["-xf", zipPath, "-C", destination]);
}

/**
 * What the pairing and site-mode flows actually write.
 *
 * The shapes are the stores' own: `agentPairings` is `{ paired: PairedAgent[] }`
 * (`service-worker/pairing-controller.ts`) and `agentSiteModes` is origin → `{ mode,
 * diagnosticsGranted }` (`service-worker/site-mode-store.ts`). Writing them directly rather than
 * driving the panel is what makes this repeatable; the flows that produce them are proven by their
 * own gates.
 */
const STORED = {
  agentPairings: {
    paired: [
      {
        agentId: "upgrade-proof-agent",
        displayName: "Claude Code (upgrade proof)",
        origin: "hallpass",
        acceptedAt: "2026-09-19T00:00:00.000Z",
      },
    ],
  },
  agentSiteModes: {
    "https://httpbin.org": { mode: "skip-checks", diagnosticsGranted: true },
    "https://www.wikipedia.org": { mode: "follow-a-plan", diagnosticsGranted: false },
  },
};

function assertThat(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

/**
 * A comparable spelling of a stored value.
 *
 * `chrome.storage.local` hands records back with their keys in its own order, so two readings that
 * say the same thing do not have the same `JSON.stringify`. Sorting the keys compares what was
 * stored rather than how it came back.
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function firstWorker(context, timeoutMs = 30_000) {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: timeoutMs }));
}

async function proveOneUpgrade(oldZip, newZip, scratchRoot) {
  const label = oldZip.split(/[\\/]/).pop();
  const stage = join(scratchRoot, label.replace(/\.zip$/, ""));
  const oldExtracted = join(stage, "old");
  const newExtracted = join(scratchRoot, "new");
  const loaded = join(stage, "extension");
  const profile = join(stage, "profile");

  unzip(oldZip, oldExtracted);
  if (!existsSync(join(newExtracted, "VERSION"))) unzip(newZip, newExtracted);
  rmSync(loaded, { recursive: true, force: true });
  cpSync(join(oldExtracted, "extension"), loaded, { recursive: true });
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${loaded}`,
      `--load-extension=${loaded}`,
      "--enable-unsafe-extension-debugging",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });
  try {
    let worker = await firstWorker(context);
    const extensionId = new URL(worker.url()).host;
    const beforeVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
    assertThat(!beforeVersion.startsWith("0.3."), `${label} already reports ${beforeVersion}`);

    await worker.evaluate(async (payload) => {
      await chrome.storage.local.set(payload);
    }, STORED);

    // The upgrade itself: the folder Chrome is serving is replaced in place, then reloaded.
    rmSync(loaded, { recursive: true, force: true });
    cpSync(join(newExtracted, "extension"), loaded, { recursive: true });

    const browser = context.browser();
    assertThat(browser !== null, "persistent context has no browser");
    const session = await browser.newBrowserCDPSession();
    const nextWorker = context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate !== worker,
      timeout: 30_000,
    });
    const reloaded = await session.send("Extensions.loadUnpacked", { path: loaded.replace(/\\/g, "/") });
    assertThat(reloaded.id === extensionId, `reload produced ${reloaded.id}, not ${extensionId}`);
    worker = await nextWorker;

    const after = await worker.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const stored = await chrome.storage.local.get(["agentPairings", "agentSiteModes"]);
      const offscreen = await fetch(chrome.runtime.getURL("offscreen.html")).then((response) => response.ok);
      const source = await fetch(chrome.runtime.getURL("service-worker.js")).then((response) => response.text());
      return {
        version: manifest.version,
        permissions: manifest.permissions ?? [],
        stored,
        offscreen,
        knowsGifRecorder: source.includes("gif_recorder"),
        knowsDialog: source.includes('"dialog"') || source.includes("'dialog'"),
      };
    });

    assertThat(after.version === "0.3.0", `manifest version is ${after.version}`);
    assertThat(after.permissions.includes("offscreen"), "manifest does not declare offscreen");
    assertThat(after.offscreen, "offscreen.html is not served by the reloaded bundle");
    assertThat(after.knowsGifRecorder, "the running service worker does not name gif_recorder");
    assertThat(after.knowsDialog, "the running service worker does not name dialog");
    assertThat(
      stable(after.stored.agentPairings) === stable(STORED.agentPairings),
      `pairing changed: ${JSON.stringify(after.stored.agentPairings)}`,
    );
    assertThat(
      stable(after.stored.agentSiteModes) === stable(STORED.agentSiteModes),
      `site modes changed: ${JSON.stringify(after.stored.agentSiteModes)}`,
    );

    process.stdout.write(
      `[T234] ${label} → ${after.version}: pairing kept, modes kept, manifest ${after.version}\n`,
    );
    return true;
  } finally {
    await context.close();
  }
}

const { old, next } = parseArgs(process.argv.slice(2));
assertThat(existsSync(next), `0.3.0 zip not found: ${next} (run \`npm run package\`)`);
assertThat(old.length > 0, "no previous-version zip found; pass --old <zip>");

const scratchRoot = join(tmpdir(), "hallpass-upgrade-ext");
// Everything the browser and the relay it spawns write stays under the scratch root.
process.env.LOCALAPPDATA = join(scratchRoot, "localappdata");
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });

let failures = 0;
for (const zip of old) {
  try {
    await proveOneUpgrade(zip, next, scratchRoot);
  } catch (error) {
    failures += 1;
    process.stdout.write(`[T234] ${zip}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exit(failures === 0 ? 0 : 1);
