import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostDataDirectory, hostManifestPath, launcherPath } from "../host-paths.js";
import { uploadConfigPath, UPLOAD_CONFIG_TEMPLATE } from "../upload-policy.js";
import {
  AGENT_HOST_ALLOWED_ORIGINS,
  AGENT_HOST_NAME,
  createLauncherScript,
  createNativeHostManifest,
  resolveRelayEntryPath,
} from "./manifest.js";
import {
  isLegacyRegistration,
  NATIVE_MESSAGING_REGISTRY_KEYS,
  NATIVE_MESSAGING_ROOTS,
  parseRegistrySubkeys,
  registryAddArguments,
  registryDeleteArguments,
  registryListArguments,
  registryQueryArguments,
  runReg,
} from "./windows.js";

/**
 * Registrations an earlier version of this host left under either root (009/FR-126).
 *
 * Each subkey's default value is a manifest path; the manifest decides (`isLegacyRegistration`).
 * The key is removed; the manifest's directory is reported and left for the owner to delete, since
 * it may still hold their `config.json` and logs from the old version.
 */
async function removeLegacyRegistrations(): Promise<string[]> {
  const removedDirectories = new Set<string>();
  for (const root of NATIVE_MESSAGING_ROOTS) {
    const listing = await runReg(registryListArguments(root));
    if (!listing.ok) continue;
    for (const name of parseRegistrySubkeys(root, listing.output)) {
      if (name === AGENT_HOST_NAME) continue;
      const key = `${root}\\${name}`;
      const value = await runReg(registryQueryArguments(key));
      const manifestPath = value.ok ? /REG_SZ\s+(.+)$/m.exec(value.output)?.[1]?.trim() : undefined;
      if (!manifestPath) continue;
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof manifest !== "object" || manifest === null) continue;
      if (!isLegacyRegistration(manifest as { name?: unknown; allowed_origins?: unknown }, AGENT_HOST_ALLOWED_ORIGINS, AGENT_HOST_NAME)) {
        continue;
      }
      await runReg(registryDeleteArguments(key));
      removedDirectories.add(dirname(manifestPath));
      process.stdout.write(`  removed earlier version's registration: ${key}\n`);
    }
  }
  return [...removedDirectories];
}

/**
 * The machine-side install of the native-messaging host: two files in the per-user data directory
 * and two registry values pointing Chrome at them (R-101).
 *
 * Everything decided here is a value produced by `manifest.ts`/`windows.ts` and unit-tested there;
 * this file only touches the machine. `install` is idempotent - it overwrites both files and passes
 * `/f` to `reg` - because the ordinary way to fix a stale registration is to run it again.
 */

async function install(): Promise<number> {
  const dataDir = hostDataDirectory();
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();
  // Resolved from where this module actually is, never from the working directory (`manifest.ts`).
  const relayEntry = resolveRelayEntryPath(import.meta.url, existsSync);

  await mkdir(dataDir, { recursive: true });
  await writeFile(launcher, createLauncherScript(relayEntry), "utf8");
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

  let failures = 0;
  for (const key of NATIVE_MESSAGING_REGISTRY_KEYS) {
    const result = await runReg(registryAddArguments(key, manifestPath));
    if (!result.ok) {
      failures += 1;
      process.stderr.write(`agent-host: failed to register ${key}\n${result.output}\n`);
    }
  }

  process.stdout.write(`agent-host installed\n  launcher: ${launcher}\n  manifest: ${manifestPath}\n`);
  for (const key of NATIVE_MESSAGING_REGISTRY_KEYS) {
    process.stdout.write(`  registry: ${key}\n`);
  }
  // `--keep-legacy` leaves an earlier version's registration alone: a developer registering a
  // checkout beside a QA install of 0.2.0 on the same machine wants both to keep working.
  const legacyDirectories = process.argv.includes("--keep-legacy") ? [] : await removeLegacyRegistrations();
  for (const directory of legacyDirectories) {
    if (directory.toLowerCase() === dataDir.toLowerCase()) continue;
    process.stdout.write(`  earlier version's files may be deleted by hand: ${directory}\n`);
  }
  return failures === 0 ? 0 : 1;
}

async function uninstall(): Promise<number> {
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();

  for (const key of NATIVE_MESSAGING_REGISTRY_KEYS) {
    // A key that was never there is not a failure: uninstall's job is that it is gone afterwards.
    await runReg(registryDeleteArguments(key));
  }
  await rm(manifestPath, { force: true });
  await rm(launcher, { force: true });

  process.stdout.write(`agent-host uninstalled\n  removed: ${launcher}\n  removed: ${manifestPath}\n`);
  for (const key of NATIVE_MESSAGING_REGISTRY_KEYS) {
    process.stdout.write(`  removed: ${key}\n`);
  }
  return 0;
}

async function status(): Promise<number> {
  const manifestPath = hostManifestPath();
  const launcher = launcherPath();
  process.stdout.write(`agent-host status\n`);
  process.stdout.write(`  launcher: ${existsSync(launcher) ? "present" : "missing"} ${launcher}\n`);
  process.stdout.write(`  manifest: ${existsSync(manifestPath) ? "present" : "missing"} ${manifestPath}\n`);
  for (const key of NATIVE_MESSAGING_REGISTRY_KEYS) {
    const result = await runReg(registryQueryArguments(key));
    process.stdout.write(`  registry: ${result.ok ? "present" : "missing"} ${key}\n`);
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
