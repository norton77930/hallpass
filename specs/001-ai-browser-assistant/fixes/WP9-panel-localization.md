# WP9 — 面板與在地化:可見揭露、`lang` 屬性、無效控制項、英文字面值、focus 管理

狀態:待開工 · 規模:S–M · 風險:無風險(UI 文案與面板行為;若必須改 worker 投影則升 R1 並派 code-reviewer)· 套用決策:無 · 相依:WP2 的投影欄位、WP5 的 lifecycle 投影

## 1. 為什麼

- 審查 M15:任務送出前的資料揭露只在 `aria-describedby`,視覺上不可見;M16:`html.lang` 不隨 locale 改變;M17:審查期顯示無效的 form-values Revoke 區塊;M18:`worker.auth.state.reason` 沒對應到 `auth.accountMismatch` 文案。
- 審查 L13 與 WP1 留下的:worker `haltTask` 的 "Needs attention" / "Stopped"(以及 "Failed")是英文字面值,zh-TW 下終態摘要是英文。
- SC-009 / SC-011:主要控制項的 focus 管理與完整雙語。

## 2. 範圍與非目標

範圍:`apps/extension/src/side-panel/TaskPanel.tsx`、`App.tsx`、`TaskWorkspace.tsx`、`workspace-controller.ts`、`AuthPanel.tsx`、`human-labels.ts`;`apps/extension/src/locales/catalog.ts`、`en-US.ts`、`zh-TW.ts`;worker `control-port.ts` 的終態摘要 lookup。

非目標:dark theme、settings page、onboarding、新的 UI 元件庫、任何 deferred scope;變更投影 schema(若真的需要,先升 R1)。

## 3. 宣稱

1. 任務送出的資料揭露是可見的 helper text,使用 `task.inputLabel`;`aria-labelledby` 指向存在的元素;初始 running 狀態顯示 `task.progress`。證據:`side-panel-productization.test.tsx`。
2. `document.documentElement.lang` 等於目前 locale;`worker.auth.state.reason` 對應到 `auth.accountMismatch` 文案。證據:`side-panel-productization.test.tsx`、`side-panel-session.test.tsx`。
3. 審查期不顯示 form-values 的 Revoke 區塊;`workspace-controller.ts` 未使用的函式刪除;`AuthPanel` 改用函式 replacer 而不是字串拼接。證據:`side-panel-productization.test.tsx`、typecheck。
4. worker 終態摘要("Stopped" / "Needs attention" / "Failed")改為 `lookup(RECOVERY_SUMMARY_KEYS[...], currentLocale)`;zh-TW 下 Stop 終態摘要為中文。證據:`control-port-task.test.ts`(locale zh-TW 的 Stop)與 packaged zh-TW gate。
5. focus 管理:審查卡出現時焦點移到卡片標題;terminal 時移到 alert;Submit/Retry 停用前先把焦點移到狀態區。證據:`side-panel-control.test.tsx`。
6. 新增的每個 key 兩語系皆有且非空。證據:`tests/contract/locales.contract.test.ts`。

## 4. 先寫的紅測

- `apps/extension/tests/side-panel-productization.test.tsx`:揭露文字可見;zh-TW 下 `html.lang === "zh-TW"`;審查期無 Revoke;Stop 終態摘要為 zh-TW。
- `apps/extension/tests/side-panel-control.test.tsx`:審查卡出現後 `document.activeElement` 在卡片內;terminal 後在 alert。
- `apps/extension/tests/control-port-task.test.ts`:locale zh-TW 啟動任務後 Stop → `summary` 為 zh-TW 文案。
- `tests/contract/locales.contract.test.ts`:新 key 兩語系皆有。

## 5. 設計

- `TaskPanel.tsx`:helper text 元件;`aria-labelledby` 修正;初始狀態文案。
- `App.tsx`:effect 設定 `lang`;auth reason 對應。
- `TaskWorkspace.tsx`:移除審查期 Revoke 區塊;`workspace-controller.ts` 死碼刪除。
- `control-port.ts`:`RECOVERY_SUMMARY_KEYS` 已存在(用於 marker 復原),`haltTask` 與 terminal 的摘要改走同一個 lookup,以 `currentLocale`。
- focus:以 `useEffect` + `ref.focus()`,尊重 `prefers-reduced-motion` 無關;不要在每次 render 搶焦點。

## 6. 契約文件同步

`contracts/extension-runtime.md` 若有列終態摘要為 reviewed copy 的段落,補「摘要由 locale 查表產生」。

## 7. 出口檢查與最終驗證

索引第 6 節;zh-TW packaged gate 是本 WP 的主要證據。

## 8. 審查

不派審查(無風險分類);若動到 worker 投影 schema 或 control-port 的 Stop 路徑以外的邏輯,升 R1 並派 code-reviewer。

## 9. 交付紀錄(實作者填寫)

