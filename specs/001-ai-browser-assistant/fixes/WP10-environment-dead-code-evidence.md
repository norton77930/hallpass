# WP10 — 環境、死碼與證據

狀態:待開工 · 規模:S–M · 風險:無風險 · 審查:不派(刪碼以 typecheck 與全套測試為證據)· 套用決策:D4、D5、D7 · 相依:WP2–WP9 全部完成

## 1. 為什麼

- 審查 L14:測試 leaf 憑證 7 天到期時,packaged gate 全紅且訊息是 `ERR_CERT_DATE_INVALID`,看起來像產品回歸(2026-09-03 實際發生過)。
- 審查 L15:多處死碼與無消費者的匯出(`task-controller.ts`、`result-transmission-guard.ts`、`operation-markers.ts` 的 `recover`、`evaluateUserDenial`、`planOriginAssessment`、`evaluateCollectionFence`、`validateHello`、server 的 `logging.ts` / `adapters/identity.ts` / `services/origin-safety.ts` 中未使用的部分、contracts 的無消費者匯出、`composeServiceWorker()` 的 evaluator 再匯出、`action-entry.ts` 的死分支)。
- 審查 L16:六個非 packaged e2e spec(`tests/e2e/us1-*`、`us2-*`、`us3-*`、`failure-lifecycle-matrix`、`privacy-retention`、`accessibility-localization`)匯入私有函式而非走 MV3 旅程,違反 FR-003 的證據規則。
- 審查 L17 與 WP1 留下的:handoff 的 T091/T092 敘述過時;branded Chrome 的 T091 沒在 gate 擴充後重跑;domain `*.test.ts` 不在 tsc 檢查內。

## 2. 範圍與非目標

範圍:`tests/harness/test-server.ts`、`specs/001-ai-browser-assistant/quickstart.md` 或 local-run 文件、上列死碼檔案、`playwright.config.ts`、`apps/extension/tests/`(接收搬家的測試)、`packages/domain/tsconfig.json`、`CLAUDE-CODE-HANDOFF.md`、`browser-matrix.md`(或 evidence 文件)。

非目標:任何產品行為變更;T093/T094;`.test-pki/` 的移除;新的測試框架。

## 3. 宣稱

1. `requireTestPki` 在 leaf 憑證到期(或 24 小時內到期)時 fail-fast,訊息含 `npm run test:certs:install`;文件註明 7 天期限(D7)。證據:harness 單元測試或 `test-environment.contract.test.ts`。
2. 審查列出的死碼刪除後,三段 typecheck、`npm test`、contract、build 全綠;contracts 的 `index.ts` 只匯出有消費者的符號。證據:出口檢查 + `grep` 證明無殘留引用。
3. 六個非 packaged e2e spec 搬到 `apps/extension/tests/` 成為單元測試,覆蓋不減(以案例數對照);`playwright.config.ts` 只剩瀏覽器旅程;`test:e2e` 計數更新(D5)。證據:vitest 案例數對照表寫進本文件第 9 節。
4. `packages/domain` 的 `*.test.ts` 納入某段 typecheck(`tsconfig.tests.json` include 或 domain 自己的 test tsconfig)。證據:故意的型別錯誤會讓該段 typecheck 失敗(實驗後移除)。
5. 新寫一份日期為完成日的 handoff(取代 08-26 版的「Current verified state」與 T091/T092 敘述);Chrome 150 重跑 `test:e2e:release-matrix` 兩個 locale 並更新 `browser-matrix.md`;Chrome 151 維持手動 cell;T086 的實際狀態記給 owner 註記(D4)。證據:文件與 release-matrix 日誌。

## 4. 先寫的紅測

- `tests/contract/test-environment.contract.test.ts`(或 harness 測試):以過期的假憑證呼叫 `requireTestPki` → 拋出含安裝指示的錯誤;有效憑證 → 通過。
- 搬家的每個 spec:先在 `apps/extension/tests/` 建立同名 vitest 檔並讓案例通過,再刪 `tests/e2e/` 的原檔;案例數前後一致。
- domain tsc:在 `task-state.test.ts` 暫時放一個型別錯誤,證明 typecheck 會紅,再移除。

## 5. 設計

