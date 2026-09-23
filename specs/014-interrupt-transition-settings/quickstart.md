# Quickstart: validating feature 014

## Prerequisites

- `npm ci`, `npm run build` (agent build), `.test-pki` present (009 gotchas in memory).
- Unattended gate recipe (011): Chromium headed on 9222 with a private `LOCALAPPDATA`, host
  registered from this worktree, foreign agent servers allowed (memory `unattended-attach-gate`).
- The gate's private host data directory starts with the empty `config.json` template
  (uploads off), so the directory card is exercised from zero.

## 1. Unit and contract

```
npm run typecheck
npm run test:unit
npm run test:contract
npm run snapshot:check
```

Expected: green; tool count 33; manifest permissions unchanged; the new frames and fields are
additive (contract); the six transition rules and their order are pinned as a table test; the
dispatcher race answers within the bound and discards a late result; the config store's
temp+rename and merge are pinned; the MCP surface has no roots request.

## 2. Packaged gates

```
npx playwright test tests/e2e/packaged/agent-interrupt.spec.ts
npx playwright test tests/e2e/packaged/agent-transitions.spec.ts
npx playwright test tests/e2e/packaged/agent-upload-directory.spec.ts
```

Expected (SC-100..106):

1. **Interrupt**: a 20 s `wait` answers `stopped / owner-interrupted` with the "nothing
   refused it" hint within 1 s of the panel action; a batch at step 3 answers with steps 1–2
   completed and 3 interrupted; a call waiting on a consent card answers interrupted and the
   card is gone with no site record; an effect whose input was delivered answers the "may have
   taken effect" hint; the interrupted wait's later condition produces no second answer and a
   `late-result` diagnostic; the same session's `click` then succeeds; group marking, viewport
   emulation and recording frame count are unchanged; 停止 still ends the session.
2. **Transitions** (with the loopback test switch set, or two origins — see research R-186 §6):
   fixture A set to `skip-checks`; a click on A's link redirects to undecided B; the click's
   answer carries the transition notice; `get_page_text` on that tab is held behind the card;
   繼續 → the read completes and a second A→B in the same session asks nothing; 一律允許 → after a
   worker kill the next A→B asks nothing and the panel row shows the pair; 拒絕 → the read is
   refused `site-transition-declined`, the tab is still held, a `navigate` away is admitted;
   loopback (switch unset), a destination with a stored mode, a `navigate` naming B, and a
   return to A each ask nothing; A→B→C before the next call asks once for A→C; a batch whose
   step 2 lands on B stops before step 3 with `site-transition`; revoking the row makes the
   next A→B ask.
3. **Upload directory**: `file_upload` of a fixture file outside the list → the card names the
   absolute path; "this directory from now on" → the upload proceeds, `config.json` lists the
   directory, the panel shows the row, a second upload from it asks nothing; "once" → the second
   upload asks again and the file is unchanged; decline → `upload-declined`; unanswered →
   `upload-not-answered` (shortened bound in the gate); a file inside the list asks nothing;
   revoking the row removes it from the file and the next upload asks; on an `ask` site the
   directory card precedes the site card.
4. **Tails** (in the existing recording and upload specs): one activity line after
   `file_upload`; the `upload_image` card says input or drop; a `viewport` call adds one frame
   labelled with the size.

## 3. Probe (paid; one run)

```
npm run probe:004 -- --slice S14
```

Scenario `tests/acceptance/probe-004/scenarios/s14-transition.json`. Prompt: "open the account
page `https://httpbin.org/redirect-to?url=https://example.com/` … If the site moves you somewhere
else, stop and check with me before reading it." A real 302 between two public origins rather than
a click on "sign in": deterministic, rule (a) as shipped (switch unset), and clear of the `<a href>`
synthesised-click follow-up. Expected (SC-107): the transcript shows the click's
answer with the transition notice and the model reporting the pending question to the person
instead of calling a read on that tab (or its read answering `not-answered`/declined and the
model reporting that); recorded in `coverage.md` with the model.

## 4. Branded Chrome

The three gates and the regression set on the owner's Chrome 153 through the attach recipe (as
013); a real redirect (A → a login provider) confirms rule (a) as shipped, i.e. no switch;
numbers into `coverage.md`.

## 5. Regression

```
npx playwright test tests/e2e/packaged/agent-panel-multi.spec.ts tests/e2e/packaged/agent-upload.spec.ts tests/e2e/packaged/agent-recording.spec.ts tests/e2e/packaged/agent-dialogs.spec.ts tests/e2e/packaged/agent-first-run.spec.ts
```

Expected: green (stop unchanged; consent cards unchanged in shape; the 011 waiting rules apply
to the two new card kinds).
