# POC Build and Acceptance Quickstart

**Status**: Phase 1 implementation is under packaged-runtime requalification; R-013 is resolved for the
POC by navigation deferral. The commands below are runnable acceptance interfaces. A passing source,
unit, or component suite does not establish packaged browser completion.

## What this validates

The quickstart covers exactly the seven POC MUST requirements:

1. **FR-001 (PR-001)** — open/focus/close the side-panel workspace;
2. **FR-002 (PR-002)** — establish, renew as permitted, reauthenticate, and end a product account session;
3. **FR-003 (PR-003)** — run one transient product-server-orchestrated request with progressive output and one terminal state;
4. **FR-004 (PR-004)** — collect bounded/redacted current-page context only after safety and
   current-task consent; expose current form values/selected-option state only through the separate
   current-document `page.form-values` grant;
5. **FR-005 (PR-005)** — review and sequentially execute scrolling, non-navigation low-risk click, and
   non-sensitive text entry only;
6. **FR-007 (PR-007)** — show active control and enforce local-first Stop, including panel close and interruption; and
7. **FR-008 (PR-008)** — enforce origin safety, disclosure, current-task grants, review, and revocation.

Attachments, saved prompts, schedules, recorded workflows, export, trusted product links/settings,
advanced page-code/console/network diagnostics, alternate hosted assistants, connectors, enterprise policy, notifications, multi-tab/batch
execution, assistant-initiated navigation, file upload, and irreversible high-risk actions are not enabled or
required by this guide.

## Prerequisites

- Windows 11 on the product owner's acceptance machine.
- Node.js 24 LTS with its bundled npm major and a clean dependency install.
- The then-current and immediately preceding stable desktop Chrome major versions. Record exact browser
  versions on the release evidence form; do not reuse stale major numbers from this document.
- Current stable NVDA for the designated screen-reader pass.
- No real provider credential for deterministic automated/manual acceptance. Auth, AI, and origin safety
  use local deterministic adapters with no durable task history.
- Before an external pilot, separately approve and configure one product-owned identity adapter and
  one server-side remote-AI adapter. Their smoke tests are a deployment gate, but their vendor choices
  may not alter the Extension contracts or place provider credentials in the Extension. This is not a
  prerequisite for deterministic POC acceptance.
- A live AI vendor is ineligible unless contract and account configuration prohibit request/output use
  for training and prohibit durable prompt, page, action, output, history, analytics, and content-log
  retention for this workload. Record the effective zero-retention/no-training evidence and disable
  provider-side application logging before any pilot.
- Production identity/network testing requires one stable production/release-assigned Extension ID. The exact ID must bind
  the `chrome.identity.getRedirectURL('auth/callback')` allowlist, product HTTPS CORS allowlist, and WSS
  Origin allowlist. A separate deterministic test ID/configuration must never enter a production build.
- Local acceptance trusts only a per-machine test CA created by the repository test-PKI command in the
  Windows CurrentUser store. Never commit its key/certificate, reuse it for production, or launch Chrome
  with certificate validation disabled.

## Planned repository commands

From the repository root:

```powershell
npm ci
npm run typecheck
npm test
npm run test:contract
npm run build
npm run test:certs:install
npm run test:config:verify
npm run test:e2e
npm run test:e2e:release-matrix
npm run test:release-smoke
npm run test:certs:remove
```

`npm run build` produces the production artefact and therefore requires the production identity. All
three values must be set, and a build with any of them missing or unusable fails rather than
producing an artefact pointed at nowhere:

| Variable | Value | Used by |
| --- | --- | --- |
| `HALLPASS_PRODUCTION_EXTENSION_ID` | the release-assigned Chrome Extension ID (32 characters, `a`-`p`) | manifest identity; the service's CORS allowlist entry `chrome-extension://<id>` |
| `HALLPASS_PRODUCTION_HTTPS_ORIGIN` | the product service origin, `https://` and a bare origin | extension only: manifest CSP `connect-src`; every product API call |
| `HALLPASS_PRODUCTION_WSS_ORIGIN` | the task-channel origin, `wss://` and a bare origin | manifest CSP `connect-src`; the pinned origin the task bootstrap is checked against; the service's `channelUrl` |

A production build refuses an empty value, a loopback host, a wildcard, the wrong scheme, the
deterministic test Extension ID, and anything that is a URL rather than a bare origin.

