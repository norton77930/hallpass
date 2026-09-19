# Manifest V3 Permission Matrix

**Status**: Phase 1 final POC least-privilege contract; R-013 resolved by navigation deferral

The five-permission production shape below is the approved POC surface. The product owner resolved
[R-013](../research.md#r-013--full-document-navigation-scope-resolution-resolved--deferred-from-poc)
by deferring every assistant-initiated full-document, link, form, script-driven, or other navigation
effect. The later `declarativeNetRequest`/`alarms` containment design remains research for a post-POC
Navigation Lab; it authorizes no current manifest key, data placement, runtime state, or implementation.
All permission rules below are normative for the POC.

## Manifest shape

The production manifest is generated from reviewed source and MUST contain this permission surface:

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "sidePanel", "storage", "identity"],
  "host_permissions": [],
  "optional_permissions": [],
  "optional_host_permissions": [],
  "incognito": "not_allowed"
}
```

An implementation may omit empty optional arrays rather than emitting them. It may not add a permission
or host pattern without a new reviewed requirement, threat analysis, contract/test update, and explicit
product-owner approval. The production manifest contains no provider/reference-extension identifier,
endpoint, asset, or private protocol.

Traceability: FR-001, FR-002, FR-004, FR-005, FR-007, FR-008; CT-001, CT-003 through CT-008,
CT-010 through CT-013; Q-020; SC-002, SC-003, SC-005 through SC-008.

## Required API permissions

| Permission | Approved use | Boundary and denial behavior | Traceability |
| --- | --- | --- | --- |
| `sidePanel` | Register and open the packaged assistant workspace from the Extension action and keyboard action | Opening/focusing alone sends no page content and starts no action. If unavailable, show an unsupported-version state and do not substitute an injected page UI. | FR-001, FR-007 |
| `activeTab` | Temporary technical access after the user invokes the Extension action on the current tab | It is not consent. Access is confined to the invoked tab/current supported top-level origin. Switching tab, losing the grant, or changing origin pauses work and requires a new explicit invocation/consent as applicable. | FR-004, FR-005, FR-008, CT-003, CT-004 |
| `scripting` | Inject the packaged content runtime on demand into frame `0` in the isolated world | Used only after task, origin-safety, and current-task-consent checks. `page.form-values` uses this same on-demand injection only after its separate current-document grant; it adds no permission. Injection denial/unavailability returns unsupported or denied; no alternate broad injection occurs. | FR-004, FR-005, CT-004, CT-008 |
| `storage` | Use `chrome.storage.session` for minimum account/session security state and non-content operation markers | No `storage.local`, `storage.sync`, IndexedDB, task history, prompt/output/page/action history, or telemetry. Content scripts receive no storage access. Logout clears account-bound state. | FR-002, FR-003, FR-005, CT-007, CT-011 |
| `identity` | Run the provider-neutral account authorization redirect through `chrome.identity.launchWebAuthFlow` with Authorization Code + PKCE | No user-supplied AI-provider key and no `identity.getAuthToken` dependency. Cancellation/error leaves the user signed out; state/redirect/account binding must validate before session creation. | FR-002, CT-006 |

## Required non-permission manifest keys

| Key | Approved value or rule |
| --- | --- |
| `action` | Packaged icon/title only; the explicit primary entry point. No popup is used. |
| `background.service_worker` | Packaged ES module owning policy, credentials, product channel, and Chrome dispatch. |
| `side_panel.default_path` | Packaged same-origin side-panel HTML only. |
| `commands._execute_action` | Keyboard route to the same Extension action; no separate authority path. |
| `default_locale` | `en_US`; packaged `_locales/en_US/messages.json` and `_locales/zh_TW/messages.json` cover manifest strings. App dictionaries use `en-US` and `zh-TW` with English fallback. |
| `content_security_policy.extension_pages` | At minimum `script-src 'self'; object-src 'self'`; `connect-src` allows only `'self'` plus build-pinned product HTTPS/WSS origins. No unsafe eval, remote scripts, wildcard, data-code, blob-code, or reference origin. |
| `incognito` | `not_allowed` for the POC. |
| `minimum_chrome_version` | Set during release to the older of the two tested stable major versions; the value is release evidence, not hardcoded by this design. |

Production and deterministic-test builds use separate reviewed endpoint configuration. A production
build fails if the product HTTPS/WSS origin is missing, non-TLS, wildcarded, or a loopback/test origin.
A deterministic test build uses the same five API permissions but may add exactly
`https://localhost/*` to `host_permissions`, solely so its service worker can reach the local product
HTTPS/WSS fixture under Chrome Local Network Access. Product HTTPS/WSS stays on `localhost`; the ordinary
page fixture is served from `127.0.0.1`, so this exception does not grant standing access to the page
under test. Its CSP pins the exact HTTPS/WSS ports. A test build with any other host pattern fails, and
the production build rejects this test permission/configuration and cannot be published with it.

