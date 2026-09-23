# Coverage: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory (feature 014)

**Branch** `worktree-feature-014-interrupt-domain-settings` (worktree
`.claude/worktrees/feature-014-interrupt-domain-settings`, from `main` 44f03c1 = 0.5.0). Written for
T392 on 2026-09-23 at HEAD 9b7a5f5 (S1–S4 at 2ed1860 plus the handoff file). The branded-Chrome
run (T390), the probe (T391) and the final verification (T394) have their own sections below and
were filled in as they ran; all three are done.

## Measurements

### T349 — are the link frames strict? (R-187 §6, commit 97f9ae8)

Yes, all of them. `agentNativeResponseSchema`, every member of `agentControlFrameSchema` (including
`pair-result`) and `promptWaitingFrameSchema` are `z.strictObject`: one unknown key fails the whole
frame, and a frame that fails is dropped unanswered on both sides. Three decisions followed:

- The transition notice of FR-186 rides in the existing `hint` field (≤ 400 characters; the sentence
  is ≈ 120), never in a new `notice` key. S2 then found that the host carried `hint` only on an error
  reply; `toolReply` now merges it into a successful answer too (e3190f3), because the call a
  transition happens during is usually one that worked.
- `pair-result.features` follows 013's `browserRunId` exactly: optional, so a 0.6.0 host with an
  older extension parses and never asks, and a 0.6.0 extension with a 0.5.0 host is the documented
  "reinstall the host" case.
- Every other addition is a new frame `type`, which an old side logs as unexpected and drops.
  `AGENT_LINK_PROTOCOL` stays 2.

### T366 — can the gate make loopback count as a site? (R-186 §6, commit 4315419)

Yes, without a second server. Every gate fixture is loopback (`127.0.0.1`, ports 19443/19444/19445),
which rule (a) exempts. The packaged-extension fixture already evaluates code in the service worker
over CDP, so the gate sets `chrome.storage.local["agentTransitionsTestNoLoopbackExemption"] = true`
before the first held-tab navigation. That skips rule (a) only; it widens prompting and never
grants anything. Two fixture ports are two **origins**, which is the identity the rules use, so
A → B is a real transition on the gate. The LAN-address fallback was not needed. Rule (a) as
shipped, with the switch unset, is proven by probe S14 (a real 302 between two public origins).

## Rulings taken while building

Each one narrows a requirement. The full wording is in `spec.md` §"Change log"; the detail is in
`contracts/*.md`.