The service reads the two of these that describe the parties it must agree with — the Extension ID,
which becomes its CORS allowlist entry, and the WSS origin, which becomes the `channelUrl` it hands
back — and applies the same bare-origin rule to the WSS value, because the two are deployed
separately and neither may rely on the other having checked it. The service does not take its own
HTTPS origin: nothing in it reads that value, and a required setting nobody consumes is one an
operator can get wrong without ever finding out.

A test build takes none of them: its endpoints are the fixed loopback ones and are never reachable
from a production artefact.

```powershell
$env:HALLPASS_PRODUCTION_EXTENSION_ID = "<release extension id>"
$env:HALLPASS_PRODUCTION_HTTPS_ORIGIN = "https://api.product.example"
$env:HALLPASS_PRODUCTION_WSS_ORIGIN   = "wss://api.product.example"
npm run build
```

`npm run build:extension:test` builds the deterministic test artefact and needs none of them.

Expected command responsibilities:

| Command | Required evidence |
| --- | --- |
| `npm run typecheck` | Strict TypeScript passes for Extension, service, shared schemas, and tests. |
| `npm test` | Domain state machines, redaction, canonicalization, policy, localization, UI, service, and Chrome adapters pass. |
| `npm run test:contract` | OpenAPI/WSS/runtime schemas, exact Manifest permissions, CSP/CORS assumptions, privacy/log-redaction exclusions, inert remote-text rendering, and terminal/idempotency invariants pass. |
| `npm run build` | Creates production server output and `apps/extension/dist/production`; requires the three `HALLPASS_PRODUCTION_*` values and rejects wildcard, loopback, missing, non-origin, or non-TLS production endpoints and remote code. The manifest is generated from the build config and then checked against it, so an artefact whose manifest does not match its source fails the build. |
| `npm run test:e2e` | Starts deterministic service/fixtures, loads the unpacked MV3 build, and runs P1 observable journeys plus failure/lifecycle cases. |
| `npm run test:e2e:release-matrix` | Runs the complete deterministic P1 suite—not only transport smoke—against each exact recorded Chrome major and both locales. If a target Chrome cannot be automated, records a blocked automation cell and requires the same deterministic full-P1 manual Load unpacked evidence; bundled Chromium cannot substitute. |
| `npm run test:release-smoke` | Exercises the exact two recorded Chrome majors and fixed Extension ID: unpacked load, HTTPS POST/CORS preflight with Authorization/Content-Type, valid WSS Origin acceptance, and missing/wrong Origin rejection. Bundled Chromium cannot satisfy this gate; unsupported automated sideload is reported as blocked and requires the documented manual Load unpacked evidence rather than a false pass. |
| `npm run test:certs:install` | Generates an uncommitted per-machine test CA/leaf with DNS SAN `localhost` and IP SAN `127.0.0.1`, installs only that CA in Windows CurrentUser Root, records its exact thumbprint, and refuses an ambiguous/pre-existing identity. **The leaf is issued for seven days.** When it lapses, every packaged case fails together with `ERR_CERT_DATE_INVALID`, which reads exactly like a product regression; the harness now checks the certificate it is actually serving and stops with `test-pki.leaf-expired` and this command instead. Note that `test:certs:verify` checks the CA, not the leaf, so it stays green through this. |
| `npm run test:config:verify` | Verifies the fixed test Extension ID, exact loopback endpoint/CORS/WSS/CSP configuration, deterministic adapter mode, proxy topology, and installed CA thumbprint/SAN before any service, proxy, or browser E2E starts. |
| `npm run test:certs:remove` | Removes only the recorded test CA/leaf/thumbprint and ignored private-key material; verifies that the trust entry is absent. |

No test success substitutes for the eight manual accessibility/browser/locale passes below.

## Local deterministic run

After implementation:

```powershell
npm run test:certs:install
npm run test:config:verify
npm run dev:test-server
npm run dev:test-proxy
npm run build:extension:test
```

