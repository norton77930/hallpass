# Research: macOS and Linux for the Outside-Agent Bridge

## R-423 — Data folder (FR-433)
`%LOCALAPPDATA%\hallpass` (Windows, unchanged, never a shell's HOME), `~/Library/Application Support/hallpass`
(macOS), `${XDG_DATA_HOME:-~/.local/share}/hallpass` (Linux). A set `LOCALAPPDATA` is the parent on every
platform: tests and the gate isolate their host files that way, and it keeps the derivation one rule.

## R-424 — Registration (FR-434)
Chrome-family browsers read `<host>.json` from a per-user folder: Linux `${XDG_CONFIG_HOME:-~/.config}/`
`google-chrome|chromium|microsoft-edge|BraveSoftware/Brave-Browser/NativeMessagingHosts`; macOS
`~/Library/Application Support/Google/Chrome|Chromium|Microsoft Edge|BraveSoftware/Brave-Browser/NativeMessagingHosts`.
Written only where the browser's own folder exists. Measured on Linux: Playwright's Chromium with its
profile at `~/.config/chromium` started the installed launcher (SC-193).

## R-425 — Launcher (FR-435)
`#!/bin/sh` with `exec`, single-quoted paths, the installing node when executable else `node`; `0755`.

## R-426 — No broker outside Windows (FR-437)
The broker's job objects (koffi, kernel32), `where.exe`, `cmd.exe`, `taskkill` and the registry make it
Windows-only; the relay skips it (`relay.broker.skipped platform`). The worker learns the OS from
`chrome.runtime.getPlatformInfo()` and projects `platform-unsupported`, which the panel and settings page
word as "Windows-only for now" instead of a fault.

## R-427 — Tests and CI (FR-438)
Each test that failed on Linux was inspected by file: Windows paths, the registry, Windows file locking,
the broker. Each is marked `it.runIf(process.platform === "win32")` in place (generated `it.each` groups by
`(win32 ? it : it.skip).each`, or the one Hermes case filtered out); host-path tests that only hard-coded a
Windows path now pass the platform and run everywhere. CI: a matrix of windows-latest, ubuntu-latest,
macos-latest; macOS `continue-on-error` until it has passed once (D-028-2).