## Production network access without host permissions

The production Extension requests no network host permission. Its service worker connects only to product origins
listed in the Extension-page `connect-src` policy. The product service:

- allows the exact production `chrome-extension://<stable-production-extension-id>` origin through explicit
  CORS for HTTPS routes;
- validates the exact Origin header during WebSocket upgrade;
- permits only the documented methods, headers, schemas, and protocol version;
- sets `Cache-Control: no-store` on session/task/safety responses as specified;
- never uses a wildcard Access-Control-Allow-Origin with credentials; and
- treats an unexpected Extension ID, web origin, missing Origin, or unconfigured build as denial.

The origin-safety request is deliberately unauthenticated and uses omitted credentials. It sends a JSON
body containing exactly `canonicalOrigin`; browser cookies, Authorization, referrer, task/account IDs,
correlation IDs, full URL, title, and page content are absent. CORS/CSP reachability never implies
authorization, origin safety, user consent, or browser capability.

Before live authorization is enabled, the build/release gate compares the stable Extension ID-derived
`chrome.identity.getRedirectURL('auth/callback')` with the exact product-service and identity-provider
allowlist. That same Extension ID must be the sole production HTTPS CORS origin and WSS Origin. The
deterministic test ID/redirect/CORS/WSS set is separate and a production build containing it fails.

## Explicitly absent production manifest authority

The manifest MUST omit:

- page `host_permissions`, `optional_host_permissions`, `<all_urls>`, wildcard HTTP(S) patterns, and
  `externally_connectable`;
- `tabs`, `webNavigation`, `debugger`, `nativeMessaging`, `downloads`, `notifications`, `alarms`,
  `unlimitedStorage`, `cookies`, `contextMenus`, `offscreen`, and clipboard permissions;
- `webRequest`, `webRequestBlocking`, `declarativeNetRequest`, and declarative rule resources;
- static `content_scripts`, page-world script injection, and broadly exposed `web_accessible_resources`;
- microphone, camera, geolocation, background file access, and file-system authority; and
- OAuth/provider configuration for a selected identity vendor until that separate deployment choice is
  approved. The POC contract uses the provider-neutral web authorization flow only.

The implementation may use non-sensitive portions of the public `chrome.tabs` API that do not require
the `tabs` permission, but it cannot read protected tab data without the active user-triggered grant and
its own policy checks. `tabs.onUpdated` is only a change signal; every protected step still performs a
fresh active-tab, origin, top-level-document, and consent validation.

## Effective-access rules

| Situation | Required behavior |
| --- | --- |
| Panel opened but no task/page consent | Render workspace only; collect/transmit no page data and perform no page action. |
| General page-read approved without `page.form-values` | Return approved non-value page context only; current ordinary values and select selected-option state are zero. |
| `page.form-values` separately approved | Use the same temporary `activeTab`/`scripting` boundary; return only bounded task-relevant ordinary values/select selected-option state conclusively classified non-sensitive. The grant is current-task/current-document only. |
| `activeTab` not granted or revoked | Explain that the user must invoke the Extension on the intended tab; no injection or product claim of access. |
| Unsupported/restricted page | Return localized unsupported state; do not request broader permission or bypass Chrome. |
| Local origin decision `deny` | Block with no override. |
| Local origin decision `unknown` | First render/acknowledge reviewed local safety-purpose/recipient/canonical-origin disclosure; then send only canonical origin to the product safety endpoint. Anything except current valid `allow` blocks. |
| User- or page-initiated origin/document changes | Treat as compatibility events, never assistant action success; invalidate document binding, every form-value snapshot/grant, action grants, and the complete Plan, then reassess safety and request fresh consent before later protected work. |
| User denies/dismisses consent | Perform no protected read/effect and expose denial as the task outcome or pending-step result. |
| Panel closes, Stop is pressed, worker epoch changes, or account logs out | Revoke local control immediately; no later operation starts or replays. |

## Release permission test

The built production manifest is a test artifact. Contract checks MUST assert the exact required
permission set, absence of all disallowed keys/patterns, packaged-only script paths, fixed TLS
`connect-src` origins, `incognito: not_allowed`, locale files, and lack of static content scripts.
The unpacked test build is also inspected: API permissions remain the exact five, its sole host pattern
is `https://localhost/*`, no page-fixture (`127.0.0.1`) host access exists, and contract checks prove the
loopback/LNA exception cannot enter the production build. Any future navigation profile changes this
exact-set test only after a new explicit product decision and reviewed permission/data/threat/contracts
update; its separate Navigation Lab must verify tab-scoped containment and cleanup before release.
