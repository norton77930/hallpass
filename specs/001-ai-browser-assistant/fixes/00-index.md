# POC 修正計畫 SPEC — 索引與工作規則

日期:2026-09-03 · 來源:2026-09-02 spec-conformance 審查與 2026-09-03 修正計畫 · 狀態:**WP1–WP10 全部完成(2026-09-05)**。修正計畫結束;剩下的是 owner 的 T091/T093/T094 與 release-matrix 配對決定。

這個目錄是修正階段的執行規格。每個工作包(WP)一份文件,寫成可以直接開工的 change proposal:範圍、非目標、
宣稱、先寫的紅測、設計接縫、契約同步、出口檢查、審查角色。主 session(實作者)開工前把該 WP 的宣稱抄成
Completion Contract 宣告,完成後照第 6 節的出口檢查收尾。`tasks.md` 的 T001–T094 宣告不可變;本目錄不編輯
`tasks.md`,T128 起的修復任務由 owner 以 speckit 流程新增並在 T086 註記(D4)。

## 1. 使用方式(給主 session)

1. 讀 `CLAUDE-CODE-HANDOFF.md` 最上方的 2026-09-03 addendum(WP1/WP4/WP3 的完成紀錄與環境教訓),再讀本索引與目標 WP 文件。
2. 開工前在第一則回應宣告分類與 Completion Contract(樣板見第 7 節),宣稱直接取自 WP 文件第 3 節。
3. 每一個行為變更先寫一個聚焦的紅測,確認紅,再做最小實作到綠;不要先改程式再補測試。
4. 完成後派 `code-reviewer`(fresh context)審查 WP 宣稱;所有 High/Medium 修掉並再審到乾淨;Low 若不與宣稱矛盾,記為後續項目,不擴大範圍。
5. 跑第 6 節的出口檢查(同一個最終 build),把結果填進 WP 文件第 9 節與本索引第 9 節,並在 handoff addendum 加一小節。
6. 進入下一個 WP 前不要「順手」做別的事;WP 之間的順序見第 3 節。

## 2. 不可變的工作規則(沿用 handoff)

- 一次只有一個 writer(主 session 或它派出的一個 writer 角色)。讀取型角色(`Explore`、`code-reviewer`、`architecture-reviewer`)不寫檔。
- 跑 extension 測試前先 `npx tsc -b`(測試透過 dist 解析 `@hallpass/domain`、`@hallpass/contracts`)。三段 typecheck 分開跑並各自檢查 exit code。
- 不實作、不標記 T093/T094;不移除 `.test-pki/`(owner 專屬);不做 deferred scope(navigation、attachments、saved prompts、durable history、DNR、alarms);絕不關閉憑證驗證;不 commit、不開 branch、不 release,除非 owner 明說。
- 每個新 reason code 都要有 en-US 與 zh-TW 文案,並有 locales contract 測試釘住。
- 契約文件(`specs/001-ai-browser-assistant/contracts/*.md`)在同一個 WP 內同步;不在文件裡承諾程式碼沒做到的事。
- 不用 regex 批次改多行程式碼,除非有損毀檢查;新檔用 Write 工具而不是 heredoc(這個 harness 的 heredoc 遇到反引號會壞)。
- Bash 子代理可能死在帳號速率限制(台北時間 08:10 重置),重派即可;`EADDRINUSE ::1:18787` 代表殘留的 harness node 程序,用 `Get-CimInstance Win32_Process` 找到後 `taskkill //F //PID`。
- 測試 leaf 憑證只有 7 天效期;所有 packaged 案例同時 `ERR_CERT_DATE_INVALID` 時請 owner 執行 `npm run test:certs:install`,那不是產品回歸。
- 秘密、token、私鑰不得出現在程式、文件、輸出。

## 3. 順序、相依與角色

