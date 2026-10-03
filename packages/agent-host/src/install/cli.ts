import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostDataDirectory, hostManifestPath, launcherPath } from "../host-paths.js";
import { uploadConfigPath, UPLOAD_CONFIG_TEMPLATE } from "../upload-policy.js";
import { createLauncherScript, createNativeHostManifest, resolveRelayEntryPath } from "./manifest.js";
import { registerAll, removeLegacyRegistrations, unregisterAll } from "./registration.js";
import { nativeMessagingKey, NATIVE_MESSAGING_ROOTS, registryQueryArguments, runReg } from "./windows.js";

/**
 * The machine-side install of the native-messaging host: two files in the per-user data directory
 * and one registry value per browser root pointing that browser at them (R-101, 010/FR-139).
 *
 * Everything decided here is a value produced by `manifest.ts`/`windows.ts`/`registration.ts` and
 * unit-tested there; this file only touches the machine and prints
 * (`specs/010-multi-browser-host/contracts/installer-output.md`). `install` is idempotent - it
 * overwrites both files and passes `/f` to `reg` - because the ordinary way to fix a stale
 * registration is to run it again.
 */

async function install(): Promise<number> {
  const dataDir = hostDataDirectory();
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();
  // Resolved from where this module actually is, never from the working directory (`manifest.ts`).
  const relayEntry = resolveRelayEntryPath(import.meta.url, existsSync);

  await mkdir(dataDir, { recursive: true });
  // The node running this installer, by absolute path: the browser's environment may not find one.
  await writeFile(launcher, createLauncherScript(relayEntry, process.execPath), "utf8");
  await writeFile(manifestPath, `${JSON.stringify(createNativeHostManifest(launcher), null, 2)}\n`, "utf8");
  /**
   * The upload configuration (US7, FR-051), created once and never overwritten.
   *
   * It exists so the owner has something to edit rather than something to discover, and it starts
   * empty, which allows no upload at all. Re-running the installer must not undo a list they have
   * since filled in, so unlike the two files above this one is only written when it is absent.
   */
  const configPath = uploadConfigPath();
  if (!existsSync(configPath)) {
    await writeFile(configPath, `${UPLOAD_CONFIG_TEMPLATE}\n`, "utf8");
  }

  const outcomes = await registerAll(runReg, manifestPath);

  process.stdout.write(`agent-host installed\n  launcher: ${launcher}\n  manifest: ${manifestPath}\n`);
  // Only what was actually written is listed: a root named on stdout is a promise that the browser
  // will find the host there, and a failed root has to break that promise loudly (010/FR-140).
  for (const { browser, key, outcome } of outcomes) {
    if (outcome === "written") process.stdout.write(`  registry: <${browser}> ${key}\n`);
  }
  for (const { browser, key, outcome, reason } of outcomes) {
    if (outcome !== "failed") continue;
    process.stderr.write(`agent-host: failed to register <${browser}> ${key}\n${reason ?? ""}\n`);
  }

  // `--keep-legacy` leaves an earlier version's registration alone: a developer registering a
  // checkout beside a QA install of 0.2.0 on the same machine wants both to keep working.
  const legacy = process.argv.includes("--keep-legacy")
    ? { removedKeys: [], directories: [] }
    : await removeLegacyRegistrations(runReg, (path) => readFile(path, "utf8"));
  for (const key of legacy.removedKeys) {
    process.stdout.write(`  removed earlier version's registration: ${key}\n`);
  }
  for (const directory of legacy.directories) {
    if (directory.toLowerCase() === dataDir.toLowerCase()) continue;
    process.stdout.write(`  earlier version's files may be deleted by hand: ${directory}\n`);
  }
  return outcomes.some(({ outcome }) => outcome === "failed") ? 1 : 0;
}

async function uninstall(): Promise<number> {
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();

  // A key that was never there is not a failure: uninstall's job is that it is gone afterwards.
  const outcomes = await unregisterAll(runReg);
  await rm(manifestPath, { force: true });
  await rm(launcher, { force: true });

  process.stdout.write(`agent-host uninstalled\n  removed: ${launcher}\n  removed: ${manifestPath}\n`);
  for (const { browser, key, outcome } of outcomes) {
    const label = outcome === "removed" ? "removed:" : "absent: ";
    process.stdout.write(`  ${label} <${browser}> ${key}\n`);
  }
  return 0;
}

async function status(): Promise<number> {
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();
  process.stdout.write(`agent-host status\n`);
  process.stdout.write(`  launcher: ${existsSync(launcher) ? "present" : "missing"} ${launcher}\n`);
  process.stdout.write(`  manifest: ${existsSync(manifestPath) ? "present" : "missing"} ${manifestPath}\n`);
  for (const { browser, root } of NATIVE_MESSAGING_ROOTS) {
    const key = nativeMessagingKey(root);
    const result = await runReg(registryQueryArguments(key));
    process.stdout.write(`  registry: ${result.ok ? "present" : "missing"} <${browser}> ${key}\n`);
  }
  return 0;
}

const COMMANDS: Record<string, () => Promise<number>> = { install, uninstall, status };

async function main(): Promise<void> {
  const command = process.argv[2] ?? "";
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`usage: agent-host <${Object.keys(COMMANDS).join("|")}>\n`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = await run();
}

await main();
