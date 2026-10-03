# Hallpass(瀏覽器代理橋接)

**讓 coding agent 操作你自己的 Chrome,每一步都由你放行。**

[English](README.md) · 繁體中文

Hallpass 是一個 Chrome 擴充功能加一個本機 MCP server。Claude Code、Codex CLI、Cursor、Claude Desktop
或任何 stdio MCP client 都能拿到 37 個瀏覽器工具,在你平常用的 Chrome、你的登入狀態下操作分頁。
每一個網站、每一個會改變頁面的動作,都受你在側欄做的決定管:只允許這一次、這個網站以後都允許、或拒絕。
你隨時可以停止 agent,把分頁拿回來。

> **平台**:Windows 11 + Google Chrome。Microsoft Edge 已於 2026-10-03 實機驗證;Brave 有註冊但未驗證(issue #2);macOS / Linux 尚未支援,見 issue #1。
> **授權**:Apache-2.0。

![coding agent 在使用者的 Chrome 裡用 DuckDuckGo 搜尋：輸入前、按 Enter 前，側邊面板都先問使用者，agent 等到按下「Allow once」才動手。頁面那一半是 Hallpass 自己的錄影，帶有動作標籤、步驟編號與浮水印](docs/media/demo.gif)

## 文件

- 英文 [README.md](README.md):安裝、第一次使用、同意模型、工具表、與 Claude in Chrome / chrome-devtools-mcp / playwright-mcp / BrowserMCP 的比較。
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

## 安全與隱私

- **留在你電腦上的**：Hallpass 沒有伺服器、沒有帳號、沒有遙測。MCP server、relay 和擴充功能之間只走
  loopback 與 Chrome native messaging，擴充功能本身不發任何網路請求。`relay.log` 只記穩定代碼，不記頁面內容。
- **會離開的**：工具回給 agent 的內容（頁面文字、表單值、截圖）會進到你的 coding agent，再送到它使用的模型供應商，
  就像 agent 讀你的檔案一樣。密碼、hidden、一次性驗證碼、信用卡欄位會被遮蔽，其他內容供應商都看得到。
- **Prompt injection**：網頁內容是不可信的輸入，可能試圖指揮讀到它的 agent。Hallpass 不偵測這件事，也不宣稱做得到；
  它給你的是決定點：在 **ask** 模式下，每個會改變頁面的動作都要等你放行，跳到你沒決定過的網站也會在下一次呼叫時問你。
  有帳號的網站請保持 **ask**，看到不預期的動作就按「結束工作階段」。
- **工作階段的網站計畫**：一個任務要跨好幾個網站時，agent 可以用 `propose_sites` 先列出要用的網站，
  你在側欄一次核准，也可以取消勾選其中幾個。之後只有這一個工作階段、只在這些網站上，頁面動作不必每次都問；
  工作階段結束、解除配對、瀏覽器關閉，或你在工作階段卡片上按「撤回網站計畫」時就失效。
  執行頁面 JavaScript、上傳檔案、跳到你沒決定過的網站照樣會問，清單以外的網站完全不受影響。
- **同時開好幾個瀏覽器**：每個裝了 Hallpass 的瀏覽器(或 profile)都會同時服務。只開一個時一切照舊；
  開了好幾個時,agent 第一次用瀏覽器工具會被擋下，先列出瀏覽器、問你要用哪一個，再用 `select_browser` 選定，
  或用 `request_browser_choice` 讓每個側欄都跳出「要讓這個瀏覽器給 … 用嗎?」,你在哪個瀏覽器按確認就用哪個。
  Hallpass 不會替你挑。選擇會記住；那個瀏覽器沒開時 agent 會被告知並重新問你，不會自己換到別的瀏覽器。
  配對與每個網站的同意都各自留在原本的瀏覽器，在一個瀏覽器允許的事，不會讓另一個瀏覽器也允許。
  側欄可以替這個瀏覽器取名(例如「公司 Edge」),也會顯示另外有幾個瀏覽器連線。

## 更新紀錄

每一版新增的功能見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)(英文完整版 [CHANGELOG.md](CHANGELOG.md))。
升級方式每一版都一樣：重新安裝主機(zip 裡的 `install.ps1`,或從原始碼 `npm run agent-host:install`),
再到 `chrome://extensions` 重新載入擴充功能，順序不拘。

## 貢獻

歡迎 issue 與 PR。[CONTRIBUTING.md](CONTRIBUTING.md) 說明建置、測試、「失敗兩次就停」的規則與 clean-room 邊界;
[SECURITY.md](SECURITY.md) 說明如何私下回報漏洞。
