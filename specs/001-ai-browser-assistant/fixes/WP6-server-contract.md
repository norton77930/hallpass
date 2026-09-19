# WP6 — Server 契約:授權交易驗證、缺 Origin 拒絕、封閉錯誤回應、409 租約、cancel reason

狀態:待開工 · 規模:M · 風險:**R2**(授權流程、憑證)· 審查:owner 開工同意 + code-reviewer · 套用決策:D3、D8、D9 · 相依:WP5 先完成 `handler.ts` 的 lease timer

**R2 程序(D8)**:owner 已於 2026-09-03 同意實作,但主 session 在開工前仍以一行向 owner 確認;由主 session 直接實作,不派 writer 角色;完成後 `code-reviewer` 通過才算完成;不可執行任何 release/deploy。

## 1. 為什麼

- 審查 H7:`/v1/auth/exchange` 不驗證 `state`、PKCE `code_verifier`、`redirectUri`,也沒有交易過期與一次性消耗;任何人拿到 code 都能換 session。
- 審查 M11:缺 `Origin` 的請求沒有被拒;M12:錯誤回應形狀開放、可能帶 message 與可快取;M14:同一 session 可同時開多個任務,沒有 409 租約。
- 審查 L10:過期 access 查詢會刪掉仍持有 refresh 的 session;L11:origin assessment 未正規化;L12:`handle()` 在 closed 後未早退、requestId 未與 outstanding 請求關聯、messageId 未去重、outbound schema 失敗直接關閉沒有 failure frame。
- handoff #2:worker `auth-controller.ts` `begin()` 的 stale 分支沒有對本次 exchange 拿到的憑證做 best-effort revoke;#6:cancel reason 沒反映到終態;#8:test-kit `auth-adapter.ts` 每次 exchange 回同一組 session/access。

## 2. 範圍與非目標

範圍:`apps/server/src/routes/auth.ts`、新的 `apps/server/src/domain/authorization-store.ts`、`composition.ts` 的 Origin hook 與 error/notFound handler、`domain/task-store.ts` 的 `activeTaskFor`、`routes/tasks.ts` 的 409、`task-channel/handler.ts` 的 L12 小修與 `maxPayload`、`services/origin-safety.ts` 的 L11、`packages/test-kit/src/auth-adapter.ts`、worker `auth-controller.ts` 的 stale revoke、contracts `product-api.ts` 的錯誤碼、`contracts/product-api.md`(或對應的 openapi)文件。

非目標:選定 identity provider;refresh token 輪替設計;rate limiting;任何 production 部署;CORS 允許清單來源的變更(WP7)。

## 3. 宣稱

1. `/v1/auth/authorization` 以 `state` 為 key 寫入 `{redirectUri, codeChallenge, expiresAt(10 分鐘), used}`;`/v1/auth/exchange` 原子消耗、比對 `redirectUri`、驗 `base64url(sha256(codeVerifier)) === codeChallenge`;state 重用、錯的 verifier、錯的 redirectUri、過期 state 各回 openapi 定義的錯誤碼、`Cache-Control: no-store`,且不建立 session;正確流程仍通。證據:`apps/server/tests/auth.routes.test.ts` 紅測。
2. test-kit `auth-adapter.ts` 每次 exchange 鑄唯一 `sessionId` / access,並驗證 code 等於 fixture 常數。證據:test-kit 測試。
3. worker `auth-controller.ts` `begin()` 的 stale 分支對本次 exchange 拿到的精確 `accessCredential` 發一次 best-effort revoke。證據:`apps/extension/tests/auth-controller.test.ts` 紅測。
4. `/v1/*` 缺 `Origin` → 403 `cors.origin-missing`;`/health` 豁免(D3);test-server 的 fixture 路由掛在 `/v1` 之外。證據:`tasks-and-channel.test.ts` 與 `tests/contract/product-api.contract.test.ts`。
5. 錯誤回應封閉:adapter 拒絕 → 503 `service.unavailable`;body 解析錯誤 → 400 `request.invalid`;未知路由 → 404 `route.not-found`;一律 `no-store`、不帶 message、不帶 stack。證據:`product-api.contract.test.ts`。
6. 同 session 在非終態任務存在時 `POST /v1/tasks` → 409 `task.lease-held`;`complete()` / cancel 釋放。證據:`tasks-and-channel.test.ts`。
7. cancel reason 記錄到任務,終態 `reasonCode` 對應契約的四個值。證據:`tasks-and-channel.test.ts`。
8. L10–L12 小修成立:過期 access 查詢不刪持有 refresh 的 session;origin assessment 拒絕 `new URL(v).origin !== v` 的輸入;`handle()` 在 closed 後早退、requestId 關聯 outstanding 請求、messageId 去重、outbound schema 失敗先送 `failure` / `protocol.violation` 再關;`@fastify/websocket` 註冊 `maxPayload`(D9:64 KiB)且超大 frame 關閉。證據:server 測試各一。