The first command creates/trusts the isolated test PKI; the second verifies its exact thumbprint/SAN,
the stable test Extension ID, deterministic-adapter mode, and all pinned endpoints before anything
listens. Run the in-memory auth/AI/task/safety upstream, deterministic redacting test proxy, and page
fixture service in separate terminals, then build the test Extension. The upstream listens only on
`https://localhost:18786`; the proxy is the sole Extension-facing HTTPS/WSS origin on
`https://localhost:18787`. Either server/proxy refuses to start for
missing/untrusted/wrong-SAN certificates or a mismatched test identity/configuration. Product
HTTPS/WSS uses `localhost`; the ordinary page fixture uses `127.0.0.1`. The unpacked test build retains
the exact five API permissions, adds only test-only `host_permissions: ["https://localhost/*"]` for
Chrome 142+ Local Network Access, and pins exact loopback ports in CSP. It has no host access to the
`127.0.0.1` page fixture, so page journeys still prove the `activeTab` boundary. Production build checks
must reject the loopback permission, endpoints, test CA, and test Extension ID. Automated Chrome uses
normal certificate validation and the same CurrentUser trust; `--ignore-certificate-errors` is forbidden.

In each target Chrome version:

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
   `apps/extension/dist/test`.
2. Confirm the manifest inspection shows exactly `activeTab`, `scripting`, `sidePanel`, `storage`, and
   `identity`, plus the sole test-only host pattern `https://localhost/*`; there is no `127.0.0.1` page
   host permission, optional host permission, or static content script.
3. Open the supported ordinary-DOM fixture printed by the test server.
4. Invoke the Extension action (or its `_execute_action` keyboard command). Confirm the side panel opens
   but no page content or page action request appears on the server.
5. Complete the deterministic product-account sign-in, then start a task from the panel.

On the first Chrome 142+ run, the worker probe may project unavailable before the Extension origin has
Local Network Access. Press the localized recovery action once and approve Chrome's local-network
permission prompt. The visible panel's bootstrap result must not itself show available; the following
worker projection is authoritative. Denial or dismissal leaves the same recoverable unavailable card.

### Recover from a stopped local service

1. Stop the terminal running `npm run dev:test-server`, then open or reconnect the side panel.
2. Confirm the panel first shows the localized finite checking state and, within five seconds, an
   unavailable card. It must not show authorizing or enable sign-in/task submission.
3. Confirm the card shows `https://localhost:18787`, `npm run dev:test-server`, and a localized
   manual reconnect action. Leave it open long enough to prove that no automatic polling occurs.
4. Start `npm run dev:test-server` in its own terminal and invoke the localized permission/reconnect
   action exactly once. If Chrome presents Local Network Access, approve it.
5. Confirm the action cannot be triggered again while its one bounded permission bootstrap is pending,
   then one new authoritative worker check reaches available and restores the existing session or
   presents sign-in. The bootstrap response alone must never transition the workspace.
   A delayed earlier probe/restore result must not overwrite the recovered state.

### Verify ordinary prompts and restricted-page recovery

1. While the active tab is chrome://newtab, submit hi. Expected: the deterministic direct-answer
   path reaches one success terminal without requesting page access, consent, or a content-script injection.
2. Still on chrome://newtab, submit read the page (讀取頁面 in zh-TW). Expected: one localized
   failure explains that Chrome's internal page cannot be read and tells the tester to switch to a regular
   HTTPS page. It must not display Page read finished or imply that collection completed.
3. Open the supported ordinary-DOM HTTPS fixture, resubmit the page-read request, approve the current-task
   consent, and confirm that it reaches one success terminal. This retry creates a new task; the failed task
   does not replay or resume.

### Verify the full-height task workspace

1. Complete a direct-answer task at both a wide side-panel width and approximately 300px. Expected: the
   composer touches the bottom edge, the document has no horizontal overflow, and the result area consumes
   the remaining height instead of leaving blank space below the composer.
2. Confirm the response text is read and displayed before the smaller localized terminal-status label.
3. Confirm the submitted request clears from the textarea immediately after valid submission; the composer
   stays available after terminal and remains disabled only while work or review is active.
4. Open safety, consent, Plan, grant, and active-control states. Expected: those surfaces scroll above the
   composer; the composer does not overlap or split the review content.
5. After any terminal outcome, submit a new protected page-read task. Expected: the prior task's response
   and terminal label disappear as the new task starts; safety/consent/progress content is not mixed with
   the prior terminal, exactly one localized Stop control is available while the new task is busy, and
   safety/consent/Plan review never claims active tab control. In zh-TW deterministic runs the fixed
   progress label is 處理中, not Working. Safety, Consent, and Plan must each appear as an inset review
   card with consistent inner spacing and token-styled primary/secondary actions; no review content or
   browser-default action may touch the panel edge.

