# WP7 — Build 與 production 組態:manifest 單一來源、缺值即失敗、channelUrl 進 config

狀態:待開工 · 規模:M · 風險:R1(build 與組態的對外介面)· 審查:code-reviewer + architecture-reviewer · 套用決策:D4、D6 · 相依:無

## 1. 為什麼

- 審查 H8:production build 接受空的 origin;`apps/extension/scripts/write-manifest.ts` 內嵌了自己的 manifest、permissions、CSP 與 test public key,是 `src/manifest.ts` / `build-config.ts` 之外的第二個來源;`scripts/validate-build.ts` 沒接進 build,但 `tasks.md` 的 T086 宣稱已接。
- 審查 M13:server `ServerConfig` 沒有 `channelUrl` 與 `allowedExtensionOrigins`;worker 開 socket 前沒有比對 channelUrl 的 origin 等於釘住的 WSS origin(契約 Bootstrap 第 3 步)。
- production identity 目前沒有任何注入點(D6)。

## 2. 範圍與非目標

範圍:`apps/extension/scripts/write-manifest.ts`、`validate-build.ts`、`write-locales.ts`(刪除)、`apps/extension/src/build-config.ts`、`manifest.ts`、`runtime.ts` 的 identity 讀取、root 與 extension 的 build script、`apps/server/src/config.ts`、`composition.ts`、`app.ts`、`packages/test-kit/src/test-composition.ts`、worker `task-channel-client.ts` 的 origin 比對、contracts `release-build.contract.test.ts`。

非目標:選定 production 部署方式或 host;live AI adapter;CI pipeline;Chrome Web Store 上架;改動 `tasks.md`(D4:由 owner 新增 T128 起的任務並在 T086 註記)。

## 3. 宣稱

1. `write-manifest.ts` 只呼叫 `createManifest(resolveBuildConfig(mode, identity))`;內嵌的 `manifest()` / `PERMISSIONS` / `csp()` / `TEST_PUBLIC_KEY` 刪除;test 模式的 host permission(`https://localhost/*`)只來自 `build-config.ts`。證據:`tests/contract/release-build.contract.test.ts` 與 `manifest.contract.test.ts`。
2. production identity 來自 `HALLPASS_PRODUCTION_EXTENSION_ID` / `HALLPASS_PRODUCTION_HTTPS_ORIGIN` / `HALLPASS_PRODUCTION_WSS_ORIGIN`;缺任一、非 `https://` / `wss://`、含 `*`、loopback、空字串 → `assertProductionEndpoints` 拋錯且 build 失敗;`.invalid` fallback 移除。證據:`release-build.contract.test.ts` 紅測。
3. identity 經 Vite define 注入 `globalThis.__HALLPASS_PRODUCTION_IDENTITY__`,`runtime.ts` 讀取;production build 缺值時 worker 啟動即拋錯;test build 不受影響。證據:`service-worker-runtime.test.ts` 紅測。
4. `validate-build.ts` 接進 extension 的 build script(在 write-manifest 之後);`write-locales.ts` 與 `public/manifest.json` placeholder 刪除;root build 明確帶 mode,不再走無參數雙模式路徑。證據:`shipping-artifact.contract.test.ts` 與 build 腳本執行。
5. server `ServerConfig` 加 `channelUrl` 與 `allowedExtensionOrigins`;`composeProductionApp(adapters, config)` 呼叫 `assertProductionConfig`,拒絕 loopback channelUrl 與空 allowlist;`registerRoutes` / `registerTaskChannel` 改為模組私有;`composeTestApp` 傳入 test channelUrl。證據:`apps/server/tests/app-startup.test.ts` 紅測。
6. worker `task-channel-client.ts` 開 socket 前比對 `new URL(channelUrl).origin === wssOrigin`,不符 → `task.invalid-bootstrap`,不開 socket。證據:`task-channel-lifecycle.test.ts` 紅測。

## 4. 先寫的紅測

- `tests/contract/release-build.contract.test.ts`:production write 在缺環境變數、loopback、wildcard、空字串下拋錯;test manifest 的 host permission 來自 build-config;manifest 內容與 `createManifest` 一致。
- `apps/server/tests/app-startup.test.ts`:production composition 拒絕 loopback channelUrl 與空 allowlist;test composition 通過。
- `apps/extension/tests/task-channel-lifecycle.test.ts`:channelUrl origin 不等於 pinned wssOrigin → 不開 socket、`task.invalid-bootstrap`。
- `apps/extension/tests/service-worker-runtime.test.ts`:production identity 缺值 → 啟動拋錯;齊全 → 正常。

