# Manual accessibility / locale pass template

Product owner only. Do not mark T093 complete without the owner's signature on every cell.

## Environment

| Field | Value |
| --- | --- |
| Windows version | `10.0.22631.7376` |
| Node version | `24.13.0` |
| Extension build | `apps/extension/dist/test` |
| NVDA version (current stable) | Not installed; owner NVDA cells blocked as of 2026-08-29 |
| Chrome current major (exact) | `151.0.7922.174` (installed Chrome) |
| Chrome previous major (exact) | `150.0.7871.124` (Google Chrome for Testing portable) |

## Eight cells

Complete each cell with pass/fail, date, and owner initials. One fail fails the cell.

| Chrome major | Locale | Mode | Result | Owner | Date |
| --- | --- | --- | --- | --- | --- |
| current | en-US | Keyboard only | | | |
| current | en-US | Keyboard + NVDA | | | |
| current | zh-TW | Keyboard only | | | |
| current | zh-TW | Keyboard + NVDA | | | |
| previous | en-US | Keyboard only | | | |
| previous | en-US | Keyboard + NVDA | | | |
| previous | zh-TW | Keyboard only | | | |
| previous | zh-TW | Keyboard + NVDA | | | |

## Per-cell steps

1. Load unpacked `apps/extension/dist/test` in that Chrome major.
2. Set Chrome UI language / accept-language to the cell locale (`en-US` or `zh-TW`).
3. Open a supported 127.0.0.1 fixture page.
4. Activate the extension action from the keyboard (`Alt+A` suggested).
5. Complete sign-in, a page-read consent, a form-values consent, one allowed action, Stop, and logout using only the keyboard (and NVDA in NVDA cells).
6. After a terminal, begin another protected task and confirm the old terminal is absent during review/progress, exactly one localized Stop control is exposed, and no active-control claim appears before safety/consent/Plan approval. In zh-TW, confirm the fixed deterministic progress label is 處理中, page-read purpose is 理解頁面內容, action and Plan purpose/summary text is localized, and no fixed English fixture copy remains. Confirm Consent shows one 資料 field with its localized categories in one list, without repeated 資料 labels or raw identifiers/JSON. Confirm Safety, Consent, and Plan each use the same inset card spacing and styled actions with no edge-touching or browser-default review button.
7. Confirm no keyboard trap, visible focus, and announced status without focus theft. No Continue/Allow
   action may collapse into an indefinite progress-only screen after a control reconnect; Stop must always
   reach a localized cancellation state even when the control message cannot be delivered. If the unpacked
   extension is reloaded while the supported fixture tab remains open, the next page-read attempt must
   replace the stale content listener and continue without requiring a page refresh; a generic collection
   failure must not falsely claim that refreshing the page is the only recovery.
8. Answer the five comprehension prompts in `comprehension-template.md` without inspecting internals.

## Owner signature

I confirm I personally completed the eight cells and the comprehension answers.

Name: ______________________  
Date: ______________________  
Signature: ______________________
