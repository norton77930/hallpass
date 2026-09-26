# Hallpass(瀏覽器代理橋接)— QA 安裝包

這個安裝包讓你在**自己的 Chrome、自己的登入狀態**下,讓 AI(任何 MCP client)操作分頁。沒有任何遠端服務;
三個程序都在你的電腦上:

```
MCP client ──stdio──▶ host\mcp-server.js ──loopback──▶ relay(Chrome 自己啟動)──▶ 擴充功能 ──▶ 分頁
```

版本見 `VERSION`。安裝包內容:`extension\`(擴充功能)、`host\`(三個 .js,不需要 node_modules)、
`install.ps1`、`uninstall.ps1`、這份 README。

## 1. 前置

- Windows 11。
- **Node.js 24 以上**(`node -v` 要看到 `v24.x`;https://nodejs.org/)。`install.ps1` 會檢查,太舊會停下來。
- **Chrome**(正式版 152 驗收過;Chromium、Edge、Brave 有註冊但未實機驗證)。想把 agent 的登入狀態和日常瀏覽分開,才用專用
  profile:`chrome.exe --user-data-dir=D:\chrome-agent-profile`。
- 一個支援 stdio MCP 的 client(第 4 節有五種常見的:CodeBuddy、Claude Code、Claude Desktop、Codex CLI、Cursor)。

## 2. 安裝(做一次)

1. 把 zip 解壓縮到一個**之後不會搬動**的資料夾,例如 `D:\hallpass\`(路徑會被寫進登錄與設定)。
2. 在那個資料夾開 PowerShell,執行:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   它會:檢查 Node、把 native host 註冊到 HKCU(不需要系統管理員)、在 `%LOCALAPPDATA%\hallpass\`
   寫入 host manifest 與啟動器、建立空的 `config.json`(只在不存在時),最後**印出並複製到剪貼簿**
   要貼進 MCP client 的 server 定義。它**不會**改任何 client 的設定。
3. 重複執行是安全的;搬動資料夾後再執行一次即可。

### 2.1 從 0.2.0 升級到 0.3.0

0.3.0 把產品改名為 **Hallpass**:MCP server 叫 `hallpass`(原 `poc-browser`)、native host 叫
`com.hallpass.host`、host 資料夾是 `%LOCALAPPDATA%\hallpass\`(原 `poc-agent-host`)。步驟:

1. 把 0.3.0 的 zip 解壓縮到一個資料夾(可以是原本那個,蓋掉 `extension\`、`host\`、兩個 `.ps1` 和 README),
   執行 `install.ps1`。它會註冊新的 host,**同時移除 0.2.0 的舊註冊**並印出來;舊資料夾
   `%LOCALAPPDATA%\poc-agent-host\` 留給你自行刪除。
2. 上傳白名單(`uploadRoots`)在新的 `%LOCALAPPDATA%\hallpass\config.json` 重填一次(新資料夾從空白開始)。
3. `chrome://extensions` → 對這個擴充功能按**重新載入**(或從新的 `extension\` 重新「載入未封裝項目」)。
   名稱會變成 **Hallpass**;ID 不變。
4. MCP client 端換 server 名稱:Claude Code 執行 `claude mcp remove poc-browser --scope user`,再執行
   `install.ps1` 印出的 `claude mcp add hallpass …`;其他 client 把設定裡的 `poc-browser` 改成 `hallpass`
   並更新路徑。工具前綴變成 `mcp__hallpass__…`。

**配對和每個網站的模式都留著**:它們存在擴充功能自己的 `chrome.storage.local`,以固定的擴充功能 ID 為鍵,
改名不會動到。從 0.1.x 直接升級也是同樣四步;0.2.0 加的 `offscreen` 權限會讓 Chrome 在重新載入後**問一次**
要不要接受新權限,同意即可。

### 2.2 升級到 0.8.0(從 0.3.0 之後的任何版本)

名稱、路徑、MCP server 名稱(`hallpass`)都沒變,只有兩步,**先後順序都可以**:

