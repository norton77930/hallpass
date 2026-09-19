# Implementation Plan: The Agent Build's Side Panel

**Branch**: `006-side-panel` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

## Summary

Rebuild `AgentPanel` as a state-driven surface over the existing panel port: the worker's projection
already carries bridge state, pairing, prompts, sessions with held tabs, and site modes; the panel maps
that to four compositions (not-connected page, paired-idle, live-session cards, one prompt on top) and
sends commands back. Three commands are added to the port (clear a site's decision, stop one session,
release one session's tabs) plus a retry; the archived remote-path components are no longer rendered in
the agent profile; the agent build gets its own name through the locale-driven manifest writer; a token
set with light/dark replaces the eight hard-coded variables; unit + attached e2e + accessibility
assertions + owner-reviewed screenshots close it.

## Technical Context

**Language/Version**: TypeScript 5.9, React (existing), vitest `extension-ui` project (jsdom, `css: true`).
**Dependencies**: none added (D-006-8).
**Panel port**: `apps/extension/src/service-worker/agent-panel-port.ts` (`worker.agent.state` ← `AgentRuntime.projection()`; `ui.agent.*` commands). Contracts for the panel messages live in `packages/contracts` (agent panel schema) — extended, not replaced.
**Build**: `apps/extension/scripts/write-manifest.ts` writes `_locales/*/messages.json` from locale keys; `build-config.ts` `createManifest` per profile.
**Testing**: `apps/extension/tests/side-panel-agent.test.tsx`, `agent-panel-port.test.ts`; e2e `tests/e2e/fixtures/side-panel-driver.ts` (`openSidePanel`, `evaluatePanel`, `clickButton`, `waitForText`) and `agent-pairing.ts` (`acceptPairing`); packaged attach gate.

## Constitution Check

| Article | Assessment |
| --- | --- |
| I | PASS — FRs trace to PR-005/007/008/020; owner decisions D-006-1–11 precede this plan. |
| II | PASS — reference identifiers confined to design-notes §7; layouts and copy are ours. |
| V | PASS — no new permission; no new capability to the agent (stop/release are owner actions the worker already performs internally). |
| VI | PASS — the panel shows site names, never page content; the tab list is removed from the panel. |
| VII | PASS — SC-044–050 are checks the gate or a screenshot can make. |
| X | PASS — no dependency. |
| XII | PASS — spec → plan → tasks → source. |

## Project Structure

```
apps/extension/src/side-panel/
  App.tsx                         agent profile renders only <AgentShell/>; narrow unchanged
  agent/                          NEW folder for the rebuilt panel
    AgentShell.tsx                state selector: not-connected | idle | sessions, prompt overlay
    NotConnected.tsx              two copy variants, retry, <details> technical block
    StatusRow.tsx                 dot, connected · agent name, overflow menu (unpair)
    SiteList.tsx                  rows: site, mode switch (3), revoke; permissive marking
    SessionCard.tsx               agent · session label, sites, state, Stop / Release tabs
    PromptCard.tsx                pairing | consent | plan (existing plan card, restyled)
    tokens.css                    :root light tokens; @media (prefers-color-scheme: dark) redefinition
    agent.css                     components, tokens only
  AgentPanel.tsx                  REMOVED (replaced by agent/)
apps/extension/src/service-worker/
  agent-panel-port.ts             + ui.agent.retry-bridge, ui.agent.site-clear, ui.agent.session-stop, ui.agent.session-release
  agent-runtime.ts                projection: + diagnostics {relayPid, recordPath, lastDisconnect}, sessions[].sites, sessions[].state; clearSiteMode(); stopSessionFromOwner(); releaseSessionTabs()
packages/contracts/src/           agent panel message schema: new commands + projection fields
apps/extension/scripts/write-manifest.ts   per-profile name keys (agent: extName.agent …)
apps/extension/src/locales/{en-US,zh-TW}.ts  agent.* copy rewritten; extName.agent keys
apps/extension/tests/
  agent-shell.test.tsx, not-connected.test.tsx, site-list.test.tsx, session-card.test.tsx, prompt-card.test.tsx
  agent-panel-port.test.ts (+4 commands), agent-runtime-*.test.ts (+3 operations)
  panel-a11y.test.tsx             names, tab order, contrast (token pairs, both themes)
tests/e2e/packaged/
  agent-panel-states.spec.ts      NEW: not-paired page; idle status + site list; two sessions, Stop, Release
  agent-claim.spec.ts / agent-pairing.ts  re-pointed at the new cards' copy keys
specs/006-side-panel/coverage.md  + screenshots/ (light/dark × idle/sessions)
```

## Design decisions

- **R-125 State is derived, never stored.** `AgentShell` computes the composition from the projection:
  `bridge !== "connected" || paired.length === 0` → NotConnected (variant `not-paired` when nothing was
  ever paired, `bridge-lost` otherwise); `sessions.length === 0` → Idle; else Sessions. A pending
  pairing / consent / plan prompt renders on top of any of them. No panel-side flags.
- **R-126 Three new owner commands, all thin.** `ui.agent.site-clear {site}` deletes the stored entry
  (`clearSiteMode`); the list is built only from *stored* entries, so a cleared site disappears and the
  default applies. `ui.agent.session-stop {sessionId}` calls the existing internal `stopSession` path
  with reason `owner-stopped` (the in-flight call's stop handle already exists for `wait`/batch).
  `ui.agent.session-release {sessionId}` iterates the session's held tabs through the same code
  `tabs_release` runs (indicator off, group marking off, lease dropped) and leaves the session paired.
  `ui.agent.retry-bridge {}` calls the bridge's `connect()`. Each is unit-tested at the port and at the
  runtime.
- **R-127 Projection additions.** `sessions[i].sites: string[]` (host names of held tabs, deduped),
  `sessions[i].state: "working" | "waiting"` (waiting when a pending prompt belongs to the session),
  `sessions[i].lastActivityAt`, `diagnostics: { relayPid?, recordPath?, lastDisconnect?: {at, reason?} }`
  from the 004 rings, `agentName` for the paired agent. The `tabs` list stays in the projection (the
  existing tests pin it) but the panel does not render it.
- **R-128 Name per profile.** `write-manifest.ts` gains a per-profile key map: `agent` reads
  `extName.agent` / `extActionTitle.agent` / `extCommandDescription.agent`, `narrow` reads the existing
  keys. `manifest.json` keeps `__MSG_extName__` in both, so the narrow guard is untouched; the agent
  build's `_locales` get the new name. The panel title reads `agent.appTitle` (not `workspace.title`).
- **R-129 Tokens.** `tokens.css`: `--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`, `--line`,
  `--accent`, `--accent-text`, `--ok`, `--warn`, `--danger`, four `--fs-*`, four `--sp-*`, `--r-1`,
  `--r-2`, `--focus`. Light in `:root`, dark under `@media (prefers-color-scheme: dark)`. The contrast
  test parses `tokens.css`, resolves both themes, and asserts every (text, surface) pair used by
  `agent.css` ≥ 4.5:1 with a small WCAG luminance function in the test (no dependency).
- **R-130 Accessibility.** Every control is a `<button>` or a labelled `<select>`/`<input>`; cards are
  `<section aria-labelledby>`; the prompt overlay is `role="dialog" aria-modal="false"` with initial
  focus on its first control; `:focus-visible` uses `--focus`. The a11y test renders each composition
  and asserts: no button without name, tab order includes every control, `getByRole` finds each.
- **R-131 Screenshots.** Taken by the packaged gate in attach mode at the end of S2: the panel page
  opened as a tab, `emulateMedia({colorScheme})` for light/dark, idle and two-session states, saved under
  `specs/006-side-panel/screenshots/`. The owner's OK closes SC-050.

## Slice ordering

| Slice | Delivers | Closes |
| --- | --- | --- |
| **S1** | port commands + projection additions + `agent/` components with working behaviour (existing CSS variables reused, no visual work) + App.tsx profile branch + name per profile + unit + e2e re-pointing + new e2e | FR-081–090, SC-044–048 |
| **S2** | tokens, both themes, `agent.css`, copy rewrite zh-TW/en-US, a11y test, screenshots | FR-091–093, SC-049–050 |

S1 ends with the attach family green; a `code-reviewer` pass on the three new owner commands (they touch
leases and the stop path) before S2 starts.
