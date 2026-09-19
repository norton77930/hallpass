# WP2 — 任務模式狀態機、single-action 槽、approved-plan 步驟綁定、可審閱的同意卡

狀態:待開工 · 規模:L · 風險:R1(跨模組正確性、對外投影介面變更)· 審查:code-reviewer + architecture-reviewer ·
套用決策:D1 · 相依:WP1 的 `packages/domain/src/task-state.ts`(已完成)

## 1. 為什麼

- 審查 H2:worker 不追蹤 `executionBinding.mode`。single-action 任務可以連續派發第二個動作;approved-plan-step 的請求不比對已核准 Plan 的步驟,server 可以在核准後送出不同的步驟或無限步驟。契約(`contracts/extension-runtime.md` Action contract)要求「a `single-action` task has exactly one browser effect slot」與「a multi-step action must match the next approved plan step」。
- 審查 M4:同意卡與 Plan 卡沒有目標標籤、風險、lifetime,使用者看不出「要點哪個元素」;契約要求 locally resolved target labels,SC-010 的理解場景需要它。handoff #4 曾把 target metadata 記為刻意延後,owner 於 D1 決定保留。
- handoff #5:`expireFormValueGrants` 會把已 revoked 的 grant 覆寫成 expired。
- 併入:WP1 留下的「approved-plan 的 success 必須要求每一步都被觀測」;WP3 re-review 的「`plan.document-changed` 中斷路徑投影 cancellation 時沒有看 `taskState.uncertainSeen`」;WP1 side-panel Plan 測試每步按 Allow 的暫時做法。

## 2. 範圍與非目標

範圍:worker 的任務模式與 Plan 生命週期;pageBindings 內的目標 metadata;`worker.consent.review` 與 `worker.plan.review` 的投影欄位;面板 `ConsentReview.tsx`、`PlanReview.tsx` 的呈現;`packages/domain` 的 `task-plan.ts`、`task-state.ts`、`authorization-grant.ts`(或放 `expireFormValueGrants` 的模組)小修;contracts 與 `extension-runtime.md` 投影表;test-kit 新 journey;packaged 案例。

非目標:navigation、attachments、saved prompts、durable history;新的資料類別;Plan 的自動重試;server 端的 plan 驗證(server 仍是不受信任方,worker 自己驗);任何持久化。

## 3. 宣稱(完成時必須成立)

1. single-action 任務只有一個效果槽:第一個動作被核准並 dispatch 後,第二個動作請求回 `denied` / `capability.single-action-exhausted`,不出同意卡、不執行。證據:`apps/extension/tests/control-port-task.test.ts` 紅測;packaged 新 journey "double click"。
2. approved-plan-step 的請求必須存在已核准的 Plan、`stepId` 等於 `nextPendingStep`、且該步驟的 binding digest(capability、purpose、expectedContext、dataCategories、canonical arguments)等於審查時的 digest;符合即以 plan-step grant 直接進入 dispatch,不再出第二張同意卡;不符 → `denied` / `plan.step-mismatch`。證據:control-port-task 紅測(相符不出卡直接 dispatch;順序錯 → denied;內容不同 → denied)。
3. 首次 dispatch 之後的 `server.plan-proposed` 一律拒絕;dispatch 前只有 `revisionOf` 等於當前 plan 的修訂才可替換並要求新審查;bound document 變更讓 plan 到期,之後的 step 請求被拒。證據:control-port-task 紅測。
4. approved-plan 任務的遠端 success 只在每一步都被觀測(observed)時接受;任何步驟未觀測 → 依 D2 降級。證據:`packages/domain/src/task-state.test.ts` 與 control-port-task 紅測。
5. `plan.document-changed` 的中斷:若 `taskState.uncertainSeen` 為真,投影 `attention-required` 而不是 `cancellation`。證據:control-port-task 紅測。
6. 同意卡與 Plan 卡顯示資料類別、origin、風險分類、lifetime、目標標籤與角色(D1);標籤 ≤ 80 字元、不含控制項的值;metadata 只存在記憶體並在 terminal 清除。證據:`side-panel-task.test.tsx` 紅測;`tests/contract/extension-runtime.contract.test.ts` 釘住新欄位必填;`privacy-boundary.contract.test.ts` 釘住不含值。
7. 三種 scope 的 allow 文案各自不同,且 en-US、zh-TW 皆有。證據:`tests/contract/locales.contract.test.ts`。
8. `expireFormValueGrants` 不覆寫 `revoked`。證據:domain 紅測。
9. WP1 side-panel 的 Plan 測試改為只核准 Plan 一次,步驟不再逐一按 Allow。證據:`side-panel-app.test.tsx` 更新後仍綠。