## 5. 設計

- `build-config.ts`:`resolveBuildConfig(mode, identity)` 成為唯一來源;`assertProductionEndpoints` 收緊。
- `write-manifest.ts`:讀環境變數 → `resolveBuildConfig` → `createManifest` → 寫檔;test 模式不需要環境變數。
- Vite config:`define: { "globalThis.__HALLPASS_PRODUCTION_IDENTITY__": JSON.stringify(identity) }`,只在 production 模式注入;`vite-env.d.ts` 宣告型別。
- `runtime.ts`:啟動時讀取並驗證;缺值即拋 `Error("production-identity-missing")`。
- server:`config.ts` 加欄位與 `assertProductionConfig`;`composition.ts` 用它;`app.ts` / `index.ts` 從環境變數組 config。
- reason code `task.invalid-bootstrap` 若尚未有兩語系文案則補上。

## 6. 契約文件同步

`contracts/extension-runtime.md` Bootstrap 段落補 origin 比對;`specs/001-ai-browser-assistant/quickstart.md` 補 production 環境變數清單與「缺值即失敗」;`evidence-index`(若存在)記錄 T086 的實際狀態供 owner 註記(D4)。

## 7. 出口檢查與最終驗證

索引第 6 節。`npm run build` 在沒有 `HALLPASS_PRODUCTION_*` 時必須失敗,因此 root build script 要區分 `build:extension:test` 與 production build;出口檢查改為以 `HALLPASS_PRODUCTION_*` 的假值(格式合法、非 loopback)跑一次 production build 證明能成功,並以缺值跑一次證明會失敗。

## 8. 審查

code-reviewer 審全部宣稱;architecture-reviewer 審 build-config / server config 的介面與單一來源。

## 9. 交付紀錄(實作者填寫)

- **完成日期**:2026-09-04。
- **owner 核准的增補**:2026-09-04,owner 選擇「加上剖面維度,但只做 narrow」。因此 `resolveBuildConfig(profile, mode, identity)`
  多了剖面這個明確輸入(`BUILD_PROFILES = ["narrow"]`、`SHIPPING_PROFILE`、`PROFILE_PERMISSIONS`),但沒有實作 `broad`、
  沒有碰 `debugger` / `<all_urls>` / CDP;narrow 的 manifest 契約測試沒有被刪除也沒有被放寬(C-3、C-4)。
- **出口檢查結果**(同一個最終 build,依序、各自檢查 exit code):`npx tsc -b` 0;`npx tsc -p apps/extension --noEmit` 0;
  `npx tsc -p tsconfig.tests.json --noEmit` 0;`npm test` 50 檔 / 441 測試、exit 0;`npm run test:contract` 11 檔 / 76 測試、exit 0;
  `npm run build:extension:test` 0;`npm run build`(帶合法假值)0;packaged gate en-US 11/11、zh-TW 11/11(依序、未並行)。
  第 7 節另外兩項:`npm run build` 在**缺** `HALLPASS_PRODUCTION_*` 時 exit 1(`production Extension ID is required...`),
  帶合法假值時 exit 0。契約測試會讀 `dist/*/manifest.json`,而索引第 6 節的順序把它排在兩個 build 之前,
  因此在兩個 build 之後又跑了一次 `test:contract`(同樣 11 檔 / 76),讓這份證據對應到最終成品而不是上一輪的成品。