1. 把 0.8.0 的 zip 解壓縮到原本的資料夾(蓋掉 `extension\`、`host\`、兩個 `.ps1` 和 README),
   **重新執行 `install.ps1`**。batch 裡上傳檔案、配對卡片自動收回,都需要新版的主機。
   已經開著的 MCP client 重開一次,才會用到新的主機。
2. `chrome://extensions` → 對這個擴充功能按**重新載入**。

升級途中主機和擴充功能的版本可以不同:新主機要等擴充功能表示看得懂,才會在配對請求上附上新的編號,
所以只做了其中一步時,就照 0.7.0 的方式運作,不會出錯。從 0.6.0 或更早升上來的話,0.7.0 的
「連線時不跳卡片、『忽略』只拒絕一次」也一起生效(一樣在主機裡)。

配對、網站模式和 `config.json` 都留著。還在 0.2.0 或更早的話,先照 §2.1 做。

**0.8.0 新增**

- **按下去做了什麼,答案會說**:點擊(以及其他按壓動作,單獨呼叫或放在 batch 裡都一樣)的答案,
  會寫出觀察時間內接著發生了什麼:換頁(附新網址)、開了新分頁(寫出分頁 id 與網址;這些分頁不屬於這個 session,
  要操作請用 `tabs_claim` 接手)、開始了下載,或什麼都沒發生。按的是連結卻什麼都沒發生時,答案會直說。
- **頁面沒回應不再被說成 stale**:頁面 10 秒沒回應時,呼叫會以 `page-not-responding` 結束;還沒送出東西時提示可以再試一次,點擊或打字已送到頁面時則提示輸入可能已經生效、重送前先看頁面;
  `stale` 只留給「頁面已經被換掉」和「分頁已經不在」。
- **每一個下載完成都只回報一次**:`wait` 等下載完成時,每個下載各回報一次,先結束的先回報。
- **batch 裡也能上傳**:`file_upload`、`upload_image` 可以當 `browser_batch` 的步驟,檢查和單獨呼叫一樣;
  資料夾詢問在 batch 開始之前依序問完,任何一個答「拒絕」,整個 batch 都不會執行。
  同一個 batch 裡拍的截圖,要在下一次呼叫再上傳。
- **沒人在等的配對卡片會消失**:agent 不再等了(等待時間到了或斷線了),卡片會從側欄移除,「!」徽章也會清掉。

**0.7.0 新增**

- **配對只在 agent 真的要動手時才問**:agent 連上來不再跳卡片,要等它第一次呼叫工具才會出現。
  同一個 agent 有好幾條連線在等時,卡片會寫出有幾條,新加入的那條會標出來。
- **按「忽略」會馬上回覆 agent**:忽略配對卡片,等著的那次呼叫立刻以「拒絕這一次」結束,agent 會被告知不要重試,
  下一次呼叫就會重新問你。「解除配對」仍然會拒絕這個 session 之後的每一次呼叫,答案裡現在會提醒 agent 用 `/mcp` 重新連線。
- **以你眼前的視窗為準**:「!」徽章和兩分鐘的等待時間,跟著你目前所在的視窗走;
  別的視窗開著側欄,不會再把卡片藏起來或把等待縮短。
- **紅色邊框該出現就出現**:agent 操作中的分頁重新載入或換頁(包括按 F5)後紅框還在;
  擴充功能重新載入之前就開著的分頁也一樣。

## 3. 載入擴充功能

1. Chrome 開 `chrome://extensions`,右上角開啟「開發人員模式」。
2. 「載入未封裝項目」→ 選安裝包裡的 `extension\` 資料夾(`install.ps1` 會印出完整路徑)。
3. 確認名稱是 **Hallpass**(zh-TW 介面顯示「Hallpass 瀏覽器代理橋接」),ID 是 `adgpccmmbgnchnphfaoabfflfcepbopd`(固定,native host 只允許這個 ID)。
4. 釘在工具列。點圖示或按 **Alt+A** 開側欄;第一次看到「還沒有 agent 連上這個瀏覽器」是正常的。

## 4. 把 MCP server 加進你的 client

`install.ps1` 印出的定義長這樣(路徑換成你解壓縮的位置;JSON 裡的反斜線要寫兩個):

```json
{ "command": "node", "args": ["D:\\hallpass\\host\\mcp-server.js"] }
```

| Client | 設定在哪裡 | 要加什麼 |
|---|---|---|
| **CodeBuddy**(騰訊 AI IDE / VS Code 外掛) | 側欄對話面板右上角 **CodeBuddy Settings** → **MCP** 頁籤 → **添加 MCP**(JSON 編輯器) | 貼上 `{ "mcpServers": { "hallpass": { "type": "stdio", "command": "node", "args": ["D:\hallpass\host\mcp-server.js"], "description": "Hallpass" } } }`(CodeBuddy 要有 `"type": "stdio"`),存檔後在 MCP 清單按「嘗試運行」確認 |
| **Claude Code** | 指令(任何目錄執行;`--scope user` 每個專案都能用) | `claude mcp add hallpass --scope user -- node "D:\hallpass\host\mcp-server.js"`,然後 `claude mcp list` 應看到 `hallpass` |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json`(設定 → 開發人員 → 編輯設定) | `"mcpServers": { "hallpass": { "command": "node", "args": ["D:\\hallpass\\host\\mcp-server.js"] } }`,存檔後重啟 Claude Desktop |
| **Codex CLI** | `~\.codex\config.toml` | `[mcp_servers.hallpass]` 底下 `command = "node"`、`args = ["D:\\hallpass\\host\\mcp-server.js"]` |
| **Cursor** | 全域 `~\.cursor\mcp.json`,或專案的 `.cursor\mcp.json` | `"mcpServers": { "hallpass": { "command": "node", "args": ["D:\\hallpass\\host\\mcp-server.js"] } }` |

**任何 stdio MCP client**:command `node`、args 同上(一個元素,`mcp-server.js` 的絕對路徑),名稱隨意。
工具名稱以 client 顯示為準,例如 Claude Code 裡是 `mcp__hallpass__read_page`。

只用 Claude Code 的話,可以直接 `.\install.ps1 -Register claude-code`:PATH 上有 `claude` 就替你執行
上面那行,沒有就只印出來。

## 5. 第一次使用

1. Chrome 開著、擴充功能已載入;開你的 client,例如:「用 hallpass 打開 https://en.wikipedia.org,告訴我首頁的標題」。
2. 第一通工具呼叫會讓側欄跳出**配對卡**:「<client 名稱> 想連上這個瀏覽器」→ 按**允許配對**。
   你正在用的那個視窗開著側欄時,有 **45 秒**;沒開(或側欄在別的視窗)時,工具列圖示會出現紅色 **!**、
   agent 會轉告你去哪裡按,卡片最多等 **2 分鐘**。逾時那一通會失敗,再叫一次就會再問。
   配對只做一次,之後 Chrome 重開也記得。
3. 第一個會**改變頁面**的動作(點擊、輸入、導航…)會跳出**同意卡**,三個選項:**只允許這一次**(下一個再問)、
   **這個網站以後都允許**(這個站不再問)、**拒絕**(這個動作回「拒絕」給 agent)。
4. agent 在動的分頁會被圈成一個分頁群組(標題 Agent),頁面頂端有橫幅;側欄會出現那個 session 的卡片,
   上面有**停止**與**還我分頁**。

**網站模式**(側欄「允許 agent 操作的網站」清單,每站一個):`ask`(每次都先問我,預設)、`follow-a-plan`
(照計畫:`browser_batch` 多步整批核准一次,單步照樣問)、`skip-checks`(不再詢問,清單上有警示標記)。
`read_console` / `read_network` / `evaluate` 另外要勾該站的「診斷授權」。上傳只能從
`config.json` 的 `uploadRoots` 列出的目錄,安裝時是空陣列 = 不能上傳。對有帳號的敏感網站不要開 `skip-checks`。

Chrome 頂端出現「Hallpass 已開始對此瀏覽器進行偵錯」橫幅是正常的,**不要按「取消」**,按了之後點擊/輸入會失敗到
下一次重新附著。Chrome 關掉 = 橋接結束,重開後 10 秒內自動恢復,不用重啟 client。

## 6. 檔案在哪裡

`%LOCALAPPDATA%\hallpass\`:

| 檔案 | 用途 |
|---|---|
| `config.json` | 上傳白名單 `{ "uploadRoots": ["D:\\agent-uploads"] }`;安裝時空陣列,移除時保留 |
| `bridge.json` | relay 發布的 loopback 位址與 token;Chrome 啟動 relay 時自動寫,不用手動改 |
| `relay.log` | relay 的診斷紀錄(只有穩定代碼,沒有頁面內容);回報問題時附上 |
| `com.hallpass.host.json`、`native-host.cmd` | host manifest 與啟動器,`install.ps1` 寫、`uninstall.ps1` 刪 |
| `agent-id` | 這台機器的 agent 身分,配對只問一次靠它 |

登錄:`HKCU\Software\<瀏覽器>\NativeMessagingHosts\com.hallpass.host`,四個瀏覽器根都寫:`Google\Chrome`、`Chromium`、`Microsoft\Edge`、`BraveSoftware\Brave-Browser`(只在目前使用者;Chrome 驗收過,Edge、Brave 只註冊、未實機驗證,見公開 repo issue #2)。

## 7. 移除

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1          # 保留 config.json
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # 連 config.json、配對身分一起刪
```

若安裝前這台機器已經有一份 host manifest(例如開發用的 repo 安裝),`install.ps1` 備份成 `.bak`,`uninstall.ps1`
會把它放回去並重新註冊。之後手動:`chrome://extensions` 移除擴充功能;從你的 client 設定移除 `hallpass`
(Claude Code:`claude mcp remove hallpass --scope user`)。

## 8. 回報問題時請附上

1. `VERSION` 的內容、Chrome 版本(`chrome://version`)、`node -v`。
2. 側欄「未連線」畫面裡「技術資訊」的內容(relay pid、`bridge.json` 路徑、最後斷線原因)。
3. `%LOCALAPPDATA%\hallpass\relay.log`。
4. 你下的指令、agent 回的錯誤代碼(例如 `not-paired`、`bridge-lost`、`input-unavailable`),以及當時側欄有沒有跳卡片。

## 9. 第三方元件

GIF 編碼器 [`gifenc`](https://github.com/mattdesl/gifenc)(MIT 授權)打包在 `extension\` 的 bundle 裡,
隨擴充功能在本機執行,不會另外下載任何東西。完整的第三方元件清單(react、zod、MCP SDK、gifenc 與其授權)
見 repo 根目錄的 `THIRD_PARTY_NOTICES.md`;Hallpass 本身以 Apache-2.0 授權(`LICENSE`)。
