# WP5 — 生命週期:面板重設、worker 重連再投影、20 秒 heartbeat、lease 到期、context 投影

狀態:待開工 · 規模:M · 風險:R1(生命週期與一致性)· 審查:code-reviewer · 套用決策:無 · 相依:無(WP6 的 server 修改在本 WP 之後)

## 1. 為什麼

- 審查 H5:側邊面板在 Port 斷線或 `runtimeEpochId` 改變後保留舊的審查卡與 Stop 狀態;使用者可能對一個已不存在的任務按 Allow 或 Stop。這是 owner 觀察到的「卡死」機制。
- 審查 H6:worker `accept()` 在新 Port 連上時沒有再投影 live task 的狀態、pending 的 safety/consent/plan 與 grants;契約要求「The Port receives a sanitized state projection immediately after connection」。
- 審查 M19、M3、handoff #10:20 秒 heartbeat 與 server lease 到期兩端都沒實作;MV3 idle timer 沒有 WebSocket 訊息重設;task 可能無限等待。
- 審查 L2:`activeControl`/`stopAvailable` 由面板點擊推斷而不是 worker 投影;第二個 Port 連上時舊 Port 沒被斷開。

## 2. 範圍與非目標

範圍:`apps/extension/src/side-panel/App.tsx`、`TaskWorkspace.tsx`、`workspace-controller.ts`;`apps/extension/src/service-worker/control-port.ts` 的 `accept()` 與投影;`task-channel-client.ts` 的 heartbeat 與 deadline;`apps/server/src/task-channel/handler.ts` 的 lease timer;新投影 `worker.context.state` 與 `worker.task.state.lifecycle`;contracts 與 `extension-runtime.md`、`task-channel.md`。

非目標:重連時「恢復」任務(任務不重放;只投影仍活著的任務狀態);多任務;背景 alarms;server 端 heartbeat 以外的協定變更(留給 WP6)。

## 3. 宣稱

1. Port 斷線或 epoch 改變後,面板沒有殘留的審查卡、Stop、進度;composer 可用;超過重連上限(常數,預設 6 次)進入「請重新開啟面板」的 unavailable 子狀態,且不呈現為授權進行中。證據:`side-panel-reconnect.test.tsx` 紅測;packaged `action-review-recovery.spec.ts` 擴充(審查卡顯示中重載擴充套件)。
2. 新 Port 被接受時,若有 live task,worker 依序重送 `worker.task.state`、pending safety/consent/plan、`worker.grants.state`;沒有 task 就什麼都不送。證據:`control-port.test.ts` 紅測。
3. 面板恢復投影後可以回答仍 pending 的審查;回答一個已不存在的審查不會有任何效果。證據:`side-panel-reconnect.test.tsx` 與 control-port 紅測。
4. worker 在 accepted 後每 20 秒送 `client.heartbeat {observedServerSequence}`;任何 server frame 重設本地 60 秒 deadline;到期 → `interrupt("lease-expired")` → `haltTask("lifecycle-interruption")`,終態為 cancellation 或 attention-required(依 in-flight 效果),不會無限等待。證據:`task-channel-lifecycle.test.ts`(fake timers)。
5. server 在 accept 時啟動 60 秒 lease timer,每個合法 client frame 重設;到期 `terminalizeOnce({outcome:"cancellation", reasonCode:"lifecycle-interruption"})`、abort provider、complete 任務並關閉;`server.heartbeat` 回覆照舊。證據:`apps/server/tests/tasks-and-channel.test.ts`。
6. 新投影 `worker.context.state {supported, originDisplay, activeControl, reasonCode?}` 在 task start、probe/binding、dispatch 前後、terminal 發出;`worker.task.state` 加 `lifecycle`(running / awaiting-safety / awaiting-consent / awaiting-plan / executing)與 `mode`;面板的 `controlActive` 與 `stopAvailable` 只由投影驅動。證據:contract 測試釘住封閉 schema;`side-panel-control.test.tsx` 紅測。
7. 第二個 Port 被接受時舊 Port 被 `disconnect()`;`onMessage` 只接受 `port === activePort` 的訊息。證據:`control-port.test.ts` 紅測。

