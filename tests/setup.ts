import { TEST_EXTENSION_ID } from "../packages/test-kit/src/build-config.js";

process.env.HALLPASS_TEST_EXTENSION_ID ??= TEST_EXTENSION_ID;
process.env.HALLPASS_TEST_MODE ??= "deterministic";

/**
 * No Vite define runs under the test runner, and the extension treats an unset build mode as
 * production so a real artefact can never silently fall back to loopback endpoints. A unit test is
 * a test build, so it says so here; a test that means to exercise the production path stubs these
 * globals itself.
 */
(globalThis as { __HALLPASS_BUILD_MODE__?: string }).__HALLPASS_BUILD_MODE__ ??= "test";

/**
 * #29 guard: on Linux and macOS a path under a real temp folder built with `win32.join` turns into
 * one relative name like `\tmp\hallpass-conv-AB\data\...`, and the write lands in the current folder.
 * Such a name cannot exist on Windows, so this only looks elsewhere. Files run in parallel, so the
 * file this fails in may not be the one that wrote the name.
 */
if (process.platform !== "win32") {
  const { readdirSync } = await import("node:fs");
  const { afterAll } = await import("vitest");
  afterAll(() => {
    const leaked = readdirSync(process.cwd()).filter((name) => name.startsWith("\\") && name.includes("hallpass-"));
    if (leaked.length > 0) {
      throw new Error(
        `a test wrote under a Windows-style path, so it landed in ${process.cwd()} (#29); delete these and find the win32 path: ${leaked.slice(0, 5).join(", ")}`,
      );
    }
  });
}