## 4. 先寫的紅測

- `packages/domain/src/task-state.test.ts`:approved-plan 三步中一步未觀測 → 遠端 success 降級為 failure / `task.unverified-success`;全部觀測 → 接受。
- `packages/domain/src/task-plan.test.ts`:`nextPendingStep` 順序、`markDispatched` 後不可替換、`expirePlanOnDocumentChange`。
- `apps/extension/tests/control-port-task.test.ts`:
  - single-action:第二個動作請求 → `denied` / `capability.single-action-exhausted`,`executions` 長度 1,沒有第二張 `worker.consent.review`。
  - plan-step 相符 → 不出同意卡、直接 dispatch;`stepId` 順序錯 → `denied` / `plan.step-mismatch`;參數與審查 digest 不同 → 同上。
  - 首次 dispatch 後 `server.plan-proposed` → `denied`;dispatch 前 `revisionOf` 相符 → 新的 `worker.plan.review`。
  - bound document 變更後的 step 請求 → `denied`,終態不是 success。
  - 一步 uncertain 之後的 `plan.document-changed` → `attention-required`。
- `apps/extension/tests/side-panel-task.test.tsx`:PlanReview 顯示資料類別、origin、風險、lifetime、每步目標標籤;ConsentReview 顯示目標標籤與角色;三種 scope 的 allow 按鈕文案不同。
- `tests/contract/extension-runtime.contract.test.ts`:`worker.consent.review`(action)與 `worker.plan.review` 的 `targetLabel`、`targetRole`、`risk`、`lifetime` 為必填且封閉;`privacy-boundary.contract.test.ts`:投影中不得出現 `value`、`formValueItems`。
- `packages/test-kit/src/ai-adapter.ts` 新 journey 關鍵字 "double click"(兩個 single-action);`tests/e2e/packaged/` 新案例:第二個動作被拒且終態不是 success;Plan 旅程的同意卡文字含目標標籤(兩個 locale)。

## 5. 設計(接縫與檔案)

- 先抽模組:把 plan/mode 狀態從 `apps/extension/src/service-worker/control-port.ts` 抽到新的 `task-mode-controller.ts`(純函式 + 小狀態物件),control-port 只接線。這是為了讓 control-port 不再變長,也讓 architecture-reviewer 有清楚的介面可審。
- 模式與槽:`handleCapabilityRequest` 對三種動作讀 `executionBinding.mode`。`single-action` 只在 mode ∈ {undecided, page-read-only} 或槽未用時接受,dispatch 時記 `singleActionRequestId`;之後的動作請求 → `denied` / `capability.single-action-exhausted`。`approved-plan-step` 走宣稱 2 的比對;比對通過即建立 plan-step grant(契約:exact Plan approval creates equivalent grants)進入 `dispatchAllowedAction`,不出同意卡。
- Plan 生命週期:用 `packages/domain/src/task-plan.ts` 既有的 `createPlan` / `markDispatched` / `nextPendingStep` / `expirePlanOnDocumentChange`。`ui.plan.decide` approved 時保存 plan(id、version、digest、steps 與每步 digest);`onBoundDocumentChanged` 使 plan 到期;`taskState` 記錄每步是否 observed,供宣稱 4。
- 可審閱的同意(D1):`PageCollector` 回傳的 `semanticNodes` 中每個 target 的 role/label/kind 存進 `pageBindings` 的 `targets: Map<handle, {role, label, kind}>`;`projectCapabilityConsent`(action)與 Plan 投影每步加 `targetLabel`、`targetRole`、`risk`(本地 `classifyClick` / `classifyTextEntry` 的結果)、`lifetime`;terminal 與 task start 清空。
- 面板:`ConsentReview.tsx`、`PlanReview.tsx` 渲染新欄位;`apps/extension/src/locales/catalog.ts` 新增 `lifetime.*`、`risk.*`,把單一 `consent.allow` 拆成三個 scope 各自的 key;`en-US.ts`、`zh-TW.ts` 補文案。
- domain:`expireFormValueGrants` 對 `revoked` 不動。
- contracts:`packages/contracts/src/extension-runtime.ts` 的投影 schema 加欄位並保持封閉;刪除殘留重複的 `consentReviewProjectionSchema`。
- reason code:`capability.single-action-exhausted`、`plan.step-mismatch`、`plan.expired`(若需要)各補兩語系文案。

