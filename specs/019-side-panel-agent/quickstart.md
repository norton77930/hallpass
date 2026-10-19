# Quickstart: validating 019

Runnable checks that prove the spec's success criteria. Shapes are in `data-model.md` and
`contracts/conversation-frames.md`; this guide does not repeat them.

## Prerequisites

- Built tree: `npm ci`, `npm run build`, `npm run agent-host:install` (the broker is a new host entry;
  the host manifest path does not change).
- Packaged gate prerequisites as in `CLAUDE.md` (private `LOCALAPPDATA` shared by browser and runner,
  `HALLPASS_FOREIGN_AGENT_SERVERS=allow`, test certificate).
- For the real-agent checks only: Claude Code and Codex installed and signed in; the owner approves the
  paid runs.

## 1. Unit and contract (every slice)

```powershell
npm run typecheck
npm test
npm run build; npm run test:contract
npm run snapshot:check
```

Expected: green; contract pins updated for the package layout (R-327) and the new frames (R-323);
`AGENT_LINK_PROTOCOL` still 2; `AGENT_TOOL_NAMES` unchanged.

## 2. Process cleanup (SC-136) — relay-process tests + a measurement

- `npx vitest run --project unit packages/agent-host/tests/broker-job.test.ts`: spawns a relay with a
  fake native port, the relay starts the broker, the broker starts the fake ACP agent through
  `cmd.exe` and a detached grandchild; hard-kill the broker → 0 of the tree's pids remain; close the
  relay's stdin and start a new relay with the same browser run id → the broker is adopted and the agent
  pids are unchanged (worker recycle, FR-295); close the stdin with no new relay → 0 pids after 15 s; a
  greeting with `role: "broker"` and a wrong secret is refused.
- Manual, 10 trials on branded Chrome: start two panel conversations, close Chrome normally (5) and end
  `chrome.exe` with `taskkill /F` (5); after each, `Get-CimInstance Win32_Process` filtered to the
  broker's recorded pids shows none.

## 3. Packaged gate with the fake agent

`HALLPASS_BROKER_TEST_AGENT` (a JSON argv, e.g. node `--experimental-strip-types` and
`tests/harness/fake-acp-agent.ts`) makes the broker run the fake agent instead of an installed one, and
`HALLPASS_BROKER_TEST_IDLE_MS` shortens the idle stop; both are honoured only with `HALLPASS_TEST_MODE=1`
(`packages/agent-host/src/broker/test-mode.ts`). The browser and the runner share a private
`LOCALAPPDATA` with `HALLPASS_FOREIGN_AGENT_SERVERS=allow`; the spec skips unless all are set.

```powershell
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-conversation.spec.ts --reporter=list
```

Covers: tabs and pinned external card (US7, FR-283), streamed answer + action list (US1), strict card
with each answer and the per-conversation rule (US2, SC-135 with the fake agent), mode switch offers two
modes (SC-140), panel closed → reopen shows the stream (US4.1–4.2), idle resume (fake clock), cap of three
(FR-311), first-use consent card + cancel (US3.1–3.2), consent withdrawal ends browser access (FR-309).

Regression: every `tests/e2e/packaged/agent-*.spec.ts` of 0.12.5 unchanged (SC-138).

## 4. Release probe S19 (paid, owner-approved)

On branded Chrome with real agents, in a scratch conversation: Claude Code and Codex each — first-use
install from an empty `agents\` folder (SC-139 timing), "summarise this page" on a fixture page with the
site in "ask" (consent card shown, answer quotes the page; SC-134 first words ≤ 10 s), a file write
refused then allowed once, the mode switch, Chrome restart then continue (SC-137), and the 20-attempt
strict run (SC-135) as 10 per agent with a prompt that tries to write without asking.
