# WP8 — 邊界封閉與有限性:每動作參數 schema、字串與 frame 上限、timeout、nonce、注入 bounds

狀態:待開工 · 規模:M · 風險:R1(對外 schema 的非破壞性變更、timeout 錯誤路徑)· 審查:code-reviewer + architecture-reviewer · 套用決策:D9 · 相依:WP6 的 `maxPayload` 常數

## 1. 為什麼

- 審查 M1:`content.execute-action.arguments` 是開放的 record,worker 與內容端沒有共用每個動作的參數 schema。
- 審查 M2:frame 位元組、`textDelta`、summary、purpose、enter-text text、`formValueItems.value`、`accountLabel` 都沒有上限。
- 審查 M6:accepted 之前收到非 `server.accepted` 的 frame 沒有中斷;M7:內容端綁定沒有 nonce,同 tab 的另一個 worker epoch 或重放訊息可以命中 binding。
- 審查 L4:collect 的 bounds 寫死在內容端,truncation 沒有投影到面板,`truncated.notice` / `withheld.*` 文案不可達。
- 審查 M19 的一部分:origin-safety 與 bootstrap 的 fetch 沒有 timeout。
- 併入:WP1 的 `PageExecutor` 結果欄位以預設值補齊;WP3 re-review 的 executor probe 前 `stale-context` 拒絕仍標 marker observed、content frame 在 fence commit 之後才組裝;WP4 的 `checkVisibility` 缺 `opacityProperty` / `contentVisibilityAuto`、collector 對永遠不會通過的 input 鑄出 handle。

## 2. 範圍與非目標

範圍:`packages/contracts/src/extension-runtime.ts`、`task-channel.ts`、新的 `bounds.ts`(可注入常數);worker `task-channel-client.ts`、`runtime.ts`、`content-broker.ts`、`control-port.ts` 的相關分支;內容端 `content-runtime/index.ts`、`targets.ts`、collector;`origin-safety-fetch` 路徑;契約文件 `extension-runtime.md`、`task-channel.md`;`privacy-boundary.contract.test.ts`。

非目標:改變 capability profile `hallpass-v1` 的類別集合;新的動作;server 端 schema 之外的行為(WP6 已處理);面板文案以外的 UI 變更(WP9)。

## 3. 宣稱

1. `content.execute-action.arguments` 是依 action 的 discriminated union,與 `task-channel.ts` 的 scroll/click/enter-text 參數 schema 共用同一模組;未知欄位被拒。證據:`tests/contract/task-channel.contract.test.ts`、`extension-runtime.contract.test.ts`。
2. `BOUNDS` 可注入常數(D9)套用於 `textDelta`、summary、purpose、enter-text text、`formValueItems.value`、`accountLabel`(`.max()`);worker 在 `JSON.parse` 前檢查 `event.data.length`,超過 frame 上限 → `interrupt("invalid-frame")`。證據:contract 測試(超長字串被拒)與 `task-channel-lifecycle.test.ts`(超大 frame → 中斷)。
3. `runtime.ts` 的 origin-safety client 與 `task-channel-client.ts` 的 `POST /v1/tasks` 用 `fetchWithTimeout(…, 5000)`;安全評估逾時 → `failCapability(…, "safety-unavailable")`;bootstrap 逾時 → task failure;任務不無限等待。證據:`origin-safety-fetch.test.ts`、`task-channel-lifecycle.test.ts`(fake timers)。
4. accepted 之前收到非 `server.accepted` 的 frame → `interrupt("invalid-frame")` 並關閉。證據:`task-channel-lifecycle.test.ts`。
5. worker 每次綁定鑄 128-bit `channelNonce` 放在 `content.probe.payload.nonce`;內容端存進 binding,其後每個訊息必須帶相同 nonce,否則 `stale-binding`。證據:`content-runtime-contract.test.ts` 與 `content-broker.test.ts`。
6. `content.collect-page.payload.bounds {maxChars, maxNodes, maxLabelChars}` 由 worker 提供;truncation 回 `{truncated:true, dimension}` 並投影到面板,使 `truncated.notice` / `withheld.*` 文案可達。證據:`content-runtime-contract.test.ts`、`side-panel-task.test.tsx`。
7. `PageExecutor` 結果不再用預設值補齊:`clicks`、`charactersChanged`、`scrollTop`、`targetVisibility`、`documentChanged` 缺一即 `content.invalid-result`。證據:`content-broker.test.ts`。
8. executor 在 probe 前的 `stale-context` 拒絕與 `fence-refused` 一樣移除 marker(而非 observed);content frame 在 fence 回答之前組裝完成,fence 之後只剩送出。證據:`control-port-task.test.ts`(recording markers)、`content-broker.test.ts`。
9. `readLiveTarget` 的 `checkVisibility` 帶 `opacityProperty: true`、`contentVisibilityAuto: true`;collector 不對 `classifyFormControl` 永遠不會回 `allowed-ordinary` 的 input 鑄出 handle(email/tel/number/未列出的 text input)。證據:`targets.test.ts`、`page-collector.test.ts`。

