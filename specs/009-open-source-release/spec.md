# Feature Specification: Open-Source Release as Hallpass 0.3.0

**Feature Branch**: `009-open-source-release` (logical feature identifier; the spec was written on the
git branch `feature-009-open-source` in the `feature-008-spec` worktree)

**Feature Directory**: `specs/009-open-source-release`

**Created**: 2026-09-19

**Status**: Implemented 2026-09-19 (S1–S5); publication to the private repository done, switch to public owed to the owner — see `coverage.md`. Owner decisions D-009-1 to D-009-10 taken 2026-09-19 in a one-question-at-a-time
review; the owner then authorised specification and implementation to proceed unattended

**Input**: Owner direction of 2026-09-19, after feature 008 merged to `main`: publish what exists now
as an open-source project and keep aligning with the reference extensions afterwards. The owner asked
for an analysis of the repository first; the analysis (read-only audit plus a survey of the
open-source landscape on GitHub) found three publication blockers — the owner's machine paths and
username in tracked files and in git history, seven reference-analysis documents that name the
internals of two third-party extensions, and no licence or README — and five decisions the owner had
to take. Ten questions were then asked one at a time; every answer is recorded below.

**Authoritative Source Order**: Constitution (II clean room, III traceability, V least privilege, X
dependency discipline) → `docs/product-requirements-draft.md` (PR-020 pairing, PR-019 update
communication) → the owner's ten decisions → the repository audit of 2026-09-19 (facts, cited inline).
No reference-extension evidence applies: this feature changes how the project is published, not what
the product does.

## Why this feature exists

The product (a Chrome extension, an MCP server and a native host that let a coding agent drive the
owner's own logged-in Chrome under per-site consent) is complete enough for a QA team to use daily
(005–008). The owner wants it public. The repository, however, is a proof-of-concept workspace: it is
named `ai-browser-assistant-poc`, its packages are `@poc/*`, its MCP server is `poc-browser`, its
native host is `com.poc.agent_host`, its git history and 112 tracked probe reports carry the owner's
disk paths and Windows username, it still builds and tests an archived remote path from 001/002, and
it has no licence, no README, no CI and no contribution files. Publishing it as-is would expose
personal data, ship a name nobody chose, and present a project no stranger could build.

The GitHub survey shaped the positioning. "Agent drives a browser" is a crowded field in three
layers: autonomous agent frameworks that open their own browser (browser-use, 115k stars), the two
official MCP servers that attach to a *developer-mode* Chrome without the user's logins or any
consent step (chrome-devtools-mcp 52k, playwright-mcp 37k), and two dozen "extension + MCP" projects
that use the user's real Chrome but hand the agent everything once connected (BrowserMCP 7k and
smaller). None of them has this project's consent model — per-site modes decided in a side panel,
pair-once, tab ownership with "give me my tabs back", an owner stop. That is what the public name and
the first screen of the README must say. Every project surveyed is cross-platform and MIT; this one
is Windows-only today and will be Apache-2.0.

## Owner decisions recorded before specification

Taken 2026-09-19, in the order asked; each is binding for this feature.