## 6. 契約文件同步

`contracts/extension-runtime.md`:Action contract 段落補「single-action 槽」與「plan-step 比對」的實際規則與 reason code;Service worker to side panel 的投影表加新欄位;Lifecycle 段落補 plan 到期與 `plan.document-changed` 對 uncertain 的處理。`contracts/task-channel.md`:`plan-proposed` 在首次 dispatch 後被拒的規則。

## 7. 出口檢查與最終驗證

索引第 6 節。packaged gate 會從 10 案例增加(double click 與 Plan 目標標籤)。

## 8. 審查

code-reviewer 審全部宣稱;architecture-reviewer 只審投影 schema 與 `task-mode-controller.ts` 介面(對外介面的非破壞性變更)。兩者都乾淨才 sealing。

## 9. 交付紀錄(實作者填寫)

- 完成日期:2026-09-03
- 出口檢查結果(同一個最終 build):`npx tsc -b` / `tsc -p apps/extension` / `tsc -p tsconfig.tests.json` 皆 exit 0;
  `npm test` 47 檔 376 測試;`npm run test:contract` 11 檔 62 測試;`build:extension:test` 與 `npm run build` exit 0;
  `HALLPASS_LOCALE=en-US npm run test:e2e:extension-core` 11 passed;`HALLPASS_LOCALE=zh-TW` 11 passed(packaged gate 由 10 案例增為 11)。
- 審查發現與處置:
  - `architecture-reviewer`(範圍:投影 schema 與 `task-mode-controller.ts` 介面):1 個 in-scope Medium —
    `worker.plan.review` 的 `canonicalOrigin` 取自 server 送來的 plan frame。已改為先確認該 Plan 的 `expectedContext`
    是本 worker 鑄出且仍存活的 page binding、origin 相符,否則回 `denied` 且不投影;顯示的 origin 改用 worker 觀測值。
    另接受其 L4:Plan 卡 lifetime 由 `current-task` 改為 `current-task-current-document`(approved plan 本來就隨
    bound document 到期)。其餘 Low 與它自己標為 follow-up 的 Medium 記於下。
  - `code-reviewer`:2 High + 2 Medium。
    H1 — 修訂被接受審查時沒有撤銷先前核准,v1 在 v2 審查中仍可 dispatch,且 v2 可在 v1 已 dispatch 後被核准。
    修法:`TaskModeState` 新增 `effectCommitted`(由 `commitAction` 設定,不隨 Plan 記錄被替換而遺失);
    `withProposedPlan` 清掉 `approved` 與步驟帳;`admitPlanProposal` 與 `approveProposedPlan` 在 `effectCommitted` 時拒絕。
    H2 — single-action 槽與 approved Plan 可並存。修法:plan-step 分支補上 `singleActionRequestId` 鏡像檢查;
    `onPlan` 用 `admissible()`(無進行中的同意/安全卡 + `admitPlanProposal`)在 `buildProposedPlan` 前後各檢查一次;
    `handleCapabilityDecision` 在 dispatch 前重跑 `actionAdmission`。
    M1 — 宣稱 6 的「標籤不含控制項的值」對 `<textarea>` 不成立(collector 用 `textContent` 當標籤,而那是它的值)。
    修法:`snapshotTarget` 只有 `BUTTON` 才用 `textContent` 回退;這同時讓該字串不再隨 `semanticNodes` 送到 server。
    M2 — 宣稱 5 沒有證據:採納審查者建議不製造繞路證據,見下方後續項目。
    另修其 L1(撤銷 general grant 時一併清 `pageTargets`)、L2(契約文件與程式對齊)、L5(補宣稱 4 的
    control-port 層負面測試:server 只跑 2/3 步就宣稱成功 → 降級)。
  - 再審:無 High/Medium。兩個 Low 也已修掉 —(a)`commitAction` 原本在 `handleCapabilityDecision` 的兩個 await
    之後才消耗槽,期間抵達的第二個動作請求會開出一張不可能被履行的卡(與宣稱 1 的「不出同意卡」矛盾),改為
    使用者按下允許的當下就佔用槽,並以持有槽的 `requestId` 讓同一請求的重新檢查冪等;(b)`ui.plan.decide` 在
    `approveProposedPlan` 拒絕時靜默 return,會把任務卡在無法履行的卡後面,改為清掉提案並回 `denied`。
  - 每一個新增的迴歸測試都以「暫時還原修正 → 確認紅 → 還原修正」驗證過。
