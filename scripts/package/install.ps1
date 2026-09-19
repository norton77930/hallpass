<#
.SYNOPSIS
  安裝 Hallpass(瀏覽器代理橋接)的 native host(QA 安裝包版)。

.DESCRIPTION
  在目前使用者(HKCU)底下註冊 host、寫入 %LOCALAPPDATA%\hallpass\ 的 host manifest 與啟動器,
  然後印出(並複製到剪貼簿)要貼進 MCP client 設定的 server 定義。不需要系統管理員權限。
  不會修改任何 MCP client 的設定,除非明確加上 -Register claude-code。
  可以重複執行;既有的 host manifest 會先備份成 .bak,uninstall.ps1 會還原它。

.PARAMETER Register
  "claude-code":若 PATH 上找得到 claude,就執行 `claude mcp add hallpass --scope user -- node "<路徑>"`;
  找不到就只印出指令,不算失敗。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Register claude-code
#>
[CmdletBinding()]
param(
  [ValidateSet("claude-code")]
  [string]$Register
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---- 這個安裝包的檔案(全部相對於腳本所在資料夾) ------------------------------------------
$hostDir      = Join-Path $PSScriptRoot "host"
$installer    = Join-Path $hostDir "install.js"
$serverPath   = Join-Path $hostDir "mcp-server.js"
$extensionDir = Join-Path $PSScriptRoot "extension"

foreach ($required in @($installer, (Join-Path $hostDir "native-host.js"), $serverPath, (Join-Path $extensionDir "manifest.json"))) {
  if (-not (Test-Path -LiteralPath $required)) {
    Write-Host "找不到 $required。請把 zip 完整解壓縮後,從解壓縮出來的資料夾執行 install.ps1。" -ForegroundColor Red
    exit 1
  }
}

# ---- 前置:Node 24 以上 --------------------------------------------------------------------
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host "找不到 node。請先安裝 Node.js 24(https://nodejs.org/),重開終端機後再執行一次。" -ForegroundColor Red
  exit 1
}
$nodeVersion = (& node -v 2>$null | Out-String).Trim()   # 例如 v24.13.0
$nodeMajor = 0
if ($nodeVersion -match '^v?(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 24) {
  Write-Host "Node 版本太舊:$nodeVersion(需要 24 以上)。請升級 Node.js 後再執行一次。" -ForegroundColor Red
  exit 1
}
Write-Host "Node $nodeVersion($($nodeCommand.Source))"

# ---- host 資料夾與既有安裝的備份 ---------------------------------------------------------------
$dataDir      = Join-Path $env:LOCALAPPDATA "hallpass"
$manifestPath = Join-Path $dataDir "com.hallpass.host.json"
$launcherPath = Join-Path $dataDir "native-host.cmd"
$configPath   = Join-Path $dataDir "config.json"

# install.js 會覆寫 manifest 與啟動器。既有的那一份(例如指向 repo 的開發安裝)備份一次,
# 讓 uninstall.ps1 能把它放回去;重複執行 install.ps1 不會用自己寫的那份蓋掉備份。
if ((Test-Path -LiteralPath $manifestPath) -and -not (Test-Path -LiteralPath "$manifestPath.bak")) {
  Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.bak"
  if (Test-Path -LiteralPath $launcherPath) {
    Copy-Item -LiteralPath $launcherPath -Destination "$launcherPath.bak"
  }
  Write-Host "已備份既有的 host manifest:$manifestPath.bak(uninstall.ps1 會還原)"
}

# ---- 寫入 manifest、啟動器、HKCU 登錄 ------------------------------------------------------------
& node "$installer" install
if ($LASTEXITCODE -ne 0) {
  Write-Host "host 安裝失敗(node host\install.js install 回傳 $LASTEXITCODE)。" -ForegroundColor Red
  exit $LASTEXITCODE
}

# 上傳白名單:只在不存在時建立,空陣列 = 不允許上傳。
if (-not (Test-Path -LiteralPath $configPath)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Set-Content -LiteralPath $configPath -Value '{ "uploadRoots": [] }' -Encoding UTF8
}

# ---- 給 MCP client 的 server 定義 ----------------------------------------------------------------
$serverPathJson = $serverPath.Replace("\", "\\")
$definition = "{ `"command`": `"node`", `"args`": [`"$serverPathJson`"] }"
$claudeAddLine = "claude mcp add hallpass --scope user -- node `"$serverPath`""

Write-Host ""
Write-Host "安裝完成。" -ForegroundColor Green
Write-Host ""
Write-Host "1) 在 Chrome 載入擴充功能:chrome://extensions → 開發人員模式 → 載入未封裝項目 →"
Write-Host "   $extensionDir"
Write-Host "   (ID 應為 adgpccmmbgnchnphfaoabfflfcepbopd)"
Write-Host ""
Write-Host "2) 把這個 MCP server 加進你用的 client(README.md 有四種 client 的位置):"
Write-Host "   $definition"
Write-Host "   Claude Code 一行版:"
Write-Host "   $claudeAddLine"

try {
  Set-Clipboard -Value $definition
  Write-Host "   (server 定義已複製到剪貼簿)"
} catch {
  Write-Host "   (無法寫入剪貼簿:$($_.Exception.Message);請自行複製上面那行)"
}

if ($Register -eq "claude-code") {
  Write-Host ""
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "執行:$claudeAddLine"
    & claude mcp add hallpass --scope user -- node "$serverPath"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "claude mcp add 回傳 $LASTEXITCODE;請手動執行上面那行。" -ForegroundColor Yellow
    }
  } else {
    Write-Host "PATH 上找不到 claude;沒有修改任何設定。請自行執行:" -ForegroundColor Yellow
    Write-Host "   $claudeAddLine"
  }
}

Write-Host ""
Write-Host "3) 從 0.2.0 升級的話:舊版的 host 註冊(名稱 com.poc.agent_host)已由上面的安裝步驟移除;"
Write-Host "   舊資料夾 %LOCALAPPDATA%\poc-agent-host 可以自行刪除;上傳白名單請在新的 config.json 重填。"
Write-Host "   MCP client 端把舊的 server 換成新的(Claude Code):"
Write-Host "   claude mcp remove poc-browser --scope user"
Write-Host "   $claudeAddLine"
Write-Host ""
Write-Host "檔案位置:$dataDir(config.json、bridge.json、relay.log)"
exit 0
