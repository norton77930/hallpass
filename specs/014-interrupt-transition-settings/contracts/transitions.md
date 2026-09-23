# Contract: site transitions (feature 014, S2)

Lives in `packages/contracts/src/agent-tools.ts` (prompt kind, fields, decision, reasons, panel
state and messages, descriptions) and `apps/extension/src/service-worker/{agent-tools/transitions.ts,
transition-store.ts, agent-runtime.ts}`; this file is the readable statement the tests pin.
Link protocol number unchanged; the one host-visible addition (`notice`) is additive and falls
back to `hint` if the response schema is strict (research R-187 §6).

## Definition

A *transition* on a held tab: its URL changes (top-level, `tabs.onUpdated`) to an http(s) origin
`to` different from the origin the session last knew for that tab, and none of rules (a)–(e) in
`data-model.md` exempts it. Identity = origin (`scheme://host[:port]`); a URL on any other scheme
is not an arrival and records nothing.

## The causing call (any tool during which the change happened)

Its own outcome is unchanged. When, at answer time, the tab has a pending transition, the
response carries:

```
notice: { transition: { from, to },
          text: "The tab moved from <from> to <to>; the next call on this tab will ask the owner." }
```

(or the same text in `hint` on a strict schema). The host appends `notice` to the JSON text
block the agent reads.

## The next call on that tab (reads included)

Held behind a card:

```
AgentEffectPrompt { kind: "transition", transition: { from, to }, site: to, tool, argsSummary, ... }
```

Panel answer `ui.agent.effect-decide { promptId, allow, rememberTransition? }`:

| Answer | Effect on the call | Effect on state |
| --- | --- | --- |
| 繼續 (`allow: true`) | proceeds | pending cleared; `from→to` allowed for this session |
| 一律允許 (`allow: true, rememberTransition: true`) | proceeds | as above + persisted `{from, to, allowedAt, lastUsedAt}` |
| 拒絕 (`allow: false`) | `{ outcome: "denied", reason: "site-transition-declined" }` | pending kept; session and tab kept |
| not answered (011 bound) | `{ outcome: "timed-out", reason: "no-answer" }`, with the 011 hint | pending kept |
| 停止 / 中斷 | as those controls | — |

(S2 ruling 2026-09-22: a question nobody answered ends exactly as a consent card's does —
`timed-out / no-answer` through `noAnswerResponse`, not a `denied` of its own. One vocabulary for
"nobody answered" is what an agent can branch on.)

**Calls that leave the site are admitted**: a `navigate` whose requested origin ≠ `to`,
`tabs_close` and `tabs_release` (S2 ruling 2026-09-22 — none of them acts on the undecided site,
and an agent that must not be there has to be able to go without waiting for an answer).
Calls on the session's other tabs are not held. Tools that name no tab are not held.

`browser_batch`: a pending transition on a step's tab stops the batch before that step, in the
batch convention S1 kept (its own outcome is `ok` whenever it ran at all; each step's outcome is
in the results): the stopped step carries `stopped / site-transition` and the notice, the steps not
run carry `stopped / not-run`, and the result also lists `completed`, `stoppedAt`, `notRun`.
(S2 ruling 2026-09-22, the same one `contracts/interrupt.md` records: the host reports a non-`ok`
call as its outcome and reason alone, so a top-level `stopped` would lose the three lists.)

## Persisted allowances

`chrome.storage.local["agentTransitionAllowances"]: { from, to, allowedAt, lastUsedAt }[]`.
Listed as `AgentPanelState.transitions`; rows in the site list show `from → to`, last used, and
a revoke → `ui.agent.transition-clear { from, to }` → removed; the next `from→to` asks again in
every session (session sets are not affected by a revoke of the persisted record, by design:
a session that was told 繼續 keeps that answer until it ends).

## Test switch (gate only)

`chrome.storage.local["agentTransitionsTestNoLoopbackExemption"] = true` disables rule (a).
Widens prompting only. Documented in `quickstart.md`; never set by the product.

## Descriptions (host `tool-offering`, contract-pinned sentences)

- `navigate`, `click`: "If the tab lands on a site the owner has not decided about, the answer
  says so and the next call on that tab asks the owner (continue / always / decline)."