| ID | Decision | Constitution touchpoint |
| --- | --- | --- |
| D-009-1 | **Publish as a new repository with no history** (Q1). All clean-up happens in the private repository on a feature branch and is merged to `main`; the public repository's first commit is a snapshot of `main`'s tracked files, taken with the version-control archive command so that untracked and ignored material cannot travel. The private repository becomes a read-only archive; development continues in the public one. Rewriting history was rejected: the paths and reports are spread over 26 commits and a missed one would need a force-push. | VI (personal data) |
| D-009-2 | **Licence: Apache-2.0** (Q2), chosen over MIT for its explicit patent grant and contributor terms — appropriate for a project that deliberately matches the behaviour of commercial products and will take outside contributions. Runtime dependencies are all MIT (react, zod, the MCP SDK, gifenc); the third-party notice written for the 007 package moves to the repository root. | X |
| D-009-3 | **Name: Hallpass** (Q3), after GitHub collision checks. The word is the project's difference: a hall pass is permission to leave the room, granted by the person in charge, one trip at a time — the per-site consent model, against the "master key" that the developer-mode MCP servers hand over. Rejected: Reins (a 410-star project in the same "restrain AI agents" domain), Leash (592, same domain), Bridle (439, agent harness), Chaperone (635), Tether (8k); and any name containing *browser*, *use*, *mcp* or *agent*, which the 115k/52k/7k-star projects own in search. Derived identifiers: repository and root package `hallpass`, workspaces `@hallpass/*`, MCP server `hallpass` (tool prefix `mcp__hallpass__*`), native host `com.hallpass.host`, host directory `%LOCALAPPDATA%\hallpass`, environment prefix `HALLPASS_*`, extension display name "Hallpass" with the zh-TW subtitle "瀏覽器代理橋接" kept. The extension's identity key does not change, so its ID, pairing and stored site modes survive the rename. | II (own identity) |
| D-009-4 | **The reference-analysis documents stay private** (Q4). The seven `docs/reference-*.md` files (the analysis and the two behaviour-evidence documents) are not published. The public repository gets one design-notes document written in the project's own words: which observable behaviours were chosen to match and why, naming Claude in Chrome, Codex and chrome-devtools-mcp only as products that were compared, with no internal detail and no "teardown" wording. Specification citations of private evidence sections are rewritten to point at the design notes or reduced to their conclusion. The owner heard the risk framing — removing identifiers would address the content-layer risk but not the optics of having studied an installed competitor — and chose the private option. | II, I |
| D-009-5 | **The specifications go public as `docs/specs/`; the archived remote path is removed** (Q5). The 001–008 spec trees (73 files, not translated) are the fullest record of why the product is shaped as it is. `apps/server`, the `narrow` build and everything that exists only for them are removed, leaving five workspaces and one path: extension, MCP server, native host. | III |
| D-009-6 | **Windows-only is stated, not fixed** (Q6). The README's first screen says Windows 11 + Chrome; macOS/Linux support is opened as public issue #1 with the change boundary named (host paths, installer, native-host manifest directory). Chromium-family browsers are "registered for, unverified". | XI |
| D-009-7 | **English README first; Traditional Chinese documents kept, not translated** (Q7). The root README is English; a short `README.zh-TW.md` links to the Chinese operations and QA guides, which move to `docs/zh-TW/` after their machine paths are removed. | — |
| D-009-8 | **One CI workflow and the standard community files** (Q8): a Windows workflow running typecheck, unit and contract tests (no browser); the packaged gate and the paid probes stay a maintainer's local step and the README says so. CONTRIBUTING (build, test, the two-attempts rule, the clean-room boundary), SECURITY (private vulnerability reporting), CODE_OF_CONDUCT (Contributor Covenant), bug and feature issue templates. | VII, II |
| D-009-9 | **First public version 0.3.0** (Q9): the rename is an incompatible change for an installed 0.2.0 (new MCP server name, new host directory), so the minor version rises; tag `v0.3.0`; a GitHub release carries the zip. The repository is created private, the snapshot pushed, CI made green and the README reviewed on the web before it is switched to public. 1.0 waits for cross-platform support and a QA cycle. | PR-019 |
| D-009-10 | **This feature runs before the viewport work** (Q10), which becomes 010. The QA team keeps 0.2.0 untouched until the 0.3.0 zip and an updated QA guide exist, then switches once. | — |

## Traceability

| Requirement | Source | Verified by |
| --- | --- | --- |
| FR-124–FR-127 (identity) | D-009-3, D-009-9 | contract tests on shipped artifacts; upgrade proof |
| FR-128–FR-130 (what leaves the private repository) | D-009-1, D-009-4, D-009-5 | snapshot check; contract test on the exported file set |
| FR-131–FR-135 (what the public reader gets) | D-009-2, D-009-6, D-009-7, D-009-8 | file presence + content checks; CI run on the public repository |
| FR-136–FR-138 (release) | D-009-9, D-009-10 | package build; release proof |
| SC-063–SC-070 | — | `coverage.md` of this feature |

## Acceptance standard *(binding for every requirement below)*

Two standards apply, because this feature has two kinds of claim.

