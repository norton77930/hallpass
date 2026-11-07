# Data Model: Agent Questions as Side-Panel Cards

All in memory (R-436): the broker's held question and outbox, the panel document's log. Nothing is stored.

## Question event (broker → panel) — `type: "question"`, R-430..R-433

| Field | Type |
| --- | --- |
| `requestId` | string 1..128 (`q-<n>`, the broker's own) |
| `message` | string ≤ 4000 |
| `toolCallId` | string 1..128, optional: the call it is tied to, when announced this turn (R-430) |
| `toolTitle` | string ≤ 200, optional: that call's title as announced |
| `fields` | `QuestionField[]` ≤ 20 |
| `skipOnly` | `true`, optional: shown with Skip only (R-432) |
| `waitsMs` | integer, optional: the agent's own waiting time when it says one (R-429) |

## QuestionField — R-432

| Field | Type |
| --- | --- |
| `key` | string 1..200, the form's property name |
| `kind` | `"choice"` \| `"choices"` \| `"text"` \| `"number"` \| `"integer"` \| `"yes-no"` \| `"unsupported"` |
| `label` | string ≤ 1000: the question's words (`title`, else `key`; R-438 for the adapters' hints) |
| `chip` | string ≤ 200, optional: the question's short tag (R-438) |
| `otherFor` | string, optional: this free-text field is the answer box or note of that choice field (R-438) |
| `description` | string ≤ 1000, optional |
| `required` | boolean |
| `options` | `{ value: string ≤ 1000, label ≤ 200, description? ≤ 1000, preview? ≤ 4000 }[]` ≤ 100 (choice, choices) |
| `minItems` / `maxItems` | integer, optional (choices) |
| `format` | `"email"` \| `"uri"` \| `"date"` \| `"date-time"`, optional (text) |
| `minLength` / `maxLength` / `pattern` | optional (text; `pattern` ≤ 400) |
| `minimum` / `maximum` | number, optional (number, integer) |
| `default` | the kind's value type, optional |
| `secret` | `true`, optional (R-433) |

## Question closed event — `type: "question-closed"`, R-435, R-436

| Field | Type |
| --- | --- |
| `requestId` | the question's |
| `ending` | `"answered"` \| `"skipped"` \| `"cancelled"` \| `"withdrawn"` \| `"agent-exited"` |
| `summary` | string ≤ 400, only with `answered` (secrets as hidden) |

## Reply (panel → broker) — R-434

`{ action: "accept", values: Record<key, string ≤ 10000 | number | boolean | string[] ≤ 100> }` (≤ 20 keys)
or `{ action: "decline" }`.

## Held question (broker only)

`{ requestId, fields, resolve, signal }` beside the permission cards (R-437); removed on any ending.