- `test-server.ts`:讀 leaf 憑證的 `notAfter`(`node:crypto` 的 `X509Certificate`),到期或 24 小時內到期即拋錯。
- 刪碼順序:先 `grep -rn` 每個符號確認無消費者,再刪;`composeServiceWorker()` 的 evaluator 再匯出移除後,測試直接匯入模組。
- 搬家:private-function 測試改為呼叫模組公開函式;若某案例本質上需要瀏覽器,改寫成 packaged 案例或標記為 owner 決策。
- typecheck:優先把 `packages/domain/src/*.test.ts` 加進 `tsconfig.tests.json` 的 include。

## 6. 契約文件同步

`quickstart.md` / local-run 文件補憑證期限與安裝指示;handoff 全面更新。

## 7. 出口檢查與最終驗證

索引第 6 節,另加 Chrome 150 的 `test:e2e:release-matrix`(en-US、zh-TW)。這是整個修正階段的唯一最終驗證;通過後立即回報 owner,由 owner 決定 T093 的排程。

## 8. 審查

不派審查。若刪碼時發現某個「死碼」其實有執行期消費者(例如透過字串鍵存取),停下來記錄並詢問 owner,而不是保留一半。

## 9. 交付紀錄(實作者填寫)

- **完成日期**:2026-09-05。

- **搬家案例數對照(前/後)**:

  | 檔案 | 搬到 | 執行案例數(前 → 後) |
  | --- | --- | --- |
  | `tests/e2e/accessibility-localization.spec.ts` | `apps/extension/tests/accessibility-localization.test.ts` | 2 → 2 |
  | `tests/e2e/failure-lifecycle-matrix.spec.ts` | `apps/extension/tests/failure-lifecycle-matrix.test.ts` | 5 → 5 |
  | `tests/e2e/privacy-retention.spec.ts` | `apps/extension/tests/privacy-retention.test.ts` | 1 → 1 |
  | `tests/e2e/us2-page-understanding.spec.ts` | `apps/extension/tests/us2-page-understanding.test.ts` | 10 → 10 |
  | `tests/e2e/us3-controlled-actions.spec.ts` | `apps/extension/tests/us3-controlled-actions.test.ts` | 1 → 1 |
  | `tests/e2e/us3-denial-boundaries.spec.ts` | `apps/extension/tests/us3-denial-boundaries.test.ts` | 2 → 2 |
  | `tests/e2e/us3-lifecycle.spec.ts` | `apps/extension/tests/us3-lifecycle.test.ts` | 3 → 3 |
  | **合計** | | **24 → 24** |

  斷言完全未改,只換了 runner 與 import 深度。靜態的 `test(` 數是 12,但其中兩個檔案用迴圈產生案例,
  實際執行是 24;這裡記的是執行數。

  **與 WP 文件的數字差異**:第 1 節說「六個」,實際是 **八個**檔案。七個直接 import 模組(上表),
  第八個 `us1-authorized-session.spec.ts` 只有一個真正 `page.goto` 的案例,另外六個是
  `test.skip` 的空殼——無論 harness 有沒有開啟都不斷言任何事。保留那一個真案例,刪掉六個空殼,
  所以 `test:e2e` 從「8 檔」變成「1 檔 1 案例 × 4 個 profile = 4」。
  `playwright.config.ts` 的 `testDir` 從 `./tests` 收斂到 `./tests/e2e` 並排除 `packaged/**`——
  不改的話,搬家之後它會用錯誤的設定去跑 packaged suite。

- **release-matrix 結果(Chrome 150,兩個 locale)**:**BLOCKED,未執行。**
  這台機器只裝了 Chrome `151.0.7922.174`;Chrome 150 已不存在。`test:e2e:release-matrix` 需要兩個
  不同的瀏覽器 binary,缺一即拒絕執行。沒有用 151 跑兩次、也沒有沿用 2026-09-01 的數字充當證據——
  那會是替一個沒人真的跑過的 cell 背書。`tests/acceptance/browser-matrix.md` 加了一則
  2026-09-05 的狀態註記(明確標示不是簽核 cell),說明現況與 owner 需要決定的兩條路:
  裝第二個 Chrome major,或依實際安裝重新記錄配對。
  branded Chrome(T091)同樣沒有做:packaged gate 用的是 bundled Chromium,把 `HALLPASS_CHROME_PATH`
  指向已安裝的 151 就能產出 branded 證據,但那是 owner 的 cell,工作規則明訂不代做。