- **Product claims** (the renamed bridge still works, 0.2.0 upgrades to 0.3.0) close on the 004
  standard: the packaged gate in attach mode on a real Chrome, scripted, with a timestamped report;
  and the 007/008 upgrade proof re-run for 0.2.0 → 0.3.0.
- **Publication claims** (nothing private leaves, a stranger can build it) close on the **snapshot**:
  the exported file set of `main`, unpacked into an empty directory on this machine, installed from
  scratch, built, tested and packaged without reference to the private checkout; and a check that
  scans every exported file for the forbidden patterns listed in FR-129. The first CI run on the
  public repository is part of the evidence and is recorded in `coverage.md`.

Nothing is handed to the owner to verify except the two acts only they can perform: reviewing the
README on the web and switching the repository to public.

**Process rule (owner, 2026-09-18)** still applies: an implementation task that fails its second
attempt is not tried a third time; the main session takes a measurement or reads the material and
re-briefs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A stranger finds the repository and understands it in one screen (Priority: P1)

A developer who already uses chrome-devtools-mcp with Claude Code lands on the repository. In the
first screen they read what Hallpass is, how it differs from what they use (their own logged-in
Chrome; every site and every action gated by them in a side panel), that it is Windows-only today,
and the licence. A demo GIF shows a consent card being answered. Below the fold: install in four
steps, first use, the consent model, the tool table, a comparison table, how to run the tests, how to
contribute.

**Why this priority**: the README is the product for everyone who has not installed it; without it
the rest of this feature is invisible.

**Independent Test**: the README exists, is English, and contains each of the named sections; the
install steps it gives are the exact steps the snapshot proof (US3) executes.

**Acceptance Scenarios**:

1. **Given** the public repository, **When** the reader opens it, **Then** the first screen (the text
   before the first second-level heading) names the product, the one-sentence difference, the
   platform statement and the licence, and shows one demo GIF recorded by the product's own recorder.
2. **Given** the README, **Then** it has these sections in this order: what it is, how it differs
   (comparison against chrome-devtools-mcp, playwright-mcp and BrowserMCP on: runs in your everyday
   Chrome / keeps your logins / per-site consent / owner stop / recording / platform), install,
   first use, consent model, tools, testing, contributing, licence.
3. **Given** a Chinese-reading QA tester, **When** they open `README.zh-TW.md`, **Then** it says in
   one screen what the project is and links to the Chinese operations guide and QA guide under
   `docs/zh-TW/`.
4. **Given** the README's install steps, **Then** no step names a path on the maintainer's machine;
   every path is relative to the clone or is a Windows environment variable.

---

### User Story 2 - The bridge works under its new name and 0.2.0 upgrades cleanly (Priority: P1)

A QA tester on 0.2.0 receives the 0.3.0 zip and the updated QA guide. They run the old uninstall,
unzip 0.3.0, run its install, reload the extension, and re-register the MCP server under its new name.
Their pairing and their per-site modes are still there; their upload roots have to be entered again in
the new host directory, and the guide says so. Their coding agent's tools are now `mcp__hallpass__*`.

**Why this priority**: a rename that breaks the one team using the product is a regression, not a
release.

**Independent Test**: the 008 upgrade proof re-run for 0.2.0 → 0.3.0 on a paired scratch profile, plus
the full packaged gate on the renamed build.

**Acceptance Scenarios**:

1. **Given** a scratch profile paired with 0.2.0 holding two stored site modes and an upload root,
   **When** 0.2.0 is uninstalled and 0.3.0 installed and the extension reloaded, **Then** the pairing
   and both site modes are present, the extension's ID is unchanged, the new host is registered under
   `com.hallpass.host` for both the Chrome and Chromium registry locations, and the first tool call
   from an MCP server registered as `hallpass` succeeds without a pairing card.
2. **Given** the 0.3.0 installer runs while the 0.2.0 host registration still exists, **Then** the
   installer removes the legacy `com.poc.agent_host` registration, reports that it did, and leaves
   the legacy directory for the user to delete (the README and QA guide tell them to).
3. **Given** the packaged gate (every `agent-*` spec of 003–008) on the renamed build, **Then** it is
   green, and every answer, log line and panel string that used to carry a `poc` identifier now
   carries the Hallpass one.
