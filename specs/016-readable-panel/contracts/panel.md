# Contract: What the panel shows (FR-223 – FR-237)

Strings: zh-TW / en-US (keys in `apps/extension/src/locales/*.ts`).

## Status row

`● 已連線 · {n} 個工作階段` / `● Connected · {n} sessions`; n = 1 `1 個工作階段` / `1 session`;
n = 0 `沒有工作階段` / `no sessions`. No agent name. No in-panel `<h1>`.
Menu 更多選項 / More options: one row per paired agent `{displayName}` + 解除配對 / Unpair.

## Session card

| Part | zh-TW | en-US |
| --- | --- | --- |
| title (label) | `{agent} · {label}` | same |
| title (no label) | `{agent} · {HH:mm} 開始` | `{agent} · started {HH:mm}` |
| subtitle | `{HH:mm} 開始 · 持有 {n} 個分頁：{sites}` / `沒有持有分頁` | `started {HH:mm} · holds {n} tabs: {sites}` / `holds no tabs` |
| state working | 正在操作 | Working |
| state waiting | 等你回答 | Waiting for you |
| state idle | `待命中 · 上次動作：{t}` | `Idle · last action {t}` |
| t | 剛剛 / `{m} 分鐘前` / `{h} 小時 {m} 分鐘前` | just now / `{m} min ago` / `{h} h {m} min ago` |
| details | 技術資訊 → `工作階段 ID：{sessionId}` | Technical details → `Session ID: {sessionId}` |
| end | 結束工作階段 (always, left) | End session |
| interrupt | 中斷這一步 (working only) | Interrupt this step |
| take back | `收回分頁（{n}）` (n ≥ 1 only) | `Take back tabs ({n})` |

Stripe: the session colour's token; absent when the projection carries no colour. A waiting card's
border uses the warn token. Label text is inert and cut with an ellipsis past ~24 visible characters
(full text in `title`).

## Site row

Select with `data-permissive="true"` in skip-checks → warn-token 2 px border; no badge.
Checkbox: 允許讀取 console 與網路紀錄 / Allow reading console and network logs; accessible name
includes the site. No "granted" line. Revoke: 撤銷 / Revoke, `aria-label` `撤銷 {site}` / `Revoke {site}`.
