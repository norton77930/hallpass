# Hallpass(瀏覽器代理橋接)

**讓 coding agent 操作你自己的 Chrome,每一步都由你放行。**

Hallpass 是一個 Chrome 擴充功能加一個本機 MCP server。Claude Code、Codex CLI、Cursor、Claude Desktop
或任何 stdio MCP client 都能拿到 33 個瀏覽器工具,在你平常用的 Chrome、你的登入狀態下操作分頁。
每一個網站、每一個會改變頁面的動作,都受你在側欄做的決定管:只允許這一次、這個網站以後都允許、或拒絕。
你隨時可以停止 agent,把分頁拿回來。

> **平台**:Windows 11 + Google Chrome。Chromium 系瀏覽器有註冊但未驗證;macOS / Linux 尚未支援,見 issue #1。
> **授權**:Apache-2.0。

## 文件

- 英文 [README.md](README.md):安裝、第一次使用、同意模型、工具表、與 chrome-devtools-mcp / playwright-mcp / BrowserMCP 的比較。
- [docs/zh-TW/operations-guide.md](docs/zh-TW/operations-guide.md):中文維護者手冊(從原始碼安裝、側欄、授權、疑難排解、跑驗收)。
- [docs/zh-TW/qa-guide.html](docs/zh-TW/qa-guide.html):中文 QA 試用指南(安裝包、CodeBuddy / Cursor 設定、含截圖)。
- [docs/design-notes.md](docs/design-notes.md):設計說明(英文):比較過哪些產品、對齊了哪些行為、為什麼。
- [specs/](specs/):每個功能的規格、計畫、任務與驗證紀錄(中英夾雜)。

## 三步開始

1. 從 [releases](../../releases/latest) 下載 `hallpass-<版本>.zip`,解壓縮到不會搬動的資料夾,執行 `install.ps1`。
2. `chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `extension\`。
3. 把 `install.ps1` 印出的 MCP server 定義貼進你的 AI 工具;Claude Code 一行:
   `claude mcp add hallpass --scope user -- node "<資料夾>\host\mcp-server.js"`。

從 0.2.0 升級請看英文 README 的 Upgrading 一節,或安裝包內 README 的 §2.1。

## 0.6.0 新增

- **中斷**:session 卡片上「停止」旁邊多一個「中斷」。它只結束正在跑的那一步(一秒內,不管那一步在等什麼),
  其他都留著:配對、分頁與分頁群組、網站模式、正在錄的 GIF、已套用的模擬視窗大小。agent 會知道是你中斷的,
  也會知道剛才有沒有東西已經送進頁面,自己決定要不要再試一次。「停止」的意思不變:結束整個 session。
- **跳到別的網站會先問你**:agent 操作中的分頁離開原本的網站、到了你從來沒決定過的網站時(點擊後被轉址、
  登入服務、短網址),造成這件事的那一次呼叫會在答案裡說明,而**下一次**對那個分頁的呼叫會跳出卡片,
  同時寫出兩個網站:**繼續**(這次 session)、**一律允許**(記住這一組,以後不再問)、
  **拒絕**(只拒絕這一次;session 繼續,問題留給下一次呼叫)。要離開的呼叫不會被擋:換去別的網址、
  關掉分頁、把分頁還你,都直接放行。記住的組合會列在側欄,寫著上次使用時間,旁邊有**撤銷**。
- **上傳你資料夾以外的檔案也會先問你**:`file_upload` 以前直接拒絕,等於要先手動改 `config.json`。
  現在本機主機會把這次呼叫停住,側欄完整列出每個檔案、以及每個檔案所在的資料夾,讓你選:
  **這次就好**、**這個資料夾以後都可以**(加進清單)、或**拒絕**。磁碟機或網路分享的根目錄永遠不會被加進清單,
  那些檔案只會以「這次就好」放行,答案裡會說明原因。允許的資料夾也列在側欄,各自有**撤銷**;
  這份清單仍然只有你和這個檔案本身能改,agent 呼叫得到的工具沒有任何一個讀得到或加得了。
- 另外補上 013 留下的三件小事:`file_upload` 成功後也會像 `upload_image` 一樣在 session 卡片留一行;
  `upload_image` 的同意卡片會說清楚是哪一種放法(放進檔案欄位,還是拖放到頁面上的位置);
  `viewport` 現在也會錄進 GIF,頁面突然變窄的那一格終於說得出原因。

**升級**:請重新安裝本機主機(`npm run agent-host:install`,或安裝包裡的 `install.ps1`)。
0.5.0 的主機遇到允許資料夾以外的檔案時,只會回 `upload-not-allowed` 直接拒絕,不會問你。
擴充功能會先問主機做得到什麼,所以 0.6.0 的擴充功能配上舊主機,行為就跟 0.5.0 一樣。

## 貢獻

歡迎 issue 與 PR。[CONTRIBUTING.md](CONTRIBUTING.md) 說明建置、測試、「失敗兩次就停」的規則與 clean-room 邊界;
[SECURITY.md](SECURITY.md) 說明如何私下回報漏洞。
