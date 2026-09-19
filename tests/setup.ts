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