- **完成日期**:2026-09-05。
- **出口檢查結果**(同一個最終 build,依序、各自檢查 exit code):`npx tsc -b` 0;`npx tsc -p apps/extension --noEmit` 0;
  `npx tsc -p tsconfig.tests.json --noEmit` 0;`npm test` 50 檔 / 464 測試、exit 0;`npm run test:contract` 11 檔 / 88 測試、exit 0;
  `npm run build:extension:test` 0;`npm run build`(帶合法假值)0;兩個 build 之後再跑一次 contract 仍 11 檔 / 88;
  packaged gate en-US 11/11、zh-TW 11/11(依序、未並行)。zh-TW gate 是本 WP 的主要證據,通過。

- **紅測**:六條宣稱全部先寫紅測、確認紅、再實作。`html.lang` 那條的實作先於測試寫成,因此以「暫時把 effect 換成 `void locale`」
  證明會紅(`expected '' to be 'zh-TW'`)再復原。

- **各宣稱的處置**:
  1. **可見揭露與 aria(M15)**:`task.submitDisclosure` 原本是 `sr-only` 的 `<label>`——揭露只存在於無障礙層,
     多數使用者永遠收不到。改成 `<p id="task-disclosure">` 可見段落,由 `aria-describedby` 連結;
     `<label>` 改用 `task.inputLabel`(「Ask about this page」)。
     `<section className="task-shell" aria-labelledby="task-title">` 指向一個**不存在**的元素(頁面上只有 `workspace-title`),
     改為 `aria-label`。任務開始但服務尚未產出進度文字時顯示 `task.progress`,不再是空白面板。
  2. **`html.lang` 與 auth reason(M16、M18)**:`App` 以 effect 設定 `document.documentElement.lang = locale`;
     `worker.auth.state.reason` 現在經 `applyAuthProjection` 存進 `authReasonCode`,`AuthPanel` 在 `auth.account-mismatch` 時
     顯示 `auth.accountMismatch` 文案。reason 隨每次投影更新或清除,不會留下解釋錯狀態的舊訊息。
  3. **審查期的 Revoke、死碼、replacer(M17)**:`TaskWorkspace` 的 Revoke 改由 `formGrantActive` 決定,
     不再在 form-values 審查**進行中**顯示(那時候還沒有可撤銷的授權)。
     `workspace-controller.ts` 刪除四個零消費者的函式:`denyPageRead`、`denyFormValues`、`revokeGrants`、`denyPlan`。
     `AuthPanel` 的 `.replace("{account}", label)` 改用函式 replacer——**這是真的 bug**:帳戶標籤是服務端提供的文字,
     而 `String.replace` 會把替換字串裡的 `$&`、`` $` ``、`$'` 當成樣式。紅測輸出是
     `'Signed in as {account}Signed in as '`,周圍文案被捲進標籤裡。
  4. **worker 終態摘要(L13)**:`haltTask` 的 `"Needs attention"` / `"Stopped"` 與 restore 路徑的 `"Failed"`
     三個英文字面值,改走既有的 `lookup(RECOVERY_SUMMARY_KEYS[...], currentLocale)`。
     紅測以「zh-TW 任務 Stop 後 summary 不得全部是 ASCII」表述,修正前得到 `Stopped`。
  5. **focus 管理(SC-009)**:`ConsentReview`、`PlanReview`、`SafetyReview` 掛載時把焦點移到卡片標題
     (標題加 `tabIndex={-1}`);`TaskPanel` 在終態出現時把焦點移到 alert,並以 outcome/reason/summary 組成的 key
     確保每個終態只搶一次焦點,不會在每次 render 搶。
  6. **文案**:本 WP 需要的六個 key(`task.inputLabel`、`task.submitDisclosure`、`task.progress`、`task.placeholder`、
     `auth.accountMismatch`、`consent.revoke`)兩語系本來就都存在且非空,因此**沒有新增任何 key**;
     locales contract 測試維持通過。

- **順帶修正的既有測試**:13 個面板測試用揭露文字(`/sends your request/i`)當作 label 去找輸入欄位——
  那正是 M15 所描述的問題本身。全部改成用真正的欄位名稱 `/ask about this page/i`。

- **審查**:依第 8 節不派(無風險分類)。本 WP 沒有變更任何投影 schema 的欄位型別,
  只在 `worker.auth.state` 既有的 `reason` 欄位上增加消費端;`workerContextStatePayloadSchema` 未動。
  唯一碰到 `control-port.ts` 的地方是兩個終態摘要的字串來源,屬第 8 節明列的 Stop 路徑,未升 R1。

- **契約文件同步**:`contracts/extension-runtime.md` 的 `worker.task.terminal` 一列補上
  「摘要由 worker 以任務啟動時的 locale 查表產生,不是英文字面值,也不會原樣投影遠端摘要」。

- **留下的後續項目**:
  1. `TaskPanel` 的 `aria-label` 借用 `task.emptyTitle`(「Ready for a task」)作為區塊名稱。語意可用但不精確;
     要更好需要一個專屬的區塊標題 key,那會是新增文案,超出本 WP 的「不新增 key」範圍。
  2. focus 移動沒有配合 `prefers-reduced-motion` 或使用者「不要自動移動焦點」的偏好做任何調整——
     目前沒有這個設定面,WP9 的非目標也排除 settings page。
  3. `us1-authorized-session.spec.ts` 等非 packaged e2e 仍在原位,`playwright.config.ts` 的 `testDir` 仍是 `./tests`;
     屬 WP10 第 3 節(D5)。
