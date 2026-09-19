# 設計提案 — Agent 整合拓撲與能力剖面

日期:2026-09-04 · 狀態:**提案,尚未核准**;需要 owner 產生對應的 Product Requirement 之後才可實作 ·
來源:2026-09-03/04 與 owner 的架構討論;參考套件的**外部可觀察**行為(manifest 宣告的權限與 CSP 連線目標)

這份文件回答一個問題:**當驅動瀏覽器的一方從「我們自己的 AI 服務」變成「任意 agent」,架構要長什麼樣。**
它不改變任何既有的工作包宣稱,也不授權任何權限變更 —— 憲章第 V 條要求每個權限都要追溯到一個已核准的能力
與可觀察的驗收情境,本文件只負責把選項與約束寫清楚,讓那個決定有依據。

## 1. 兩個層面

owner 的產品意圖分成兩層,兩層都要,而且是不同的東西:

| 層面 | 對面是誰 | 誰擁有對話 | 使用情境 |
| --- | --- | --- | --- |
| **L1 本機 agent** | 使用者自己機器上的 CLI(Claude Code、Codex CLI 等) | agent | 自己用;或交付給別人,他自備 agent |
| **L2 產品服務** | 我們營運的 server,agent 跑在裡面 | server | 產品線;使用者不需要自備任何東西 |

L1 不需要我們營運任何伺服器,也不碰使用者帳號;L2 是現在 POC 已經在做的形狀。

**明確不在本提案內**:雲端中繼站(擴充套件與遠端 agent 各自連出到一個公開轉發站)。它只有在「agent 不在
使用者機器上、而且我們不擁有那個 agent」時才需要,會引入「我們營運一台看得到所有使用者瀏覽內容的伺服器」
這個法遵等級的問題。若日後需要,應以獨立提案處理。

## 2. 一份協定,兩個端點

關鍵觀察:**從擴充套件的角度,L1 與 L2 沒有差別。** 兩者都是「主動連出一條 WSS/WS、對面送能力請求、
本地執行並回報」。MV3 無法監聽埠,所以永遠是擴充套件連出去,這一點兩層一致。

```
L1:  擴充套件 ──ws://127.0.0.1:<port>──> 本機轉接器 ──MCP(stdio)──> Claude Code / Codex CLI
L2:  擴充套件 ──wss://<產品 origin>─────> 產品 Server(agent provider 在裡面)
```

因此 `contracts/task-channel.md` 那份契約**兩層共用**,不分岔:同一組 `server.capability-request` /
`client.capability-result`、同一套 Plan 提案與決定、同一套心跳與租約(WP5)。

擴充套件的政策層 —— 同意卡、模式閘門(WP2)、效果驗證(WP1)、效果時分類(WP4)、dispatch fence(WP3)——
**在兩層下完全不變**,因為它們的前提本來就是「不信任驅動我的那一方」。本機 agent 並不比遠端 agent 可信。

### 擴充套件唯一要新增的概念:連線模式

```
connectionMode = "product" | "local"
```

- 決定連去哪個端點
- 決定用哪一套認證(見第 3 節)
- **不決定任何政策**:兩種模式下,能力集合、同意流程、拒絕理由完全相同

## 3. 認證會分岔,這是唯一無法共用的部分

| | L2 產品服務 | L1 本機 agent |
| --- | --- | --- |
| 信任來源 | 使用者的產品帳號 | 使用者在瀏覽器裡的明示配對 |
| 機制 | OAuth 授權碼 + PKCE、session、refresh(WP6 的範圍) | 配對碼 + 側欄確認 |
| 憑證存放 | `chrome.storage.session`(既有的 allowlist) | 同上,但存的是配對綁定而非帳號憑證 |
| 撤銷 | 登出 / `DELETE /v1/auth/session` | 解除配對;關閉擴充套件即失效 |

**L1 為什麼不能沿用 OAuth**:本機 CLI 沒有帳號可登入,也沒有 redirect URI 可回。它需要證明的是
「使用者本人同意這個本機程序驅動這個瀏覽器」,那是配對問題,不是身分問題。

**L1 的配對必須滿足**(否則放寬 CSP 等於開門):

1. 配對碼由**擴充套件**產生並顯示在側欄,由使用者複製到 agent 端 —— 不可以反過來,否則任何本機程序都能
   自稱已配對
2. 使用者必須在側欄按下明示確認,且看得到對方宣告的身分字串(該字串視為不可信的顯示文字)
3. 配對綁定單一 runtime epoch;擴充套件重啟即失效
4. 側欄隨時可解除配對,解除後既有連線立即中斷

**尚未決定**:是否改用 native messaging 取代 localhost WebSocket。native messaging 的信任來自作業系統
(Chrome 以執行檔路徑與 `allowed_origins` 綁定),不需要配對碼,但需要安裝一個原生主機清單檔,交付成本較高。
兩個參考套件**兩者都準備了**。建議 L1 第一版用 localhost + 配對,把 native messaging 列為後續選項。

