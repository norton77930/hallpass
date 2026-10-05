# Contract: `prompt-waiting`, the `hint`, and the attention sentences

## Link frame (worker → relay → server)

```json
{ "type": "prompt-waiting", "sessionId": "s…", "callId": "c…", "kind": "ask",
  "panelConnected": false, "waitedMs": 5000, "boundMs": 120000 }
```

- Sent every 5 000 ms (±500) while a question **raised with no panel connected** is pending,
  starting 5 s after raise; the first tick plus transit is what SC-078's "within 6 s" measures. A
  question raised with a panel connected sends no ticks (review M1).
- For a consent question raised by a `browser_batch` step the frame's `callId` is the **batch**
  call id — the one the relay routes and the router holds — never the step id (review H1).
- Every session waiting on one pairing card sends its own ticks with its own `sessionId` (review
  M2); a session's ticks stop at its bound and restart, with presence re-read, on a re-request
  (review L2).
- `callId` omitted for `kind: "pairing"`.
- A relay or host that does not know the type drops it; `AGENT_LINK_PROTOCOL` is unchanged.

## Host behaviour on receipt

| Party | Action |
| --- | --- |
| relay | forwards to the session's server, unchanged |
| router | if it holds `callId`: re-arm the backstop to `boundMs - waitedMs + 10 000`, never beyond 130 000 from the call's start; otherwise ignore |
| server | `notifications/progress { progressToken, progress: waitedMs, total: boundMs, message }` on the call's token (or the pairing exchange's); `message` = attention sentence when `panelConnected` is false, else the existing neutral text |
| server (pairing) | `awaitPairing` bound = `max(45 000, boundMs)` once a frame with `panelConnected: false` arrives for this session |

## Tool outcome on expiry

```json
{ "outcome": "timed-out", "reason": "no-answer", "hint": "<attention sentence>" }
{ "outcome": "timed-out", "reason": "not-paired: no answer", "hint": "<attention sentence>" }
```

`hint` is present only when the question was raised with the panel closed. The MCP text result
carries it as today's `{reason, hint}` JSON so the agent can relay it.

## Attention sentences (`packages/contracts`, `ATTENTION_SENTENCES`)

| kind | text (English line, then zh-TW line, separated by a newline) |
| --- | --- |
| pairing | Hallpass is waiting for you to accept the pairing in Chrome's side panel, which is closed. Click the Hallpass icon in the toolbar or press Alt+A to open it.<br>Hallpass 正在等你在 Chrome 側欄接受配對,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A 打開它。 |
| ask / plan / dialog / diagnostics | Hallpass is waiting for your answer to a consent card in Chrome's side panel, which is closed. Click the Hallpass icon in the toolbar or press Alt+A to open it.<br>Hallpass 正在等你回答側欄裡的同意卡,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A 打開它。 |
| browser-choice (018, added 2026-10-04) | Hallpass is waiting for you to choose which browser to use, and the side panel that asks is closed. In the browser you want, click the Hallpass icon in the toolbar or press Alt+A, then confirm there.<br>Hallpass 正在等你選擇要用哪個瀏覽器,但詢問的側欄沒有打開。請在你要用的瀏覽器點工具列的 Hallpass 圖示或按 Alt+A,然後在那裡確認。 |

The browser-choice sentence names no consent card and no one browser, because the choice spans every
browser running Hallpass. `request_browser_choice` reports it as its progress text once any browser
ticked with its panel closed, and as the `hint` of a `{chosen: false}` answer in that case.

Invariant: no page content, no tool arguments, no session id in the sentences (FR-151).

## Badge (browser state)

`setBadgeText("!")`, `setBadgeBackgroundColor("#b23a3a")`, `setTitle("Hallpass: a question is
waiting — click to open the side panel")` while attention is on; `setBadgeText("")` and the
manifest title otherwise. No `setPanelBehavior` (withdrawn at review L1: it would replace the
`action.onClicked` path that opens the tab-scoped panel).
