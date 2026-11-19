# Plan: 041 focus check before keys

- **A**: no code (D-041-1). The packaged overlay scenario is the pin.
- **B**: proven (coverage.md).
- **C seam**: `createFocusConfirmer` / `pollFocusRetained` and the `type` / `key` delivery in
  `apps/extension/src/service-worker/agent-tools/effects.ts`; the verdict table in
  `apps/extension/src/service-worker/effect-verification.ts`; the focus answer for an unresolvable handle in
  `apps/extension/src/content-runtime/index.ts` (`content.resolve-active-element`); the verdict enum in
  `packages/contracts/src/agent-tools.ts` and the verdict text in `packages/agent-host/src/mcp-server.ts`.
- **Slice C** (implementer-sonnet, worktree `spec-041-frame-focus`): T1121..T1126.
- **Risk**: R1 (error-handling paths: what an unanswerable check does): code-reviewer after the slice.