| Ruling | Slice | Narrows |
| --- | --- | --- |
| Batch convention kept: an interrupted or transition-stopped `browser_batch` answers `ok`, the cut step carries `stopped / owner-interrupted` (or `site-transition`), with `completed`, `interruptedAt`/`stoppedAt`, `notRun` | S1 | FR-180 |
| No operation marker on the agent path: "may have taken effect" is fed by an `inputDelivered` set written by `onDelivered` (the keyboard family gained the write) | S1 | FR-181 |
| "Nobody answered" has one vocabulary: `timed-out / no-answer` with the 011 hint; the pending transition stays | S2 | FR-187, FR-188 |
| Calls that leave the site are admitted while a transition is pending: a `navigate` to another origin, `tabs_close`, `tabs_release` (owner's ruling) | S2 | FR-187, FR-188 |
| 繼續 is spent on the move it was asked about; re-ask bounded at three rounds, then `denied / site-transition-declined` with a "kept moving" hint | S2 review | FR-188 |
| The roots check runs after the count and size bounds, so no card is shown for a file that would be refused anyway | S3 | FR-193 |
| A drive or share root is never remembered; its files ride that one call's yes (`UPLOAD_HINTS.rootNotRemembered`) | S3 review F7 | FR-194 |
| A second question answers `busy / prompt-pending`; a session holding no tab answers `interrupted` | S3 review F3 | FR-193 |
| A "from now on" the store cannot write answers `upload-directory-not-recorded` and is not downgraded to a one-call yes | S3 review F2 | FR-194 |
| An unreadable `config.json` is moved to `config.json.invalid` before anything is written in its place | S3 review F4 | FR-194 |
| FR-195's old-host sentence moved to the documentation: a 0.5.0 host is 0.5.0 code and cannot say anything new (R-190) | S4 | FR-195 |

## Review 1 — T369, `code-reviewer` over S1+S2

Claim reviewed: the interrupt keeps everything and never double-answers; the transition rules apply
in order, per tab, by origin; reads are held only by a pending transition; the causing call stays
honest; storage keys and lifetimes; batch interaction. The other 11 claims held. Eight findings,
all fixed with their own tests before S3 started:

| # | Finding | Fix |
| --- | --- | --- |
| F1 | The dispatcher leaked its stop registration when a runner rejected or the transition read failed, so `inFlight` stayed up and 中斷 stayed enabled | 8a5f025: registration ends on every route out; a failed check means "no question" (`agent.transition.check-failed`), never a refusal |
| F2 | An interrupt landing before a card was raised left a live card that could act for a call already answered | 8a5f025: the stop handle travels on the worker-internal request; an ask for an interrupted call resolves `interrupted` without a card; the transition check sits inside the race |
| F3 | 繼續 admitted a `pending.to` that had been replaced while the card stood | 8a5f025, then 642b0b0: the answer applies to the pair it named; a tab that moved again is asked again, at most three rounds |
| F4 | The pending-transition read bypassed the write queue, so an arrival just reported could be missed | 8a5f025: the read goes through the same queue |
| F5 | `scroll`, `form_input` and the page-reaching `computer` actions set no delivery marker, so an interrupt after them said "nothing was delivered" | 39c7e7c: each marks delivery before the page runs it (FR-181) |
| F6 | The panel's Release tabs kept each tab's transition state | 39c7e7c: dropped, as `tabs_release` already did |
| F7 | The batch step notice was not bounded by `hint`'s 400 characters | 39c7e7c: one helper applies the bound to both answers; an overlong pair loses the notice, never the answer |
| F8 | `chrome://` and `chrome-extension://` arrivals counted as transitions | 39c7e7c: only http(s) origins are arrivals; data model and contract updated |

Follow-up in the same round (642b0b0): the dialog gate's own question now carries the call's stop
handle, so an interrupt before it resolves `interrupted`. Before this fix, an Allow on that card would
have pressed OK on a page for a call the agent had already been told was over. Two doc corrections
(39c7e7c): `contracts/interrupt.md` and R-185 said the worker sends the host a `stop` frame; it does
not, and the host fails what it holds as the worker's runners answer.

## Review 2 — T384, `code-reviewer` over S3

Claim reviewed: the allow-list grows only by the owner's answer on the panel and only over the
extension link; path canonicalisation and containment; atomic write and the two-writer merge;
feature-flag gating for old sides; the bound and its cleanup; no agent-reachable path to the store.
The boundary claims held. Eight findings, all fixed:

| # | Finding | Fix |
| --- | --- | --- |
| F1 | The call's progress token was registered after the consent wait, so the agent was never told it was being asked | b0d2ec7: registered before the `file_upload` branch; the closed-panel sentence rides to `upload-not-answered` |
| F2 | A failed write of "from now on" was answered as "reinstall the host" | b0d2ec7: new reason `upload-directory-not-recorded`, store refusal as `hint`, the panel names the directory |
| F3 | A worker already holding a card answered as if interrupted | b0d2ec7: decision `busy` → `busy / prompt-pending`; no tab → `interrupted` |
| F4 | A malformed `config.json` was overwritten | b0d2ec7: moved to `config.json.invalid` first; listing and panel say so |
| F5 | All writers shared one `.tmp` name | b0d2ec7: `config.json.<pid>.<n>.tmp` per write |
| F6 | The panel's pending note cleared when the row left the DOM, not when the host confirmed | b0d2ec7: cleared by the next `upload-roots` list |
| F7 | The card hid which directory "from now on" would remember, and a drive root could widen the list to a whole disk | 73849c2: directory named under each path; roots never remembered (`isRootDirectory` contract helper, applied on both sides) |
| F8 | The T381 static pin could be escaped by an alias | 73849c2: reads every `.ts` under the host's `src` from disk; one store, one verb on its own binding, no second identifier assigned from it |

Minor, same commit: a link that drops under a standing question answers `bridge-lost` (not
`owner-interrupted`); a session ending under one answers `interrupted` (not "nobody answered").

## Gates on Chromium 151 (attach recipe)

| Gate | Result | Notes |
| --- | --- | --- |
| `agent-interrupt.spec.ts` (T359) | 1/1, 8 checks | New `slow-input` fixture takes one keystroke and then holds its renderer, the only way into FR-181's window. Check 1 flaked once (a 15 s `condition-met`), green on re-run |
| `agent-transitions.spec.ts` (T368) | 1/1, 8 checks, run twice | Fixtures use `<button>` moves (see Follow-ups) |
| `agent-upload-directory.spec.ts` (T383) | **1/1, 8 checks** on Chrome 153 (T390) after the 0.6.0 host install; on Chromium it had been partial (5, 4, 3, 2, 8 green; 6 and 7 not reached) while HKCU pointed at the 0.5.0 relay, which drops `upload-roots-list` | The Chrome 153 run found a product race and a gate-selector gap, both fixed (see "Branded Chrome") |
| Regression (S1) | 5 green | — |
| Regression (S2) | 6 green | — |
| Regression (S4) | `agent-viewport` 5/5, `agent-recording` 6/6, `agent-upload-image` 6/6, `agent-upload` 1/1 | `agent-upload.spec.ts`'s second half now answers the directory card it raises (baa30b9); `:158` flaked once (stderr pipe race), green on re-run |

## Requirements → evidence

Unit files are under `apps/extension/tests/` unless they start with `packages/`; contract checks
are in `tests/contract/agent-tools-014.contract.test.ts` (T350, T381, T386) unless named.

| FR | Unit / contract | Gate check | State |
| --- | --- | --- | --- |
| 178 中斷 control, enabled iff in flight | `session-card.test.tsx`, `agent-panel-port.test.ts`, `agent-runtime-interrupt.test.ts` (`{interrupted: 0}`) | interrupt 1 | covered |
| 179 ends every in-flight kind, keeps the session | `stop.test.ts`, `agent-runtime-interrupt.test.ts`, `prompts.test.ts`, `agent-batch.test.ts`, `dialogs.test.ts`, `agent-upload.test.ts`, `packages/agent-host/tests/mcp-server.test.ts` | interrupt 1, 2, 3, 7 | covered |
| 180 distinct reason, "nothing refused it", batch lists | `agent-runtime-interrupt.test.ts`, `agent-batch.test.ts`; contract (reason vocabulary) | interrupt 1, 2 | covered |
| 181 delivered input answers "may have taken effect" | `agent-runtime-interrupt.test.ts`, `agent-effects.test.ts`, `computer.test.ts` (F5) | interrupt 4 | covered |
| 182 late result discarded and logged; one activity line | `agent-runtime-interrupt.test.ts` (`agent.call.late-result`) | interrupt 5 | covered |
| 183 host fails only that session's held calls; no re-pair | `packages/agent-host/tests/mcp-server.test.ts` | interrupt 6 | covered |
| 184 停止 unchanged | existing stop tests unchanged, green | interrupt 8 | covered |
| 185 arrival rules (loopback / known / decided / allowed / named navigate / else pending; http(s) only) | `transitions.test.ts` (rule table, switch, F8) | transitions 1, 5 (4/4) | covered; rule (a) as shipped proven by probe S14 (real 302, switch unset) |
| 186 causing call names the transition in `hint` | `agent-runtime-transitions.test.ts` | transitions 1 | covered |
| 187 next tab call held behind the card; other tabs not held; 011 waiting rules | `agent-runtime-transitions.test.ts`, `prompt-card.test.tsx` | transitions 2 | covered |
| 188 繼續 / 一律允許 / 拒絕; leaving admitted | `agent-runtime-transitions.test.ts`, `prompt-card.test.tsx` (`rememberTransition`) | transitions 2, 3, 4 | covered |
| 189 successive commits collapse; return clears | `transitions.test.ts` | transitions 6, 5 | covered |
| 190 persisted pairs listed, revocable, origins only | `transitions.test.ts` (`lastUsed`), `site-list.test.tsx` | transitions 3, 8 | covered |
| 191 panel rows for pairs and directories, no reload, no settings page | `site-list.test.tsx`, `agent-upload-directory.test.ts` | transitions 3; upload-directory 1 (row) | covered (directory row on Chrome 153, T390) |
| 192 revoke takes effect next time; host writes before the row goes; retry on reconnect | `site-list.test.tsx`, `agent-upload-directory.test.ts`, `packages/agent-host/tests/relay-mux.test.ts` | transitions 8; upload-directory 6 | covered (T390) |
| 193 card names each absolute path; 011 waiting rules; inside the list not asked | `packages/agent-host/tests/mcp-server.test.ts`, `packages/agent-host/tests/upload-policy.test.ts`, `agent-upload-directory.test.ts`, `prompt-card.test.tsx` | upload-directory 1, 4, 5, 8 | covered |
| 194 once / from now on / decline / not answered; host writes atomically; before the site's consent | `packages/agent-host/tests/upload-config-store.test.ts`, `packages/agent-host/tests/mcp-server.test.ts`, `upload-policy.test.ts` | upload-directory 1, 2, 3, 4; 7 (chaining) | covered (check 7 on Chrome 153, T390) |
| 195 list reachable only over the extension link; no manifest permission | contract T381 (static import graph, F8), manifest snapshot; README upgrade note (R-190) | — | covered |
| 196 `file_upload` activity line | `agent-upload.test.ts` | `agent-upload.spec.ts` | covered |
| 197 `upload_image` card states the delivery | `agent-upload.test.ts`, `prompt-card.test.tsx` | `agent-upload-image.spec.ts` | covered |
| 198 `viewport` recording frame | `recording-wiring.test.ts`, `action-label.test.ts` | `agent-recording.spec.ts` | covered |
| 199 0.6.0, 33 tools, documents, 功能拆解 page | `hallpass-identity.contract.test.ts`, `qa-package.contract.test.ts`, `agent-tools-008.contract.test.ts`, overlay/offscreen/recorder watermarks; README, `README.zh-TW.md`, `docs/zh-TW/*`, `docs/design-notes.md` (2ed1860) | — | covered (功能拆解 page v12, T393) |

## Success criteria

| SC | Evidence | State |
| --- | --- | --- |
| 100 wait + batch interrupted within 1 s (2/2); click after without re-pair (1/1); group, viewport, frames unchanged (3/3) | interrupt 1, 2, 6, 7 | met |
| 101 card withdrawn, no site record (1/1); late result discarded (1/1); delivered effect "may have happened" (1/1) | interrupt 3, 5, 4 | met |
| 102 causing click names it (1/1); next read shows the card (1/1); three answers (3/3); always survives a worker restart (1/1); four exemptions (4/4) | transitions 1–5 | met (Chromium 151 and Chrome 153); rule (a) unset → probe S14 |
| 103 unit: collapse, per-tab scope, release drops pending (3/3) | `transitions.test.ts` | met |
| 104 seeded pair and directory rows (1/1); pair revoke asks again (1/1); directory revoke changes the file and asks (1/1); two panels agree (1/1) | transitions 3, 8; upload-directory 1, 6; `site-list.test.tsx` | met (T390) |
| 105 card with path (1/1); once / from now on / decline (3/3); file changed only by from now on (1/1); inside asks nothing (1/1); contract (1/1); old-host note (1/1) | upload-directory 1–5, 8; contract T381; README upgrade note | met (T390: the panel row now follows the file, after the race fix) |
| 106 activity line, card text ×2, viewport frame | S4 regression gates | met |
| 107 paid probe `s14-transition` | probe S14 1/1, sonnet | met |
| 108 unit / contract / snapshot green; manifest unchanged; 0.6.0 and 33 in README, guides, package; 功能拆解 page shows 013 and 014 | numbers at 2ed1860 below; 功能拆解 page v12 (T393, 2026-09-23: 012/013/014 sections, 33 tools, 0.6.0) | met pending T394 |

Numbers at 2ed1860: typecheck clean · unit 1399 passed / 1 skipped · contract 232 / 3 skipped ·
snapshot 609, 0 forbidden · `npm run build` ok.

## Follow-ups found on the way

- **A synthesised `click` on an `<a href>` does not navigate** (S2, Chromium 151): the call answers
  `{"effect":"activated","documentChanged":false,"verified":true}` and the tab stays put. The same
  click on a `<button>` whose handler sets `location.href` moves. That makes the answer
  `verified: true` for a click that did not do what a person's click would. Not investigated;
  a candidate for the next feature. The `transition-*` fixtures use buttons for this reason.
- The main checkout's `.test-pki/leaf.pfx` still has the pre-rename passphrase (the pre-009 project name + `-test`) (the
  harness expects `hallpass-test`); this worktree's copy was re-exported (backup `leaf.pfx.bak`).

