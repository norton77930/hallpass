# Quickstart: validating spec 032

## Automated

```powershell
npx tsc -b; npm run typecheck; npm test; npm run build; npm run test:contract; npm run snapshot:check
```

Packaged gate (attach mode, private `LOCALAPPDATA`, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`, test pages on
`https://localhost:19443`), with the 031 scripted elicitation client:

- a cross-site move answered `session` in the client runs the next call and withdraws the card;
- the same move answered `deny` refuses as `site-transition-declined`;
- a `propose_sites` answered `session` in the client approves every proposed site for the session.

## Owner live check (branded Chrome, Claude Code; about 5 minutes)

Before: reload the extension at `chrome://extensions` and run `/mcp` → reconnect hallpass.

1. **Transition in the terminal.** Ask the agent to open `https://www.wikipedia.org`, search for a word and
   press Enter (the tab moves to a language site). Cover Chrome with the terminal. On the agent's next call
   the terminal asks *continue for this session / deny*; there is no *always*. Choose continue. Expected:
   the agent carries on, and the side panel card is gone.
2. **Revoke.** In the terminal, allow page actions on that site for this session. Open Hallpass settings and
   revoke the site. Ask the agent to click something there. Expected: you are asked again.
3. **Activity.** Open the session card. Expected: lines for checks 1 and 2 naming the site, 在終端機, and the
   answer.
4. **Bar after restart** (optional). Act on a tab, then at `chrome://serviceworker-internals` stop the
   Hallpass worker. Within about 30 s of it starting again, the "being debugged" bar is gone.