After local/manual acceptance, stop the test server and run `npm run test:certs:remove`; capture the
successful exact-thumbprint removal check. Failure to clean test trust fails the local acceptance run.

## Core acceptance journey

Perform the following in both locales:

1. **Workspace** — open, focus, keyboard-navigate, close, and reopen the panel. Expected: current context
   is accurate; opening alone has no protected network/page effect.
2. **Authorization** — test signed-out, authorizing, signed-in, expired/reauthentication-required,
   policy-blocked, logout, and the renewal account-mismatch fixture. Expected: refresh `409` clears the
   local binding and projects `reauthentication-required` with `auth.account-mismatch`; no protected task runs with an
   invalid/account-mismatched session; logout clears account-bound session state. Contract fixtures
   reject plain PKCE, malformed verifier/challenge, constant/low-entropy, missing, expired, mismatched,
   duplicate, or replayed OAuth state and redirect/Extension-ID mismatch.
3. **Direct answer** — submit a deterministic request whose service fixture sends progress and success
   without any Plan or capability frame. Expected: explicit `answer-only` mode, progressive/final text,
   exactly one success terminal, and rejection of any capability frame after terminal.
4. **Ask about page / controlled form values** — submit a question on a fixture containing ordinary
   input and textarea values, a select with a current selected option, and sensitive/ambiguous fields.
   On an unknown fixture origin, first review/continue the locally authored origin-only safety-purpose
   disclosure; only then may the canonical-origin request occur. After remote allow, approve ordinary
   current-task page-read consent but initially deny/omit `page.form-values`. Expected: no
   classifier traffic precedes disclosure acknowledgment; only canonical origin reaches it; the first
   bounded result has ordinary DOM context but zero current form values and zero selected-option state.
   Repeat with the separate locally authored current-task/current-document `page.form-values`
   disclosure/grant. Expected: only bounded task-relevant ordinary input/textarea values and select
   selected-option display state conclusively classified non-sensitive may cross WSS; withholding and
   truncation/access limitations are visible; progressive output ends once.
5. **Sensitive and ambiguous fields** — populate password, hidden/file, one-time-code, payment-card,
   sensitive-autocomplete, product-credential, and ambiguous fields with distinct sentinels. Expected:
   those sentinels and their length/partial representations are absent from snapshots, WSS traffic,
   progressive output, errors, durable storage, logs, telemetry, and diagnostics; only non-value
   withholding metadata may remain.
6. **Single controlled action** — request exactly one allowed browser effect. First deny an otherwise-
   eligible request. Expected: no operation marker, dispatch, or browser effect occurs, and the product
   explains whether the task can continue or why it stopped. Resubmit and approve it. Expected: no
   artificial Plan is required; the locally derived exact target and action/text arguments, purpose,
   data, risk, and one-dispatch lifetime are explicit; one approved effect runs. Changing purpose/
   target/arguments after approval or attempting a second unplanned browser action is denied and
   requires fresh review.
7. **Controlled plan** — request a same-document fixture task containing all three allowed action categories. Expected:
   the ordered plan shows exact locally resolved targets plus action/text arguments and
   purposes/data categories before execution; denial starts nothing; approval executes only those exact
   bindings one revalidated step at a time with observable results. Mutating purpose, target, text,
   category, or arguments under the same step ID is denied and requires a new Plan version/review.
   A one-step initial Plan, absent/non-`exact` `bindingState`, pending navigation field, or capability
   outside `hallpass-v1` is rejected. After the first dispatch the Plan is immutable and no completed step can replay.
8. **Grant review/revoke** — inspect current-task grants and revoke before a pending step. Expected: the
   pending/new operation is denied; no persistent/session/site-wide consent option exists.
9. **Stop** — press Stop before dispatch, between steps, and while a fixture holds an effect response.
   Repeat by closing the side panel. Expected: local control/grants revoke immediately, no later action
   starts, remote cancellation is best effort, and an unconfirmed begun effect ends attention-required.
10. **Terminal state** — drive success, denial, cancellation, attention-required, and failure fixtures.
   Expected: every initiated task displays exactly one understandable terminal outcome.

## Safety and context matrix

