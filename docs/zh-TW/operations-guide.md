# Hallpass(瀏覽器代理橋接)— 操作手冊(維護者版)

2026-09-26 · 適用於 **Hallpass 0.8.0**(33 個 MCP 工具、side panel 三態、錄製 GIF 與對話框、
中斷、跳站確認、上傳資料夾詢問、0.7.0 的配對與提示修正,以及 0.8.0 的「答案要誠實」)。

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
- **Chrome**——你平常用的那個就可以(正式版 Chrome 152 驗收過)。安裝程式會在四個登錄位置註冊 native host:
  `Google\Chrome`、`Chromium`、`Microsoft\Edge`、`BraveSoftware\Brave-Browser`;其中只有 Chrome 跑過驗收,
  Edge 與 Brave 只註冊、未實機驗證(公開 repo issue #2)。
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
**Cursor**:Settings → MCP → Add new global MCP server(`~\.cursor\mcp.json`),同樣的 `mcpServers` 區塊(不需要 `type`)。
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
   你正在用的那個視窗開著側欄時,有 **45 秒**;沒開(或側欄在別的視窗)時,工具列圖示會出現紅色 **!**、
   agent 會轉告你去哪裡按,卡片最多等 **2 分鐘**。逾時那一通會失敗,再叫一次就會再問。
   配對只做一次,之後 Chrome 重開也記得。
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
| **有 session** | 每個 session 一張卡:agent 名稱與工作階段、正在操作的網站、狀態(執行中 / 等你決定)、**中斷**、**停止**、**還我分頁** | 只結束正在跑的那一步;停掉某一個 agent;把分頁拿回來但讓它繼續 |
| **提示卡**(疊在最上面) | 配對卡 / 同意卡 / 計畫卡,一次一張,依到達順序 | 回答 |

- **中斷**:只結束正在跑的那一步(詳見 §9.3),session、分頁、授權、錄影全部留著;沒有東西在跑時按下去
  會告訴你「現在沒有正在執行的步驟」。
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
| 呼叫回 `not-paired` | 配對卡有沒有在時限內按(所在視窗開著側欄 45 秒;沒開時 2 分鐘,圖示有紅色「!」) | 再叫一次,按「允許配對」 |
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

## 9.1 012 新增的兩件事(0.4.0,工具數 31 → 32)

**`viewport {tabId, action, width?, height?}`**:給某一個分頁一個**模擬的視窗大小**(320–4096 px),
頁面就照那個寬高重新排版——手機寬、平板寬、寬螢幕都可以,**你自己的瀏覽器視窗完全不動**。它用的是
Chrome DevTools 協定的畫面模擬,不是把視窗拉大拉小,因為視窗是你的;`resize_window` 留給「真的必須
改視窗」的少數情況,兩個工具互不影響。**截圖**跟著改:分頁被模擬時拍的就是那個模擬視窗的整張畫面,
`region` 以 CSS 像素裁切但**按畫面自己的密度**取像(在 DPR 1.25 或 2 的螢幕上不會再少裁 25 %),
另外新增 `scale`(0.1–1)可以要一張比較小的圖;圖太大時會直接回「請用 scale ≤ 多少重試」。

**放開分頁時一定會清掉**:模擬在 Chrome 裡**不會因為 debugger 斷線就消失**(2026-09-21 實測),
所以擴充功能在每一條「放開」路徑上都會先主動清除——`reset`、`tabs_release`、你在側欄按「還我分頁」、
解除配對、撤銷授權、session 結束都算。也就是說,**agent 不可能把你的分頁留在手機寬**;側欄的活動
紀錄會寫「視窗模擬為 375x812」與清除的那一行。

## 9.2 013 新增:把 agent 剛拍的截圖放進頁面(0.5.0,工具數 32 → 33)

**`upload_image {tabId, imageId, ref | coordinate, filename?}`**:把**這個 session 自己拍的截圖**
放進它正在操作的頁面——不需要先存成檔案,也不會存成檔案。每一張截圖的回覆(`screenshot` 與
`computer` 的 screenshot 動作)現在都會帶一個 `imageId`,agent 直接引用它:給 `ref` 就放進
`<input type="file">`(頁面自己用按鈕藏起來的那種也放得進去),給 `coordinate` 就在那個點上做一次
拖放(dragenter → dragover → drop),同源子框架往下**一層**也找得到;檔名預設 `screenshot.png`。

- **留什麼**:只有那張截圖的位元組、它的型別與拍攝時間,**只在本機 MCP server(host)的程序記憶體裡**,
  不寫磁碟、不進瀏覽器儲存、側欄也讀不到;另一個 agent 的 session 是另一個程序,拿不到你這個的 id。
- **留多久**:**5 分鐘**,而且一個 session 總共最多留 **8 MiB**;超過就先丟最舊的,單張太大的直接不留
  並在回覆裡說「不能之後上傳」。過期或被丟掉的 id 會被明確拒絕(`expired` / `evicted`),agent 應該
  重新拍一張——這些拒絕發生在 host 端,**頁面完全不會被碰到**。
- **經過站點同意**:放檔案進頁面就是改頁面,所以跟點擊一樣受站點模式管——`ask` 會出同意卡(0.6.0 起
  卡上直接寫是哪一種放法:「把代理拍的截圖放進頁面的檔案欄位」或「把代理拍的截圖拖放到頁面上的位置」,
  一樣不會出現 id 或檔名)、`skip-checks` 直接做、撤銷授權就拒絕;錄製中也會拍一張。做成之後側欄的
  活動紀錄會寫「檔案已放進 {站點} 的表單」或「截圖已拖放到 {站點}」。
- **兩種投遞**:檔案輸入框(頁面的 `input`/`change` 會跑,回覆帶頁面自己讀回來的檔名與大小)與
  拖放(回覆帶投遞的座標)。你自己磁碟上的檔案仍然走 `file_upload` 與它的 upload roots。

## 9.3 014 新增:中斷、跳站確認、上傳資料夾詢問(0.6.0,工具數不變仍是 33)

**中斷(側欄按鈕,不是工具)**:session 卡片上「停止」旁邊多一個**中斷**。按下去只結束**正在跑的那一步**,
一秒內一定有答案,不管那一步在等什麼(`wait`、還沒有人回答的同意卡、跑很久的批次步驟都算)。其他東西全部
留著:配對、分頁與分頁群組、網站模式與診斷授權、正在錄的 GIF、已套用的模擬視窗大小。agent 收到的答案是
`stopped / owner-interrupted`,而且會告訴它**剛才有沒有東西已經送進頁面**(鍵盤、點擊這類已經送出去的動作
會說「可能已經生效」,還沒送出去的會說「沒有任何東西被送出」),它自己決定要不要重試。批次會照原本的慣例
回報:跑完的、被中斷在第幾步、沒跑到的。沒有任何東西在跑時按下去,只會出現一行提示,不會有任何副作用。
「停止」的行為完全沒變——那是結束整個 session。

**跳站確認**:agent 操作中的分頁,從原本的網站跳到**你從來沒決定過的網站**時(點擊後被轉址、登入服務、
短網址),造成這件事的那一次呼叫會在回覆裡說明「這個分頁從 A 到了 B,下一次呼叫會問擁有者」,而**下一次**
對那個分頁的呼叫(連讀取都算)會跳出卡片,卡上同時寫出兩個網站,三個答案:**繼續**(這次 session 有效)、
**一律允許**(記住 A→B 這一組,以後不再問)、**拒絕**(只拒絕這一次,回 `denied / site-transition-declined`;
session 繼續,問題留著等下一次呼叫)。要**離開**的呼叫不會被擋:換去別的網址、關掉分頁、把分頁還你,
都直接放行——不然 agent 發現自己不該在那裡也走不掉。本機位址(127.0.0.1/localhost)之間的跳轉不會問。
記住的組合列在側欄「允許 agent 操作的網站」下面,寫著上次使用時間,旁邊有**撤銷**。

**上傳資料夾詢問**:`file_upload` 遇到 `uploadRoots` 以外的檔案,以前直接拒絕(要先手動改 `config.json`);
0.6.0 改成**當下問你**。本機主機會把這次呼叫停住(最多等 125 秒),側欄完整列出每個檔案的路徑與它所在的
資料夾,三個答案:**這些檔案這次就好**、**這些資料夾以後都可以**(寫進 `config.json` 的 `uploadRoots`)、
**拒絕**。磁碟機或網路分享的根目錄(`C:\`、`\\server\share`)**永遠不會**被加進清單,那些檔案只會以
「這次就好」放行,回覆裡會說原因。檔案太多、總量太大會照舊直接拒絕,而且是在問你**之前**就判斷完——
不會讓你為了一個怎樣都會失敗的呼叫去放寬清單。允許的資料夾也列在側欄,各自有**撤銷**;這份清單只有你
(和這個檔案本身)能改,agent 呼叫得到的任何工具都讀不到、也加不了。

> **升級提醒**:0.6.0 的擴充功能要配 0.6.0 的本機主機,請**重新安裝主機**(`npm run agent-host:install`,
> 安裝包使用者是 `install.ps1`)。舊主機(0.5.0)遇到允許資料夾以外的檔案只會回 `upload-not-allowed`
> 直接拒絕,不會問你;擴充功能會先問主機做得到什麼,所以新擴充功能配舊主機就跟 0.5.0 一樣,不會出錯,
> 只是沒有這個問題卡片。

## 9.4 0.7.0:配對與提示修正(工具數不變仍是 33)

- **配對只在第一次呼叫工具時才問**(004 FR-059a):agent 連上來(MCP initialize、relay 重新連上)不再跳配對卡片,
  要等它第一次呼叫工具。同一個 agent 有好幾條連線在等時,卡片寫出有幾條,新加入的那條會標出來。
- **「忽略」馬上回覆 agent**(003 FR-032a、006 FR-084):忽略配對卡片,等著的呼叫立刻以 `denied / not-paired`
  結束並附「不要重試」的提示,下一次呼叫會重新跳卡片。**解除配對**仍然拒絕這個 session 之後的每一次呼叫,
  提示裡會叫 agent 用 `/mcp` 重新連線。
- **以你眼前的視窗為準**(011 D-011-6):「!」徽章、配對與同意卡的 2 分鐘等待,看的是你目前所在視窗有沒有
  Hallpass 側欄;別的視窗開著側欄,不會再把卡片藏起來或把等待縮成 45 秒。卡片仍會送到每一個開著的側欄。
- **紅色邊框**:agent 操作中的分頁重新載入或換頁(包括 F5)後紅框還在;擴充功能重新載入之前就開著的分頁也會畫出來。

> **升級提醒**:請**重新安裝主機**(`npm run agent-host:install`,安裝包使用者是 `install.ps1`)。
> 連線時不跳卡片、「忽略」只拒絕一次,都在主機裡;已安裝的 0.6.0 主機在你按「忽略」之後,
> 仍會拒絕這個 session 之後的每一次呼叫。

## 9.5 0.8.0:答案要誠實(工具數不變仍是 33)

- **按下去做了什麼,答案會說**(015 FR-200 – FR-202):`click`、`double_click`、`triple_click`、`right_click`、
  `computer` 的按壓動作,以及 `browser_batch` 裡的同樣步驟,答案的 `observed` 會多寫出按下去之後 400 ms 觀察時間內
  發生的事:這個分頁換頁(`url` 是新網址)、開了新分頁(`newTabs`,每個寫出分頁 id 與網址,`held: false`——
  不屬於這個 session,要操作得先用 `tabs_claim` 接手)、開始下載(`downloads`,寫法同 `downloads_context`),
  或什麼都沒發生(`observedForMs` 寫出觀察了多久)。按的是有網址的連結卻什麼都沒發生時,答案附一句提示:
  連結按到了,但 400 ms 內沒有換頁、沒開分頁、沒下載,頁面可能自己處理了,先讀頁面或等一下再下結論。
  觀察時間就是原本按完之後的等待,**不會變慢**。
- **頁面沒回應不再被說成 `stale`**(FR-204 – FR-206):頁面 10 秒沒回應時,答案是
  `failed / page-not-responding`,提示說頁面還開著。還沒送出任何東西時,提示是「可以再試一次,或先截圖看看它的狀態」;
  點擊或打字已經送到頁面後才沒回應時,提示是「這個輸入可能已經生效,重送之前先截圖或讀一下頁面」,避免送出按鈕被按兩次。`stale` 只留給
  「頁面已經被換掉」(`stale-reference`)和「分頁已經不在」(`tab-gone`)。
  **已知的 Chromium 行為**:一個分頁先跳到別的網站、再回到原本的網站之後,第一次按下會用 `window.open`
  開新視窗的按鈕,有機會讓那個頁面卡住(沒有 Hallpass、只用 CDP 按也一樣會發生,這不是擴充功能能避免的)。
  以前 agent 要等 30 秒才拿到「沒回應」;現在 10 秒內就會被告知 `page-not-responding`。卡住的分頁可以關掉重開。
- **每一個下載完成都只回報一次**(FR-207 – FR-209):`wait` 等下載完成時,依結束時間先後,
  把這個 session 還沒回報過的下載(完成、失敗或取消)一次回報一個,每個只回報一次;開始等之前就結束的會馬上回報,
  沒有待回報的才會等下一個。別的 session 的下載不會被報給你。
- **batch 裡也能上傳**(FR-210 – FR-215):`file_upload`、`upload_image` 可以當 `browser_batch` 的步驟,
  用的是和單獨呼叫**同一套**檢查(允許資料夾、當下詢問、不記住磁碟機根目錄、主機讀檔、截圖快取、大小上限)。
  需要問資料夾的,會在 batch 的第一步開始之前,依步驟順序一次問一個;任何一個答「拒絕」,整個 batch 什麼都不做,
  答案寫出是第幾步(例如 `step 2: upload-declined`)。同一個 batch 裡拍的截圖不能在同一個 batch 上傳,
  答案會提示在下一次呼叫再上傳。整個 batch 的上傳內容加總太大時回 `batch-upload-too-large`,提示拆成幾次呼叫。
  在問題卡片上按「中斷」或「停止」,和單獨上傳時一樣,batch 一步都不會跑。
- **沒人在等的配對卡片會消失**(FR-216 – FR-219):主機不再等某個 session 的配對答案(等待時間到了,或 session 結束了)
  時,會告訴擴充功能收回那張卡片上的這個 session;沒有 session 在等了,卡片就從側欄移除,「!」徽章也清掉。
  你對卡片的回答只算數給當下還在等的 session。

> **升級提醒**:請**重新安裝主機**(`npm run agent-host:install`,安裝包使用者是 `install.ps1`),
> 並到 `chrome://extensions` **重新載入**擴充功能,先後順序都可以。升級途中主機和擴充功能版本可以不同:
> 新主機要等擴充功能表示看得懂「收回配對」,才會在配對請求上附上新的編號;看不懂的一方就照 0.7.0 的方式運作,
> 不會出錯。連結協定版本不變(仍是 2)。

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
