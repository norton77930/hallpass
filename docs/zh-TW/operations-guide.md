# Hallpass(瀏覽器代理橋接)— 操作手冊(維護者版)

2026-09-19 · 適用於 009 完成後的 **Hallpass 0.3.0**(31 個 MCP 工具、side panel 三態、錄製 GIF 與對話框)。

> 這份是中文的維護者手冊。英文的 README 是公開入口;開發從 <https://github.com/norton77930/hallpass> 繼續。
這份文件寫給**要開始用 AI(Claude Code)操作自己瀏覽器的人**;開發與測試的細節在
`CLAUDE-CODE-HANDOFF.md` 與 `tests/acceptance/owner-remaining-runbook.md`。

## 0. 這是什麼(一分鐘版)

你在 **Claude Code** 終端機裡下指令,Claude Code 透過一個 MCP server 把「瀏覽器工具」的呼叫送進
Chrome 的擴充功能,由擴充功能在**你的 Chrome、你的登入狀態**下操作分頁。每一個會改變頁面的動作,
都受**你在側欄裡對每個網站做的決定**管:每次都問、照計畫、或不再詢問。

```
Claude Code ──stdio──▶ mcp-server.js ──loopback──▶ relay(native host)──▶ 擴充功能 service worker ──▶ 分頁
  (你打字的地方)        (每個 session 一個)        (Chrome 自己啟動)         (配對、同意、工具執行)
```

沒有任何遠端服務;三個程序都在你的電腦上。

## 1. 安裝(做一次)

> **不想碰 repo?用安裝包。**`npm run package` 會產出 `release/hallpass-<版本>.zip`(擴充功能資料夾 + 自足的
> host + `install.ps1` / `uninstall.ps1` + README)。解壓後跑 `install.ps1`,照它印出的路徑載入擴充功能、把 server
> 定義貼進你用的 MCP client(README 有 Claude Code / Claude Desktop / Codex CLI / Cursor 四種的位置)。只需要 Node 24,
> 不需要 npm、不需要 build。下面 1.2–1.4 是從 repo 安裝的方式。

### 1.1 前置
- Windows 11、**Node 24**(`node -v`)、npm。
- **Chrome**——你平常用的那個就可以(正式版 Chrome 152 驗收過;Chromium 系也行,安裝程式會在
  `Google\Chrome` 與 `Chromium` 兩個登錄位置都註冊 native host)。
  想把 agent 的登入狀態和日常瀏覽分開,才用專用 profile:`chrome.exe --user-data-dir=D:\chrome-agent-profile`。
  `--remote-debugging-port=9222` 只有跑自動測試才需要,日常使用**不要**加。
- **Claude Code** 已安裝且可登入(`claude --version`)。
- 下面的 `<repo>` 一律代表這個 repo 在你機器上的 checkout 路徑(自行代換,含空白的路徑記得加引號)。

### 1.2 建置
```powershell
cd "<repo>"
npm install
npx tsc -b
npm run build:extension:agent      # 產出 apps\extension\dist\agent(不是 dist\test)
npm run agent-host:install         # 寫入 %LOCALAPPDATA%\hallpass\ 與 HKCU 的 NativeMessagingHosts 登錄
```
`agent-host:install` 寫的 host manifest 直接指向這個 repo 的 `packages\agent-host\dist`,
所以**之後重新 build 不需要重新安裝**;搬移 repo 才需要。

### 1.3 載入擴充功能
1. Chrome 開 `chrome://extensions`,右上角開啟「開發人員模式」。
2. 「載入未封裝項目」→ 選 `<repo>\apps\extension\dist\agent`。
3. 確認名稱是**「Hallpass」**(zh-TW 介面顯示「Hallpass 瀏覽器代理橋接」),ID 是
   `adgpccmmbgnchnphfaoabfflfcepbopd`(manifest 內含固定 key,
   ID 不會變;native host 只允許這個 ID)。
4. 把它釘在工具列。點圖示或按 **Alt+A** 會開側欄;第一次看到的是「還沒有 agent 連上這個瀏覽器」,正常。