## 4. 先寫的紅測

- `apps/extension/tests/side-panel-reconnect.test.tsx`:running 與 review 狀態下 `port.onDisconnect` → 無殘留卡片、無 Stop、composer 可用;重連收到再投影 → 恢復 review 並可回答;重連 6 次失敗 → unavailable 子狀態文案(兩語系)。
- `apps/extension/tests/control-port.test.ts`:`accept()` 時有 live task → 依序再投影(斷言訊息順序);無 task → 只送 auth/availability;第二個 Port → 舊 Port `disconnect` 被呼叫且舊 Port 的訊息被忽略。
- `apps/extension/tests/task-channel-lifecycle.test.ts`(fake timers):accepted 後 20 秒送 heartbeat 且帶 `observedServerSequence`;60 秒無 server frame → `lease-expired` 中斷;任一 server frame 重設 deadline。
- `apps/server/tests/tasks-and-channel.test.ts`:60 秒無 client frame → cancellation / `lifecycle-interruption` 終態、provider 被 abort、任務被 complete;client heartbeat 重設 lease。
- `tests/contract/extension-runtime.contract.test.ts`:`worker.context.state` 與 `lifecycle` 欄位封閉且必填。
- packaged `tests/e2e/packaged/action-review-recovery.spec.ts` 擴充:審查卡顯示中重載擴充套件 → 面板無殘留審查卡與 Stop,可送出新任務。

## 5. 設計

- 面板 `App.tsx`:`port.onDisconnect` 套用 `applyTaskProjection(current, {progress:"", active:false})` 並清 `controlActive`;`onMessage` 偵測到 `runtimeEpochId` 改變時同樣重設;重連次數常數(預設 6)後進入 unavailable 子狀態;先前 available 時在 checking 期間保留 shell,避免每輪 probe 清掉 composer 草稿。
- worker `control-port.ts` `accept()`:在 auth/availability probe 之後,若 `running || starting || pendingConsent || pendingPlan || pendingSafety`,依序重送 `worker.task.state`、pending 的 review(用既有 reviewId/digest,不重鑄)、`worker.grants.state`;沒有 task 就不送。新 Port 接受時 `activePort?.disconnect()`,並記錄 `activePort`;`onMessage` 檢查來源。
- `task-channel-client.ts`:accepted 後 `setInterval` 20 秒送 heartbeat;`lastServerFrameAt` 與 60 秒 deadline(常數,屬部署輸入,不是 spec 數字);到期 `interrupt("lease-expired")`;close 時清 timer。heartbeat 同時提供 Chrome 重設 MV3 idle timer 所需的 WebSocket 訊息。
- server `handler.ts`:accept 時啟動 60 秒 lease timer;每個通過 schema 的 client frame 重設;到期走既有的 `terminalizeOnce` 與關閉路徑;`server.heartbeat` 回覆不變。
- 投影:`packages/contracts/src/extension-runtime.ts` 新增 `worker.context.state` schema 與 `worker.task.state.lifecycle`/`mode`;面板 `ActiveControl.tsx` 由 `activeControl` 驅動;`stopAvailable` 開始被尊重(false 時不渲染 Stop)。

## 6. 契約文件同步

`contracts/extension-runtime.md`:Service worker to side panel 表加 `worker.context.state` 與 `lifecycle`;Lifecycle 段落補「重連再投影的順序」與「20 秒 heartbeat / 60 秒 lease 為部署輸入」。`contracts/task-channel.md`:`client.heartbeat` 的節奏與 lease 到期終態。

## 7. 出口檢查與最終驗證

索引第 6 節。fake-timer 測試不得用真實等待。

## 8. 審查

code-reviewer 審全部宣稱,特別看:重連再投影不會重鑄 reviewId/digest、heartbeat timer 在 close/Stop/epoch 更替時被清、lease 到期與使用者 Stop 同時發生只投影一個終態。

## 9. 交付紀錄(實作者填寫)