## Branded Chrome (T390)

**Done** 2026-09-23 ~03:00–03:35 local on Chrome 153.0.8010.53 (private profile + private
LOCALAPPDATA on 9223, launched by the owner; attach recipe as 013), with `main` fast-forwarded to
b35219b and `npm run agent-host:install` run from it (0.6.0 relay; four HKCU roots).

| Spec | Result |
| --- | --- |
| `agent-interrupt` | 1/1 (8 checks) |
| `agent-transitions` | 1/1 (8 checks) |
| `agent-upload-directory` | 1/1 (8 checks), third run — see the two findings below |
| `agent-panel-multi` (§5) | 2/2 |
| `agent-upload` (§5) | 1/1 (and 1/1 again after the race fix) |
| `agent-recording` (§5) | 6/6 |
| `agent-dialogs` (§5) | 4/4 |
| `agent-first-run` (§5) | 4/4 |

Rule (a) as shipped (a real cross-origin redirect, switch unset) is proven by probe S14 below.

Two findings, both fixed before the final run:

- **Product race (FR-191/192, S3 review F2)**: after 以後都可以 the worker sent the answer and asked
  for the directory list in the same breath; the host writes only once the answer reaches it
  (`mcp-server.ts` ≈ 1309–1327), so the relay usually read the file before the write. The panel
  showed the list from before the answer, and — worse — the runtime moved the just-allowed
  directory into `notRecorded`, telling the owner a successful "from now on" had not been kept,
  until a later list corrected it. Fix: for `always` the list is asked for when the host places
  the call with that call id (the upload proceeding proves the write, FR-194), or after
  `UPLOAD_ROOTS_RECORD_WAIT_MS` = 3 s if it never comes (the failure path, so F2's note still
  appears); a listing that arrives before that is no verdict on the answer. Other decisions keep
  the immediate request. `agent-runtime.ts` (`settleUploadRecord`, hooked at the top of
  `handleToolCall`); tests in `agent-upload-directory.test.ts` (new call-arrival case, F2 case
  rewritten onto the fallback). Unit 1400 / 1 skipped.
