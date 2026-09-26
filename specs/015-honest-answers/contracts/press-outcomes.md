# Contract: Press outcomes and binding failures (FR-200 – FR-206)

## Applies to

`click`, `double_click`, `triple_click`, `right_click`, `computer` actions `left_click`,
`right_click`, `double_click`, `triple_click`, `middle_click` (where supported), and the same tools
as `browser_batch` steps (the step result carries the same `observed` object and `hint`).

## Observation (additive)

```text
observed: {
  effect, documentChanged, verified, verdict, ...existing optional fields,
  url?:           string                        // documentChanged && known at settle end
  newTabs?:       [{ tabId, url, held: false }] // opener = pressed tab, created during the window
  downloads?:     [{ id, filename, url, state }]// recorded for this session during the window
  observedForMs?: number                        // set only when none of the three happened
}
hint?: string   // link with address + nothing observed; or newTabs present (names tabs_claim)
```

Rules:
1. The window is the existing settle wait after dispatch (400 ms). Collection adds no wait.
2. `documentChanged` keeps its meaning. `url` is omitted when the tab's URL cannot be read.
3. `newTabs` never changes ownership; `held` is `false`.
4. `downloads` uses the same identity as `downloads_context`.
5. A press that caused several outcomes reports all of them.
6. Link hint (en-US wording, host-independent): "The link was pressed, but nothing navigated,
   opened or downloaded within 400 ms. The page may handle it itself — read the page or wait
   before assuming it did nothing."
7. New-tab hint: "The press opened tab <id> (<url>). It is not held by this session; use tabs_claim
   to act on it."

## Binding failure

```text
{ outcome: "failed", reason: "page-not-responding", hint: "The page did not answer for 10 s; it is still open. Retry the call, or take a screenshot to see its state." }
```

Emitted when the page binding's probe hits the content deadline. Also emitted (T402, R-197) when a press or keystroke's CDP input dispatch is not answered within the same deadline; the input was delivered and may have taken effect, so that answer carries a different hint:

```text
{ outcome: "failed", reason: "page-not-responding", hint: "The input reached the page, which then did not answer for 10 s; it is still open and the input may have taken effect. Take a screenshot or read the page before sending it again." }
```

`stale` remains only for
`tab-gone` and `stale-reference` (and the existing `stale-context` inside verification, which is a
verdict, not a binding failure).

## Tests that pin it

- contract: observation schema accepts each new field, rejects unknown keys, `held` literal false;
  reason `page-not-responding` in the reason list.
- unit: fake tabs/downloads events inside and outside the window; link vs button target; batch
  pass-through; deadline → reason.
- gate: `agent-press-outcomes.spec.ts` six variants × tools (SC-109).