## 4. 先寫的紅測

- 契約測試:超長 `textDelta`、未知 action 參數欄位、開放 result 欄位、缺 `documentChanged` 的 click 結果皆被拒。
- `apps/extension/tests/task-channel-lifecycle.test.ts`(fake timers):bootstrap 5 秒逾時 → failure;超大 frame → `invalid-frame`;accepted 前的 progress frame → 關閉。
- `apps/extension/tests/origin-safety-fetch.test.ts`:5 秒逾時 → `safety-unavailable`。
- `apps/extension/tests/content-runtime-contract.test.ts`:nonce 不符 → `stale-binding`;bounds 注入後 truncation 帶 `dimension`。
- `apps/extension/tests/content-broker.test.ts`:結果缺欄位 → `content.invalid-result`;frame 在 fence 前組裝(以 schema parse 失敗的假輸入證明 fence 未被呼叫)。
- `apps/extension/tests/control-port-task.test.ts`:executor 回 `stale-context` → recording markers 含 `remove`、不含 `observe`。
- `apps/extension/tests/targets.test.ts`、`page-collector.test.ts`:opacity 選項;不鑄 handle。

## 5. 設計

- 新 `packages/contracts/src/bounds.ts`:`createBounds(overrides?)` 回封閉物件,預設值為 D9;contracts 的 schema 以 `bounds` 建立(工廠函式而非模組常數,讓測試可注入)。
- `task-channel-client.ts`:`onmessage` 先檢查長度;accepted 前的 state machine;`fetchWithTimeout` 放 `apps/extension/src/service-worker/` 共用。
- nonce:`content-broker.ts` 的 `ensureContentRuntime` 產生並記在 binding;所有 `contentFrame` 帶 nonce;內容端 `index.ts` 比對。
- bounds 注入:worker 在 `collectFromActiveTab` 帶 `bounds`;內容端 collector 以它截斷並回 `truncated`;`worker.task.state` 或新欄位投影(與 WP5 的投影表協調,若 WP5 已加 `worker.context.state`,truncation 放那裡)。
- `content-broker.ts` `executeOnActiveTab`:frame 先組好再問 fence;`control-port.ts` 的 `!executed.ok` 分支對 `stale-context` 也 `remove`。
- `targets.ts`:`checkVisibility({ opacityProperty: true, contentVisibilityAuto: true })`(try/catch 舊瀏覽器)。
- collector:鑄 handle 前用 `classifyFormControl` 過濾。

## 6. 契約文件同步

`contracts/extension-runtime.md`:訊息表補 nonce、bounds、封閉 arguments;`task-channel.md`:frame 上限、字串上限、accepted 前的規則、5 秒 bootstrap timeout 為部署輸入;`evidence-index` 記錄 D9 預設值。

## 7. 出口檢查與最終驗證

索引第 6 節。

## 8. 審查

code-reviewer 審全部宣稱;architecture-reviewer 審 `bounds.ts` 的注入介面與 schema 共用模組的邊界。

## 9. 交付紀錄(實作者填寫)

- **完成日期**:2026-09-05。
- **出口檢查結果**(同一個最終 build,依序、各自檢查 exit code):`npx tsc -b` 0;`npx tsc -p apps/extension --noEmit` 0;
  `npx tsc -p tsconfig.tests.json --noEmit` 0;`npm test` 50 檔 / 456 測試、exit 0;`npm run test:contract` 11 檔 / 88 測試、exit 0;
  `npm run build:extension:test` 0;`npm run build`(帶合法假值)0;兩個 build 之後再跑一次 contract 仍 11 檔 / 88(沿用 WP7 第 9 節第 3 項的作法,
  讓 manifest 相關斷言對應到最終成品);packaged gate en-US 11/11、zh-TW 11/11(依序、未並行)。