4. **Given** the side panel in zh-TW, **Then** the extension's name reads "Hallpass" with the subtitle
   "瀏覽器代理橋接"; in every other locale it reads "Hallpass".
5. **Given** a recording exported by 0.3.0, **Then** its watermark reads `Hallpass 0.3.0` (008
   D-008-3: the watermark is the manifest's name and version at run time — no code change, one
   assertion).

---

### User Story 3 - Nothing private leaves, and the snapshot builds on its own (Priority: P1)

The maintainer produces the public snapshot. It contains no path from their machine, no username, no
probe report, no reference-analysis document, no archived server, no speckit tooling, no session
configuration. Unpacked into an empty directory, it installs, type-checks, passes unit and contract
tests and produces the 0.3.0 zip, with nothing read from the private checkout.

**Why this priority**: this is the blocker the audit found; publishing without it is the one mistake
that cannot be undone.

**Independent Test**: the snapshot check (scan for forbidden patterns and forbidden paths, zero hits)
and the from-scratch build proof, both scripted, both with a report.

**Acceptance Scenarios**:

1. **Given** `main` after this feature, **When** the archive command exports it, **Then** the export
   contains none of: `docs/reference-*.md` (all seven),
   `tests/acceptance/probe-004/reports/**`, `apps/server/**`, `.specify/**`, `.claude/**`,
   `CLAUDE-CODE-HANDOFF.md`, `.mcp.json`, `.scratch/**`, `tests/acceptance/*checkpoint*.md`,
   `tests/acceptance/owner-remaining-runbook.md`, `tests/acceptance/local-run-checklist.md`.
2. **Given** the export, **When** every file in it is scanned, **Then** there are zero occurrences of
   the maintainer's Windows username, the private checkout's drive path (either slash style), the
   two reference extensions' store identifiers, the reference bundle's build hash, and any of the
   legacy identifiers `@poc/`, `poc-browser`, `poc-agent-host`, `com.poc.`, `POC_` — except inside
   the change-log and upgrade sections that name the legacy identifiers on purpose (an explicit
   allow-list of files and lines).
3. **Given** the export unpacked into an empty directory on a machine with only Node 24 and npm,
   **When** `npm ci`, the type-check, the unit suite, the contract suite and the package command run,
   **Then** all succeed and the zip is `release/hallpass-0.3.0.zip`.
4. **Given** the private repository, **Then** the excluded paths are still tracked there (the archive
   is the only place they are absent), and `tests/acceptance/probe-004/reports/` is additionally
   ignored for future commits so new reports never enter history.

---

### User Story 4 - A contributor can build, test, and follow the rules (Priority: P2)

Someone opens a pull request. CI runs the type-check, unit and contract suites on Windows and posts a
green check. CONTRIBUTING told them how to build, which tests need a real Chrome and how to run them
locally, that a task is not retried a third time after two failures, and that reference extensions may
be observed but never copied. SECURITY told them where to report a vulnerability privately. The
specifications under `docs/specs/` explain every requirement, and no requirement points at a document
that is not there.

**Why this priority**: the first outside pull request and the first vulnerability report are the two
moments a project looks either maintained or abandoned.

**Independent Test**: file presence and content checks in the contract suite; the CI workflow's first
run on the public repository; a scan of `docs/specs/**` for dangling evidence references.

**Acceptance Scenarios**:

1. **Given** the public repository, **Then** `LICENSE` is the Apache-2.0 text, `THIRD_PARTY_NOTICES.md`
   lists every runtime dependency with its licence, and `CONTRIBUTING.md`, `SECURITY.md`,
   `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md` exist.
2. **Given** a push or pull request, **Then** one workflow runs on `windows-latest`: install, type-check,
   unit, contract; nothing in it needs a browser, a paid call or a secret.
3. **Given** `specs/**`, **When** scanned for a citation of a private evidence section or a private
   reference document's file name, **Then** there are zero hits; each former citation either
   points at a section of `docs/design-notes.md` or states its conclusion inline.
