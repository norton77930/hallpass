import { dirname } from "node:path";
import { AGENT_HOST_ALLOWED_ORIGINS, AGENT_HOST_NAME } from "./manifest.js";
import {
  isLegacyRegistration,
  nativeMessagingKey,
  NATIVE_MESSAGING_ROOTS,
  parseRegistrySubkeys,
  registryAddArguments,
  registryDeleteArguments,
  registryListArguments,
  registryQueryArguments,
} from "./windows.js";

/**
 * The registry loops of the installer, with the registry tool passed in (010/R-157).
 *
 * They used to live in `cli.ts`, which runs `main()` at import and therefore cannot be imported by a
 * test: the only way to see what the installer does to the roots was to run it against the real
 * machine. Here each loop takes the runner as a parameter and *returns* what happened per root, so
 * the CLI is left with printing and an exit code, and a unit test can fail one root and assert that
 * the others were still written (FR-140).
 */

/** The shape of `runReg`: a non-zero `reg.exe` exit is an answer (`ok: false`), never an exception. */
export type RegRunner = (args: string[]) => Promise<{ ok: boolean; output: string }>;

/** What one command did to one root; `reason` carries `reg.exe`'s message when it failed. */
export type RegistrationOutcome = {
  browser: string;
  key: string;
  outcome: "written" | "failed" | "removed" | "absent";
  reason?: string;
};

/** The table with each row's key, in table order: what every loop below walks. */
function registrationTargets(): { browser: string; key: string }[] {
  return NATIVE_MESSAGING_ROOTS.map(({ browser, root }) => ({ browser, key: nativeMessagingKey(root) }));
}

/**
 * Register the host under every root in the table, in table order.
 *
 * A root that cannot be written does not stop the others: a permission error on one browser's key is
 * no reason to leave the user with the other browsers unregistered as well. The caller decides the
 * exit code from the outcomes; nothing here throws.
 */
export async function registerAll(reg: RegRunner, manifestPath: string): Promise<RegistrationOutcome[]> {
  const outcomes: RegistrationOutcome[] = [];
  for (const { browser, key } of registrationTargets()) {
    const result = await reg(registryAddArguments(key, manifestPath));
    outcomes.push(
      result.ok ? { browser, key, outcome: "written" } : { browser, key, outcome: "failed", reason: result.output },
    );
  }
  return outcomes;
}

/**
 * Remove the host's entry from every root in the table, in table order.
 *
 * A non-zero `reg delete` is reported as `absent`, not as a failure, and the message is not read:
 * `reg.exe` is localised, so "the key was not there" and "the key could not be deleted" cannot be
 * told apart from its text, and uninstall's job is only that the entry is gone afterwards - which is
 * true in both cases for the overwhelmingly common one (nothing was registered for that browser).
 */
export async function unregisterAll(reg: RegRunner): Promise<RegistrationOutcome[]> {
  const outcomes: RegistrationOutcome[] = [];
  for (const { browser, key } of registrationTargets()) {
    const result = await reg(registryDeleteArguments(key));
    outcomes.push({ browser, key, outcome: result.ok ? "removed" : "absent" });
  }
  return outcomes;
}

/**
 * Registrations an earlier version of this host left under any of the roots (009/FR-126, 010/FR-142).
 *
 * Each subkey's default value is a manifest path; the manifest decides (`isLegacyRegistration`). The
 * key is removed; the manifest's directory is reported and left for the owner to delete, since it may
 * still hold their `config.json` and logs from the old version. A root that cannot be listed is
 * skipped: a root that does not exist has nothing legacy under it.
 *
 * The removed keys are returned rather than printed, so this loop stays a value the CLI formats.
 */
export async function removeLegacyRegistrations(
  reg: RegRunner,
  readManifest: (path: string) => Promise<string>,
): Promise<{ removedKeys: string[]; directories: string[] }> {
  const removedKeys: string[] = [];
  const removedDirectories = new Set<string>();
  for (const { root } of NATIVE_MESSAGING_ROOTS) {
    const listing = await reg(registryListArguments(root));
    if (!listing.ok) continue;
    for (const name of parseRegistrySubkeys(root, listing.output)) {
      if (name === AGENT_HOST_NAME) continue;
      const key = `${root}\\${name}`;
      const value = await reg(registryQueryArguments(key));
      const manifestPath = value.ok ? /REG_SZ\s+(.+)$/m.exec(value.output)?.[1]?.trim() : undefined;
      if (!manifestPath) continue;
      let manifest: unknown;
      try {
        manifest = JSON.parse(await readManifest(manifestPath));
      } catch {
        continue;
      }
      if (typeof manifest !== "object" || manifest === null) continue;
      if (
        !isLegacyRegistration(
          manifest as { name?: unknown; allowed_origins?: unknown },
          AGENT_HOST_ALLOWED_ORIGINS,
          AGENT_HOST_NAME,
        )
      ) {
        continue;
      }
      await reg(registryDeleteArguments(key));
      removedKeys.push(key);
      removedDirectories.add(dirname(manifestPath));
    }
  }
  return { removedKeys, directories: [...removedDirectories] };
}
