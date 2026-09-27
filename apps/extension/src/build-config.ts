/**
 * Capability profiles.
 *
 * A profile is the set of permissions an artefact declares, together with the execution backend
 * those permissions buy. It is a build-time dimension, not a runtime flag: the manifest declares
 * its permissions in the file, so one artefact that could switch profiles would have to declare
 * the union of both - which is the same as taking the wider set unconditionally.
 *
 * `agent` is the only profile this repository builds (009/T246). The archived `narrow` profile of
 * 001/002 - five API permissions, no host permission, effects through `chrome.scripting` - was
 * removed with the remote path it served. The dimension stays because it is what makes a wider
 * permission set a decision recorded here rather than a relaxation of an existing one.
 */
export const BUILD_PROFILES = ["agent"] as const;

export type BuildProfile = (typeof BUILD_PROFILES)[number];

/**
 * The agent profile's permission set. Each entry traces to an approved capability and to nothing
 * wider than that capability:
 *
 * - `nativeMessaging` — the worker opens the native-messaging port to the local host (FR-031).
 * - `tabs` / `tabGroups` — the session owns a visible tab group and answers tab context (FR-044).
 * - `alarms` — the bridge retries a connection the worker could not make (FR-033). An MV3 worker is
 *   torn down between events, so a retry held in a timer would die with it; an alarm is the only
 *   scheduler that survives the worker and is therefore the only way "retry later" can mean anything.
 *
 * - `debugger` — console, network records and page evaluation come from the DevTools protocol and
 *   from nowhere else (FR-049, FR-050, R-105). It is the widest permission in this list, which is
 *   why nothing uses it until the owner has granted diagnostics for a site: the permission makes
 *   the capability *possible*, the per-site grant makes it *allowed*, and Chrome's own "is
 *   debugging this browser" bar makes it visible while it is attached.
 *
 * - `downloads` — the worker *observes* the browser's downloads so a session can be told the name
 *   and state of a file a page produced (005/FR-076, D-005-2). Two listeners and nothing else: the
 *   extension never starts, opens, moves or removes a download, and a test holds the adapter to
 *   those two members. File upload (US7) still needs none of it: the *host* reads the owner's files
 *   under its allowed-roots rule and they cross to the page as bytes inside a native frame (FR-051).
 *
 * `identity` is absent: the agent path talks to no remote service, so it signs nobody in.
 */
export const AGENT_PROFILE_PERMISSIONS = [
  "activeTab",
  "scripting",
  "sidePanel",
  "storage",
  "nativeMessaging",
  "tabs",
  "tabGroups",
  "alarms",
  "debugger",
  "downloads",
  /**
   * 008 — image encoding for session recordings. A service worker has no canvas and no image
   * decoder, so the frames a recording collects are turned into a GIF in an offscreen document,
   * which is the only thing this permission buys (FR-121). The document speaks only
   * `chrome.runtime`: it is handed bytes and hands bytes back, reaches no tab, and makes no
   * request of its own.
   */
  "offscreen",
] as const;

/**
 * The agent profile's host permission. The agent drives tabs the owner opened on any site, and a
 * tab it must read or capture is not necessarily the active one, so `activeTab` cannot cover it
 * (FR-045, R-105).
 */
export const AGENT_HOST_PERMISSIONS = ["<all_urls>"] as const;

const PROFILE_PERMISSIONS: Record<BuildProfile, readonly string[]> = {
  agent: AGENT_PROFILE_PERMISSIONS,
};

const PROFILE_HOST_PERMISSIONS: Record<BuildProfile, readonly string[]> = {
  agent: AGENT_HOST_PERMISSIONS,
};

/**
 * The one host permission the build takes beyond the profile's, so a packaged run can reach the
 * local test page fixtures. It belongs to the build and to nothing else.
 */
const TEST_HOST_PERMISSIONS = ["https://localhost/*"] as const;

export const CSP_SCRIPT_SRC = "script-src 'self'";
export const CSP_OBJECT_SRC = "object-src 'self'";

export const TEST_BUILD_EXTENSION_ID = "adgpccmmbgnchnphfaoabfflfcepbopd";
export const TEST_BUILD_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3F4BFMcog4B3m6v/DoxOzA/e8Fw37m+V70tF5YM5kvoC6T+VOfS+CRum4qMWNLLth61tAXff244WZcdBb7hytAsZ9f1y387YRlYi8c8n56wzCN0hC+Xvu2d0bH0UIi5HgcCX3ZTKc8rWzjxOVPGAzHWQI3ztkSkJCXyXc1uE+zlV+2Ruyj30VSVuHXqeqUu0+5KcXd/NTHNasye6OZMzGcPJ+MfyRwVvDninCPmr5Ro4WdCIoSxG4pfPhmkCVAfPhHIHhhJhRDTbd233Q2rN8xm51d4iNmXVfHaRRePpwzq7NUtFxhZwHL2sJL0BjiwC2Xe2VYbiTPHxr8SB29EDrwIDAQAB";