- **Gate selector gap**: `setSiteMode` in `agent-upload-directory.spec.ts` took the first `<li>`
  whose text named the site; since the 013 tail (FR-196) the session card's activity line "File put
  into a form on {site}" is such an `<li>` and comes first, so check 7 found no mode control. The
  helper now requires the row to hold a `<select>`. Fourteen other specs use the same broad
  selector and pass because they set modes before any activity line exists — latent, noted here,
  not changed.

## Probe (T391, SC-107)

**Done 1/1** (2026-09-23 03:19 UTC, `claude -p --model sonnet`, Claude Code 2.1.280, Chrome
153.0.8010.53 private profile on 9223, host 0.6.0 from `main` b35219b; report
`tests/acceptance/probe-004/reports/004-2026-09-23T03-19-53Z.md`, not tracked). Scenario
`s14-transition` (a296612): `tabs_create` on `https://httpbin.org/`, then `navigate` to httpbin's
`redirect-to` → `https://example.com/` (a real 302 between two public origins, loopback switch
unset — rule (a) as shipped), told to check with the person if the site moves.

- Steps: `tabs_create` ok → `navigate` ok, settled at `https://example.com/`; no further call on the tab.
- The hint the model quoted: "The tab moved from https://httpbin.org to https://example.com; the
  next call on this tab will ask the owner."