## 4. 本機轉接器(L1)

一個獨立的小程序,不屬於擴充套件也不屬於產品 Server:

```
Claude Code / Codex CLI  ──MCP (stdio)──>  轉接器  ──WS (127.0.0.1)──>  擴充套件
        呼叫工具                          翻譯               能力請求
```

職責:

- 對 agent 側:當一個 MCP server,把能力揭露成工具(`page.read`、`browser.scroll`、`browser.click`、
  `browser.enter-text`,以及 Plan 相關的工具,見下)
- 對擴充套件側:實作 `task-channel` 契約的 server 那一半 —— 包含 WP5 的 60 秒租約與心跳回應
- **不做任何政策判斷**。它是翻譯層,不是授權層。所有拒絕都發生在擴充套件裡

### 協定形狀的落差(需要設計)

現有協定是**任務型**的:有任務生命週期、progress 文字、Plan 提案、terminal 摘要,因為對面擁有整段對話。
MCP 是**呼叫型**的:一問一答,對話在 agent 那邊。

落差與處理方向:

| 現有協定元素 | MCP 對應 | 說明 |
| --- | --- | --- |
| `server.capability-request` | 工具呼叫 | 直接對應 |
| `client.capability-result` | 工具回傳 | 直接對應 |
| `server.plan-proposed` + `ui.plan.decide` | 一個 `propose_plan` 工具 | Plan 卡照樣出;agent 主動呼叫而非協定推送 |
| `server.progress` | 無對應 | L1 下側欄顯示什麼,待設計 |
| `server.terminal` | 無對應 | 任務邊界在 agent 那側;側欄需要另一種「這段互動結束了」的表示 |

**這是 L1 唯一需要真正設計工作的地方**,其餘都是既有機制的重用。

## 5. 能力剖面:`debugger` 與 `<all_urls>`

owner 的第二階段意圖是把功能對齊參考套件,那需要 `debugger`(CDP)與 `<all_urls>`。
本節**規劃它,但不採用它**。

### 現況與參考套件的落差

| | 目前 POC | 兩個參考套件 |
| --- | --- | --- |
| 主機權限 | 無 | `<all_urls>` |
| 自動化 | `activeTab` + `scripting` 動態注入,ISOLATED world | `debugger`(CDP) |
| 分頁視野 | 僅當前作用中分頁 | `tabs`、`webNavigation`、`tabGroups`、`history` 等 |
| 權限數 | 5 | 16–18 |

### 為什麼不在這個階段拿

1. **憲章第 V 條明文禁止這個理由。** 原文:「Permission scope MUST NOT be broadened for convenience,
   anticipated future work, or parity with a reference extension.」「為了第二階段」與「為了對齊參考套件」
   正好是被點名的兩個理由。正當路徑是:先有一個**需要它的、已核准的能力**與可觀察的驗收情境。

2. **現有證據的意義會改變。** packaged gate 現在有六個受限頁面案例(`chrome://newtab`、擴充套件自身頁面、
   PDF、`file://`、`data:`、`blob:`),它們之所以成立,是因為 `activeTab` + `scripting` **做不到**。換成 `<all_urls>` +
   `debugger` 之後,其中數個會從「做不到」變成「政策上拒絕」——那是弱得多的主張,那幾個案例都要重寫。
   `tests/contract/manifest.contract.test.ts` 目前釘死「production 恰好五個權限、零個 host permission」,
   那個測試**就是這個主張本身**。

3. **`debugger` 不是更大的 `scripting`,是不同的信任模型。** 現在的 content runtime 刻意只在 ISOLATED
   world 執行、不碰 MAIN world、不做 page-world bridge,這是「被入侵的頁面拿不到什麼」這個論證的基礎。
   CDP 直接繞過那道邊界(可在 main world 求值、可經 Network domain 取得 cookie 與標頭、可繞過 CSP)。
   採用它不是延伸現有設計,而是**部分取代它的圍堵論證**。另外 CDP 附著時 Chrome 會顯示「正在偵錯」提示列,
   那是使用者可見的成本。

4. **安裝時的同意畫面會變。** 5 個權限 → 「讀取及變更你在所有網站上的資料」。這是產品定位決策,不只是技術決策。

### 現在就要固定的約束(這才是「規劃」的實質)

不論日後採用哪個剖面,以下必須成立:

**C-1 政策層永遠在執行後端之上。** `classifyClick` / `classifyTextEntry`、同意卡、模式閘門、dispatch
fence、效果驗證,一律在 service worker 裡執行,與效果由 `chrome.scripting` 或 CDP 送出無關。
**CDP 絕不可被用來繞過任何一個已經拒絕的操作。**