- **出口檢查結果**(同一個最終 build,依序、各自檢查 exit code):`npx tsc -b` 0;
  `npx tsc -p apps/extension --noEmit` 0;`npx tsc -p tsconfig.tests.json --noEmit` 0
  (現在也涵蓋 `packages/*/src/**/*.test.ts`);`npm test` 57 檔 / 490 測試、exit 0;
  `npm run test:contract` 11 檔 / 92 測試、exit 0;`npm run build:extension:test` 0;
  `npm run build`(帶合法假值)0;兩個 build 之後再跑一次 contract 仍 11 檔 / 92;
  packaged gate en-US 11/11、zh-TW 11/11(依序、未並行)。

  **關於這份數字的誠實註記**:en-US 的 gate 在這輪跑了三次。第一次死在 webServer 啟動
  (我自己造成的 strip-types 解析錯誤,見下);第二次 10/11,`core-journey` 輸掉一個瞬間控制項的競態;
  第三次(修掉競態的觀察時機之後)11/11。zh-TW 在同一批改動之後也重跑並 11/11。
  兩個 gate 的最終數字都來自同一份 `dist/`——中間只改過測試檔與 harness 匯入路徑,沒有改過產品程式。

- **各宣稱的處置**:
  1. **憑證 fail-fast**:`.pfx` 是 PKCS#12,`node:crypto` 打不開,所以改成從 harness 自己的 TLS
     連線另一端讀**實際提供出去的**憑證(`getPeerCertificate().valid_to`)——那才是真正在用的那一張。
     判定邏輯抽成純函式 `classifyLeafValidity` / `leafValidityMessage`,不需要憑證就能測。
     已過期的 leaf 會讓 handshake 先失敗,那個錯誤被 `isCertificateExpiryError` 認出並回報成同一個環境錯誤。
     一天內到期也會停(gate 要跑好幾分鐘,不能讓它在跑到一半時過期)。
     七天效期寫進 `quickstart.md` 與 `local-run-checklist.md`,並註明
     `test:certs:verify` 檢查的是 CA 不是 leaf,所以它在這種情況下仍是綠的、不能當依據。
  2. **死碼**:刪除 `service-worker/task-controller.ts` 與 `service-worker/result-transmission-guard.ts`
     (完全沒有消費者);`operation-markers.recover`(與 domain 的 `mapMarkerAfterRestart` 重複,
     產品路徑用的是後者,測試改成斷言真正會執行的那個);`server/logging.ts`
     (`logCoarse` 呼叫遮蔽器之後把結果丟掉——沒有任何日誌產生,也沒有任何東西被遮蔽,
     留著會讓人以為日誌有被遮蔽);`server/adapters/identity.ts` 與 `bindOriginSafetyProvider`
     (兩個把參數原樣回傳的函式)。
     `composeServiceWorker()` 不再再匯出十個純函式(唯一消費者是一個逐個斷言「是 function」的測試,
     那是在測試測試本身),改成回傳 `service-worker/index.ts` 真正呼叫的四個成員,並用一個測試釘住這個表面。
     contracts 的 barrel 收掉 WP8 時代的內部符號(`createActionArgumentSchemas`、四個動作參數 schema、
     `channelNonceSchema`、`collectionBoundsSchema`)與被 WP8 孤立的
     `formValueWithholdingProjectionSchema`。
     **四個 per-capability result schema 沒有刪除,而是補上真正的契約測試**:它們是讓效果可驗證的東西
     (`documentChanged` / `valueEchoed` 的字面 `false`),先前沒有任何消費者,意味著欄位被放寬也不會有人發現。
  3. **e2e 搬家**:見上表。
  4. **domain typecheck**:`tsconfig.tests.json` 的 include 加上 `packages/*/src/**/*.test.ts`,
     **一納入就抓到五個原本藏著的型別錯誤**——三個 `PlanStep` 字面值缺 `bindingDigest`,
     兩個 `packages/test-kit/src/test-proxy.test.ts` 的 `exactOptionalPropertyTypes` 違規。全部修正。
     這比「故意放一個型別錯誤證明會紅」更直接:它自己就紅了。
  5. **handoff / 證據**:handoff 日期改為 2026-09-05,`Status` 與 `Pick up here` 整段重寫
     (舊的還在描述 2026-08-26 的「手動瀏覽器測試進行中」與從未完成的 `test:certs:install`)。
     `browser-matrix.md` 加了 2026-09-05 狀態註記。T086 的實際狀態記在 handoff 的 owner 待辦第 4 點(D4)。