| Fixture or injected condition | Expected result |
| --- | --- |
| Local origin `allow` | Still requires current-task consent; allow is not trust or consent. |
| Local origin `deny` | Blocked locally with no override and no remote classifier call. |
| Local origin `unknown`, remote `allow` | No request occurs before the reviewed safety-purpose disclosure is rendered and acknowledged; request body is exactly canonical scheme/host/effective-port origin; protected work still waits for separate consent. |
| Remote `deny`, `unknown`, expired, invalid, unavailable, or malformed | Fail closed; no dependent page collection, transmission, or action. |
| URL contains username/password, path, query, or fragment | None of those components reaches origin classification. |
| General page-read is granted but `page.form-values` is absent/denied | Approved non-value context may return; current ordinary values and select selected-option state are zero. |
| `page.form-values` is granted for the exact current document | Only bounded task-relevant ordinary input/textarea values and select selected-option state conclusively classified non-sensitive may return; sensitive/ambiguous values reveal no value, length, hash, or partial content. |
| Unsupported browser/internal/store/PDF/privileged/inaccessible page | Accurate localized unsupported state; no bypass or fabricated context. |
| Content only in iframe, Shadow DOM, canvas, or WebGL | `unsupported`/`inaccessible`, not success or fabricated answer. |
| Oversized ordinary DOM | Bounded subset plus explicit truncation disclosure using test-injected limit. |
| Tab switch | Task pauses/stops according to binding; no operation moves to the new tab. |
| Server sends `browser.navigate-same-origin`, another navigation literal, `navigation.destination`, or a pending navigation Plan field | Closed `hallpass-v1` schema rejects it before review, consent, marker creation, content dispatch, or browser effect; the task exposes unsupported capability. |
| Assistant asks for same- or cross-origin full-document, link, form, script-driven, or other navigation | Zero navigation effect; explicit unsupported result. The server cannot convert it into generic click. |
| Click target is an anchor/link, has form submit/reset/file or any URL/form action, may navigate through script, or is unclassifiable | Denied before activation, including same-origin targets. |
| Unexpected document replacement occurs during an allowed action | Never success; old context/targets/grants and complete Plan expire, no later step starts, and the result is non-success or attention-required according to effect certainty. |
| User/page performs same-origin navigation, reload, or SPA/document change | Compatibility event only: old document/targets/action grants, every form-value snapshot/grant, and complete Plan expire; later form-value access and protected actions require a fresh probe/review/grant and new Plan ID as applicable. No old step resumes. |
| User/page changes origin while an action is pending | In addition to full stale-state invalidation, exercise local allow/deny/unknown and, for unknown, remote allow/deny/unknown/invalid/unavailable. Every non-allow produces zero dispatch; local or remote allow still requires fresh current-task action review/consent before later protected work. |
| Stop, explicit form-grant revocation, or any terminal outcome | The form-value snapshot/grant expires immediately; delayed collection/result payload is dropped before WSS forwarding. |
| Target removed/replaced after plan approval | `stale-context`; no fallback selector or neighboring control is activated. |
| File input, purchase, deletion, account/security, final/public submission, ambiguous risk | No effect; explicit denied/unsupported result. |

## Post-POC Navigation Lab (not a POC release gate)

R-013 preserves technical evidence for a possible additive navigation profile, but none of it is a POC
command, task, manifest permission, or acceptance prerequisite. If the product owner later authorizes
that scope, the new profile must separately prove on both release Chrome majors:

- containment of cross-origin and same-origin redirect chains, including 3xx responses with and without
  `Content-Type`;
- no successful download/unsupported-document effect for attachment, missing-type, or non-HTML responses;
- equivalent handling for page Service Worker, CacheStorage, and synthetic redirect/response fixtures;
- the exact reviewed `declarativeNetRequest`/`alarms` permission/data surface, tab-scoped rule priorities,
  immediate Stop/terminal/tab cleanup, and alarm/startup orphan recovery; and
- fail-closed behavior for install/removal uncertainty, with no claim of navigation success or silent
  fallback. Any containment bypass or incomplete cleanup blocks that future profile's release.

## Lifecycle and no-replay checks

Automated E2E must terminate/recreate the service-worker epoch at each operation-marker state:
`prepared`, `dispatched`, `observed`, and `uncertain`.