- 完成日期:2026-09-03
- 出口檢查結果(同一個最終 build):三段 typecheck 皆 exit 0;`npm test` 47 檔 396 測試;
  `npm run test:contract` 11 檔 65 測試;`build:extension:test` 與 `npm run build` exit 0;
  packaged gate en-US 11 passed、zh-TW 11 passed。
- 宣稱 1 的證據替換:第 3 節列的 packaged 案例(審查卡顯示中重載擴充套件)沒有加。
  `chrome.runtime.reload()` 會摧毀側欄文件本身,重載後沒有任何面板狀態可供重設,「還能送出新任務」
  只能在一個全新的頁面上觀察,而那個頁面證明不了任何關於重設的事。這個不變式屬於「面板活得比 worker 久」
  的情境,正是 `side-panel-reconnect.test.tsx` 覆蓋的接縫;改在 packaged `action-review-recovery.spec.ts`
  加一個真實 Chrome 的投影驅動斷言(終態之後面板不再有 Stop)。審查者確認宣稱 1 因此仍然成立,條件是
  在這裡與索引第 9 節記下替換與理由,而不是讓第 3 節那行沒有對應證據地留著。
- 審查發現與處置(`code-reviewer`):1 High + 1 Medium + 8 Low。
  H1 — 兩個側欄互相搶 worker 造成無限重連。Chrome 側欄是每個視窗一個,而面板端無法區分「worker 消失」
  與「我被換掉」,所以被斷開的面板會重連並反過來取代對方;更糟的是每次接受都會投影 `worker.service.state`,
  把重連計數重設,宣稱 1 的上限永遠不會生效。修法:新增封閉投影 `worker.panel.superseded`,worker 在
  `previous.disconnect()` 之前送給被取代的 Port;面板收到後設 `supersededRef` 並停止重連。
  `panelDisconnected: boolean` 改為 `panelStatus: "connected" | "disconnected" | "superseded"`,兩種情況
  有各自的文案,因為只有其中一種能靠重開這個面板解決。
  M1 — 宣稱 6 的面板端沒有正面測試(`applyContextProjection` 欄位對映錯了不會有測試失敗),已在第 3 節
  指名的 `side-panel-control.test.tsx` 補上四個轉換的測試。
  已修的 Low:heartbeat 送失敗時只清 interval、保留 deadline(原註解與行為不符);`projectStartingContext`
  在 `contextState` 已建立時返回,慢的 resolver 不會在效果進行中撤掉控制指示;server 的 `handle()` 在
  `closed` 時提早返回,避免競態 frame 重新武裝已終結 session 的 lease;重連測試補上 zh-TW 文案斷言;
  補上「terminal 之後 timer 也停」的斷言;再審後補上 `worker.panel.superseded` 的 contract 釘樁。
  再審:無 High/Medium;所有新增的迴歸測試都以「暫時還原修正 → 確認紅 → 還原修正」驗證過。
- 留下的後續項目:
  - 被取代的面板是刻意的死路:若之後贏的那個視窗把側欄關掉,被取代的面板不會自己回來(worker 會在那次
    斷線 halt 掉任務),使用者要關掉再開這個面板。文案已經這樣寫,而且仍優於 WP5 之前那個沉默的過期面板。
  - `handleGrantRevoke` 撤銷 general grant 時清掉 pageBindings 但沒有讓 Plan 到期,於是重連後的面板會停在
    `lifecycle: awaiting-plan` 卻沒有 Plan 卡(Stop 仍在)。這是 WP2 的既有缺口被重連放大,歸 WP2/WP8。
  - 本文件第 5 節說再投影發生在「auth/availability probe 之後」,實作與契約都放在之前(面板一連上就該拿到
    它能回答的東西)。程式與契約一致,是設計註記過時。
  - 宣稱 6 說 `worker.context.state` 在 terminal 發出,實作只在控制指示為真時才發(面板在 terminal 本來就會
    清掉 `controlActive`),行為上沒有落差,在此精確記錄。
  - 20 秒 / 60 秒兩個常數是部署輸入,記在契約的 "Channel liveness" 與 "Lease and heartbeat" 兩節;WP10 的
    evidence-index 若要收錄,兩者都應列為 A-010 下的驗證界限而不是產品延遲數字。