- 留下的後續項目:
  - 宣稱 5 的 `uncertainSeen` 條款刻意保留為 fail-closed 防護,但在 WP2 的模式閘門下公開路徑不可達(有 effect 即
    `effectCommitted`,而它會拒絕所有提案;提案會清掉 `approved`;single-action 則被 `planSeen` 擋下)。證據是
    `contracts/extension-runtime.md` 的條文而非紅測,兩位審查者都同意這個處置。
  - `capability.single-action-exhausted`、`plan.step-mismatch`、`plan.expired` 沒有雙語系文案:它們是送往 server 的
    capability-result `errorCode`,與既有的 `stale-context`、`grant-revoked`、`user-denied` 同類,面板從不把 error code
    當文字渲染(有文案的是會產生本地終態摘要的 reason code)。審查者確認這不違反索引第 2 節的規則;此處記錄該判讀。
  - 架構審查的 M2:`taskState.mode`(依收到的 frame 推導)與 `TaskModeState`(依決策推導)是兩套帳,步驟記錄也
    重複(`dispatchedStepIds`/`stepByRequestId` vs `planStepIds`/`observedPlanStepIds`),目前靠呼叫順序維持一致。
    建議日後讓 `TaskModeState` 成為唯一擁有者,或把槽/Plan 狀態收進 `packages/domain`。
  - 其餘架構 Low:channel seam 的型別在驗證後被丟成 `{ mode: string }` 與 `unknown[]`(contracts 應輸出
    `executionBinding` 的推導型別);`canonicalDigest` 沒有排序 key,`canonicalValue` 應移進 domain;投影出來的
    target/risk 沒有納入 `planDigest`;`PlanStep.purposeDigest`/`argumentDigest` 沒有生產端讀者(每步多兩次 SHA-256);
    role/kind/risk 詞彙分散在五處;面板消費型別比投影鬆;`commitAction`/`dispatchedStepIds` 名稱其實是 committed。
  - code review 的 L4:risk 標籤信任頁面自訂的 `role`。實務上 collector 不會為 anchor 之類鑄出 handle,所以卡片
    最多只是樂觀,效果時仍由 `classifyClick` 擋下。
  - collector 的標籤政策只修到「控制項自身內容不得當標籤」這一點;WP4 留下的「仍為 email/tel/number 與未列出的
    text input 鑄 handle」屬 WP8。
  - 被拒絕的第二個動作,其終態摘要仍來自 server(既有行為,非 WP2 造成)。
