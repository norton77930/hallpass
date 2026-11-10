# Data Model: Consent Follow-ups After the Terminal Trial

## Owner question (worker, in memory; unchanged shape, widened use)

| Field | Meaning |
|---|---|
| id | `promptId` / `planId` / `proposalId`, random, never reused |
| kind | effect, diagnostics, dialog, transition, site-plan, plan, upload-directory |
| site(s) | the site it decides; transition also its from-site; site plan its proposed sites |
| terminal | present when raised to the client: host call id and choices offered |
| shown at | when armed; the tick with `waitedMs: 0` is sent then (R-486) |
| outcome | once, session, always, deny, timed-out; channel client / browser / none (R-488) |

Rules: one pending question per worker; one answer per question; a client answer is honoured only for the
open question with the same id and only for a choice it offered (031 FR-471).

## Session admission (chrome.storage.session)

| Store / key | Entry | Revoke of site S removes (R-487) |
|---|---|---|
| session grants / `agentSessionGrants` | session, agent, site, kind (page-actions, diagnostics) | every entry with site S, every session |
| site plans / `agentSessionSitePlans` | session, agent, origins | S from every plan; a plan left empty is removed |
| transitions allowed / `agentTransitionsAllowed` | session → list of from→to pairs | every pair whose destination is S, every session |
| transition allowances / `agentTransitionAllowances` (local) | from, to, date (*always*) | nothing |

## Activity item kind `consent` (contracts; see contracts/activity-consent.md)

`{ kind: "consent", at, site, question, channel, answer }`, kept in the session's latest-20 list.

## Debugger attachment (worker, in memory)

States per tab: unattached → attached and held (call, viewport, diagnostics, dialog, recording frame) →
attached and idle (countdown armed) → released. After a worker restart, an attached tab nobody holds starts
in "attached and idle" (R-489).