### 1.4 把 MCP server 加進你的 AI 工具
server 是標準的 stdio MCP,任何支援 MCP 的工具都能接。**CodeBuddy**:側欄對話面板右上角 CodeBuddy Settings → MCP 頁籤 → 添加 MCP,貼
`{ "mcpServers": { "hallpass": { "type": "stdio", "command": "node", "args": ["<repo>\packages\agent-host\dist\mcp-server.js"] } } }`。
**Cursor**:Settings → MCP → Add new global MCP server(`~.cursormcp.json`),同樣的 `mcpServers` 區塊(不需要 `type`)。
**Claude Code** 二選一。指令版(在任何目錄執行,`--scope user` 讓每個專案都能用):
```powershell
claude mcp add hallpass --scope user -- node "<repo>\packages\agent-host\dist\mcp-server.js"
claude mcp list        # 應看到 hallpass
```
或在 `~/.claude.json`(或專案的 `.mcp.json`)加:
```json
{ "mcpServers": { "hallpass": { "command": "node",
  "args": ["<repo>\\packages\\agent-host\\dist\\mcp-server.js"] } } }
```
工具在 Claude Code 裡的名字是 `mcp__hallpass__<工具名>`,例如 `mcp__hallpass__read_page`。

## 2. 第一次使用

1. Chrome 開著(你平常用的或專用 profile 都可以),擴充功能已載入。
2. 開 Claude Code,例如:「用 hallpass 打開 https://en.wikipedia.org,告訴我首頁的標題」。
3. 第一通工具呼叫會讓側欄跳出**配對卡**:「Claude Code 想連上這個瀏覽器」→ 按**允許配對**。
   有 **45 秒**;逾時那一通會失敗,再叫一次就會再問。配對只做一次,之後 Chrome 重開也記得。
4. 第一個會**改變頁面**的動作(點擊、輸入、導航…)會跳出**同意卡**:
   「Claude Code 想在 wikipedia.org 上點擊頁面元素」→ 三個選項:
   - **只允許這一次** — 這個動作過,下一個再問(預設模式 `ask`)。
   - **這個網站以後都允許** — 這個站切到 `skip-checks`,之後不再問。
   - **拒絕** — 這個動作回「拒絕」給 agent。
5. agent 在動的分頁會被圈成一個分頁群組(標題 Agent),頁面頂端有橫幅;側欄會出現那個 session 的卡片。

## 3. 側欄怎麼看

| 畫面 | 你會看到 | 你能做 |
|---|---|---|
| **未連線** | 一頁:發生什麼(未配對 / 連線中斷)、怎麼做、「重新檢查連線」、「技術資訊」(relay pid、`bridge.json` 路徑、最後斷線原因) | 重試;看技術資訊回報問題 |
| **待命**(已配對、沒有 session) | 狀態列「● 已連線 · Claude Code」、「更多選項」(解除配對)、**允許 agent 操作的網站**清單 | 改每個網站的模式、撤銷、勾選診斷授權 |
| **有 session** | 每個 session 一張卡:agent 名稱與工作階段、正在操作的網站、狀態(執行中 / 等你決定)、**停止**、**還我分頁** | 停掉某一個 agent;把分頁拿回來但讓它繼續 |
| **提示卡**(疊在最上面) | 配對卡 / 同意卡 / 計畫卡,一次一張,依到達順序 | 回答 |

- **停止**:那個 session 結束,agent 那端的呼叫會收到 `owner-stopped`;它的分頁留著、變回你的。
  agent 下一通呼叫會自動開新 session,不用重啟 Claude Code。
- **還我分頁**:它佔的分頁全部還你(群組、橫幅解除),session 還在;它之後要動這些分頁會被拒,
  可以自己再開新分頁。
- 頁面橫幅上的「回到 agent 的分頁」可以跳回它的主分頁。

## 4. 三種網站模式與其他授權

| 模式 | 意思 | 適合 |
|---|---|---|
| `ask`(每次都先問我) | 每一個改變頁面的動作都跳同意卡 | 預設;不熟的網站、有帳號的網站 |
| `follow-a-plan`(照計畫) | `browser_batch` 多步呼叫整批核准一次(計畫卡),單步動作照樣問 | 表單填寫這類固定流程 |
| `skip-checks`(不再詢問) | 這個站完全不問。清單上有警示標記 | 你信任、沒有敏感資料的站 |

- **診斷授權**(每站一個勾選):開了才允許 `read_console` / `read_network` / `evaluate`。
  `evaluate` 會在頁面裡執行程式,視為效果、也受站點模式管。
- **上傳**:agent 只能上傳 `%LOCALAPPDATA%\hallpass\config.json` 裡 `uploadRoots` 列出的目錄
  下的檔案。安裝時是空陣列 = 不能上傳。例如:
  ```json
  { "uploadRoots": ["D:\\agent-uploads"] }
  ```
