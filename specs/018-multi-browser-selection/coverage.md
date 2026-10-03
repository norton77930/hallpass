# Coverage: Several Browsers, One Bridge (018)

Branch `next-round-followups` (worktree `relay-no-cross-browser-supersede`), spec approved 2026-10-03.
Baseline before 018 code (commit 4aebfad): typecheck clean, unit + extension-ui 1757 passed / 1 skipped,
contract 273, snapshot 0 forbidden / 0 hits.

After S1–S6 + review fixes + 0.11.0 (2026-10-03): typecheck clean, unit + extension-ui 1861 passed /
1 skipped, contract 291 passed / 2 skipped (the QA-zip checks skip until `npm run package` makes the
0.11.0 zip), snapshot 0 / 0.

| Requirement | Evidence | State |
| --- | --- | --- |
| FR-266 every browser served | `relay-process.test.ts` "018" (both relays serve, closing one leaves the other); gate SC-127 | pass |
| FR-267 identity + default name | `browser-identity.test.ts`; `browser-names.test.ts`; relay peers test | pass |
| FR-268 owner rename, agents cannot | `browser-row.test.tsx`; runtime rename tests; relay `browser-name` test | pass (no gate case — US4 not in the gate) |
| FR-269 list | `mcp-server.test.ts` "018 T504"; gate SC-127 | pass |
| FR-270 select | same; `browser-routing.test.ts` | pass |
| FR-271 one browser, no question | `resolve-browser.test.ts`; gate SC-131 | pass |
| FR-272 several, refused before anything runs | `browser-routing.test.ts` (0 frames); gate SC-127/128 | pass |
| FR-273 remembered per agent | `browser-choice-store.test.ts`; gate SC-130 (new session runs unasked) | pass |
| FR-274 in-browser choice | `browser-choice.test.ts` (10); worker/panel tests; gate SC-132 ×3 | pass |
| FR-275 consent per browser | `browser-routing.test.ts` (per-browser pairing, pictures carry their browser); gate SC-130 | pass |
| FR-276 call runs where it began; foreign tab ids refused | `browser-routing.test.ts` (provenance incl. batch and new tabs) ; gate SC-129, SC-130 | pass |
| FR-277 disconnected browser refused, no fallback | `resolve-browser.test.ts`; `browser-routing.test.ts`; gate US5 | pass |
| FR-278 older extension / host | relay legacy-id tests; directory legacy entry; `relay-standby` ignored test | pass (unit) |
| FR-279 panel: this browser + others | `browser-row.test.tsx` | pass |
| FR-280 stand-by retired | S6 tests; contract rejects `relay-standby` / `standby` | pass |
| FR-281 en-US + zh-TW | locale contract test | pass |
| SC-127 – SC-132 | `tests/e2e/packaged/agent-multi-browser.spec.ts` 8/8 (Playwright Chromium 151 ×2, 2026-10-03, 4.7 min) | pass |
| SC-133 paid probe | — | owner run, not done |

Reviews: architecture review of the plan (sound with changes, applied: R-276 – R-279); security
code review of S4a + S4b (T507, pass with fixes; fixes 6f1ae74; m1, m5 recorded in research.md).

Gate run notes: first run 2/8 (harness: leftover owner tab counted in SC-129; unload/reload of the
extension does not restore it in Chromium 151 → replaced by CDP close + relaunch on the same profile;
SC-132 waited on the host half). Second run 8/8.

Open: T513 single-browser `agent-*` regression on this branch; final code review (T515); probe S18
(owner); the Edge transitions settle defect (010 coverage) is unrelated to 018.

## Final review round (T515), 2026-10-03

Final code review of S2/S3/S5/S6/0.11.0: pass with fixes; M1, m1–m4, m6 fixed (af96434, 33ea75d,
803f81c), m5 recorded. Integration after the fixes: typecheck clean, unit + extension-ui 1867 passed /
1 skipped, contract 291 passed / 2 skipped (QA-zip checks), snapshot 0 / 0.

Follow-ups (not in scope): the legacy `bridge.json` entry still judges liveness by pid only
(transitional, 0.10.x relays); the progress text during `request_browser_choice` stays neutral after a
panel-closed tick (only the final reply carries the attention sentence); a choice-specific attention
sentence (today the consent one is reused).

Still open for release: T513 single-browser `agent-*` regression on this branch (needs the owner's OK
for the Chromium host-key redirect), probe S18 (owner), `npm run package` for the 0.11.0 zip.

## T513 single-browser regression (2026-10-03)

Playwright Chromium 151, fresh browser per spec file, private LOCALAPPDATA, Chromium host key pointed at
this branch and restored after every run.

- Run 1: 24 of 33 spec files clean; 9 had a failure. Re-run of those: batch-upload, computer, refs and
  site-plan clean (flaky); actions, pairing-withdraw, press-outcomes, upload-image failed again.
- Two 018 regressions found and fixed:
  - a worker whose identity read did not answer acked without identity after 9 s, and the relay
    published a ghost legacy browser beside the real one (measured: 4 times in relay.log) → R-279
    implemented as written: no ack without identity, backoff instead (3accab2);
  - two calls on one tab could reach the router out of order after the per-call directory read, so the
    wrong one was told busy → calls are routed in the order the agent sent them (host).
- After the fixes: actions, batch-upload, computer, press-outcomes, refs, site-plan, upload-image clean;
  two-browser gate still 8/8; unit + extension-ui 1871 / 1 skipped, contract 291 / 2 skipped.
- Remaining: `agent-pairing-withdraw.spec.ts` test 1 (card left up after the host's withdrawal).
  Measured: the host sends `pair-withdraw` on time and the relay forwards it, but the worker's
  `chrome.storage.local` stops answering about a second after the pairing request (storage.session,
  tabs and runtime keep answering), so the withdrawal's state write never completes. **The 0.10.0
  build (main 9b2cb71) fails the same test the same way on this machine today** — an environment
  fault of this Playwright Chromium, not an 018 regression (it passed in the 017 run of 2026-10-02).
- Follow-up (design, predates 018): the pairing card's withdrawal waits on a `storage.local` write
  before the panel changes. The reference updates the card in memory first and persists without
  waiting; adopting that would make the card leave even when storage stalls.
  - Fixed: a transition that changes only the card (connection, Ignore, withdrawal, abandon,
    decline) no longer writes, since storage holds only `paired`; accept and unpair still write
    before they are believed (003 FR-032a F1). Unit test "018 T513 follow-up" in
    `apps/extension/tests/pairing-controller.test.ts`.

## Probe S18 (T514, SC-133), 2026-10-03

Owner's branded Chrome 154.0.8037.92 (debug profile, agent already paired) + a second Chromium 151,
both on one host from main 9b14088, a private LOCALAPPDATA shared by both browsers and the probe
(the machine's own relay had other sessions' servers attached), `claude -p` 2.1.288 as the caller.

- Run 1 (13:19): fail — the agent listed both browsers, selected Chrome by id and worked only there,
  but reported no heading: example.com no longer has an h1 (multilingual page, title kept). The
  scenario was fixed to read the title; the expectation is unchanged (4ce1d0b).
- Run 2 (13:21): **pass** (`selected-named`): `list_browsers` → `select_browser 9d69b25c…` (the browser
  named Chrome) → `tabs_context` (title Example Domain read in Chrome). Its `navigate` on that tab was
  refused `not-yours` (a tab left by run 1, not held by this session) — correct protection; the title
  came from the tab list. Nothing ran in the Chromium. Reports: tests/acceptance/probe-004/reports/
  004-2026-10-03T13-19-15Z.md and 004-2026-10-03T13-21-12Z.md (private).
