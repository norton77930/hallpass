# Feature Specification: macOS and Linux for the Outside-Agent Bridge

**Feature Branch**: `feature-028-macos-linux` (from main ac53ea9, 0.17.0, after 027)

**Feature Directory**: `specs/028-macos-linux`

**Created**: 2026-10-28

**Status**: Draft. D-028-1..3 put to the owner on 2026-10-28 and accepted as recommended.

**Input**: Issue #1 (opened at 0.3.0): Hallpass runs on Windows 11 only; the product is plain Node and Chrome,
and what is Windows-specific is the installation - the data folder, the host registration through the
registry, the `.cmd` launcher and the PowerShell scripts.

**Facts checked 2026-10-28**: since 0.3.0 the side-panel conversations (019-027) added a broker whose
agent installs, launches, process ends, folder dialogs and environment reads are Windows-specific (job
objects, `where.exe`, `cmd.exe`, `taskkill`, the registry). The outside-agent bridge - an agent's MCP
server, the relay Chrome starts, the extension - depends only on the data folder and the installation.
On macOS and Linux Chrome finds a native-messaging host from a manifest file in a fixed per-user folder per
browser, not from the registry, and starts its `path` directly, so the launcher is a shell script.

**Decisions (D-028-n, confirmed by the owner)**:

- **D-028-1 — the bridge only** (Q1): outside coding agents can use the browser through Hallpass on macOS
  and Linux. Side-panel conversations stay Windows-only for now; on macOS and Linux the side panel and the
  settings page say so instead of offering them.
- **D-028-2 — Linux and macOS** (Q2): both are supported. Linux is verified in this work; macOS follows the
  browsers' documented folders and is marked not yet verified on a Mac until someone with one reports.
- **D-028-3 — CI on Linux and macOS, Windows-only tests marked** (Q3): CI gains Linux and macOS jobs for the
  browser-less suites; each test that can only pass on Windows says so and runs on Windows only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install on macOS or Linux (Priority: P1)

The owner unpacks the release on macOS or Linux, runs `./install.sh`, loads the extension, and their coding
agent's browser tools work: the first call pairs, cards appear in the side panel, actions run.

**Acceptance Scenarios**:

1. **Given** Linux or macOS with Node 24 and Chrome, **When** the owner runs `install.sh`, **Then** the host
   files are in the per-user data folder and a host manifest is in each installed browser's per-user
   native-messaging folder (Chrome, Chromium, Edge, Brave); the output lists each one written.
2. **Given** the extension is loaded, **When** a coding agent calls a Hallpass tool, **Then** the pairing
   card appears, as on Windows.
3. **Given** `install.sh` is run again, **Then** it rewrites the same files and nothing else.
4. **Given** `uninstall.sh`, **Then** the manifests and launcher are removed (and the skill, as 026 FR-421).

### User Story 2 - Side-panel conversations say they are Windows-only (Priority: P1)

**Acceptance Scenarios**:

1. **Given** macOS or Linux, **When** the owner opens the side panel's conversation area or the settings
   page's Agents section, **Then** it says side-panel conversations are available on Windows only for now,
   instead of "the helper needs updating" or a broker error.
2. **Given** macOS or Linux, **Then** the relay starts no conversation broker.

### User Story 3 - CI keeps Linux and macOS working (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a push, **Then** CI runs typecheck, the unit and UI tests, the contract tests and the snapshot
   check on Linux and macOS as well as Windows.
2. **Given** a test that can only pass on Windows (a Windows path, the registry, Windows file locking, the
   side-panel broker), **Then** it is marked as such and skipped elsewhere; every other test runs everywhere.

### Edge Cases

- `LOCALAPPDATA` set on macOS or Linux (an isolated test or gate run): it is the data folder's parent, as on
  Windows; otherwise the platform's own per-user folder.
- A browser not installed: its native-messaging folder's parent does not exist; nothing is written for it and
  the output says it was skipped.
- A node path with a quote in it: the launcher quotes it for the shell; a bare `node` fallback stays.

## Requirements *(mandatory)*

- **FR-433**: The per-user data folder MUST be `%LOCALAPPDATA%\hallpass` on Windows,
  `~/Library/Application Support/hallpass` on macOS and `$XDG_DATA_HOME/hallpass` (default
  `~/.local/share/hallpass`) on Linux; a set `LOCALAPPDATA` names its parent on every platform.
- **FR-434**: On macOS and Linux the installer MUST write the host manifest into the per-user
  native-messaging folder of each of Chrome, Chromium, Edge and Brave whose own per-user folder exists, and
  the uninstaller MUST remove them; the registry is used on Windows only.
- **FR-435**: On macOS and Linux the launcher MUST be an executable shell script that runs the installing
  node by absolute path when it still exists, else `node` from the path, passing Chrome's arguments on.
- **FR-436**: The release MUST include `install.sh` and `uninstall.sh` beside the PowerShell pair.
- **FR-437**: On macOS and Linux the relay MUST NOT start a conversation broker, and the side panel and
  settings page MUST say side-panel conversations are Windows-only for now.
- **FR-438**: CI MUST run the browser-less suites on Linux and macOS; tests that can pass only on Windows
  MUST be marked and run on Windows only.

## Success Criteria *(mandatory)*

- **SC-193**: On Linux, a Chromium with the built extension starts the installed host through native
  messaging and the relay publishes its browser record (checked here, end to end).
- **SC-194**: The Linux CI job passes with no unmarked failing test.
- **SC-195**: No Windows behaviour changes: every Windows test still runs on Windows.

## Assumptions

- Node 24 is installed by the owner (as on Windows); `install.sh` refuses an older one.
- macOS is not verified on a Mac in this work (D-028-2); its folders are the browsers' documented ones.
- The packaged gate and acceptance probes stay Windows runs; on Linux the end-to-end check is SC-193.

## Change log

| Date | Change | Source |
| --- | --- | --- |
| 2026-10-28 | Created from issue #1 with D-028-1..3 | Owner, main session |