## 4. 先寫的紅測

- `apps/server/tests/auth.routes.test.ts`:state 重用、錯的 verifier、錯的 redirectUri、過期 state → 對應錯誤碼、`no-store`、無 session;正確 PKCE 流程通。
- `apps/server/tests/tasks-and-channel.test.ts`:同 session 第二個任務 409;cancel reason 反映到終態;終態後 frame 不到 adapter;超大 frame 關閉;缺 Origin 的 `/v1/tasks` 403、`/health` 204。
- `tests/contract/product-api.contract.test.ts`:未知路由與 adapter 拒絕的回應形狀、`no-store`、無 message。
- `apps/extension/tests/auth-controller.test.ts`:stale begin → 對該憑證的 revoke 被呼叫一次。
- `packages/test-kit/src/auth-adapter.test.ts`(新):兩次 exchange 得到不同 session/access;錯的 code 被拒。

## 5. 設計

- `authorization-store.ts`:記憶體 store,TTL 10 分鐘,`consume(state)` 原子;composition 注入。
- `routes/auth.ts`:authorization 寫入 store;exchange 先驗 store 再呼叫 adapter;錯誤碼沿用 `packages/contracts/src/product-api.ts` 的封閉列舉,缺的在此新增並同步 openapi/文件。
- `composition.ts`:`onRequest` hook 對 `/v1/*` 檢查 `Origin`;`setErrorHandler`、`setNotFoundHandler`。
- `task-store.ts`:`activeTaskFor(sessionId, runtimeEpochId)`;`routes/tasks.ts` 回 409。
- `handler.ts`:L12 小修;`maxPayload` 由 config 注入(D9 預設 64 KiB,與 WP8 的 frame 上限同一常數來源)。
- worker `auth-controller.ts`:stale 分支 best-effort revoke,失敗吞掉。
- 所有變更不得記錄 code、verifier、credential 到 log。

## 6. 契約文件同步

`contracts/product-api.md`(或 openapi 檔)補錯誤碼、409、Origin 規則、`no-store`;`contracts/task-channel.md` 補 `maxPayload` 與 cancel reason 對應。

## 7. 出口檢查與最終驗證

索引第 6 節。另外:`npm run test:contract` 必含 product-api 契約;packaged gate 用的是 test-server,Origin hook 上線後 gate 仍須全綠(fixture 路由已移出 `/v1`)。

## 8. 審查

code-reviewer 審全部宣稱;因屬 R2,審查報告要明列「授權交易驗證」與「錯誤回應不洩漏」兩點的驗證結果。若碰到 `composition.ts` 的對外介面(config 形狀),加派 architecture-reviewer。

## 9. 交付紀錄(實作者填寫)