4. **Given** `docs/design-notes.md`, **Then** it names the three compared products, lists each matched
   behaviour with the reason it was matched (cursor glide, per-action recording frames, chained dialog
   consent, tab groups and banner, honest resize), states in one paragraph that the implementation is
   independent and that no source, asset or private identifier of any compared product was used, and
   contains no store identifier, version, build hash, file name or internal name of those products.

---

### User Story 5 - The release exists and the owner has two buttons left (Priority: P2)

The public repository exists (private at first) with the snapshot as its only commit, CI green, tag
`v0.3.0`, and a release carrying `hallpass-0.3.0.zip`. The owner reads the README on the web and
presses "make public". Issue #1 ("macOS and Linux support") is already open with the change
boundary named.

**Why this priority**: the deliverable of an open-source feature is a repository, not a branch.

**Independent Test**: the repository, tag, release asset and issue exist and are recorded in
`coverage.md` with their addresses.

**Acceptance Scenarios**:

1. **Given** the snapshot pushed, **Then** the repository has exactly one commit on its default branch,
   its CI run is green, tag `v0.3.0` points at that commit, and the release attached to the tag
   carries the zip whose checksum matches the one the snapshot build produced.
2. **Given** the private repository, **Then** its `main` carries this feature merged, and a final note
   in `docs/zh-TW/operations-guide.md` and in the private `CLAUDE-CODE-HANDOFF.md` says where
   development continues.
3. **Given** the QA team, **Then** the updated QA guide (0.3.0 names, the upgrade steps, the new tool
   prefix) is published to the same page as before, so their bookmark still works.

---

### Edge Cases

- **The old MCP registration remains in the user's Claude Code configuration.** `poc-browser` would
  point at a path that no longer has a `mcp-server.js` under the old package name. The README and
  QA guide give the two commands (remove old, add new); the 0.3.0 installer prints them at the end.
- **Two native hosts registered at once** (0.2.0 not uninstalled). The 0.3.0 installer removes the
  legacy registration itself (US2 scenario 2); Chrome only ever asks for `com.hallpass.host`.
- **The extension was loaded unpacked from the old `dist/agent` path.** After the rename the build
  output path is unchanged (`apps/extension/dist/agent`), so a reload suffices; the display name
  changes on reload.
- **A contributor's fork on macOS.** CI is Windows-only; the README's platform statement and issue
  #1 tell them what is missing. Nothing in the snapshot claims to run elsewhere.
- **A forbidden pattern legitimately needed in public text** (the upgrade section must name
  `poc-agent-host` to say "delete this directory"). The scan's allow-list names those lines; any new
  occurrence fails the check.
- **The snapshot check is run in the public repository.** The exclusions are expressed in a tracked
  attributes file, so the public repository carries a check that has nothing to exclude and stays
  green; the forbidden-pattern scan keeps protecting future commits there.

## Requirements *(mandatory)*

### Functional Requirements

**Identity**

- **FR-124 (D-009-3 — MUST)**: The product's identifiers MUST be, everywhere they are visible to a
  user, an agent, the browser or the operating system: display name "Hallpass" (zh-TW subtitle
  "瀏覽器代理橋接"), root package and repository `hallpass`, workspace packages `@hallpass/*`, MCP
  server `hallpass`, native host `com.hallpass.host`, host directory `%LOCALAPPDATA%\hallpass`,
  environment-variable prefix `HALLPASS_*`, package `release/hallpass-<version>.zip`. A contract test
  MUST pin each of these on the built artifacts (both manifests, the host manifest, the MCP server's
  advertised name, the package file list) and MUST fail on any remaining `poc` identifier in a shipped
  file.
- **FR-125 (PR-020 — MUST)**: The extension's identity key MUST NOT change, so that its ID, an existing
  pairing and every stored site mode and diagnostics grant survive the upgrade; the upgrade proof
  MUST show them present after 0.2.0 → 0.3.0.
- **FR-126 (D-009-9 — MUST)**: The 0.3.0 installer MUST register `com.hallpass.host` for both the
  Google Chrome and the Chromium registry locations, MUST remove a legacy `com.poc.agent_host`
  registration if present and say so in its output, MUST leave the legacy directory in place, and MUST
  end by printing the two MCP-registration commands (remove `poc-browser`, add `hallpass`). The 0.3.0
  uninstaller MUST remove only the 0.3.0 registration and directory.
