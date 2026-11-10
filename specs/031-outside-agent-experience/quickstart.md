# Quickstart: Validating 031

Prerequisites: `npm install`, `npm run build`, the extension reloaded at `chrome://extensions`, and the
host installed (`npm run agent-host:install`). The packaged gate runs as described in CLAUDE.md (attach
mode, private `LOCALAPPDATA`, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`, test pages on
`https://localhost:19443`).

## Automated

```powershell
npm run typecheck
npm test                      # unit + extension-ui: prompts, gate, session grants, diagnostics, capture, attachments
npm run build:extension
npm run test:contract         # frames in contracts/terminal-consent.md, refusal codes, features list
npm run snapshot:check
```

Packaged gate specs (local only): one per story, named `tests/e2e/packaged/agent-*-031.spec.ts`. They use a
fake MCP client that advertises form elicitation and answers from a script, so every client-side
branch (answer, deny, decline, cancel, no answer, no capability) runs without a person.

## Live checks the gate cannot replace (owner, a few minutes, listed in tasks)

1. **Claude Code renders the question** (US1): in an interactive Claude Code session paired with
   Hallpass, ask the agent to click on a site in `ask` mode. Expected: a question appears in the terminal
   with three options; *Allow on this site for this session* lets the next clicks run unasked; the side
   panel shows the grant "from terminal".
2. **Codex renders the question** (US1): the same check in an interactive Codex session. If it does not
   appear, record the Codex setting that hides it. The card fallback must still work (US2).
3. **Chrome behind the terminal** (US4): cover Chrome completely, ask the agent to change a page and take
   a screenshot. Expected: the picture is current, and the owner's active tab never changes.
4. **Minimized** (US4.3): minimize Chrome, ask for a screenshot. Expected: the agent gets a picture of the
   tab and the window stays minimized; only if that capture fails does the agent say the window is
   minimized (D-031-11 as amended).
5. **Debugging notice** (US5): after the agent stops, the browser's "being debugged" notice disappears
   within about 30 s.

## Measurement before slice 3 (R-462, R-463)

A scripted run on branded Chrome attach mode records, for each tab state, 10 non-activating captures
after a page change and whether each is fresh. It also records whether a click and typing land in a
minimized window. The results go in this feature's research change log before slice 3 implementation
begins.