- **下載**:頁面觸發的下載照常落在 Chrome 的下載資料夾;agent 用 `downloads_context` /
  `wait download-complete` 得知檔名與狀態,然後用自己的檔案工具讀。擴充功能不會啟動、開啟、移動或刪除任何下載。
- **表單值**:agent 讀得到欄位目前的值;密碼、hidden、以及 autocomplete 標為密碼 / 一次性驗證碼 /
  信用卡的欄位一律遮罩(`redacted`),值不會離開頁面。
- **錄製**(`gif_recorder`,008):一個 session 一份錄製,每個會改變頁面的動作(含 `browser_batch`
  的每一步)拍一張,上限 200 張;匯出寫進 Chrome 的下載資料夾,和其他下載一樣受 `downloads_context`
  / `wait download-complete` 管理。錄製不需要額外授權——它拍的就是 agent 自己動過的分頁。
- **對話框**(`dialog`,008):頁面的 alert / confirm / prompt 由 agent 回答,但按「確定」和點擊一樣
  受站點模式管;按「取消」與 alert 不問。詳見 §9。

## 5. 注意事項(踩過的坑)

1. **Chrome 頂端的「Hallpass 已開始對此瀏覽器進行偵錯」橫幅**:這是輸入走瀏覽器層級(CDP)
   的正常現象,參考套件也一樣。**不要按「取消」**——按了之後所有點擊/輸入會回 `input-unavailable`,
   要等 agent 下次重新附著(或停止 session 再來)。
2. **受限頁面**:`chrome://`、Chrome 線上應用程式商店、`file://` 等,agent 拿不到、也不能導航過去。
3. **要登入的網站先自己登入**。agent 用的是你的 profile,cookie 共用;它看得到你登入後的畫面,所以
   對敏感網站(銀行、健康、約會)不要開 `skip-checks`,最好連 `ask` 都別給。
4. **截圖會閃一下**:`screenshot` 要切到那個分頁擷取再切回來,屬正常。
5. **多個 Claude Code 同時用同一個 Chrome 可以**:每個 session 各自一個分頁群組,互不搶分頁;
   別人持有的分頁對它是「not-yours」。
6. **Chrome 關掉 = 橋接結束**:relay 是 Chrome 啟動的,Chrome 退出它就結束;agent 下一通呼叫會回
   `bridge-lost`,重開 Chrome 後自動恢復(10 秒內),不用重啟 Claude Code。
7. **重新 build 之後要重載擴充功能**(`chrome://extensions` → 重新載入);host 端不用重裝。
8. **側欄語言**跟 Chrome 介面語言:`zh-TW` 顯示中文,其他一律英文。
9. **一次只回答一張提示卡**;卡片上有 agent 名稱與網站,確認是你預期的那一個再按。
10. **不要在敏感頁面按「這個網站以後都允許」**——那是持久設定(存在 `storage.local`),
    要收回去側欄清單按「撤銷」。

## 6. 給 AI 的指令範例

- 讀:「用 hallpass 打開 https://github.com/octocat/Hello-World,把 README 的前三段讀給我。」
- 找 + 點:「在這個分頁找『Sign in』連結並點下去,然後告訴我現在的網址。」
- 表單:「打開 https://httpbin.org/forms/post,customer name 填 Ada,size 選 Large,不要送出;
  用 read_page 確認欄位值後回報。」
- 多步一次核准:「用 browser_batch 一次做:點搜尋框 → 輸入 chrome extension → 按 Enter → 等 1 秒。」
- 下載:「導航到 https://github.com/octocat/Hello-World/archive/refs/heads/master.zip,
  用 wait download-complete 等它下完,告訴我檔案路徑。」
- 多分頁:「開兩個分頁分別打開 A 站和 B 站,比較兩邊的標題。」

agent 回報 `not-yours` / `held-by-session` 表示那個分頁不是它的(你的或別的 session 的);要它用
`tabs_claim` 拿走沒人持有的分頁,或自己 `tabs_create`。

## 7. 疑難排解