- **紅測的實際情況(如實記錄,因為不是每一條都做到先紅)**:
  - 先寫紅測、確認紅、再實作:宣稱 2 的 frame 長度檢查、宣稱 3、宣稱 4、宣稱 6、宣稱 7、宣稱 8。
  - 事後以「暫時移除該修正」證明會紅:宣稱 5(把 `bindingMatches` 的 nonce 比對拿掉,`content-runtime-contract.test.ts` 立刻紅,再復原)。
  - 由既有測試先變紅帶出:宣稱 1 與宣稱 9。`content-runtime-effect-policy.test.ts` 三案與 `content-runtime-contract.test.ts` 一案
    在 schema/collector 改動後立刻失敗,新斷言是在那之後補的。這兩條是 schema 形狀變更,先寫紅測的診斷價值低於行為變更,但仍應記下差異。
  - 審查補的三個測試(claim 8 的 §4 指名紅測、claim 5 的兩次收集後 cancel、claim 9 的 `checkVisibility` 選項)都是先紅後綠。

- **審查發現與處置**(fresh context:`code-reviewer` 全部宣稱 + `architecture-reviewer` 注入介面與共用模組邊界):

  **code-reviewer:1 High + 4 Medium + 5 Low,全部修掉。**
  - **High — 每次收集鑄一個新 nonce,導致 Stop/terminal 的 cancel 靜默失效。** `ensureContentRuntime` 每次都重新 probe,
    而 probe 會把內容端的 binding nonce 換成新的;`cancelContent` 以 `tabId:documentEpoch` 去重並帶「第一個」binding 的 nonce。
    一般頁面讀取(N1)→ 允許表單值 → 再收集(N2)之後,cancel 帶 N1 送出,內容端回 `stale-binding`,
    頁面的 target map 與 binding 在任務結束後仍活著;`cancelActiveContent` 回 `{cancelled:false}` 而呼叫端丟棄結果,沒有任何地方會發現。
    這等於回歸 WP3「Stop 與 terminal 必須讓每個 handle 失效」的保證。
    **修法**:nonce 改為**每任務一個**(`contentNonce`,任務開始時鑄),所有 frame 重複同一個值,不再輪替。
    防護目標不變:別的任務或別的 worker epoch 帶的是不同的值。紅測:`control-port-task.test.ts`
    「cancels with the nonce the page is still bound to after a second collection」——修正前 cancel 帶兩個不同 nonce,修正後只有一個。
  - **Medium — `invalid-action-arguments` 被記成已觀測的 marker。** 這是我在 fence 之前新增的第三種 pre-send 拒絕,
    但 `control-port.ts` 只對 `fence-refused` / `stale-context` 做 `remove`。一個 `observed` marker 在 worker 重啟後會投影
    `failure` 復原終態,而那個效果根本沒離開過 worker。已併入同一組。
  - **Medium — 宣稱 3 在 header 之後有洞。** `fetchWithTimeout` 在 `fetch()` resolve(收到 header)時就清掉 abort timer,
    之後的 `response.json()` 不受任何上限保護;服務回了 header 再卡住 body,任務一樣無限等。
    **修法**:新增 `requestJsonWithTimeout`,一個上限涵蓋 header 與 body;bootstrap、origin assessment 與四個 auth 呼叫都改用它,`readJson` 因此無消費者而刪除。
  - **Medium — `PageExecutor` 介面仍會補預設值。** broker 端已經拒絕缺欄位,但 `control-port.ts` 把 `documentChanged === undefined`
    當成「沒變」、把缺少的 `targetVisibility` 補成 `not-applicable`。兩者都改為必填。
    這揭露了 `control-port-task.test.ts` 與 `side-panel-app.test.tsx` 共 16 處會偽造結果的 executor stub
    (最典型的是對**所有** capability 都回傳 scroll 結果),全部改成回報該 capability 真正的證據——那正是宣稱 7 要消滅的東西。
  - **Low 修掉的**:frame 長度用 UTF-16 長度比對位元組上限(改用 `TextEncoder` 量位元組,兩個方向一致);
    accepted 之前的協定違規與一般早期關閉無法區分(改拋 `task.channel-protocol`);
    `checkVisibility` 的 `opacityProperty` / `contentVisibilityAuto` 沒有測試釘住(補兩個測試,含舊引擎拒絕選項時不得判定為隱藏);
    claim 8 的 §4 指名紅測缺席(補 `content-broker.test.ts`「refuses an unbuildable frame without ever asking the fence」);
    宣稱 9 的證據檔名與 WP 文件所寫不同(實際在 `content-runtime-effect-policy.test.ts`,不是 `page-collector.test.ts`)。

  **architecture-reviewer:1 High + 3 Medium + 5 Low。**
  - **High — bounds 之間互不相容:一個完全合法的 frame 可以超過 `maxFrameBytes`。** 8,000 字可見文字 + 200 個節點 + 100 個表單項目
    在中文頁面(UTF-8 三位元組)遠超過 64 KiB,而兩端送出前都不量大小;server 的 `maxPayload` 會關閉連線,
    client 只看到 `close` 並回報 `channel-loss`——使用者被告知「通道中斷」,而不是真正發生的事。
    **修法**:`formValueItems`、`selectedOptionLabels`、plan `steps` 補 `.max()`(`maxFormValueItems` 100、`maxPlanSteps` 20 進 `ProtocolBounds`);
    `sendFrame` 送出前量位元組,超過即拋;`submitCapabilityResult` 接住它並改送 `failed` / `result-oversized`,讓任務仍然走到終態。
  - **Medium — 注入是裝飾性的,但註解與文件說得像真的。** 兩個部署物都只讀模組層級的預設實例,
    `ServerConfig` 與 `ExtensionBuildConfig` 都沒有 bounds 欄位,`CHANNEL_MAX_FRAME_BYTES` 在結構上就不可注入。
    **採納審查者建議的「最小誠實修法」**:把 `bounds.ts`、`task-channel.ts`、`task-channel.md`、`evidence-index.md` 四處說法
    改成「這是協定常數,factory 存在是為了讓上限集中在一個物件、以及讓測試能建出更緊的協定」,並說明真要做部署注入需要什麼(擴充套件端的 build-time define + 兩端一致性檢查)。
    順帶把 server 那個從來沒人傳的 `registerTaskChannel(options?.maxPayload)` 收掉(WP6 第 9 節留給 WP8 的項目)。
  - **Medium — label 上限存在四份表述,只因為「剛好都是 80」才一致。** wire 上的 `{maxChars,maxNodes,maxLabelChars}`、
    collector 的 `DEFAULT_LABEL_CHARS`、control-port 的 `TARGET_LABEL_MAX_CHARS`、`ProtocolBounds.maxLabelChars`。
    一旦漂移,worker 會用自己的上限切 label、面板卻用 schema 的上限驗證,超長的 review 會被面板靜默丟棄而 worker 以為送出去了,任務就卡在一張沒有出現的卡片後面。
    **修法**:wire 直接用 `ProtocolBounds` 的欄位名(`Pick<ProtocolBounds, ...>`),另外兩個常數刪除改讀同一個值;broker 內寫死的 500 與 50 也改讀 bounds。
  - **Medium — `worker.form-values.withheld` 不會在面板接管時重播,而且與 truncation 的清除語意不同。**
    這同時就是 packaged `core-journey` 失敗的根因:`/form` 那次讀取的「A sensitive field was withheld」殘留到後面好幾個任務。
    **採納審查者的選項 (b)**:把 withholding 併進 `worker.context.state`(`withheld?: "withheld-sensitive" | "withheld-ambiguous"`),
    一次拿到重播、清除與 latest-read 三種語意;新加的訊息型別隨之刪除(它從未出貨,現在移除是零成本)。

