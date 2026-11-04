# Quickstart: Agent Questions as Side-Panel Cards

1. **Automated** (any platform). The 029 tests:
   - contracts: the new events and the reply command;
   - host: questions over the fake agent's `ask:elicit` and the new `ask:form:*` keywords, covering each
     field kind, Skip, Stop, withdrawal, exit, a question outside a turn, an invalid reply, and two answers;
   - side panel: the card's controls, required fields, secret input, Skip only, the answered line.

   ```bash
   npx vitest run --project unit packages/contracts packages/agent-host/tests/broker-questions-029.test.ts
   npx vitest run --project extension-ui apps/extension/tests/side-panel-question-card-029.test.tsx
   ```

2. **Measure first (Windows)**: `npm run build`, then `npm run probe:017`. Expected (R-429):
   - Claude Code and Codex: `asked by elicitation (form)`;
   - DeepSeek: plain text;
   - Hermes 0.22.2: recorded for R-428.

3. **Claude Code (Windows, side panel)**: ask "Ask me with your question tool whether to use tabs or
   spaces." A card shows the choices and an "Other" box. Pick one and press Send; the reply names it. Ask
   again and press Skip; the agent says you did not answer.

4. **Codex**: in a mode where Codex asks for input, the card's message is Codex's ("needs your input") and
   the questions are its fields. Press Stop while it waits; the card closes as cancelled and the turn ends.

5. **Two panel documents**: open the side panel in two windows. Answer in one; the other's card closes with
   the same answered line.

6. **Unchanged**: a Codex MCP tool approval still arrives as a permission card. Hermes and DeepSeek
   conversations are as before. `%LOCALAPPDATA%\hallpass` holds no answered value (SC-199).