- `prepared` work projects cancellation/`lifecycle-interruption` and is never dispatched after restart.
- `dispatched` or `uncertain` projects attention-required and never retries.
- `observed` without its memory-only exact result projects failure/`lifecycle-interruption`; it is not
  repeated or reported successful.
- Each old marker remains until its terminal/interruption projection reaches the panel (or finite expiry)
  and then is cleaned; no prior task resumes.
- Pause marker persistence or the final page probe, then close/Stop/revoke/change context before it
  resolves. Expected: the final recheck wins, no content collect/effect/result transmission starts, and
  the safely terminalized marker is cleaned only after projection. A crash before cleanup may conservatively
  become attention-required but never dispatches.
- A stale channel message, plan decision, grant, target handle, or result from an earlier epoch is rejected.
- Network loss, WebSocket loss, server lease expiry, and panel Port disconnect start no later action.
- Stop remains effective even when HTTPS/WSS cancellation is unreachable.
- If the panel control port dies while submitting Safety, Consent, or Plan input, the pending review remains
  visible instead of collapsing into indefinite progress. If Stop cannot be delivered over that port, the
  panel immediately settles to a localized cancellation while the worker disconnect fence prevents later
  protected work.

Inspect `chrome.storage.session` through the Extension service-worker tooling during an active task and
after terminal/logout. The session allowlist is exactly opaque product session ID, access/refresh
credential, expiry, account/organization binding, and in-progress auth state/verifier. Operation markers
are exactly runtime epoch, opaque task/request/account IDs, phase, and expiry. Action category, prompt,
progressive/final output, URL/origin, title, DOM/page text, plan text, grant details, target data, action
arguments/results, history, and telemetry must be absent. After logout, all account-bound keys are
absent. Browser restart or extension reload/update restores no Core history.

Run the deterministic service behind the test proxy with sentinel Authorization values, task/channel/
message/request IDs, Origin, tickets, bodies, and task-ID paths. Inspect product-service, proxy, and WSS
logs after terminal cleanup. Expected: none of the sentinels or correlatable task identifiers persist;
no operational log/counter/metric persists either. Stable codes/coarse state may appear only in active
process/UI memory and isolated test capture.

## Localization and accessibility gate

The sole product owner performs every declared primary flow in this matrix:

| Chrome | Locale | Interaction mode |
| --- | --- | --- |
| Current stable major | `en-US` | Keyboard only |
| Current stable major | `en-US` | Keyboard + current stable NVDA |
| Current stable major | `zh-TW` | Keyboard only |
| Current stable major | `zh-TW` | Keyboard + current stable NVDA |
| Previous stable major | `en-US` | Keyboard only |
| Previous stable major | `en-US` | Keyboard + current stable NVDA |
| Previous stable major | `zh-TW` | Keyboard only |
| Previous stable major | `zh-TW` | Keyboard + current stable NVDA |

All eight passes require 100% success. Record:

- exact Windows, Chrome, Extension build, Node, and NVDA versions;
- locale and fallback behavior, including one injected missing non-safety string;
- action entry, sign-in/reauthentication/logout, task input, plan/consent review, grant revoke, Stop,
  progressive status, terminal outcomes, unsupported state, and errors;
- visible focus, logical focus order, no keyboard trap, accessible names/roles/states, announced progress
  without focus theft, and understandable consent/active-control/Stop/uncertain-effect wording; and
- screenshots or recordings where useful, with no credentials or sensitive page values.

In every one of the eight passes, record the sole product owner's answer—without inspecting internal
state or this design—to fixed comprehension prompts:

1. Which current page/origin, product service, and signed-in account does this decision affect?
2. Which exact data categories will leave the Extension, or which exact target/action/text effect
   will occur, and for what purpose?
3. Is safety `allow` the same as consent, what do deny/unknown mean, and how long does this grant last?
4. Is the task currently waiting, running, stopped, succeeded, denied, cancelled, failed, or
   attention-required, and can another browser action still start?
5. If an effect is uncertain, what is known, what is not known, and why will the product not retry it?

Each answer must contain the expected user-visible facts for that fixture; all declared comprehension
cases must be correct. One wrong/ambiguous answer fails that matrix cell, requires copy/announcement
revision, and is retested rather than waived.

