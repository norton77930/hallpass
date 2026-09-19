# Clean-room provenance (T087)

Production source under `apps/extension/src`, `packages/contracts`, and `packages/domain` must not import `@hallpass/test-kit`, declare `declarativeNetRequest`/`chrome.alarms`, or copy reference-extension private assets. (`apps/server/src` was removed with the archived remote path in 009.)

Checked by `tests/contract/shipping-artifact.contract.test.ts`. `poc-scope.contract.test.ts` was retired with the remote path in 009.
