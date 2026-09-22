# Quickstart: validating feature 013

## Prerequisites

- `npm ci`, `npm run build` (agent build), `.test-pki` present (009 gotchas in memory).
- Unattended gate recipe (011): Chromium headed on 9222 with a private `LOCALAPPDATA`, host
  registered from this worktree, foreign agent servers allowed (memory `unattended-attach-gate`).

## 1. Unit and contract

```
npm run test:unit
npm run test:contract
npm run snapshot:check
```

Expected: green; tool count 33; no manifest permission change; the four descriptions contain the
steering sentences (contract test); cache rules (expiry, eviction order, oversize, unknown vs
gone) pinned in `packages/agent-host` unit tests; content delivery rules pinned in the
content-runtime unit tests.

## 2. Packaged gate

```
npx playwright test tests/e2e/packaged/agent-upload-image.spec.ts
```

Expected, in order (SC-093..097):

1. `screenshot` → text block has `imageId` + the upload sentence. `upload_image` by `ref` to the
   visible input → fixture shows `screenshot.png:<size>:image/png`, change-ran flag; the same to
   the hidden input (2/2). `size` equals the decoded screenshot's byte length.
2. `upload_image` by `coordinate` on the drop zone → zone reports `dragenter,dragover,drop` and
   the file; by `ref` to the zone → same, delivered at its centre; by `coordinate` inside the
   same-origin child frame → the child's zone reports it (3/3).
3. Unknown id → `unknown-image-id`; an id after the clock passed 5 min (test hook or wait) →
   `image-no-longer-available (expired)`; an id evicted by taking screenshots past the budget →
   `(evicted)`; nothing reached the page (fixture unchanged) (4/4; the foreign-session case is a
   unit test on two cache instances).
4. Site in `ask`: the panel card appears with "upload screenshot … to …"; decline → input empty,
   answer says declined; accept → uploaded; one activity line per upload (2/2).
5. Screenshot, kill the worker (recipe from `agent-panel-multi.spec.ts`), `upload_image` →
   succeeds (1/1). End the session, start a new one, quote the old id → `unknown-image-id` (1/1).

## 3. Probe (paid; owner allowed 2026-09-22)

```
npm run probe:004 -- --scenario s13-upload-image
```

Prompt: "Attach a picture of this page to the form on it, then tell me what the page shows
next to the attachment field." Expected (SC-098): the transcript shows a `screenshot` (or
`computer` screenshot) call followed by `upload_image` with that call's `imageId`, and no
`file_upload`; recorded in coverage.md with the model.

## 4. Branded Chrome

The same gate on the owner's Chrome 153 through the attach recipe (as 012 T321); numbers into
coverage.md.

## 5. Regression

```
npx playwright test tests/e2e/packaged/agent-upload.spec.ts tests/e2e/packaged/agent-reads.spec.ts tests/e2e/packaged/agent-recording.spec.ts
```

Expected: green (`file_upload` unchanged apart from its description; screenshot answers still
carry the image; a recorded upload gets its overlay frame).