- **第二個被 gate 抓到的問題,這個不是我造成的**:`core-journey.spec.ts` 的 `assertRestrictedPage`
  在等 `copy.stop` 之後才等 `unsupported` / `failed`。`stopAvailable` 在任務開始時是無條件投影的,
  所以 Stop 確實會出現;但受限頁面不需要任何網路往返就會走到終態,那個控制項可能在一次輪詢間隔內
  就出現又消失。在負載很高的機器上這一格就失敗了,而產品行為是對的。
  這個 spec 自己在前面已經為同類情況寫了 `waitForEitherText`
  (「Either outcome is contract-correct here; the browser decides which one the timing produces」),
  所以改用同一個判斷;`unsupported`、`failed` 與「不得出現 pageFinished」這三個真正的保證仍然逐一斷言。
  這是放寬對一個瞬間控制項的觀察時機,不是放寬結果。

- **一個被 gate 抓到的自造缺陷(值得記)**:我把 PKI 純函式放在 `tests/harness/test-pki.ts`,
  並用 `./test-pki.js` import。三段 typecheck、`npm test`、`npm run test:contract` **全部通過**,
  因為 tsc 與 vitest 的解析器都會把 `.js` 對應回 `.ts`。但 `tests/harness/test-server.ts` 是由
  `node --experimental-strip-types` 直接執行的,那個 runtime **不會**做這個對應,於是
  `ERR_MODULE_NOT_FOUND`,測試服務起不來,兩個 packaged gate 都在 webServer 階段就死了,
  而且只留下一行 `Exit code: 1`。
  **這是同一個坑第二次**:WP7 也是為了同樣的原因把 `createManifest` 從 `src/manifest.ts` 搬進
  `build-config.ts`(見 WP7 第 9 節)。修法是照 `test-server.ts` 自己既有的模式——
  把純函式放進 `packages/test-kit/src/test-pki.ts`(會編譯成 `dist/`),harness import
  `../../packages/test-kit/dist/test-pki.js`,契約測試 import `src/`。
  這條約束已寫進 handoff 的「How to work in this repo」。

- **審查**:依第 8 節不派(無風險分類)。刪碼的證據是三段 typecheck、全套測試與兩個 build 全綠;
  每個被刪的符號都先以 `grep` 確認過沒有消費者(包含以字串鍵存取的契約測試)。
  沒有發現「其實有執行期消費者」的情況,因此沒有需要停下來詢問 owner 的項目。

- **留下的後續項目**:
  1. **release-matrix 的配對已失效**(見上)。這是 owner 的決定,不是可以代做的事。
  2. `packages/contracts` 仍有幾個沒有外部消費者的協定詞彙常數(`SCHEMA_VERSION`、`TASK_LIFECYCLES`、
     `TASK_MODES`、`TERMINAL_OUTCOMES`、`DataCategory`)。它們是封閉詞彙,contracts 內部有在用,
     刪掉會讓這個套件作為「契約」變差;比較好的做法是替它們補契約測試,像本 WP 對 result schema 做的那樣。
     本 WP 沒有做,因為那是新增覆蓋而不是刪碼,超出宣稱 2 的範圍。
  3. `tests/e2e/` 現在只剩 `us1-authorized-session.spec.ts`(一個案例)、`packaged/` 與 `fixtures/`。
     那一個案例仍以 `HALLPASS_E2E=1` 為前提,而 `HALLPASS_E2E` 沒有任何自動化流程會設定;
     它實質上是 owner 手動流程的一部分,而不是 CI gate。要不要保留 `test:e2e` 這個 script 是 owner 的決定。
  4. `redactLogFields` 一併隨 `server/logging.ts` 刪除。它編碼了 `LOG_FORBIDDEN_FIELDS` 的隱私規則,
     但沒有任何地方呼叫它——server 不做粗粒度日誌。**如果之後要加日誌,這個遮蔽器必須先回來**,
     隱私邊界契約測試仍在釘 `LOG_FORBIDDEN_FIELDS` 本身。這一點特別記給 owner。
