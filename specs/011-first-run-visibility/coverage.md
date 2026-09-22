# Coverage: First-Run Visibility

**Feature**: `specs/011-first-run-visibility` · **Branch**: `feature-011-first-run-visibility`
(worktree `feature-008-spec`, from main fc8831e) · **Written**: 2026-09-21 night by the main session.

## Requirements

| Requirement | Evidence | Where |
| --- | --- | --- |
| FR-146 the agent is told within 6 s, relayable | `prompt-waiting` tick at 5 s → MCP progress with `ATTENTION_SENTENCES`; gate: pairing sentence at 5018 ms, consent at 5014 ms | `agent-first-run.spec.ts` tests 1–2; host `prompt-waiting.test.ts` |
| FR-147 badge on while waiting with no panel; cleared on answer / expiry / connect | `deriveAttention` + `action-badge.ts`; pairing card now expires in the worker at its bound (9b43862) | `prompt-waiting.test.ts` (8-row table, expiry cases), `agent-runtime-wiring.test.ts`; gate tests 1–2 (`!` → `""`) |
| FR-148 2-minute wait with progress ≥ every 5 s; 25 s / 45 s unchanged when a panel is connected | bound fixed at raise; ticks only while closed (review M1); gate expiry: 120 017 ms, 46 notices | `prompt-waiting.test.ts`, `router.test.ts`, gate test 3; regression `agent-pairing`/`agent-dialogs`/`agent-batch-wait` 6/6 |
| FR-149 panel connecting mid-wait shows the card first | projection on connect | `agent-panel-port.test.ts` (+3); gate tests 1–2 (`acceptPairing` returned "accepted", consent card present) |
| FR-150 the client bound never ends the call first | R-161 (Claude Code ≈ 28 h); host router re-armed per tick, cap 130 s; batch stated bounds never shortened, batch steps tick under the batch id (review H1) | `router.test.ts`, `relay-mux.test.ts`; gate test 3 |
| FR-151 no page content in badge, title, sentences | fixed sentences in contracts; contract case pins no `{`, two lines | `prompt-waiting.contract.test.ts` |
| FR-152 worker-initiated open | **measured refused** (R-160) → A + B are the behaviour; `setPanelBehavior` withdrawn at review (L1) | `research.md` R-160; `service-worker-bootstrap.test.ts` "never takes the icon's click away" |
| FR-153 pointer visible and arrived before every press (baseline) | gate: pointer present, `transform` transition, travel 192 / 109 px = target distances 192 / 109 px | gate test 4 |
| FR-154 pointer upgrade | **not scheduled** — D-011-5 owed (owner to watch the glide) | — |
| FR-155 documents | design notes §8; README "First use" step 2; comparison page v11 (pointer row ✓ 004; closed-panel row 011) | 0e04fcb; artifact Ss9GGEjLAb4CGYvYzPwob5 |

## Measurements before the plan (SC-082)

| | Method | Result |
| --- | --- | --- |
| R-160 | `.scratch/r160-sidepanel-open.mjs`, Chromium 151, worker evaluate | `sidePanel.open()` refused in every form: "may only be called in response to a user gesture"; badge and `setPanelBehavior` ok |
| R-161 | Claude Code docs | `MCP_TOOL_TIMEOUT` ≈ 28 h; stdio idle 30 min; progress does not extend and need not |

## Runs (2026-09-21)

