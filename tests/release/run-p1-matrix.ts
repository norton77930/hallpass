import { spawnSync } from "node:child_process";
import { releaseMatrixProfiles, validateReleaseEnvironment } from "./release-environment.js";

const release = validateReleaseEnvironment(process.env);
if (!release.ok) {
  console.error(release.reason);
  process.exit(2);
}
let failed = false;
for (const profile of releaseMatrixProfiles(release.value)) {
  const profileName = `${profile.channel}-${profile.locale}`;
  console.error(`release-matrix.profile-start:${profileName}`);
  const result = spawnSync(
    "npx",
    // No --reporter here: a CLI reporter flag replaces the configured array wholesale, which would
    // drop the machine-readable report the packaged gate config writes for every run.
    ["playwright", "test", "--config", "playwright.extension.config.ts"],
    {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        ...release.value,
        HALLPASS_RELEASE_MATRIX: "1",
        // Pin a distinct run directory per profile. Without it an inherited value would make all
        // profiles share one output directory and clear each other's artifacts.
        HALLPASS_GATE_RUN_ID: `${profileName}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        HALLPASS_RELEASE_PROFILE: profileName,
        HALLPASS_RELEASE_CHANNEL: profile.channel,
        HALLPASS_RELEASE_MAJOR: profile.major,
        HALLPASS_CHROME_PATH: profile.executablePath,
        HALLPASS_LOCALE: profile.locale,
      },
    },
  );
  if (result.status !== 0) {
    failed = true;
    console.error(`release-matrix.profile-failed:${profileName}`);
  }
}
process.exit(failed ? 1 : 0);
