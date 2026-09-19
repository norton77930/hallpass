import type { BuildProfile } from "./src/build-config.ts";

/**
 * What a build command names on the command line.
 *
 * A *target* is the one word that picks the profile and the directory the artefact lands in. There
 * is one of them: 001/002's `production` and `test` targets were the archived remote path's and were
 * removed with it (009/T246). Keeping the mapping here means the Vite configs, the manifest writer
 * and the artefact checks cannot disagree about what `agent` means.
 */
export const BUILD_TARGETS = ["agent"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

export type ResolvedBuildTarget = {
  target: BuildTarget;
  profile: BuildProfile;
  /** The artefact is loaded unpacked against the local test fixtures; it carries no store identity. */
  mode: "test";
  /** The `dist/` subdirectory, which is the target's own name - one target, one artefact. */
  outDir: BuildTarget;
};

export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

/**
 * The define the bundle reads about its own build.
 *
 * Both keys for the same value: a bare identifier define does not rewrite
 * `globalThis.__HALLPASS_BUILD_MODE__`, and the source reads it through `globalThis` so it stays safe
 * under vitest where no define runs at all.
 */
export function buildTargetDefine(target: ResolvedBuildTarget): Record<string, string> {
  return {
    "globalThis.__HALLPASS_BUILD_MODE__": JSON.stringify(target.mode),
    __HALLPASS_BUILD_MODE__: JSON.stringify(target.mode),
  };
}

export function resolveBuildTarget(value: string | undefined): ResolvedBuildTarget {
  if (value === undefined || !isBuildTarget(value)) {
    // The target decides the permissions the artefact is built against, so it is
    // never inferred (the rule the mode argument already carried).
    throw new Error(`expected an explicit build target: ${BUILD_TARGETS.join(" | ")}`);
  }
  return { target: value, profile: "agent", mode: "test", outDir: value };
}