| 現象 | 先看 | 處理 |
|---|---|---|
| 側欄「還沒有 agent 連上」,但 Claude Code 已呼叫 | `claude mcp list` 有沒有 `hallpass`;擴充功能 ID 是否正確;`%LOCALAPPDATA%\hallpass\bridge.json` 是否存在 | 沒安裝就 `npm run agent-host:install`;ID 不對就重新載入 `dist\agent` |
| 側欄「和本機 agent 的連線中斷了」 | 展開「技術資訊」看最後斷線原因;`%LOCALAPPDATA%\hallpass\relay.log` | 通常自己恢復;沒有就按「重新檢查連線」,再不行重啟 Claude Code |
| 呼叫回 `not-paired` | 配對卡有沒有在 45 秒內按 | 再叫一次,按「允許配對」 |
| 呼叫回 `bridge-lost` | Chrome 是否關了 | 開 Chrome,10 秒內自動恢復 |
| 點擊/輸入回 `input-unavailable` | 是否按了偵錯橫幅的「取消」 | 停止 session 後重來,別按取消 |
| 呼叫回 `denied` + `restricted-page` | 目標是 `chrome://` 之類 | 換一般網頁 |
| 呼叫回 `stale` | 頁面正在載入或已換頁 | 讓 agent 先 `wait` 或重新 `read_page` |
| 上傳回 `upload-not-allowed` | `config.json` 的 `uploadRoots` | 把目錄加進去 |
| 診斷工具回 `denied` | 側欄該站的「診斷」勾選 | 勾起來 |

日誌:relay 與 host 只記穩定代碼(`relay.started / superseded / unowned / chrome.closed`、
`agent.call.completed …`),不記頁面內容;放心附在回報裡。

## 8. 更新與移除

- **從 0.2.0 升級到 0.3.0(改名)**:MCP server 改叫 `hallpass`、host 改叫 `com.hallpass.host`、資料夾改為
  `%LOCALAPPDATA%\hallpass\`。安裝包使用者照 `scripts/package/README.md` §2.1 的四步;從 repo 安裝的人重跑
  `npm run agent-host:install`(它會移除舊註冊並印出來)、`claude mcp remove poc-browser`、再 `claude mcp add hallpass …`、
  重新載入擴充功能。配對與站點模式都留著(擴充功能 ID 不變);上傳白名單要在新的 `config.json` 重填。

- **更新程式碼**:`git pull`(或取得新檔)→ `npx tsc -b` → `npm run build:extension:agent` →
  `chrome://extensions` 重新載入。host 指向 repo 的 dist,自動生效;Claude Code 下一次啟動 server 用新的。
- **移除**:`npm run agent-host:uninstall`(刪 `%LOCALAPPDATA%\hallpass` 與登錄鍵)、
  `claude mcp remove hallpass`、在 `chrome://extensions` 移除擴充功能。
- **從 0.1.x 升級**:安裝包使用者把新 zip 蓋進同一個資料夾 → 重跑 `install.ps1` → 重新載入擴充功能;
  Chrome 會問一次 `offscreen` 權限,配對、站點模式、`config.json` 都留著(`scripts/package/README.md`
  §2.1 與 QA 指南是同一份說明,已用 `tests/acceptance/upgrade-proof.mjs` + `upgrade-host-proof.ps1` 驗過)。

## 9. 008 新增的兩個工具與 `offscreen` 權限

工具數量 **29 → 31**:

| 工具 | 做什麼 | 受什麼管 |
|---|---|---|
| `gif_recorder {action, filename?}` | `start` / `stop` / `export` / `clear`。一個 session 一份錄製;`start` 先拍一張現況,之後每個會改變頁面的動作(`browser_batch` 的每一步各算一張)拍一張,讀取類不拍;上限 **200 張**,滿了之後每個回覆都帶 `recording.full`。`export` 可給檔名(英數字、空白、`-`、`_`、`.`,不可 `.` 開頭,≤ 80 字),不給就是 `agent-recording-<時間>.gif` | 不另外徵詢——它拍的是 agent 自己操作的分頁;檔名不合文法直接回 `invalid-filename`,沒有畫面回 `empty-recording` |
| `dialog {tabId, action, promptText?}` | 回答頁面的 alert / confirm / prompt。對話框開著時,對那個分頁的其他工具一律立刻回 `blocked-by-dialog`(實測 6–7 ms) | `dismiss` 與 alert 不問;`confirm` / `prompt` 的 `accept` 視同一次點擊,受站點模式管;例外是「承接」:同一分頁上剛核准的動作在 1000 ms 內引出的對話框不再問,側欄出通知卡 |

**`offscreen` 權限(0.2.0 加入,0.3.0 唯一超出 005 的權限)**

