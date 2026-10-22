# Quickstart: validate 021

## Prerequisites

- Built tree: `npx tsc -b && npm run build`, dev host installed (`npm run agent-host:install`), extension reloaded.
- Hermes 0.22.2 installed with the official installer pinned to commit d923a5e, its model configured by the owner.
- Git for Windows (for Hermes' commands under automatic).
- DeepSeek: the owner's DeepSeek settings name a model and its key (environment variable or its own store).

## Automated

```powershell
npm run typecheck
npm test                    # descriptors, launch settings, mode restart, stop-while-starting, reject-only card, panel
npx tsc -b; npm run build:extension; npm run test:contract
npm run snapshot:check
```

Packaged gate (fake agent scenarios `hermes` and `deepseek`): `agent-conversation.spec.ts` through the
`.scratch/t602` runner.

## Live (owner's machine, owner's model)

1. Panel → agent list shows Hermes (ready / not installed / version problem, Git note) and DeepSeek
   (needs download, pre-release note).
2. DeepSeek → first use downloads (≤ 30 min), then "Starting DeepSeek… may take a few minutes"; press Stop
   once: the process is gone within 5 s and the message returns to the composer.
3. Strict, each agent, in a scratch folder: ask to edit `a.txt` → card appears before the edit; ask to run
   `echo hi > b.txt` → card or no command tool, `b.txt` not created unasked; ask to delete `a.txt` → not
   deleted unasked (SC-155..157).
4. Hermes: switch to automatic between turns → agent restarts, conversation continues; in-folder edit runs
   unasked. DeepSeek (D-021-16): pick automatic on the new conversation's mode chip before the first message
   → it starts in automatic and an in-folder edit runs unasked; once started its mode chip offers no switch
   and says another mode needs a new conversation. Any agent: a mode picked before the first message is the
   mode the started conversation shows (FR-361).
   Known limitation (R-361): a resumed Hermes session keeps its stored system prompt, so after switching modes
   the model may still say it has no command tools; the tools are available (they are recomputed on load) -
   tell it so in the next message. DeepSeek: the mode is fixed once the conversation has started (D-021-16);
   another mode needs a new conversation.
5. DeepSeek: a request whose card names no action shows only Reject.
6. Close and reopen a DeepSeek conversation after its agent stopped → continues, note that earlier turns are
   not replayed.
7. Claude Code and Codex: one strict turn each, unchanged (SC-162).
