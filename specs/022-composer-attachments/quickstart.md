# Quickstart: validating attachments

Prerequisites: `npm install`, `npx tsc -b`, `npm run build`, extension reloaded, host installed for this
checkout (`npm run agent-host:install`), test pages `npm run dev:test-pages`.

1. Unit + UI: `npm test` — attachment tests in `packages/agent-host` (staging, naming, containment, limits,
   cleanup, prompt blocks), `apps/extension/tests` (tab capture, composer chips, transfer, held message).
2. Contract: `npm run test:contract` after the build.
3. Shots (fake agent, no API cost): `node .scratch/t602/t602.mjs shots --phases=attach --langs=en-US,zh-TW`
   then `node .scratch/t602/sheets.mjs` — chips (image/file/tab, preparing/ready/refused), + menu with hint
   and a disabled entry, bubble with attachments, light and dark.
4. Live with Claude Code (owner, optional, costs one prompt): paste a screenshot, ask what it shows; drop a
   CSV, ask for its row count; "Attach this tab" on a long article, ask for 3 points. Check
   `<folder>\hallpass-attachments\`.
5. Containment: unit test feeds names `..\..\x`, `C:\x`, `con`, `a:b`, 300-char names — every write stays in
   the subfolder (SC-151).