- 用途只有一個:把錄到的畫面在一個背景文件裡編成 GIF(`reasons: ["BLOBS"]`)。
- 這個文件**只**載入擴充功能自己的兩個模組與 GIF 編碼器,**不發任何網路請求**,`chrome.*` 只用到
  `chrome.runtime.onMessage`;它只收得到本擴充功能寄出、且訊息型別以 `recording/` 開頭的訊息,
  帶 `tab` 的寄件者一律拒絕(網頁拿不到任何一張畫面)。
- 生命週期:第一次 `start` 時開,錄製全部清空且沒有待撤銷的 blob URL 時關(**閒置就關**)。
  它是獨立的 target:**service worker 被回收或被殺掉,畫面不會不見**(2026-09-19 的實測)。
- 匯出流程:編碼 → `chrome.downloads.download` → **等瀏覽器說完成** → 撤銷 blob URL → 清掉畫面 →
  文件閒置就關。下載失敗(`download-failed`)時**畫面原封不動留著**,agent 可以再匯出一次;
  回報的檔名是**瀏覽器實際存下來的那個**(同名會變 `TC-1234 (1).gif`)。
- `narrow` build 的 manifest 完全沒動;兩份 manifest 都有 contract test 釘住。

## 10. 跑驗收(工程)

- **附著模式的 gate**(`HALLPASS_CDP_ENDPOINT`):008 新增
  `tests/e2e/packaged/agent-recording.spec.ts`(錄製、覆蓋圖、worker 被殺、200 張上限、下載被拒)與
  `tests/e2e/packaged/agent-dialogs.spec.ts`(三種模式的對話框、離開提示),外加
  `agent-window-restore.spec.ts`。截圖用的
  `agent-guide-shots.spec.ts` 預設跳過,要 `HALLPASS_PANEL_SHOTS=1` 才跑。
- **驗收探針**(`claude -p --model sonnet` 當呼叫端):`tests/acceptance/probe-004/scenarios/`
  的 **S9**(`s9-recording`)與 **S10**(`s10-dialogs`);報告在 `…/probe-004/reports/`。
- **不佔用 owner 的 Chrome 就能跑 gate 的做法**(私有 `LOCALAPPDATA`):用一個獨立的
  `LOCALAPPDATA` 目錄同時啟動**瀏覽器**與 **runner**,瀏覽器的 native host 會把 relay 記錄寫進那個
  目錄,這次跑的 `mcp-server.js` 也只讀那裡,機器上其他 Claude Code session 的 server(讀的是平常
  那份記錄)就碰不到這個瀏覽器。這是 `HALLPASS_FOREIGN_AGENT_SERVERS=allow` 唯一允許的情況——runner 的
  `LOCALAPPDATA` 不可以是使用者預設的那個,fixture 會擋(`tests/e2e/fixtures/packaged-extension.ts`)。
  ```powershell
  $env:LOCALAPPDATA="<某個私有目錄>\gate-localappdata"      # 瀏覽器與 runner 共用的私有目錄
  $env:HALLPASS_CDP_ENDPOINT="http://127.0.0.1:9222"; $env:HALLPASS_LOCALE="en-US"
  $env:HALLPASS_FOREIGN_AGENT_SERVERS="allow"
  npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-recording.spec.ts --reporter=list
  ```
  瀏覽器要載入 `apps/extension/dist/agent`(gate 會比對,版本不符直接停)。
  下載相關的 journey 會先把瀏覽器的下載行為改回 `default`:Playwright 會把它附著的瀏覽器的每個下載
  改名成 GUID 丟進自己的 artifacts 目錄,那樣就證不了「檔案用 agent 要的名字存下來」。
  對話框的 journey 收尾一定要把對話框關掉——沒人回答的原生對話框會讓下一次 `connectOverCDP` 卡住。

## 11. 工作方式(踩過兩次就停)

owner 2026-09-18 的規則,008 全程適用,寫在這裡是因為它省下的時間比任何一個技巧都多:
**一件事失敗兩次就不試第三次**。停下來,回去讀參考套件或在 gate 上**取一個量測**,把結果寫成
行為分析(私有存檔;公開摘要是 `docs/design-notes.md`)的一個新章節,再用那份證據重新交代任務。
「換個猜法再試一次」正是這條規則要擋掉的事。任何缺陷或設計問題,先讀已安裝的參考套件(clean room:
只讀行為,不抄任何識別字或程式碼),再動手。

---

開發從 2026-09-19 起在公開 repo 繼續:<https://github.com/norton77930/hallpass>。原私有 repo 只作存檔。