- **owner 開工確認(日期/原文)**:2026-09-04,owner 原文「開始 WP6」(承接 2026-09-03 的 D8 同意)。
- **完成日期**:2026-09-04。
- **出口檢查結果**(同一個最終 build,依序、各自檢查 exit code):`npx tsc -b` 0;`npx tsc -p apps/extension --noEmit` 0;
  `npx tsc -p tsconfig.tests.json --noEmit` 0;`npm test` 50 檔 / 429 測試、exit 0;`npm run test:contract` 11 檔 / 69 測試、exit 0;
  `npm run build:extension:test` 0;`npm run build` 0;packaged gate en-US 11/11、zh-TW 11/11(依序、未並行)。
- **審查發現與處置**(fresh-context `code-reviewer`,兩輪):
  - 兩個 R2 標題兩輪都 PASS:「授權交易驗證」(唯一建立 session 的路徑必須先消耗交易並通過 PKCE,失敗一律同一行同一碼且不觸及 provider)、
    「錯誤回應不洩漏」(server 下所有錯誤回應都是裸 `{code}`、值都在封閉列舉內、一律 `no-store`)。
  - **1 High(H1)**:`activeTaskFor` 對「上一個 runtime epoch 的活任務」呼叫 `complete()`,記錄被刪但 channel 與 provider 仍在跑,
    等於把 M14 想關掉的狀況換個形式打開。改成 `cancel(taskId, "lifecycle-interruption")`,由 channel 的 cancel listener 走正常終態與 teardown。
  - **2 Medium**:(M1)L10 的修法讓 `getByAccess` 刪掉 `byAccess` 索引,結果 `DELETE /v1/auth/session` 拿過期憑證找不到 session,
    本地與遠端都留下一個沒人拿得到的 session — 改成不刪索引、每次重驗到期,並新增只給 logout 用的 `findByAccess`;
    (M2)`client.stop` 的 `reason` 被丟掉、硬寫成 `user-stop`,與本 WP 剛同步的 `task-channel.md` 矛盾 — 改為採用 client 給的 reason。
  - **修掉的 Low**(與宣稱或文件矛盾者):L4 `task-channel.md` 的冪等段落與新的 messageId 去重規則自相矛盾;
    L5 宣稱 4 缺 channel upgrade 的證據;L7 第三個 stale 分支沒被斷言會 revoke;L8 openapi 錯誤碼比對只有單向;L10 過時註解。
  - 複審後新增 1 Low(logout 的路由接線本身沒被釘住,改回 `getByAccess` 也不會有測試變紅)也一併補上路由層紅測。
  - 每個行為變更都先寫紅測;H1/M1/M2 與 L12 各項各自以「暫時還原該修正 → 確認變紅 → 復原」證明過。
- **留下的後續項目**:
  1. `IdentityProvider.exchange` 沒有「provider 拒絕」的回傳分支,只能丟例外,於是變成 `503 service.unavailable`;
     擴充套件會讀成服務中斷。要改 `ports/identity-provider.ts` 的形狀,超出本 WP 第 2 節範圍。
  2. provider 產出的 `server.terminal` 自己過不了 envelope schema 時會靜默關閉(`terminals` 在 `send` 之前就加了),
     `task-channel.md` 的寫法已涵蓋這個情況;真要送出 frame 只需把「終態計數」改成 `send` 回 true 之後才加。
  3. `seenMessageIds` 在單一 session 內無上限(rate limiting 是非目標;加上限會破壞去重本身)。
  4. `maxPayload` 的注入接縫只在 `registerTaskChannel` 的選用參數上,沒有進 `ServerConfig(WP7 起;WP6 當時名為 ServiceSecurityPolicy)` — 併入 WP8 的 bounds 注入。
  5. `authorization-store.start` 對重複的 `state` 會直接覆蓋既有交易(只是對已知 state 的騷擾,不影響 session 路徑)。
  6. `npm test` 在本機出現過兩次異常回報(49 檔 / 428 與 49 檔 / 421 + 1 error),都發生在我中止另一個測試背景工作之後的短窗內;
     之後連續 15 次以上皆為 50 檔 / 429。機器上有約 170 個其他專案的常駐 node 行程,判斷是 worker 啟動期的資源競爭,
     不是本 WP 的回歸,但 WP10 的環境證據值得記一筆。
