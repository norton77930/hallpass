# Data Model: Outside-Agent Consent and Capture Experience (031)

## Question (extends the existing pending prompt, `prompts.ts`)

| Field | Meaning |
|---|---|
| `promptId`, `callId`, `sessionId`, `site`, `tool` | as today |
| `kind` | `effect` (as today) or `diagnostics` (new card kind, R-460) |
| `clientChoices` | the choices the client may offer: `["once","session","deny"]`, or `["once","deny"]` for tools outside the covered set (R-457) |
| `cardChoices` | adds `always` (effect: the remembered skip-checks mode; diagnostics: the diagnostics grant) |
| `raisedAt`, `boundMs` | `boundMs` is always 120 000 (R-453) |
| `answeredFrom` | `client` or `browser`, set by whichever answer settles it first |

States: `pending` -> `allowed(once | session | always, from)` | `denied(from)` | `timed-out` | `stopped`
| `released` | `interrupted`. Exactly one transition leaves `pending`. Any answer that arrives after it
is logged as late and changes nothing (existing behaviour, now also for answers from the client).

## Session grant (new, `chrome.storage.session`, R-456)

| Field | Meaning |
|---|---|
| `sessionId` | key, the agent session |
| `site` | full origin (as in D-030-2) |
| `kind` | `page-actions` (admits `AGENT_SITE_PLAN_COVERED_TOOLS`) or `diagnostics` (admits `read_console`, `read_network`, and the diagnostics check of `evaluate`) |
| `source` | `client` or `browser` |
| `grantedAt` | epoch ms |

Rules: entries are only ever added (no replace). An entry is removed with its whole session on
`releaseSession`, unpair (by agent) or a session clear. It never matches another `sessionId`. A grant of
`kind: diagnostics` never satisfies the effect gate, and a grant of `kind: page-actions` never satisfies
the diagnostics check.

## Debugging hold (extends `AgentInputAttachments`, R-466)

| Field | Meaning |
|---|---|
| `holders` | set of `input`, `diagnostics`, `recording`, `viewport` (as today, now readable) |
| `inFlight` | count of effect and capture calls currently using the tab |
| `idleTimer` | armed when `inFlight == 0` and holders ⊆ {`input`}; it drops `input` 20 s later |

Lifetime holders, which stop the idle release: `recording`, `viewport`, `diagnostics`.

## Capture outcome (extends the screenshot answers)

New refusal code: `window-minimized`, with a hint telling the agent to ask the owner to restore the
window. It is returned before anything is activated (R-463).