| What | Result |
| --- | --- |
| brief 1 (host) `npx vitest run --project unit packages/agent-host` | 115 passed / 1 skipped (105 before) |
| brief 2 (worker + badge) `npm run test` | 1163 / 1 skipped (1137 before) |
| code review (T296) | H1 blocking (batch step ticks unroutable, cancel mismatch), M1 (ticks with panel open + old relay), M2 (second session no ticks), L1 (`setPanelBehavior` bypasses `action.onClicked`), L2, L3, L4 — all fixed in 8177323; gate author's finding (pairing card never expired in the worker → badge stuck) fixed in 9b43862 |
| after fixes `npm run test` | 1178 passed / 1 skipped; `npm run test:contract` 186 passed |
| gate run 1 (Chromium 151, attach, private LOCALAPPDATA, worktree host registered `--keep-legacy`) | 2 passed / 2 failed — both test-side: the harness MCP SDK client's 60 s default request timeout (SDK default, the very thing R-161 separates from Claude Code) and a pointer travel measured in viewport coordinates while ref resolution scrolls each target to the viewport centre |
| gate run 2 (harness `timeoutMs`; pointer in document coordinates) | **4 passed** (3.7 min): pairing sentence 5018 ms; consent 5014 ms; expiry 120 017 ms with `hint`, 46 notices; pointer 192 / 109 px vs targets 192 / 109 px |
| regression `agent-pairing`, `agent-dialogs`, `agent-batch-wait` | 6 passed |
| machine restored | host registration re-pointed at the main checkout (`npm run agent-host:install` from main); test Chromium stopped |
| final verification (T301) | see the closing commit message |

## T299 — paid probe on the owner's Chrome 153 (2026-09-21 21:40, owner's go-ahead)

`claude -p --model sonnet`, `--output-format stream-json --verbose`, `--allowedTools mcp__hallpass__*`,
side panel closed, agent already paired, main rebuilt at b4b349a and the host reinstalled, extension
reloaded. Steps: `tabs_context` → `tabs_create https://example.com` → `wait 1500` → `read_page
interactive` (one link, "Learn more") → `click` that ref (site mode `ask`).

| Observation | Value |
| --- | --- |
| `click` issued | t = 31.2 s |
| `click` returned | t = 151.2 s — **120.0 s** held: not the host's 30 s backstop, not the SDK 60 s, not the old 25 s |
| result | `{"outcome":"timed-out","reason":"no-answer","hint":"<pairing/consent sentence, both lines>"}` (`is_error: true`) |
| agent's final answer | quoted the hint verbatim (both lines) and named step 4 as its source |
| MCP progress notices seen by the model | **none**. The stream carries only Claude Code's own `tool_progress` heartbeats (`elapsed_time_seconds` 29 / 59 / 90 / 120, `heartbeat: true`); the server's `notifications/progress` with the attention sentence never reaches the model or the transcript |
| cost | US$0.16 (a first run at US$0.15 stopped early: `find` found no "More information..." link on example.com, which now says "Learn more") |

**Finding (SC-078 in Claude Code).** The sentence reaches the MCP client at 5 s (gate) but Claude
Code does not surface progress messages to the model; the person at the terminal is told at expiry
(2 minutes) through the `hint`, and during the wait the only cue is the toolbar badge (B). A + B
still turn the old outcome (45 s, no instruction) into "badge now, instruction at 2 minutes";
whether another client shows progress is for QA's first use (Cursor, CodeBuddy). Recorded in the
spec as an assumption correction; the design is unchanged (the hint is the carrier that works
everywhere).

**Owner's observation (2026-09-21, right after the probe):** the toolbar badge `!` was lit during
the two-minute wait and disappeared when it ended — SC-080's set → cleared-on-expiry transition on
the owner's branded Chrome 153, with a real Claude Code caller.

## Owed to the owner

- Nothing for this feature. `git merge --ff-only feature-011-first-run-visibility` on main when
  convenient (main is at b4b349a; the branch adds the T299 record).
- **D-011-5**: watch the pointer glide; keep or upgrade (FR-154 → S4).
- Merge `feature-011-first-run-visibility` into `main` (fast-forward), rebuild, `npm run
  agent-host:install`, reload the extension — the relay fix (a waiting tick no longer spends the
  call route) and the worker changes ship together.
- Other MCP clients (Cursor, CodeBuddy): the 2-minute hold is assumed tolerated; QA's first use
  checks it.