- **FR-127 (MUST)**: The `narrow` build, `apps/server`, and every test, configuration entry and document
  that exists only for them MUST be removed; the remaining five workspaces MUST type-check, and the
  unit and contract suites MUST be green with the removed cases gone rather than skipped. Contract
  tests that compared the two builds' manifests MUST be rewritten to assert the `agent` manifest alone.

**What leaves the private repository**

- **FR-128 (D-009-1, D-009-4, D-009-5 — MUST)**: The public snapshot MUST be produced by the
  version-control archive of `main`, and the following MUST be excluded from that archive by a
  tracked attributes file: the reference-analysis documents, the probe report directory, `apps/server`
  (until removed), the speckit and assistant tooling directories, the hand-off document, the session
  MCP configuration, the scratch directory, and the owner-only acceptance checklists. The private
  repository MUST keep tracking those files.
- **FR-129 (VI — MUST)**: A snapshot check MUST scan every file of the archive for: the maintainer's
  Windows username, the private checkout's path in both slash styles, the two reference extensions'
  store identifiers, the reference bundle's build hash, and the legacy identifiers `@poc/`,
  `poc-browser`, `poc-agent-host`, `com.poc.`, `POC_`. It MUST report zero hits outside an explicit
  allow-list of file-and-line entries for text that names a legacy identifier on purpose (upgrade
  instructions, change logs), and it MUST be runnable in both the private and the public repository.
- **FR-130 (III — MUST)**: The specification trees of 001–008 MUST be published under `docs/specs/`
  with every citation of a private evidence document rewritten to cite `docs/design-notes.md` or
  reduced to its conclusion; the two coverage files and the three test files that carry the
  maintainer's paths MUST be scrubbed; `tests/acceptance/probe-004/reports/` MUST be ignored for
  future commits.

**What the public reader gets**

- **FR-131 (D-009-2, X — MUST)**: The repository root MUST carry `LICENSE` (Apache-2.0, verbatim) and
  `THIRD_PARTY_NOTICES.md` listing every runtime dependency of the shipped artifacts with its licence
  (react, react-dom, zod, the MCP SDK, gifenc), replacing the notice section of the package README.
- **FR-132 (D-009-7 — MUST)**: The root `README.md` MUST be English and MUST contain, in order: first
  screen (name, one-sentence difference, platform statement, licence, demo GIF), how it differs
  (comparison table against chrome-devtools-mcp, playwright-mcp and BrowserMCP), install (four steps
  from the release zip, and the from-source path), first use (pairing card, first consent card),
  consent model (three site modes, diagnostics grant, upload roots, downloads), tools (all 31, one line
  each), testing (unit/contract in CI; gate and probes local, how), upgrading from 0.2.0, contributing,
  licence. `README.zh-TW.md` MUST exist, be one screen, and link to `docs/zh-TW/operations-guide.md`
  and `docs/zh-TW/qa-guide.html`.
- **FR-133 (D-009-4, II — MUST)**: `docs/design-notes.md` MUST exist and MUST: name Claude in Chrome,
  Codex and chrome-devtools-mcp as compared products; list each behaviour chosen to match with its
  reason; state the independent-implementation position in one paragraph; and contain no store
  identifier, version number, build hash, file name, internal name or "teardown" wording for any of
  them. The Chinese operations and QA guides MUST move to `docs/zh-TW/` with every machine path
  replaced by a relative path or an environment variable, updated to 0.3.0 names.
- **FR-134 (D-009-8 — MUST)**: `.github/workflows/ci.yml` MUST run on push and pull request on
  `windows-latest`: install, type-check, unit, contract — nothing requiring a browser, a paid call or a
  secret. `CONTRIBUTING.md` MUST cover build, the three CI suites, the local gate and probes, the
  two-attempts rule and the clean-room boundary; `SECURITY.md` MUST direct reports to GitHub's
  private vulnerability reporting; `CODE_OF_CONDUCT.md` MUST be the Contributor Covenant; the two
  issue templates MUST exist.
