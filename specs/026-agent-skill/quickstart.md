# Quickstart: A Hallpass Skill for Outside Coding Agents

Prerequisites: a build with this feature (`npm run build`), the host installed for the checkout
(`npm run agent-host:install`), the extension reloaded.

1. **Automated**: `npx vitest run --project unit packages/agent-host/tests/agent-skill-026.test.ts
   packages/agent-host/tests/broker-agent-skill-026.test.ts packages/contracts/src/conversation.test.ts`,
   `npx vitest run --project extension-ui apps/extension/tests/settings-agent-skill.test.tsx`,
   `npx vitest run --project contract tests/contract/agent-skill-text.contract.test.ts`. All pass.
2. **Settings page, not installed**: open the settings page; the section "Skill for your coding agents"
   lists both folders as Not installed with Install.
3. **Install**: press Install on each; both read Up to date, and the files exist under
   `%USERPROFILE%\.claude\skills\hallpass\` and `%USERPROFILE%\.agents\skills\hallpass\`.
4. **Changed by you**: add a line to one copy and press Check again; it reads Changed by you; Update asks
   for confirmation and only then replaces it.
5. **The agents read it**: start `claude` in any folder and ask "which skills do you have?" - `hallpass` is
   listed. Do the same with Codex (records whether it reads `~/.agents/skills`, R-411).
6. **Behaviour** (SC-184, SC-185, model calls): with an unpaired browser ask the agent to open a page and
   click something; it mentions the pairing card. Decline the next consent card; it reports the decline and
   does not send the action again.
7. **Uninstall**: run `node packages/agent-host/dist/install/cli.js uninstall`; the unchanged copy is gone,
   the changed one stays and is named in the output.