**C-2 執行後端是可替換的介面,不是散落的呼叫。** `createControlRuntime` 注入的頁面埠口清單以
`apps/extension/src/service-worker/page-ports.ts` 為準(該檔同時擁有這些埠口回傳與拋出的詞彙),此處不再重列:
埠口數量會隨功能成長 —— 描述解析器已經存在,US6 再加上條件評估器。這正是替換執行後端的接縫。新增 CDP 後端
意味著為該檔列出的每個埠口新增另一組實作,**不修改 `control-port.ts` 的任何政策程式碼**。

**C-3 剖面是 build 時的維度,不是 runtime 的旗標。** 權限集合、CSP `connect-src`、執行後端在建置時決定,
產出不同的成品;不可以在同一個成品裡用旗標切換,否則 manifest 必須宣告聯集,等於直接放寬。

**C-4 每個剖面各有一份 manifest 契約測試,各自釘死自己的權限集合。** 目前那份改名為 narrow 剖面的測試,
不刪除、不放寬。

### 建議的剖面

| 剖面 | 權限 | 執行後端 | 用途 |
| --- | --- | --- | --- |
| `narrow`(現況) | 5 個,零 host permission | `chrome.scripting`,ISOLATED world | 目前的 POC 與 T093 驗收 |
| `broad`(第二階段) | 待核准的能力決定,包含 `debugger`、`<all_urls>` | CDP | 對齊參考套件的功能範疇 |

`broad` 的權限清單**不在本文件決定**。它由第二階段每一個被核准的能力逐項推導,每一項都要帶自己的驗收情境。

## 6. 對既有工作包的影響

| 工作包 | 影響 |
| --- | --- |
| WP1–WP5(已完成) | **無**。政策層與生命週期在兩層拓撲下都成立,不需回頭改 |
| WP6(server 契約) | **不受影響,照原計畫做**。它是 L2 的認證衛生,L1 不使用它 |
| **WP7(build/production 組態)** | **唯一需要現在調整設計的一包。** 它要把 production identity 寫進 manifest,若不預留「剖面」這個維度,之後要回頭重做。應以剖面為輸入產生 manifest 與 CSP,而不是單一組寫死的 origin |
| WP8(封閉邊界、上限) | 無影響;上限與 schema 與後端無關 |
| WP9(面板 / 在地化) | 需新增:連線模式與配對的文案。可在 WP9 一併處理,或留到 L1 實作時 |
| WP10(環境、死碼、證據) | 若剖面成形,evidence-index 需區分剖面;packaged gate 的受限頁面案例意義隨剖面而異 |

## 7. 待 owner 決定

1. **L1 第一版用 localhost + 配對,還是 native messaging?**(建議:localhost + 配對)
2. **L1 的側欄在沒有 progress / terminal 的情況下顯示什麼?**(第 4 節的落差)
3. **`broad` 剖面要不要真的做,還是先只做 L1 而維持 narrow?** 兩者正交:L1 不需要 `debugger` 就能運作,
   只是能操作的頁面範圍與 narrow 剖面相同
4. **WP7 是否現在就改成剖面導向?**(建議:是,成本低於事後重做)

## 8. 功能盤點(第二階段的前置,已由 owner 確認必要)

owner 於 2026-09-04 確認:**功能面必須對齊參考套件**,因此 `broad` 剖面是既定方向,不是假設。
但「對齊參考套件」目前還不是可動工的規格,第二階段開始前必須先有一份功能盤點:

- 依兩個參考套件**外部可觀察**的行為列出功能清單(不讀其實作,見憲章第 II 條)
- 每一項標注:我們已有 / 沒有;需要哪個權限;是否其實不需要 `broad` 剖面就能做
- 這份清單同時滿足憲章第 V 條「每個權限追溯到一個已核准的能力」的要求

**已完成:2026-09-04。** 證據併入參考分析(私有存檔;公開摘要為 `docs/design-notes.md`)(版本現行性覆核 + Codex 對照 + 建議新增
F-022~F-024)與差距表(同一存檔);去向是 spec-kit feature
`specs/002-reference-parity/`。原本的建議時機:WP7 完成之後。 屆時剖面已在建置流程裡成形,盤點可以對照真實的建置產物去標注每一項,
而不是對照假設;WP8–WP10 是收斂與收尾,設計敏感度低,不會被盤點卡住。

## 9. 本文件的地位

依憲章第 III 條的追溯鏈(`Reference Feature → Product Requirement → Spec → Plan → Task`),本文件位於
**Product Requirement 之前**。它不是規格,不授權實作,也不使任何權限變更生效。第 5 節的剖面規劃在
owner 產生對應的 Product Requirement 並附上驗收情境之前,不得進入 `tasks.md` 或任何工作包。
