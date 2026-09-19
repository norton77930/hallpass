/**
 * `@hallpass/agent-host` — everything that runs outside the browser: the native-messaging relay Chrome
 * spawns and the MCP server the agent spawns. Nothing here may import a Chrome type; the package is
 * plain Node so it can be unit-tested and driven over stdio without a browser.
 *
 * The package exists before it has behaviour so every later slice has one home (T001); the modules
 * that carry the transport arrive with their own tests.
 */
export const AGENT_HOST_PACKAGE = "@hallpass/agent-host";

export { encodeFrame, FrameDecoder, NATIVE_FRAME_MAX_BYTES } from "./native-frame.js";
export {
  createFrameChannel,
  dialRelay,
  DIAL_RETRY_MS,
  inspectBridgeRecord,
  isProcessAlive,
  listenAndPublish,
  readBridgeRecord,
  removeBridgeRecord,
  writeBridgeRecord,
  type BridgeRecord,
  type BridgeRecordReading,
  type DialRelayOptions,
  type FrameChannel,
  type LinkConnection,
  type LinkConnector,
  type PublishedRelay,
  type RelayDial,
} from "./bridge-link.js";
export {
  createRelayMux,
  type MuxConnection,
  type MuxVerdict,
  type RelayMux,
  type RelayMuxOptions,
} from "./relay-mux.js";
export {
  agentIdFilePath,
  bridgeFilePath,
  hostDataDirectory,
  hostManifestPath,
  launcherPath,
  type HostEnvironment,
} from "./host-paths.js";
export { CALL_TIMEOUT_MS, CallRouter } from "./router.js";
export { AGENT_HOST_NAME, AGENT_HOST_ALLOWED_ORIGINS } from "./install/manifest.js";