- **本 WP 對既有 spec 的一個修正**:WP8 第 3 節宣稱 3 寫的是 `failCapability(…, "safety-unavailable")`,
  實際的錯誤碼是既有的 `origin-safety-unavailable`(兩個語系都有文案、也已有測試釘住)。沒有新增錯誤碼,行為與宣稱一致。

- **留下的後續項目**:
  1. `TRUNCATION_DIMENSIONS` 只有兩個值,但 worker 仍會靜默截斷 title、selection、揭露的表單值與節點文字而不回報。
     被切掉的表單值是使用者最會在意的一個,和本 WP「說出被切掉了什麼」的原則不一致。
  2. factory + 模組層級預設實例的模式:action 參數 schema 在載入時被建三次,re-export 清單是 TypeScript 無法檢查完整性的手寫列表,
     而且 contracts 只有一個 barrel 且沒有 `sideEffects: false`,所以注入到頁面的 content script 仍打包了它用不到的 task-channel schema。
     不是本 WP 造成的,但本 WP 讓它固定下來。
  3. 真正的部署注入(見上面的 Medium):需要擴充套件端的 build-time define 與兩端一致性檢查。目前沒有需求,不做。
  4. `capabilityRequestPayloadSchema` 現在與 plan step 共用同一個 action↔arguments 配對機制,但 action consent 卡片的
     `arguments` 仍是開放 record(`extension-runtime.ts`);要收斂需要 WP9 的面板投影一起改。
  5. `formValueWithholdingProjectionSchema` 在 withholding 併進 `worker.context.state` 之後已無任何執行期消費者
     (只剩一個契約測試釘著它)。它在 WP8 之前就是不可達的(那正是第 1 節 L4 的內容),現在是真的死了。
     刪除歸 WP10 第 3 節宣稱 2(「contracts 的 `index.ts` 只匯出有消費者的符號」),不在本 WP 動它。