export type ExtensionBuildConfig = {
  profile: BuildProfile;
  extensionId: string;
  permissions: readonly string[];
  hostPermissions: readonly string[];
};

/**
 * The policy an extension page runs under, and the one place it is written.
 *
 * `connect-src 'self'` names no remote endpoint because nothing in this artefact opens one: the two
 * pinned loopback origins here were the archived remote service's and were removed with it
 * (009/T246). The directive stays rather than being dropped - MV3 leaves `connect-src` unrestricted
 * by default, so removing it would widen the page's reach to every origin instead of narrowing it to
 * the extension's own. The panel speaks `chrome.runtime` ports, the offscreen document `onMessage`,
 * and the worker `connectNative`; none of those is a fetch, so none of them needs an entry.
 */
export function extensionPageCsp(): string {
  return `${CSP_SCRIPT_SRC}; ${CSP_OBJECT_SRC}; connect-src 'self'`;
}

/**
 * The single source for everything the build decides: the manifest and the CSP both come from here.
 *
 * The artefact is loaded unpacked against the local test fixtures, so its Extension ID is the one
 * the public key pins. There is no second, store-signed identity to resolve: that belonged to the
 * archived remote path (009/T246).
 */
export function resolveBuildConfig(profile: BuildProfile): ExtensionBuildConfig {
  return {
    profile,
    extensionId: TEST_BUILD_EXTENSION_ID,
    permissions: PROFILE_PERMISSIONS[profile],
    hostPermissions: [...PROFILE_HOST_PERMISSIONS[profile], ...TEST_HOST_PERMISSIONS],
  };
}

/**
 * The manifest is produced from the build config and nowhere else.
 *
 * It lives beside the configuration it reads because the build-time writer imports it without a
 * bundler: a second hand-maintained copy of the permissions and the CSP is exactly what let the
 * shipped manifest drift away from the source of truth (review H8).
 */
export type ManifestV3 = {
  manifest_version: 3;
  name: string;
  version: string;
  default_locale: "en_US";
  minimum_chrome_version?: string;
  permissions: string[];
  host_permissions?: string[];
  incognito: "not_allowed";
  action: { default_title: string };
  background: { service_worker: string; type: "module" };
  side_panel: { default_path: string };
  commands: {
    _execute_action: { suggested_key: { default: string }; description: string };
  };
  content_security_policy: { extension_pages: string };
  content_scripts?: Array<{
    matches: string[];
    js: string[];
    all_frames: boolean;
    match_about_blank: boolean;
    run_at: "document_start";
  }>;
  key?: string;
};

/**
 * The agent profile's declared content script (004 FR-062, R-117).
 *
 * Declared rather than injected, and at `document_start` in every frame: the indicator has to be
 * on a held tab from the page's first paint, and a frame the page writes into itself
 * (`about:blank`) is a frame the session still holds. The same declaration is what the frame
 * reading of S3 runs in, which is why `all_frames` is here now rather than added later.
 */
const AGENT_CONTENT_SCRIPTS = [
  {
    matches: ["<all_urls>"],
    js: ["agent-content.js"],
    all_frames: true,
    match_about_blank: true,
    run_at: "document_start" as const,
  },
];

/**
 * The version of the artefact (008 FR-122), and the one place it is written down: the packaged zip
 * takes its name from the manifest, and the MCP host answers with the same literal so a client that
 * asks who it is talking to cannot be told a different release than the one loaded.
 */
export const AGENT_EXTENSION_VERSION = "0.9.0";

export function createManifest(
  config: ExtensionBuildConfig,
  options: { publicKey?: string } = {},
): ManifestV3 {
  const manifest: ManifestV3 = {
    manifest_version: 3,
    name: "__MSG_extName__",
    version: AGENT_EXTENSION_VERSION,
    default_locale: "en_US",
    // The profile decides the permission set; the manifest only writes down what it was given.
    permissions: [...config.permissions],
    incognito: "not_allowed",
    action: { default_title: "__MSG_extActionTitle__" },
    background: { service_worker: "service-worker.js", type: "module" },
    side_panel: { default_path: "side-panel.html" },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+A" },
        description: "__MSG_extCommandDescription__",
      },
    },
    content_security_policy: {
      extension_pages: extensionPageCsp(),
    },
  };
  manifest.content_scripts = AGENT_CONTENT_SCRIPTS.map((script) => ({ ...script }));
  if (config.hostPermissions.length > 0) {
    manifest.host_permissions = [...config.hostPermissions];
  }
  if (options.publicKey) {
    manifest.key = options.publicKey;
  }
  return manifest;
}