For deterministic review content, fixed product copy follows the selected locale. In zh-TW, page-read
purpose is 理解頁面內容, approved-action purpose is 執行一次已核准的瀏覽器操作, and Plan summaries/steps use
reviewed zh-TW text rather than English fixtures. Consent renders exactly one 資料 field whose semantic
list contains every localized category, such as 網站來源 and 可見頁面文字; it does not repeat the field
label or expose raw identifiers/JSON. The en-US path uses the corresponding reviewed English labels.

Every missing/invalid selected-locale message first falls back to its reviewed `en-US` text, including
consent, safety, active-control, Stop, and uncertain-effect copy. Only when that reviewed English
fallback is also missing or semantically ambiguous does the protected operation fail closed.

Inject hostile remote/model strings into progress, plan purpose/summary, consent-purpose detail, errors,
and terminal summary (`<script>`, event-handler markup, Markdown links, `javascript:` URLs, and control
text). Expected: bounded inert text is displayed; no HTML node, script, navigation, clickable remote
link, focus theft, or browser effect is created.

## Required evidence and exit rule

Implementation later creates versioned templates under `tests/acceptance/` for automated command logs,
exact built-manifest assertions, network/privacy capture summaries, and the eight signed manual passes.
The POC is acceptable only when:

- all planned commands pass from a clean install;
- SC-001 through SC-011 have direct evidence and every P1 case succeeds on both recorded Chrome majors;
- the sole product owner signs all eight accessibility/browser/locale passes;
- no deferred capability or broader permission is needed to complete the Core journey;
- deterministic tests show zero unauthorized protected effects, zero sensitive/ambiguous-value leaks,
  controlled ordinary form-value transmission only under the exact separate grant, no replay,
  effective Stop, and exactly one terminal result per initiated task.

### External pilot gate (post-POC, not a deterministic POC exit condition)

Before any external pilot, separately approved live identity and remote-AI adapters must pass a product
deployment smoke gate, including stable Extension-ID redirect/CORS/WSS binding and documented
no-retention/no-training provider eligibility. Until vendors are selected, deterministic acceptance
validates the POC architecture and safety boundary and may satisfy the POC exit above; it must not be
represented as a live-provider pilot. This gate is created and executed only after the separate
vendor/deployment selection.

## Existing-page recovery after extension reload

Reloading or updating the unpacked extension invalidates its old Chrome runtime context even if the
current ordinary HTTP(S) page stays open. The worker must dynamically inject the current packaged content
runtime, replace any listener retained by the page from the old context, probe it, and then collect. A
page-global boolean from the old extension context is not proof that a live listener still exists.

Automated acceptance covers both stale-guard recovery and same-document reinjection: the former must bind
a fresh listener and complete broker probe/collect; the latter must leave exactly one active listener.
For an undifferentiated collect-failed result, the UI asks the user to confirm the tab remains open and
reopen the side panel. It must not prescribe refreshing the page unless the failure reason specifically
establishes that refresh is required.

## Packaged core runtime gate (2026-08-30 rebaseline)

The first-phase core is not accepted by source-level or private-function tests alone. Build both modes,
then run the self-contained packaged Chromium gate:

```powershell
npm run build
npm run build:extension:test
npm run test:e2e:extension-core
```

The gate loads `apps/extension/dist/test` as an unpacked MV3 extension in a persistent Playwright
Chromium context and exercises the real service worker, side panel, built classic content runtime,
TLS fixture page, deterministic service, consent, DOM collection, protected action, Stop, invalidation,
and terminal projection. Production keeps zero host permissions. Chromium 151 does not accept the
documented CDP Local Network Access permission names, so this disposable context disables only that
browser-owned check. The Extension manifest/product path is unchanged, and current/previous branded
Chrome acceptance still owns the real LNA prompt and denial behavior.

Latest 2026-09-01 result: six packaged tests pass with zero skips. Playwright starts the upstream on
`18786`, then the real HTTPS/WSS redacting proxy on `18787`; the Extension never receives the
upstream address. The gate includes actual extension reload, same-document reinjection, exactly one
listener, opaque/restricted pages, separate form grants, and the full side-panel journey. Current and
previous branded-Chrome owner/LNA cells remain separate T091/T093 release gates.

Only after this gate and the normal regression commands are green should the owner perform the single
consolidated current/previous branded Chrome × locale × keyboard/NVDA T093 sign-off.
