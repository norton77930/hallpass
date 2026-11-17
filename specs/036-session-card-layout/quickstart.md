# Quickstart: verifying 036

1. **Machine** (worktree root): `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`,
   `npm run snapshot:check`.
2. **Focused**: `npx vitest run --project unit apps/extension/tests/session-card-model.test.ts` and
   `npx vitest run --project extension-ui apps/extension/tests/session-card.test.tsx`.
3. **Fixture captures** (visual gates V1-V4): from `apps/extension`, `npx vite --mode agent --port 5288`,
   then `node tests/visual/capture-session-cards.mjs <out-dir>` - writes
   `session-cards-{zh-TW,en-US}-{light,dark}.png` of the real `SessionCard` list rendered with the
   prototype's six-session fixture at 360 px. V1 (light zh-TW) is judged against the prototype's
   `shots/v-E.png`; V2-V4 against FR-541..556.
4. **Live** (gate L1): the unattended attach recipe (memory: Playwright Chromium on 9222, private
   LOCALAPPDATA, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`), then
   `HALLPASS_PANEL_SHOTS=1 npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-panel-shots.spec.ts`
   - two real sessions (one idle, one waiting) in the real panel, light/dark × zh-TW/en-US. Pass: the
   waiting card is open on top with Answer, the idle card is folded under "Idle", and pressing Answer
   focuses the consent card.