| 順序 | WP | 主題 | 規模 | 風險 | 審查角色 | 相依 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [WP2](WP2-task-mode-plan-binding.md) | 任務模式狀態機、single-action 槽、approved-plan 步驟綁定、可審閱的同意卡 | L | R1 | code-reviewer + architecture-reviewer | WP1 的 `taskState`(已完成);D1 |
| 2 | [WP5](WP5-lifecycle.md) | 面板重設、worker 重連再投影、20 秒 heartbeat、lease 到期、context 投影 | M | R1 | code-reviewer | 無 |
| 3 | [WP6](WP6-server-contract.md) | server 授權交易驗證、缺 Origin 拒絕、封閉錯誤回應、409 租約、cancel reason | M | **R2** | owner 開工同意 + code-reviewer | WP5 先改 `handler.ts` 的 lease;D3、D8、D9 |
| 4 | [WP7](WP7-build-production-config.md) | manifest 單一來源、production identity 缺值即失敗、channelUrl 進 config | M | R1 | code-reviewer + architecture-reviewer | D4、D6 |
| 5 | [WP8](WP8-closed-boundaries.md) | 每動作參數 schema、字串與 frame 上限、timeout、nonce、bounds 注入 | M | R1 | code-reviewer + architecture-reviewer | WP6 的 maxPayload;D9 |
| 6 | [WP9](WP9-panel-localization.md) | 可見揭露、`lang`、無效控制項、英文字面值、focus 管理 | S–M | 無風險 | 不派審查(僅 UI 文案與面板行為;若碰 worker 投影則升 R1) | WP2 的投影欄位 |
| 7 | [WP10](WP10-environment-dead-code-evidence.md) | 憑證到期 fail-fast、死碼、非 packaged e2e 搬家、證據與 release matrix | S–M | 無風險 | 不派審查 | 全部完成後;D5、D7 |

順序的理由:WP2 完成後 SC-004、SC-005、SC-008 的自動化證據才成立;WP5 與 WP6 都碰 `apps/server/src/task-channel/handler.ts`,
先做 lease 再做 server 契約避免互相覆蓋;WP7 之前不需要 production 組態;WP8 的 frame 上限與 WP6 的 `maxPayload` 用同一個 D9 數值;
WP9、WP10 是收尾。中途發現難度或風險超出分類時,依 orchestration 政策停下來問 owner,不要默默繼續。

## 4. 已定案的 owner 決策(2026-09-03,owner 採納全部建議)

| 決策 | 定案 | 套用於 |
| --- | --- | --- |
| D1 | worker 在記憶體保留最少的 target metadata(role、label ≤ 80 字元、控制項種類;不含值、不持久化、terminal 即清除),讓同意卡與 Plan 卡能顯示「要點哪個元素」。資料類別屬 `page.target-metadata`,已在 `hallpass-v1` 內,不新增類別。 | WP2 |
| D2 | 遠端 success 被本地降級:有 uncertain 結果 → `attention-required` / `task.effect-uncertain`;其餘 → `failure` / `task.unverified-success`。已由 WP1 實作。 | 已完成 |
| D3 | `/v1/*` 缺 `Origin` 一律 403 `cors.origin-missing`;`/health` 豁免;test-server 的 fixture 路由掛在 `/v1` 之外。 | WP6 |
| D4 | `tasks.md` 不編輯;owner 以 speckit 新增 T128 起的修復任務並在 T086 註記 `validate-build.ts` 尚未接線的事實。 | WP7、WP10 |
| D5 | 六個匯入私有函式的非 packaged e2e spec 搬到 `apps/extension/tests/` 成為單元測試,保留覆蓋;`playwright.config.ts` 只剩瀏覽器旅程。 | WP10 |
| D6 | production identity(extension ID、HTTPS origin、WSS origin)在 build 時由 `HALLPASS_PRODUCTION_EXTENSION_ID` / `HALLPASS_PRODUCTION_HTTPS_ORIGIN` / `HALLPASS_PRODUCTION_WSS_ORIGIN` 經 Vite define 注入;缺值、非 `https://`/`wss://`、含 `*`、loopback 即 build 失敗;runtime 缺值即啟動拋錯。live adapter 出現前 production 仍不可部署。 | WP7 |
| D7 | 測試 leaf 憑證維持 7 天;`tests/harness/test-server.ts` 的 `requireTestPki` 加到期檢查並印出 `npm run test:certs:install` 指示。 | WP10 |
| D8 | WP6 屬 R2:owner 已同意實作,但主 session 在 WP6 開工前仍以一行向 owner 確認;完成後 `code-reviewer` 通過才算完成;由主 session 直接實作,不派 writer 角色。 | WP6 |
| D9 | 上限為可注入常數,預設值記在 evidence-index:frame 64 KiB;progress/summary/purpose 4,000 字元;enter-text text 2,000 字元;collect visibleText 8,000 字元(沿用現值);`maxPayload` 與 frame 上限相同。 | WP6、WP8 |

