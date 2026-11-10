# Contract: Activity item kind `consent` (032)

`agentActivityItemSchema` (packages/contracts) gains the kind `"consent"` and three optional fields, present
exactly when the kind is `consent`:

| Field | Values |
|---|---|
| `question` | `effect`, `diagnostics`, `transition`, `site-plan`, `plan`, `upload-directory`, `dialog` |
| `channel` | `client`, `browser`, `none` (`none` only with `timed-out`) |
| `answer` | `once`, `session`, `always`, `deny`, `timed-out` |

`site` is required for `consent`. The existing 20-entry cap (`AGENT_ACTIVITY_KEPT`) applies.

## Side panel sentence

One sentence per item, from the panel's own keys (zh-TW and en), naming the question, the site, the place
(在終端機 / 在 Chrome) and the answer, for example 「頁面操作 · https://www.wikipedia.org · 允許這個工作階段（在終端機）」
and 「換網站 · https://zh.wikipedia.org · 沒有回答（逾時）」. An unknown kind must never fall through to the
dialog sentence (today's `activityText` default).
