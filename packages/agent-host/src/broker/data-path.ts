import { posix, win32, type PlatformPath } from "node:path";

/**
 * #29: the path flavour for paths under `base`. The broker's own folders (the data folder, the
 * host's manifests) are Windows paths on Windows, where this is always `win32` as before. Elsewhere
 * a real folder such as `/tmp/x` takes `posix`: built with `win32.join` it became the relative name
 * `\tmp\x\...`, and a write landed in the current folder. A Windows-looking base (a drive letter, a
 * UNC root, a backslash) keeps `win32`, so a test that stands in for a Windows machine still gets
 * Windows paths on any host.
 */
export function pathFor(base: string): PlatformPath {
  if (process.platform === "win32") return win32;
  return /^[A-Za-z]:|\\/u.test(base) ? win32 : posix;
}

/** `pathFor(base).join(base, ...parts)`: a path under one of the broker's own folders. */
export const joinUnder = (base: string, ...parts: string[]): string => pathFor(base).join(base, ...parts);