- **FR-135 (D-009-6 — MUST)**: The README's first screen MUST state "Windows 11 and Google Chrome;
  Chromium-family browsers are registered for but unverified; macOS and Linux are not supported yet —
  see issue #1", and issue #1 MUST exist on the public repository naming the change boundary (host
  path resolution, installer, native-host manifest location).

**Release**

- **FR-136 (D-009-9 — MUST)**: The product version MUST be 0.3.0 in the extension manifest, the host
  package, the package file name and the README; the upgrade proof of 008 MUST be re-run for 0.2.0 →
  0.3.0 and its report kept.
- **FR-137 (D-009-9 — MUST)**: The public repository MUST be created private under the owner's GitHub
  account with the snapshot as its single commit, CI green, tag `v0.3.0`, and a release attached to
  the tag carrying `hallpass-0.3.0.zip`; switching it to public is the owner's act and is recorded as
  owed, not done.
- **FR-138 (D-009-10 — MUST)**: The QA guide MUST be updated for 0.3.0 (names, tool prefix, upgrade
  steps, re-entering upload roots) and republished to its existing page; the private repository's
  hand-off document and the Chinese operations guide MUST each end with a note saying where
  development continues.

### Key Entities

- **Snapshot**: the archive of `main`'s tracked files minus the excluded paths; the unit of
  publication. Attributes: source commit, file count, checksum of the produced zip.
- **Forbidden pattern**: a string whose presence in the snapshot fails the check; has an allow-list of
  (file, line) exceptions.
- **Legacy identifier**: a 0.2.0 name (`poc-browser`, `com.poc.agent_host`, `poc-agent-host`) that the
  installer and the documents may name only to tell the user to remove it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-063**: The snapshot check reports 0 forbidden-path hits and 0 forbidden-pattern hits outside
  the allow-list, on `main` after merge.
- **SC-064**: The snapshot unpacked into an empty directory completes install, type-check, unit,
  contract and package in one scripted run with exit code 0 and produces `release/hallpass-0.3.0.zip`.
- **SC-065**: The 0.2.0 → 0.3.0 upgrade proof shows the pairing, 2/2 stored site modes and the
  extension ID unchanged, and the first tool call after the upgrade succeeds without a pairing card.
- **SC-066**: The packaged gate (all `agent-*` specs) is green on the renamed build on a real Chrome in
  attach mode.
- **SC-067**: The contract suite contains a test that fails when any shipped file carries a `poc`
  identifier, and it passes.
- **SC-068**: `docs/specs/**` contains 0 references to private evidence documents.
- **SC-069**: The public repository's first CI run is green; tag `v0.3.0` and the release asset exist;
  the asset's checksum equals the snapshot build's.
- **SC-070**: The README contains every section named in FR-132 in that order, and the repository root
  contains every file named in FR-131 and FR-134.

## Assumptions

- The owner's GitHub account is the one `gh` is authenticated as on this machine; the repository is
  created there, private, named `hallpass`. If a repository of that name already exists under the
  account, the feature stops and asks.
- The extension's identity key is a public key and remains in the manifest source; keeping it is what
  preserves the ID across the rename. No private key is or will be in either repository.
- The demo GIF is recorded with the product's own recorder against a public page (the Wikipedia
  navigate-type-click flow of 008) and committed under `docs/media/`; it is the only binary added.
- The `narrow` build's removal takes the 001/002 remote path's tests and checkpoints with it; their
  specs stay under `docs/specs/001-…` and `002-…` as history, with a one-line status note that the
  remote path was retired in 003 and removed in 009.
- Chrome's rejection of `--remote-debugging-port` on the default profile, and the private-`LOCALAPPDATA`
  gate recipe of 008, are unchanged; the gate for this feature runs the way 008's did.

## Out of scope

- macOS and Linux support (issue #1); a Chrome Web Store listing; an npm publication of any package;
  translating the Chinese documents; renumbering the 001–008 specs or their requirement IDs; the
  viewport/zoom/upload_image work (010); any change to product behaviour beyond the rename.

## Change Log

| Date | Change | Source |
| --- | --- | --- |
| 2026-09-19 | Created from the owner's ten decisions | Grill of 2026-09-19 |