## 5. 併入的後續項目對照

| 來源 | 項目 | 併入 |
| --- | --- | --- |
| WP1 | approved-plan 的 success 必須要求每一步都被觀測;side-panel Plan 測試每步按 Allow 的暫時做法 | WP2 |
| WP1 | `PageExecutor` 結果欄位以預設值補齊(`clicks ?? 1` 之類)應改為必填 | WP8 |
| WP1 | `haltTask` 的 "Needs attention" / "Stopped" 英文字面值 | WP9 |
| WP1 | domain `*.test.ts` 不在 tsc 檢查內;branded Chrome T091 未重跑 | WP10 |
| WP3 re-review | `plan.document-changed` 中斷投影 cancellation 時沒看 `taskState.uncertainSeen` | WP2 |
| WP3 re-review | executor 在 probe 前的 `stale-context` 拒絕仍把 marker 標成 observed;content frame 在 fence commit 之後才組裝 | WP8 |
| WP4 | `checkVisibility` 沒帶 `opacityProperty` / `contentVisibilityAuto`;collector 仍對 email/tel/number 與未列出的 text input 鑄出 handle | WP8 |
| 審查 | `expireFormValueGrants` 覆寫 revoked(handoff #5) | WP2 |

## 6. 出口檢查(每個 WP 固定,同一個最終 build)

依序執行,每一步檢查 exit code;任何一步失敗就不算完成:

```
npx tsc -b
npx tsc -p apps/extension --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm test
npm run test:contract
npm run build:extension:test
npm run build
HALLPASS_LOCALE=en-US npm run test:e2e:extension-core
HALLPASS_LOCALE=zh-TW npm run test:e2e:extension-core
```

兩個 packaged gate 只在最終 build 上跑(審查修正之後),而且要依序跑,不能並行(固定埠 18786/18787/19443–19445)。
WP10 另加 Chrome 150 的 `test:e2e:release-matrix`(兩個 locale);Chrome 151 記錄為手動 cell。
唯一最終驗證就是這份清單;全部通過後立即回報,不再加任何選擇性的審查、測試、重構或文件。

## 7. Completion Contract 樣板

```
分類:<中等|困難> / <R1|R2>(<觸發條件>) → <路徑>
範圍:WPn 第 2 節;非目標:WPn 第 2 節列出的項目與所有 deferred scope。
宣稱:
  1. <WPn 第 3 節第 1 條> — 證據:<紅測檔名 / packaged spec / contract test>
  2. ...
審查角色:<WPn 第 8 節>
唯一最終驗證:索引第 6 節的清單,於審查修正後的最終 build 上執行。
進度:active → sealing(所有宣稱 PASS)→ done(最終驗證通過並回報)。
```

## 8. 開工提示(貼給主 session 的文字)

```
你是這個 repo 的主 session(實作者)。先讀 CLAUDE-CODE-HANDOFF.md 最上方的 2026-09-03 addendum,
再讀 specs/001-ai-browser-assistant/fixes/00-index.md 與 specs/001-ai-browser-assistant/fixes/WP<N>-*.md。
依索引第 1 節與第 2 節的規則執行 WP<N>:開工前宣告分類與 Completion Contract(宣稱取自 WP 文件第 3 節);
每個行為變更先寫紅測;完成後派 code-reviewer 審查 WP 宣稱,修到沒有 High/Medium;之後在同一個最終 build 上
跑索引第 6 節的出口檢查;把結果填進 WP 文件第 9 節、索引第 9 節,並在 handoff addendum 加一小節。
WP6 屬 R2:開工前先用一行向我確認。做完就回報,不要接著做下一個 WP。
```

## 9. 證據紀錄(每個 WP 完成時填寫)

| WP | 完成日期 | 三段 typecheck | `npm test` | contract | build(test/prod) | gate en-US / zh-TW | 審查(High/Med/Low)→ 再審 | handoff 小節 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WP1 | 2026-09-03 | 0/0/0 | 46 檔 / 328 | 56 | ok / ok | 10/10 / 10/10 | 1 High(uncertain-first)修正 → 乾淨 | 有 |
| WP4 | 2026-09-03 | 0/0/0 | 46 檔 / 328 | 56 | ok / ok | 10/10 / 10/10 | 2 覆蓋缺口 + 4 小項修正 → 乾淨 | 有 |
| WP3 | 2026-09-03 | 0/0/0 | 46 檔 / 348 | 56 | ok / ok | 10/10 / 10/10 | 1 Med + 5 Low 修正 → 乾淨(3 Low 併入 WP2/WP8) | 有 |
| WP2 | 2026-09-03 | 0/0/0 | 47 檔 / 376 | 62 | ok / ok | 11/11 / 11/11 | arch 1 Med;code 2 High + 2 Med 修正 → 再審 2 Low 亦修正 → 乾淨 | 有 |
| WP5 | 2026-09-03 | 0/0/0 | 47 檔 / 396 | 65 | ok / ok | 11/11 / 11/11 | 1 High(雙面板互搶)+ 1 Med 修正 → 再審 1 Low 亦修正 → 乾淨 | 有(宣稱 1 的 packaged 案例已替換,見 WP5 第 9 節) |
| WP6 | 2026-09-04 | 0/0/0 | 50 檔 / 429 | 69 | ok / ok | 11/11 / 11/11 | 1 High(superseded epoch 孤兒任務)+ 2 Med(logout 找不到過期憑證、`client.stop` reason 被丟掉)+ 5 Low 修正 → 複審乾淨(再補 1 Low 的路由紅測) | 有 |
| WP7 | 2026-09-04 | 0/0/0 | 50 檔 / 441 | 76 | ok / ok | 11/11 / 11/11 | 無 High;code 2 Med(define→bundle、channelUrl 各自無測試釘住)+ arch 2 Med(server 驗證較寬鬆、必填卻沒人讀的 httpsOrigin)+ 8 Low 修正 → 複審乾淨 | 有 |
| WP8 | 2026-09-05 | 0/0/0 | 50 檔 / 456 | 88 | ok / ok | 11/11 / 11/11 | code 1 High(每次收集鑄新 nonce → 二次收集後 cancel 靜默失效,等於回歸 WP3 保證)+ 4 Med + 5 Low;arch 1 High(欄位上限總和可超過 frame 上限,只有傳輸層會發現)+ 3 Med + 5 Low → 全部修正 → 複審乾淨 | 有 |
| WP9 | 2026-09-05 | 0/0/0 | 50 檔 / 464 | 88 | ok / ok | 11/11 / 11/11 | 不派審查(無風險);修掉 `AuthPanel` 的 `$&` 替換樣式注入、可見揭露、`html.lang`、審查期 Revoke、worker 三個英文終態字面值、focus 管理;刪除 4 個零消費者的 controller 函式 | 有 |
| WP10 | 2026-09-05 | 0/0/0 | 57 檔 / 490 | 92 | ok / ok | 11/11 / 11/11 | 不派審查(無風險);憑證 fail-fast、刪 5 處死碼與 10 個無消費者再匯出、7 個 e2e spec 搬家(24→24 案例)、domain 測試納入 typecheck(當場抓到 5 個型別錯誤);**Chrome 150 release-matrix 因機器上沒有該 binary 記為 blocked** | 有 |