- **審查發現與處置**(fresh context:`code-reviewer` 兩輪 + `architecture-reviewer` 一輪):
  - **無 High**。六條宣稱與剖面增補全部成立,兩位審查者都確認沒有 `broad` 剖面的東西滲進來。
  - **code-reviewer 2 個 Medium(都是「宣稱為真但沒有東西釘住」)**:(M1)Vite define → bundle 這段沒有自動化證據,
    而這個 repo 已經發生過一次「define key 沒對上原始碼讀法、識別字留在 bundle、worker 跑在空 origin」的事故;
    修法是 `validate-build.ts` 檢查兩個 production bundle 不得殘留 `__HALLPASS_PRODUCTION_IDENTITY__` / `__HALLPASS_BUILD_MODE__` 字樣,
    且 worker bundle 必須含有設定的 Extension ID 與 HTTPS origin。(M2)「channelUrl 來自 config」沒被釘住,
    把舊的寫死字串放回去所有測試仍會過;修法是用一個獨特的 channelUrl 組出服務並斷言 bootstrap 原樣回傳。
  - **architecture-reviewer 2 個 Medium(都在 server 端的共用 identity)**:(M1)server 對 `HALLPASS_PRODUCTION_WSS_ORIGIN`
    的驗證比擴充套件寬鬆,而且直接字串串接。兩者是分開部署的,`wss://api.example/` 這種值會通過 server、
    組出 `wss://api.example//v1/tasks/channel`,而擴充套件只比對 origin 所以也會通過,socket 開到一個服務不路由的路徑,
    每個任務都以傳輸錯誤收場——診斷會指向錯的地方。修法是 `isBareWssOrigin` 與 `TASK_CHANNEL_PATH` 的組合檢查。
    (M2)`ServerConfig.httpsOrigin` 是必填卻沒有任何路由讀它;已移除,`configFromEnvironment` 只需要兩個變數,quickstart 同步說明理由。
  - **一併修掉的 Low**:channel 路徑與 Extension-Origin regex 收成單一來源;`composeApp` 改回穩定錯誤碼
    `deployment.config-invalid: <detail>`;三處讀環境變數收斂成 `productionIdentityFromEnvironment`;
    test 版 manifest 也對照 `createManifest` 做新鮮度檢查(production 版在 build 內已有);
    `rewriteChannelUrl` 補上「這是 harness 接縫,跑在 pin 之後」的註解;三份文件裡已不存在的 `ServiceSecurityPolicy` 名稱更正。
  - 每個行為變更都先寫紅測。M1 的 define 檢查以「刪掉 `globalThis.` 那個 define key」重現歷史事故證明會紅;
    M2 與 server 的兩個 Medium 各自以暫時還原該修正證明會紅,再復原。複審乾淨。
- **範圍內做出的一個結構決定(兩位審查者都判定可接受)**:`apps/extension/src/manifest.ts` 已刪除,`createManifest` 移進
  `build-config.ts`。原因是 `write-manifest.ts` 跑在 `node --experimental-strip-types` 下,無法解析 `.ts` 檔裡的 `./build-config.js`
  specifier;另一條路是對整個 extension 原始碼開 `allowImportingTsExtensions`,那會放寬所有出貨程式碼的模組解析,更糟。
  `src/` 裡本來就沒有任何東西 import 它。副作用:`tasks.md` T021 的檔案清單過時(D4:owner 以 T128 起的任務註記)。
- **留下的後續項目**:
  1. `side-panel/workspace-controller.ts` 仍把 `https://localhost:18787` 當初始值帶進 production bundle,
     `control-port.ts` 也留了一個到不了的同樣字串。實際不可達(worker 一定會投影真實 origin),但 production 面板在
     worker 尚未投影前會顯示 loopback 位址與 `npm run dev:test-server` 字樣——屬 WP9。
  2. `isLoopbackOrigin` 是子字串比對,`https://127.0.0.2` 會通過而 `https://notlocalhost.example` 會被拒。只是防手滑,不是安全邊界。
  3. 索引第 6 節的順序把 `test:contract` 排在兩個 build 之前,而 manifest 相關斷言讀的是磁碟上的成品。
     本次已在 build 後補跑一次;要根治得調整第 6 節順序,屬 WP10 的證據整理。
  4. **剖面遷移備忘(`BUILD_PROFILES` 加第二個值那天必須同時做)**:`SHIPPING_PROFILE` 要從模組常數變成建置輸入;
     worker 需要一個剖面的 Vite define(否則 `broad` 成品的 worker 會解析成 narrow);`dist/` 目前只有 mode 這一個維度,
     必須再加剖面,C-4「每個剖面各有一份讀自己成品的契約測試」才可能成立。
  5. `packages/test-kit/src/build-config.ts` 仍複製了 test 版的兩個 origin(ID 已跨檔釘住,origin 沒有)。
  6. 兩個部署物各自維護一份 loopback 標記清單(`build-config.ts` 與 `config.ts`),中間沒有共用套件可放。
  7. `registerTaskChannel` 改為私有後,它的 `options?.maxPayload` 已無呼叫者(WP6 第 9 節已把注入接縫併給 WP8)。
  8. `validate-build.ts` 會拒絕 bundle 裡出現 `__HALLPASS_BUILD_MODE__` 字樣;`minify: false` 會保留註解,
     所以日後若有 `src/` 註解寫到這個字樣,production build 會以一句誤導的訊息失敗。fail-closed 且立刻看得到,暫不處理。
  9. `tasks.md` T021 / T022 的檔案清單因刪檔而過時(D4,owner 註記)。