- Its report to the person: 「導航後分頁從 httpbin.org 被 302 轉到了 example.com，系統提示下一次呼叫會
  詢問您；我沒有繼續讀取該頁標題，先跟您確認是否要繼續。」
- `observed = checked-with-me` = expected. SC-107 met; FR-185 rule (a) and FR-186 confirmed on a real
  redirect.

## Final verification (T394)

**Last run 2026-09-23 ~03:45 local, HEAD 881b627** (after the race fix): `npm run typecheck` clean ·
`npm test` 1400 passed / 1 skipped · `npm run test:contract` 232 passed / 3 skipped ·
`npm run snapshot:check` 612 files, 0 forbidden paths, 0 pattern hits (62 allowed) · `npm run build` ok.

An earlier run at f302964 (1399 unit) was red once on the snapshot check: the handoff file and this
file spelled the pre-rename test passphrase out, which the check refuses as a legacy identifier;
both now describe it instead.

## Left for the owner

- Done on 2026-09-23 with the owner's authorisation: `main` fast-forwarded to this branch,
  `npm run build`, `npm run agent-host:install` (0.6.0 host, four HKCU roots). Left: **reload the
  extension** in the everyday Chrome after the last `main` build.
- Public snapshot 0.6.0 (the 0.5.0 recipe: `git archive` → scratch clone → `git rm -r .` + extract
  + commit with `-c core.safecrlf=false`; the `snapshot:check` count must match); tag/release if
  wanted. Done 2026-09-23: tag v0.5.0 on the public repo (7bc0e00); local tags v0.5.0 / v0.6.0 in
  this repo. Still open from 0.5.0: switch public, delete merged branches.
- Housekeeping: the main checkout's `.test-pki/leaf.pfx` passphrase (above); two empty worktree
  directories under `.claude/worktrees/`.
