export const TEST_KIT_PACKAGE = "@hallpass/test-kit" as const;
export {
  TEST_EXTENSION_ID,
  TEST_EXTENSION_PUBLIC_KEY,
  TEST_PAGE_ALLOW_PORT,
  TEST_PAGE_DENY_PORT,
  TEST_PAGE_UNKNOWN_PORT,
} from "./build-config.js";
export { systemClock, fixedClock } from "./clock.js";
export { opaqueId } from "./ids.js";
export { createFakeChrome } from "./fake-chrome.js";
export {
  decodeGif,
  nonBackgroundPixelsIn,
  sampleColorAt,
  type DecodedFrame,
  type DecodedGif,
  type PixelRect,
  type SampledColor,
} from "./gif-decode.js";
export {
  assertTestPkiReady,
  assertLeafSans,
  assertProductionRejectsTestIdentity,
} from "./service-fixture.js";
export { PAGE_FIXTURE_HOST, pageFixtureOrigins } from "./page-fixture.js";
export {
  agentServerListingCommand,
  foreignAgentServersProblem,
  listAgentServerProcesses,
  parseAgentServerProcesses,
  type AgentServerProcess,
} from "./agent-server-processes.js";
